// ==========================================
// Aikata - LLMプロバイダー (OpenAI/Anthropic/Gemini対応)
// ==========================================

import type { LLMProvider, LLMResponse, Message, Tool, ToolCall } from "../types";
import { getActiveConfig, getActiveProviderEntry, getProvider, type ProviderEntry, type ProviderType } from "../utils/config";
import { logger } from "../utils/logger";

// ==================== メッセージ形式変換 ====================

function toOpenAITools(tools: Tool[]): any[] {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function messagesToAnthropic(msgs: Message[]): { system?: string; messages: any[] } {
  let system = "";
  const messages: any[] = [];
  for (const m of msgs) {
    if (m.role === "system") { system += m.content + "\n"; continue; }
    if (m.role === "tool") {
      messages.push({ role: "user", content: `[ツール結果: ${m.tool_call_id}]\n${m.content}` });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: m.tool_calls.map(tc =>
          `<function_call name="${tc.function.name}">${tc.function.arguments}</function_call>`
        ).join("\n"),
      });
      continue;
    }
    messages.push({ role: m.role as string, content: m.content });
  }
  return { system: system.trim() || undefined, messages };
}

function messagesToGemini(msgs: Message[]): { systemInstruction?: any; contents: any[] } {
  let systemInstruction: any = undefined;
  const contents: any[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    let role = m.role === "assistant" ? "model" : "user";
    if (m.role === "tool") role = "user";
    contents.push({ role, parts: [{ text: m.content }] });
  }
  return { systemInstruction, contents };
}

// ==================== レスポンス形式変換 ====================

function parseOpenAIResponse(json: any): LLMResponse {
  const choice = json.choices?.[0];
  if (!choice) throw new Error("LLM API: 応答に choices がありません");
  return {
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls || null,
    finishReason: choice.finish_reason || "stop",
    usage: json.usage ? {
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
      totalTokens: json.usage.total_tokens,
    } : undefined,
  };
}

function parseAnthropicResponse(json: any): LLMResponse {
  const content = json.content?.[0];
  let text: string | null = null;
  let tool_calls: ToolCall[] | null = null;

  if (content?.type === "text") {
    text = content.text;
  } else if (content?.type === "tool_use") {
    tool_calls = [{
      id: content.id || "tc1",
      type: "function",
      function: { name: content.name, arguments: JSON.stringify(content.input || {}) },
    }];
  }

  return {
    content: text,
    tool_calls,
    finishReason: json.stop_reason || "stop",
    usage: json.usage ? {
      promptTokens: json.usage.input_tokens,
      completionTokens: json.usage.output_tokens,
      totalTokens: json.usage.input_tokens + json.usage.output_tokens,
    } : undefined,
  };
}

