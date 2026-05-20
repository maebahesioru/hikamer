// ==========================================
// Hikamer - 高度Cron管理ツール（OpenClaw cron-quick-create由来）
// /schedule create, schedule list の強化版
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { createCronJob, listCronJobs, deleteCronJob, toggleCronJob } from "../repo";
import { logger } from "../utils/logger";

// ==================== スケジュールタイプ ====================

const PRESET_SCHEDULES: Record<string, { label: string; cron: string }> = {
  "30min": { label: "30分ごと", cron: "*/30 * * * *" },
  "1hour": { label: "1時間ごと", cron: "0 * * * *" },
  "2hours": { label: "2時間ごと", cron: "0 */2 * * *" },
  "6hours": { label: "6時間ごと", cron: "0 */6 * * *" },
  "daily": { label: "毎日0時", cron: "0 0 * * *" },
  "daily9am": { label: "毎日9時", cron: "0 9 * * *" },
  "daily21pm": { label: "毎日21時", cron: "0 21 * * *" },
  "weekdays": { label: "平日毎朝9時", cron: "0 9 * * 1-5" },
  "weekly": { label: "毎週月曜0時", cron: "0 0 * * 1" },
  "monthly": { label: "毎月1日0時", cron: "0 0 1 * *" },
};

// ==================== ツール: cron_create ====================

const createTool: ToolDescriptor = {
  name: "cron_create",
  emoji: "⏰",
  owner: "core",
  description: "cronジョブを作成します。scheduleプリセットかcron式を指定。",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "定期実行するタスク内容",
      },
      schedule: {
        type: "string",
        description: "スケジュール種別: preset名(30min/1hour/daily/9am-5pm/weekly等) または cron式",
        default: "daily",
      },
      label: {
        type: "string",
        description: "ジョブの識別ラベル（省略時は自動生成）",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = (args.prompt as string || "").trim();
    const schedule = (args.schedule as string || "daily").trim();
    const label = (args.label as string || "").trim() || prompt.slice(0, 60);

    if (!prompt) return "[エラー] prompt が必要です";

    // プリセット解決
    let cronExpr = schedule;
    for (const [key, preset] of Object.entries(PRESET_SCHEDULES)) {
      if (schedule === key || schedule === preset.label) {
        cronExpr = preset.cron;
        break;
      }
    }

    // cron式の簡易バリデーション (5フィールド)
    const cronParts = cronExpr.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      return `[エラー] 無効なcron式またはプリセット: "${schedule}"\n` +
        `利用可能なプリセット: ${Object.keys(PRESET_SCHEDULES).join(", ")}`;
    }

    const id = `cron-${Date.now().toString(36)}`;
    const conversationId = String(args._conversation_id || "global");

    createCronJob({
      id,
      conversation_id: conversationId,
      platform: "discord",
      chat_id: String(args._chat_id || conversationId),
      cron_expr: cronExpr,
      prompt,
      label,
    });

    logger.info(`Cron作成: ${id} "${label}" → "${cronExpr}"`);

    // プリセット名表示
    let scheduleLabel = cronExpr;
    for (const [, preset] of Object.entries(PRESET_SCHEDULES)) {
      if (preset.cron === cronExpr) {
        scheduleLabel = preset.label;
        break;
      }
    }

    return `⏰ **Cron作成完了**\n` +
      `ID: \`${id}\`\n` +
      `ラベル: ${label}\n` +
      `スケジュール: ${scheduleLabel} (\`${cronExpr}\`)\n` +
      `タスク: ${prompt.slice(0, 100)}\n\n` +
      `ジョブ一覧: \`/jobs\`\n` +
      `削除: \`cron_delete id=${id}\``;
  },
};

// ==================== ツール: cron_delete ====================

const deleteTool: ToolDescriptor = {
  name: "cron_delete",
  emoji: "🗑️",
  owner: "core",
  description: "cronジョブを削除します。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "削除するcronジョブのID（/jobsで確認）",
      },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = args.id as string;
    if (!id) return "[エラー] id が必要です";
    const ok = deleteCronJob(id);
    return ok ? `🗑️ Cron \`${id}\` を削除しました。` : `🗑️ Cron \`${id}\` は見つかりません。`;
  },
};

// ==================== ツール: cron_list ====================

const listTool: ToolDescriptor = {
  name: "cron_list",
  emoji: "📋",
  owner: "core",
  description: "登録されているcronジョブ一覧を表示します。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    const jobs = listCronJobs();
    if (jobs.length === 0) {
      return "📋 cronジョブは登録されていません。`cron_create` で追加できます。";
    }

    const lines = jobs.map(j => {
      const nextRun = j.next_run ? ` 次回: ${j.next_run}` : "";
      const lastRun = j.last_run ? ` 最終: ${j.last_run}` : "";
      return `• \`${j.id.slice(0, 16)}...\` [${j.enabled ? "有効" : "無効"}] \`${j.cron_expr}\`` +
        `\n   "${(j.label || j.prompt).slice(0, 60)}"${nextRun}${lastRun}`;
    });

    return `📋 **Cronジョブ一覧** (${jobs.length}件)\n\n${lines.join("\n")}`;
  },
};

toolRegistry.register(createTool);
toolRegistry.register(deleteTool);
toolRegistry.register(listTool);

export { createTool, deleteTool, listTool };
