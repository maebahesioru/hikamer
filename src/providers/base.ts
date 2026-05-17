// ==========================================
// Aikata - LLMプロバイダー (v1.4 - retry + reasoning + streaming)
// ==========================================

import type { LLMProvider, LLMResponse, LLMChunk, Message, Tool, ToolCall } from "../types";
import { getProvider, getApiKey, getActiveModel, type ProviderEntry, type ProviderType } from "../utils/config";
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
    reasoning_content: choice.message?.reasoning_content || undefined,
    usage: json.usage ? {
      promptTokens: json.usage.prompt_tokens,
      completionTokens: json.usage.completion_tokens,
      totalTokens: json.usage.total_tokens,
      reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens,
    } : undefined,
  };
}

function parseAnthropicResponse(json: any): LLMResponse {
  const content = json.content?.[0];
  let text: string | null = null;
  let tool_calls: ToolCall[] | null = null;
  if (content?.type === "text") { text = content.text; }
  else if (content?.type === "tool_use") {
    tool_calls = [{
      id: content.id || "tc1", type: "function",
      function: { name: content.name, arguments: JSON.stringify(content.input || {}) },
    }];
  }
  return {
    content: text, tool_calls,
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
        id: `gc${tool_calls.length}`, type: "function",
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
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

// ==================== リトライロジック ====================

/** リトライ時の通知コールバック（messaging.tsからセット→Discord表示） */
export let onRetry: ((msg: string) => void) | null = null;

/** リトライコールバックをセット（必ず使い終わったらnullに戻す） */
export function setOnRetry(fn: ((msg: string) => void) | null): void {
  onRetry = fn;
}

async function retryFetch(
  fn: () => Promise<Response>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fn();
      // 500系 or 429 → retry
      if ((res.status >= 500 || res.status === 429) && i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        const msg = `⏳ APIエラー(${res.status}) ${delay/1000}秒後にリトライ (${i + 1}/${maxRetries})`;
        logger.warn(msg);
        onRetry?.(msg);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e: any) {
      lastError = e;
      if (i < maxRetries && (e.name === "TimeoutError" || e.message?.includes("fetch"))) {
        const delay = baseDelay * Math.pow(2, i);
        const msg = `⏳ API接続失敗  ${delay/1000}秒後にリトライ (${i + 1}/${maxRetries})`;
        logger.warn(msg);
        onRetry?.(msg);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("リトライ上限到達");
}

// ==================== プロバイダー作成 ====================

export function createActiveProvider(): LLMProvider {
  const { provider: providerKey, model } = getActiveModel();
  const entry = getProvider(providerKey);
  if (!entry) throw new Error(`プロバイダー '${providerKey}' が providers.json にありません。`);
  const apiKey = getApiKey(providerKey);
  return createProvider(entry, model, apiKey);
}

function createProvider(entry: ProviderEntry, model: string, apiKey: string): LLMProvider {
  const url = getChatUrl(entry, model);

  return {
    name: entry.name,
    model,

    async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
      let body: any;
      let headers: Record<string, string> = { "Content-Type": "application/json" };
      let finalUrl = url;

      switch (entry.type) {
        case "openai": {
          body = { model, messages, temperature: 0.7, max_tokens: 8192 };
          if (tools.length > 0) { body.tools = toOpenAITools(tools); body.tool_choice = "auto"; }
          headers["Authorization"] = `Bearer ${apiKey}`;
          break;
        }
        case "anthropic": {
          const c = messagesToAnthropic(messages);
          body = { model, max_tokens: 8192, messages: c.messages, ...(c.system ? { system: c.system } : {}), ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}) };
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
          break;
        }
        case "gemini": {
          const c = messagesToGemini(messages);
          body = { contents: c.contents, ...(c.systemInstruction ? { systemInstruction: c.systemInstruction } : {}), ...(tools.length > 0 ? { tools: [{ functionDeclarations: toOpenAITools(tools).map((t: any) => t.function) }] } : {}) };
          if (apiKey) finalUrl = `${url}?key=${apiKey}`;
          break;
        }
      }

      logger.debug(`LLM: ${entry.type}/${model}`);

      const startTime = Date.now();
      const response = await retryFetch(() =>
        fetch(finalUrl, {
          method: "POST", headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })
      );

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

      logger.debug(`LLM応答: ${elapsed}ms, finish=${result.finishReason}, reasoning=${result.usage?.reasoningTokens || 0}t`);
      return result;
    },

    // ==================== ストリーミング ====================
    async *chatStream(messages: Message[], tools: Tool[]): AsyncGenerator<LLMChunk> {
      let body: any;
      let headers: Record<string, string> = { "Content-Type": "application/json" };
      let finalUrl = url;

      switch (entry.type) {
        case "openai": {
          body = { model, messages, temperature: 0.7, max_tokens: 8192, stream: true };
          if (tools.length > 0) { body.tools = toOpenAITools(tools); body.tool_choice = "auto"; }
          headers["Authorization"] = `Bearer ${apiKey}`;
          break;
        }
        default:
          // 非OpenAI系は非ストリーミングにフォールバック
          const result = await (createProvider(entry, model, apiKey)).chat(messages, tools);
          yield { content_delta: result.content || "", reasoning_delta: result.reasoning_content || "", tool_calls: result.tool_calls, finishReason: result.finishReason };
          return;
      }

      logger.debug(`LLM Stream: ${entry.type}/${model}`);

      // retry付きfetch（ストリーム接続前に429/500リトライ）
      const response = await retryFetch(async () => {
        return await fetch(finalUrl, {
          method: "POST", headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      }, 3, 2000);

      if (!response.ok) {
        const errText = await response.text().catch(() => "unknown");
        throw new Error(`LLM API エラー (${response.status}): ${errText.slice(0, 500)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("ストリーム読み取り不可");

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              yield { content_delta: "", reasoning_delta: "", tool_calls: null, finishReason: "stop" };
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              yield {
                content_delta: delta.content || "",
                reasoning_delta: delta.reasoning_content || "",
                tool_calls: delta.tool_calls || null,
                finishReason: choice.finish_reason || null,
              };
            } catch { /* skip malformed JSON */ }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// ==================== モデル一覧取得 ====================

export async function fetchModels(providerKey: string): Promise<string[]> {
  const entry = getProvider(providerKey);
  if (!entry) throw new Error(`プロバイダー '${providerKey}' が見つかりません`);
  const apiKey = getApiKey(providerKey);

  let url = getModelsUrl(entry);
  const headers: Record<string, string> = {};

  switch (entry.type) {
    case "openai": headers["Authorization"] = `Bearer ${apiKey}`; break;
    case "anthropic": headers["x-api-key"] = apiKey; break;
    case "gemini": if (apiKey) url = `${url}?key=${apiKey}`; break;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`モデル一覧取得失敗: ${res.status}`);
  const json = await res.json() as any;

  switch (entry.type) {
    case "openai": return (json.data || []).map((m: any) => m.id).sort();
    case "anthropic": return (json.data || []).map((m: any) => m.id).sort();
    case "gemini": return (json.models || []).map((m: any) => m.name.replace("models/", "")).sort();
    default: return [];
  }
}
