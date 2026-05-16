// ==========================================
// Aikata - スケジュールツール
// ==========================================

import { randomUUID } from "crypto";
import {
  createCronJob,
  deleteCronJob,
  listCronJobs,
  toggleCronJob,
} from "../repo";
import type { Tool } from "../types";
import * as cron from "node-cron";

export const scheduleTool: Tool = {
  name: "schedule",
  description:
    "定期実行タスクを管理します。指定したcron式で定期的にプロンプトを実行します。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "delete", "list", "toggle"],
        description:
          "create=作成, delete=削除, list=一覧, toggle=有効/無効切替",
      },
      cron_expr: {
        type: "string",
        description:
          "cron式（action=create時必須）。例: '0 9 * * *' (毎日9時), '*/30 * * * *' (30分毎)",
      },
      prompt: {
        type: "string",
        description: "実行するプロンプト（action=create時必須）",
      },
      label: {
        type: "string",
        description: "タスクのラベル名（省略可）",
      },
      job_id: {
        type: "string",
        description: "ジョブID（action=delete/toggle時必須）",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;
    const convId = (args._conversation_id as string) || "cli";
    const platform = (args._platform as string) || "cli";
    const chatId = (args._chat_id as string) || "cli";

    switch (action) {
      case "create": {
        const cronExpr = args.cron_expr as string;
        const prompt = args.prompt as string;
        const label = args.label as string | undefined;

        if (!cronExpr || !prompt) {
          return "[エラー] cron_expr と prompt は必須です。";
        }

        if (!cron.validate(cronExpr)) {
          return `[エラー] 無効なcron式です: "${cronExpr}"\n形式例: "0 9 * * *" (毎日9時), "*/30 * * * *" (30分毎)\nフィールド: 分 時 日 月 曜日`;
        }

        const id = `cron-${randomUUID().slice(0, 8)}`;
        createCronJob({
          id,
          conversation_id: convId,
          platform,
          chat_id: chatId,
          cron_expr: cronExpr,
          prompt,
          label,
        });

        return `✅ スケジュール登録完了\nID: ${id}\nCRON: ${cronExpr}\nプロンプト: "${prompt}"\nラベル: ${label || "(なし)"}\n※ 最大1分以内に反映されます。`;
      }

      case "delete": {
        const jobId = args.job_id as string;
        if (!jobId) return "[エラー] job_id は必須です。";
        const deleted = deleteCronJob(jobId);
        return deleted
          ? `✅ スケジュール削除: ${jobId}`
          : `[エラー] ジョブが見つかりません: ${jobId}`;
      }

      case "list": {
        const jobs = listCronJobs(convId);
        if (jobs.length === 0) return "スケジュールされたタスクはありません。";
        const lines = jobs.map((j) =>
          [
            `[${j.id}] ${j.label || "(ラベルなし)"}`,
            `  CRON: ${j.cron_expr}`,
            `  プロンプト: ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? "…" : ""}`,
            `  状態: ${j.enabled ? "✅有効" : "❌無効"}`,
            `  最終実行: ${j.last_run || "未実行"}`,
          ].join("\n")
        );
        return `📋 スケジュール一覧 (${jobs.length}件):\n\n${lines.join("\n\n")}`;
      }

      case "toggle": {
        const jobId = args.job_id as string;
        if (!jobId) return "[エラー] job_id は必須です。";
        const jobs = listCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) return `[エラー] ジョブが見つかりません: ${jobId}`;
        const newState = !job.enabled;
        toggleCronJob(jobId, newState);
        return `✅ スケジュール ${jobId} を${newState ? "有効" : "無効"}にしました。`;
      }

      default:
        return `[エラー] 不明なアクション: ${action}`;
    }
  },
};
