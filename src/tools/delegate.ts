// ==========================================
// Aikata - サブエージェント委任ツール
// 子エージェントを起動→タスク実行→結果返却
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { agentLoop } from "../agent";
import { createActiveProvider } from "../providers/base";
import { buildSystemPrompt } from "../system-prompt";
import { logger } from "../utils/logger";

const MAX_SUBAGENT_ITERATIONS = 30;
const SUBAGENT_TIMEOUT_MS = 300_000; // 5分

const delegateTool: ToolDescriptor = {
  name: "delegate_task",
  emoji: "👾",
  owner: "core",
  description: "サブエージェントにタスクを委任します。複雑な調査・コード生成・ファイル操作などを並行または独立して実行させたい時に使用。結果はテキストで返ります。",
  parameters: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "サブエージェントに依頼する具体的なタスク内容",
      },
      context: {
        type: "string",
        description: "サブエージェントに渡す追加コンテキスト（ファイルパス、API情報、制約等）",
      },
    },
    required: ["goal"],
  },
  async execute(args) {
    const goal = String(args.goal || "").trim();
    const context = String(args.context || "").trim();
    if (!goal) return "[エラー] goal が必要です";

    logger.info(`サブエージェント開始: "${goal.slice(0, 60)}…"`);

    const startTime = Date.now();
    let aborted = false;

    try {
      // タイムアウト設定
      const timeout = setTimeout(() => {
        aborted = true;
      }, SUBAGENT_TIMEOUT_MS);

      // 独立した会話ID
      const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // メッセージ生成：goal + context
      const message = context
        ? `【タスク】\n${goal}\n\n【コンテキスト】\n${context}\n\n上記のタスクを実行し、結果を簡潔にまとめて報告してください。`
        : `以下のタスクを実行し、結果を簡潔にまとめて報告してください：\n\n${goal}`;

      // 子エージェント実行
      const provider = createActiveProvider();
      const result = await agentLoop(
        provider,
        buildSystemPrompt(),
        message,
        subId,
        "cli",
        { streaming: false },
      );

      clearTimeout(timeout);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`サブエージェント完了: ${elapsed}s (${result.iterations}反復)`);

      if (aborted) {
        return `[エラー] サブエージェントがタイムアウトしました (${SUBAGENT_TIMEOUT_MS / 1000}秒)\n結果の一部:\n${result.response.slice(0, 3000)}`;
      }

      return `【サブエージェント結果】\n${result.response.slice(0, 15000)}`;
    } catch (e: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.error(`サブエージェント失敗: ${e.message}`);
      return `[エラー] サブエージェント失敗 (${elapsed}s): ${e.message}`;
    }
  },
};

toolRegistry.register(delegateTool);
export { delegateTool };