function parseGeminiResponse(json: any): LLMResponse {
  const candidate = json.candidates?.[0];
  const content = candidate?.content;
  let text = "";
  const tool_calls: ToolCall[] = [];

  for (const part of content?.parts || []) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      tool_calls.push({
        id: `gc${tool_calls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  return {
    content: text || null,
    tool_calls: tool_calls.length > 0 ? tool_calls : null,
    finishReason: candidate?.finishReason || "stop",
    usage: json.usageMetadata ? {
      promptTokens: json.usageMetadata.promptTokenCount,
      completionTokens: json.usageMetadata.candidatesTokenCount,
      totalTokens: json.usageMetadata.totalTokenCount,
    } : undefined,
  };
}

// ==================== URL構築 ====================

function getChatUrl(entry: ProviderEntry, model: string): string {
  switch (entry.type) {
    case "openai": return `${entry.baseUrl}/v1/chat/completions`;
    case "anthropic": return `${entry.baseUrl}/v1/messages`;
    case "gemini": return `${entry.baseUrl}/v1beta/models/${model}:generateContent`;
  }
}

function getModelsUrl(entry: ProviderEntry): string {
  switch (entry.type) {
    case "openai": return `${entry.baseUrl}/v1/models`;
    case "anthropic": return `${entry.baseUrl}/v1/models`;
    case "gemini": return `${entry.baseUrl}/v1beta/models`;
  }
}

// ==================== プロバイダー作成 ====================

export function createActiveProvider(): LLMProvider {
  const active = getActiveConfig();
  const entry = getActiveProviderEntry();
  return createProvider(entry, active.model);
}

function createProvider(entry: ProviderEntry, model: string): LLMProvider {
  const url = getChatUrl(entry, model);

  return {
    name: entry.name,
    model,

    async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
      let body: any;
      let headers: Record<string, string> = { "Content-Type": "application/json" };

      switch (entry.type) {
        case "openai": {
          body = { model, messages, temperature: 0.7, max_tokens: 4096 };
          if (tools.length > 0) {
            body.tools = toOpenAITools(tools);
            body.tool_choice = "auto";
          }
          headers["Authorization"] = `Bearer ${entry.apiKey}`;
          break;
        }
        case "anthropic": {
          const converted = messagesToAnthropic(messages);
          body = {
            model,
            max_tokens: 4096,
            messages: converted.messages,
            ...(converted.system ? { system: converted.system } : {}),
            ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
          };
          headers["x-api-key"] = entry.apiKey;
          headers["anthropic-version"] = "2023-06-01";
          break;
        }
        case "gemini": {
          const converted = messagesToGemini(messages);
          body = {
            contents: converted.contents,
            ...(converted.systemInstruction ? { systemInstruction: converted.systemInstruction } : {}),
            ...(tools.length > 0 ? { tools: [{ functionDeclarations: toOpenAITools(tools).map((t: any) => t.function) }] } : {}),
          };
          url.replace(/{model}/g, model); // URLのモデル部分はすでに設定済み
          if (entry.apiKey) {
            url.includes("?") ? null : null;
          }
          break;
        }
      }

      logger.debug(`LLM: ${entry.type}/${model}`);

      const startTime = Date.now();
      const finalUrl = entry.type === "gemini" && entry.apiKey
        ? `${url}?key=${entry.apiKey}`
        : url;

      const response = await fetch(finalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text().catch(() => "unknown");
        throw new Error(`LLM API エラー (${response.status}): ${errText.slice(0, 500)}`);
      }

      const json = await response.json() as any;

      let result: LLMResponse;
      switch (entry.type) {
        case "openai": result = parseOpenAIResponse(json); break;
        case "anthropic": result = parseAnthropicResponse(json); break;
        case "gemini": result = parseGeminiResponse(json); break;
        default: result = parseOpenAIResponse(json);
      }

      logger.debug(`LLM応答: ${elapsed}ms, finish=${result.finishReason}`);
      return result;
    },
  };
}

// ==================== モデル一覧取得 ====================

export async function fetchModels(providerKey: string): Promise<string[]> {
  const entry = getProvider(providerKey);
  if (!entry) throw new Error(`プロバイダー '${providerKey}' が見つかりません`);

  const url = getModelsUrl(entry);
  const headers: Record<string, string> = {};
  let finalUrl = url;

  switch (entry.type) {
    case "openai":
      headers["Authorization"] = `Bearer ${entry.apiKey}`;
      break;
    case "anthropic":
      headers["x-api-key"] = entry.apiKey;
      break;
    case "gemini":
      if (entry.apiKey) finalUrl = `${url}?key=${entry.apiKey}`;
      break;
  }

  const res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`モデル一覧取得失敗: ${res.status}`);

  const json = await res.json() as any;

  switch (entry.type) {
    case "openai":
      return (json.data || []).map((m: any) => m.id).sort();
    case "anthropic":
      return (json.data || []).map((m: any) => m.id).sort();
    case "gemini":
      return (json.models || []).map((m: any) => m.name.replace("models/", "")).sort();
    default:
      return [];
  }
}
