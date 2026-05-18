// ==========================================
// Aikata - サブエージェント委任ツール
// 子エージェントを起動→タスク実行→結果返却
// 単一 + 並列の両方に対応（OpenHuman由来）
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { agentLoop } from "../agent";
import { createActiveProvider } from "../providers/base";
import { buildSystemPrompt } from "../system-prompt";
import { logger } from "../utils/logger";

const MAX_SUBAGENT_ITERATIONS = 30;
const SUBAGENT_TIMEOUT_MS = 300_000; // 5分

// ==================== 単一委任 ====================

const delegateTool: ToolDescriptor = {
  name: "delegate_task",
  emoji: "👾",
  owner: "core",
  description: "サブエージェントにタスクを委任します。複雑な調査・コード生成・ファイル操作などを独立して実行させたい時に使用。結果はテキストで返ります。",
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

    return runSubagent(goal, context);
  },
};

// ==================== 並列委任（OpenHuman spawn_parallel_agents由来） ====================

const parallelTool: ToolDescriptor = {
  name: "spawn_parallel_agents",
  emoji: "👥",
  owner: "core",
  description: "複数のサブエージェントを並列起動してタスクを同時実行します。2つ以上のタスクを同時に処理したい場合に使用。各タスクは独立して動作し、結果はまとめて返ります。",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "実行するタスクのリスト（2〜5個推奨）",
        items: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description: "このサブエージェントに依頼する具体的なタスク内容",
            },
            context: {
              type: "string",
              description: "このサブエージェントに渡す追加コンテキスト",
            },
          },
          required: ["goal"],
        },
      },
    },
    required: ["tasks"],
  },
  async execute(args) {
    const tasks = args.tasks as Array<{ goal: string; context?: string }> | undefined;
    if (!tasks || !Array.isArray(tasks) || tasks.length < 2) {
      return "[エラー] tasks は2つ以上のタスクを含む配列が必要です";
    }

    const maxTasks = 5;
    const limited = tasks.slice(0, maxTasks);
    if (tasks.length > maxTasks) {
      logger.warn(`並列タスク数制限: ${tasks.length}→${maxTasks}`);
    }

    logger.info(`並列サブエージェント開始: ${limited.length}タスク`);

    const startTime = Date.now();
    const promises = limited.map((task, idx) => {
      const goal = task.goal?.trim();
      const context = task.context?.trim() || "";
      if (!goal) return Promise.resolve(`[タスク${idx + 1}] エラー: goal が必要です`);

      return runSubagentSafe(goal, context, idx + 1);
    });

    const results = await Promise.allSettled(promises);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const lines = results.map((r, i) => {
      const tag = `**タスク${i + 1}**`;
      if (r.status === "fulfilled") {
        return `### ${tag}\n${r.value.slice(0, 3000)}`;
      } else {
        return `### ${tag}\n[エラー] ${r.reason?.message || "不明なエラー"}`;
      }
    });

    const summary = `## 並列実行結果 (${elapsed}s)\n\n${lines.join("\n\n")}`;
    logger.info(`並列サブエージェント完了: ${elapsed}s (${limited.length}タスク)`);

    return summary;
  },
};

// ==================== 内部 ====================

async function runSubagent(goal: string, context: string): Promise<string> {
  logger.info(`サブエージェント開始: "${goal.slice(0, 60)}…"`);

  const startTime = Date.now();
  let aborted = false;

  try {
    const timeout = setTimeout(() => { aborted = true; }, SUBAGENT_TIMEOUT_MS);

    const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const message = context
      ? `【タスク】\n${goal}\n\n【コンテキスト】\n${context}\n\n上記のタスクを実行し、結果を簡潔にまとめて報告してください。`
      : `以下のタスクを実行し、結果を簡潔にまとめて報告してください：\n\n${goal}`;

    const provider = createActiveProvider();
    const result = await agentLoop(
      provider,
      await buildSystemPrompt(),
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
}

/** エラーを飲み込む安全版 */
async function runSubagentSafe(goal: string, context: string, idx: number): Promise<string> {
  try {
    const result = await runSubagent(goal, context);
    return result;
  } catch (e: any) {
    return `[エラー] タスク${idx}: ${e.message}`;
  }
}

// ==================== 登録 ====================

toolRegistry.register(delegateTool);
toolRegistry.register(parallelTool);

export { delegateTool, parallelTool };
