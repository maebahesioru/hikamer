// ==========================================
// Aikata - エージェントループ v1.1
// ==========================================

import type { AgentResult, LLMProvider, Message, ToolLogEntry } from "./types";
import { toolRegistry } from "./tools/registry";
import { getRuntimeConfig } from "./utils/config";
import { logger } from "./utils/logger";
import {
  ensureConversation,
  getHistory,
  saveMessages,
  logToolCall,
} from "./repo";

export async function agentLoop(
  provider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
  conversationId: string,
  platformHint?: string,
): Promise<AgentResult> {
  const runtimeConfig = getRuntimeConfig();
  const toolLogs: ToolLogEntry[] = [];
  let iterations = 0;

  // 会話IDからプラットフォームを推測
  let platform = platformHint || "cli";
  let chatId = conversationId;
  if (conversationId.startsWith("tg-")) {
    platform = "telegram";
    chatId = conversationId.slice(3);
  } else if (conversationId.startsWith("dm-")) {
    platform = "discord";
  } else if (/^\d{17,20}$/.test(conversationId)) {
    platform = "discord";
  }

  ensureConversation(conversationId);

  // 全履歴を復元（トリミングなし、永続保存）
  const pastHistory = getHistory(conversationId, 99999);

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...pastHistory,
    { role: "user", content: userMessage },
  ];

  saveMessages(conversationId, [{ role: "user", content: userMessage }]);

  logger.info(`エージェント開始: ${conversationId} "${userMessage.slice(0, 50)}…"`);

  while (iterations < runtimeConfig.maxIterations) {
    iterations++;
    logger.iteration(iterations);

    const tools = toolRegistry.getOpenAISchema();

    try {
      const response = await provider.chat(messages, tools);

      // テキスト応答のみ → 終了
      if (response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
        saveMessages(conversationId, [
          { role: "assistant", content: response.content },
        ]);
        // ★ トリミングしない（永続保存）
        logger.info(`エージェント完了: ${iterations}反復, ${response.usage?.totalTokens || "?"}トークン`);
        return { response: response.content, iterations, toolLogs };
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls || [],
      };
      messages.push(assistantMsg);

      if (!response.tool_calls || response.tool_calls.length === 0) {
        saveMessages(conversationId, [assistantMsg]);
        logger.warn("空応答で終了");
        return { response: response.content || "（応答なし）", iterations, toolLogs };
      }

      for (const tc of response.tool_calls) {
        const toolName = tc.function.name;
        const args = JSON.parse(tc.function.arguments || "{}");
        args._conversation_id = conversationId;
        args._platform = platform;
        args._chat_id = chatId;

        const startTime = Date.now();
        const result = await toolRegistry.execute(toolName, args);
        const duration = Date.now() - startTime;
        const success = !result.startsWith("[エラー]");

        const entry: ToolLogEntry = {
          tool_name: toolName,
          args,
          result,
          duration_ms: duration,
          success,
          error: success ? undefined : result,
        };
        toolLogs.push(entry);
        logToolCall(conversationId, entry);

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }

      const newMessages: Message[] = [
        assistantMsg,
        ...response.tool_calls.map((tc, i) => ({
          role: "tool" as const,
          content: toolLogs[toolLogs.length - response.tool_calls!.length + i]!.result,
          tool_call_id: tc.id,
        })),
      ];
      saveMessages(conversationId, newMessages);

    } catch (e: any) {
      const errorMsg = `[致命的エラー] ${e.message || String(e)}`;
      logger.error(errorMsg);
      return { response: errorMsg, iterations, toolLogs };
    }
  }

  logger.warn(`最大反復回数到達: ${iterations}/${runtimeConfig.maxIterations}`);
  return {
    response: `最大反復回数（${runtimeConfig.maxIterations}回）に達したため処理を中断しました。\n/maxiter で上限を変更できます。`,
    iterations,
    toolLogs,
  };
}
