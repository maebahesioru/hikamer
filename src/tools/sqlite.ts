// ==========================================
// Hikamer - SQLiteクエリツール (読み取り専用)
// ==========================================

import { db } from "../db";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";

const sqliteTool: ToolDescriptor = {
  emoji: "🗄️",
  owner: "core",
  name: "sqlite",
  description: "HikamerのSQLiteデータベースを読み取り専用でクエリします。テーブル: conversations, messages, tool_logs, cron_jobs, config。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SELECTクエリのみ実行可能",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = (args.query as string).trim();
    if (!query) return "[エラー] クエリが空です。";

    const upper = query.toUpperCase();
    if (!upper.startsWith("SELECT") && !upper.startsWith("PRAGMA") && !upper.startsWith("EXPLAIN")) {
      return "[エラー] 読み取り専用です。SELECTクエリのみ実行可能。";
    }

    try {
      const rows = db.prepare(query).all();
      if (rows.length === 0) return "(0件)";
      const limit = rows.slice(0, 50);
      const cols = Object.keys(limit[0]);
      const header = cols.join(" | ");
      const sep = cols.map(() => "---").join(" | ");
      const body = limit.map((r: any) => cols.map(c => String(r[c] ?? "NULL")).join(" | ")).join("\n");
      const suffix = rows.length > 50 ? `\n…（残り ${rows.length - 50} 件）` : "";
      return `${rows.length}件\n${header}\n${sep}\n${body}${suffix}`;
    } catch (e: any) {
      return `[SQLエラー] ${e.message}`;
    }
  },
};

toolRegistry.register(sqliteTool);
export { sqliteTool };
