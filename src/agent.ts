// ==========================================
// Hikamer - エージェントループ v1.2 (streaming + reasoning)
// ==========================================

import type { AgentResult, LLMProvider, LLMChunk, Message, ToolLogEntry } from "./types";
import { toolRegistry } from "./tools/registry";
import { getRuntimeConfig } from "./utils/config";
import { logger } from "./utils/logger";
import {
  ensureConversation,
  getHistory,
  saveMessages,
  logToolCall,
} from "./repo";
import { goalSystem, extractGoalContext } from "./goal-system";
import { contextMonitor } from "./context-monitor";
import { telemetry } from "./telemetry";

export interface AgentOptions {
  /** ストリーミング有効（デフォルトtrue） */
  streaming?: boolean;
  /** 割り込み制御（AbortSignalで強制停止） */
  signal?: AbortSignal;
  /** ストリーミングコールバック */
  onChunk?: (chunk: LLMChunk, accumulated: { reasoning: string; content: string }) => void;
  /** ツール実行開始コールバック */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  /** ツール実行完了コールバック */
  onToolEnd?: (toolName: string, result: string, durationMs: number) => void;
}

export async function agentLoop(
  provider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
  conversationId: string,
  platformHint?: string,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const runtimeConfig = getRuntimeConfig();
  const toolLogs: ToolLogEntry[] = [];
  let iterations = 0;
  let allReasoning = "";
  let partialContent = "";
  const { streaming = true, onChunk, onToolStart, onToolEnd, signal } = options;

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

  // v1.40: プロンプトエンジン統合（prompt-master由来）
  let enhancedSystemPrompt = systemPrompt;
  try {
    const { extractIntent, diagnosePrompt, formatDiagnosis, buildPrompt } = await import("./prompt-engine");
    const intent = extractIntent(userMessage, provider.model);
    
    // 品質診断（重要度高いものだけログ）
    const issues = diagnosePrompt(userMessage, { model: provider.model });
    const criticalIssues = issues.filter(i => i.severity === "high");
    if (criticalIssues.length > 0) {
      logger.info(`[PromptEngine] ${criticalIssues.length}件の改善点を検出`);
    }

    // エージェント的タスクの場合はReActテンプレートをシステムプロンプトに追加
    if (intent.isAgentic) {
      enhancedSystemPrompt += `\n\n## エージェントモード\nこのタスクは自律エージェント動作が必要です。\n- 目標達成まで段階的に進める\n- 停止条件: 目標達成または致命的エラー\n- 各ステップ: Thought → Action → Observation → ...`;
    }
    // 推論が必要な場合はCoT促進
    if (intent.needsReasoning && !intent.isReasoningModel) {
      enhancedSystemPrompt += `\n\n## 思考モード\nこのタスクは段階的な推論が必要です。\n問題を分解し、各ステップを明示的に考えてから回答してください。`;
    }
  } catch (e) {
    // prompt-engineが利用不可でも従来通り動作
    logger.debug(`[PromptEngine] 統合スキップ: ${e}`);
  }

  // 全履歴を復元
  const pastHistory = getHistory(conversationId, 99999);

  const messages: Message[] = [
    { role: "system", content: enhancedSystemPrompt },
    ...pastHistory,
    { role: "user", content: userMessage },
  ];

  // Goal System: アクティブなゴールがある場合、システムプロンプトにガイダンスを注入
  if (goalSystem.isActive) {
    const status = goalSystem.getStatus();
    const goalGuidance = [
      `\n## ⚠️ アクティブゴール`,
      `以下の完了条件を達成するまで作業を継続してください：`,
      `「${status.condition}」`,
      `進捗: ${status.turnCount}/${status.maxTurns} ターン目`,
    ];
    if (status.lastEvaluation?.reason) {
      goalGuidance.push(`前回の評価: ${status.lastEvaluation.reason}`);
    }
    messages[0]!.content += goalGuidance.join("\n");
  }

  saveMessages(conversationId, [{ role: "user", content: userMessage }]);

  logger.info(`エージェント開始: ${conversationId} "${userMessage.slice(0, 50)}…"`);

  while (iterations < runtimeConfig.maxIterations) {
    iterations++;
    logger.iteration(iterations);

    // 割り込みチェック
    if (signal?.aborted) {
      logger.warn(`割り込み検出: ${iterations}反復目で中断`);
      return {
        response: "処理を中断しました（ユーザーによる割り込み）。",
        iterations,
        toolLogs,
        reasoning: allReasoning || undefined,
      };
    }

    // Grace Call: 最終反復なら「これが最後」メッセージを注入
    if (iterations === runtimeConfig.maxIterations) {
      const graceMsg = "[システム] これが最後の応答チャンスです。ツールは呼ばずに、テキストだけで直接回答してください。";
      messages.push({ role: "user", content: graceMsg });
    }

    const tools = toolRegistry.getOpenAISchema();

    try {
      // ストリーミング有効ならストリーミング（ツールありでもOK）
      const useStream = streaming && !!provider.chatStream;
      
      let response: { content: string | null; tool_calls: any[] | null; finishReason: string; reasoning_content?: string };

      if (useStream) {
        // ストリーミングモード — ツール呼び出しはチャンク間で蓄積マージが必要
        let contentAcc = "";
        let reasoningAcc = "";
        let finishReason = "stop";
        let streamToolCalls: Map<number, any> = new Map(); // index → merged tool_call

        for await (const chunk of provider.chatStream!(messages, tools)) {
          contentAcc += chunk.content_delta;
          reasoningAcc += chunk.reasoning_delta;
          partialContent = contentAcc;
          if (chunk.finishReason) finishReason = chunk.finishReason;

          // ツール呼び出しをチャンク間で蓄積マージ
          if (chunk.tool_calls) {
            for (const tc of chunk.tool_calls) {
              const idx = (tc as any).index ?? 0;
              const existing = streamToolCalls.get(idx);
              if (existing) {
                // arguments を追記
                if (tc.function?.arguments) {
                  existing.function.arguments += tc.function.arguments;
                }
                // id / name は最初のチャンクで設定済みなので上書き不要
              } else {
                // 新規ツール呼び出し
                streamToolCalls.set(idx, {
                  id: tc.id || "",
                  type: "function",
                  function: {
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                  },
                });
              }
            }
          }

          if (onChunk) {
            onChunk(chunk, { reasoning: reasoningAcc, content: contentAcc });
          }
        }

        allReasoning += reasoningAcc;
        const mergedToolCalls = Array.from(streamToolCalls.values());
        response = {
          content: contentAcc || null,
          tool_calls: mergedToolCalls.length > 0 ? mergedToolCalls : null,
          finishReason,
          reasoning_content: reasoningAcc,
        };
      } else {
        // 通常モード
        const llmResponse = await provider.chat(messages, tools);

        if (llmResponse.reasoning_content) {
          allReasoning += llmResponse.reasoning_content;
        }

        response = {
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
          finishReason: llmResponse.finishReason,
          reasoning_content: llmResponse.reasoning_content,
        };
      }

      // テキスト応答のみ → 終了
      if (response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
        saveMessages(conversationId, [
          { role: "assistant", content: response.content, reasoning_content: response.reasoning_content },
        ]);
        logger.info(`エージェント完了: ${iterations}反復`);
        return {
          response: response.content,
          iterations,
          toolLogs,
          reasoning: allReasoning || undefined,
        };
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls || [],
        reasoning_content: response.reasoning_content,
      };
      messages.push(assistantMsg);

      // v1.43: 応答評価（DeepEval由来 LLM-as-a-Judge）
      if (response.content && response.content.length > 50) {
        import("./response-judge").then(({ responseJudge }) => {
          responseJudge.evaluate(response.content!, {
            userMessage,
            systemPrompt,
            toolCalls: response.tool_calls?.map(tc => tc.function.name),
          }).then(result => {
            if (!result.passed && result.overallScore < 0.5) {
              logger.warn(`[Agent] 応答品質低: ${(result.overallScore * 100).toFixed(0)}%`);
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      if (!response.tool_calls || response.tool_calls.length === 0) {
        saveMessages(conversationId, [assistantMsg]);
        logger.warn("空応答で終了");
        return {
          response: response.content || "（応答なし）",
          iterations,
          toolLogs,
          reasoning: allReasoning || undefined,
        };
      }

      for (const tc of response.tool_calls) {
        const toolName = tc.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch (parseErr: any) {
          logger.warn(`⚠️ ツール引数JSONパース失敗 (${toolName}): ${parseErr.message} → raw="${(tc.function.arguments || "").slice(0, 200)}"`);
          args = {};
        }
        args._conversation_id = conversationId;
        args._platform = platform;
        args._chat_id = chatId;

        const startTime = Date.now();
        onToolStart?.(toolName, args);
        const result = await toolRegistry.execute(toolName, args);
        const duration = Date.now() - startTime;
        onToolEnd?.(toolName, result, duration);
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

      // v1.63: Context Monitor — GSDパターン
      const ctxWarning = contextMonitor.afterToolCall(iterations, runtimeConfig.maxIterations);
      if (ctxWarning) {
        messages.push({ role: "user", content: ctxWarning });
        // クリティカルなら強制終了
        if (contextMonitor["currentLevel"] === "critical") {
          logger.warn("[Agent] コンテキスト枯渇のため強制終了");
          return {
            response: `⚠️ コンテキストが枯渇しました（${iterations}反復）。\\n最終結果: ${partialContent || response.content || "(応答なし)"}`,
            iterations,
            toolLogs,
            reasoning: allReasoning || undefined,
          };
        }
      }

      // v1.74: テレメトリー記録
      try {
        const turnSuccess = !toolLogs.some(t => !t.success);
        telemetry.recordTurn({
          turnNumber: iterations,
          sessionId: conversationId,
          startTime: Date.now() - toolLogs.reduce((s, t) => s + t.duration_ms, 0),
          endTime: Date.now(),
          durationMs: toolLogs.reduce((s, t) => s + t.duration_ms, 0),
          modelUsed: provider.model || "unknown",
          inputTokens: 0,
          outputTokens: (response.content || "").length,
          reasoningTokens: (response.reasoning_content || "").length,
          toolCalls: toolLogs.slice(-response.tool_calls!.length).map(t => ({
            toolName: t.tool_name,
            args: t.args,
            result: t.result.slice(0, 500),
            success: t.success,
            durationMs: t.duration_ms || 0,
            timestamp: Date.now(),
            sessionId: conversationId,
            iteration: iterations,
          })),
          success: turnSuccess,
          error: turnSuccess ? undefined : toolLogs.filter(t => !t.success).map(t => t.error).filter(Boolean).join("; "),
        });
      } catch { /* telemetry failure must not crash agent */ }

      // 割り込みチェック（長時間ツールからの帰還後）
      if (signal?.aborted) {
        logger.warn(`ツール実行後の割り込み: ${iterations}反復`);
        return {
          response: "処理を中断しました（ユーザーによる割り込み）。",
          iterations,
          toolLogs,
          reasoning: allReasoning || undefined,
        };
      }

      // Goal System: 毎ターン後に達成判定
      if (goalSystem.isActive) {
        const goalContext = extractGoalContext(messages, 8000);
        const evaluation = await goalSystem.evaluateGoal(goalContext, 1000);

        if (!goalSystem.isActive) {
          // 達成！ゴールが自動クリアされた
          logger.info(`[Agent] 🎯 ゴール達成: ${evaluation.reason}`);
          return {
            response: `🎯 **ゴール達成！** ${evaluation.reason}\n\n${response.content || ""}`,
            iterations,
            toolLogs,
            reasoning: allReasoning || undefined,
          };
        }
      }

    } catch (e: any) {
      const ctx = iterations > 0
        ? `反復=${iterations}, content=${partialContent.slice(0, 100)}`
        : "初回呼び出し時";
      const errorMsg = `[致命的エラー] ${e.message || String(e)}`;
      logger.error(`💀 ${errorMsg} (${ctx})`);
      if (e.stack) logger.debug(e.stack);
      return {
        response: errorMsg,
        iterations,
        toolLogs,
        reasoning: allReasoning || undefined,
      };
    }
  }

  logger.warn(`最大反復回数到達: ${iterations}/${runtimeConfig.maxIterations}`);
  return {
    response: `最大反復回数（${runtimeConfig.maxIterations}回）に達したため処理を中断しました。\n/maxiter で上限を変更できます。`,
    iterations,
    toolLogs,
    reasoning: allReasoning || undefined,
  };
}
