// ==========================================
// Hikamer - タスク管理・Todoシステム（OpenHuman + Hermes Agent由来）
// SQLiteベースのタスクボード + Todo
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { db } from "../db";
import { logger } from "../utils/logger";

// ==================== DB初期化 ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','blocked','done','archived')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    notes TEXT,
    conversation_id TEXT,
    assignee TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    completed_at TEXT
  );
`);

// ==================== ステータス正規化 ====================

function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().replace(/[\s_-]/g, "");
  if (s === "todo" || s === "pending" || s === "backlog") return "todo";
  if (s === "inprogress" || s === "started" || s === "working" || s === "doing") return "in_progress";
  if (s === "blocked" || s === "stuck") return "blocked";
  if (s === "done" || s === "complete" || s === "finished") return "done";
  if (s === "archived" || s === "archive") return "archived";
  return "todo";
}

// ==================== ツール: todo ====================

const todoTool: ToolDescriptor = {
  name: "todo",
  emoji: "📋",
  owner: "core",
  description: "タスクを管理します。タスクの追加/一覧/完了/削除。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "done", "delete", "update"],
        description: "add=追加, list=一覧, done=完了, delete=削除, update=更新",
      },
      title: {
        type: "string",
        description: "action=add時のタスクタイトル",
      },
      id: {
        type: "string",
        description: "action=done/delete/update時のタスクID",
      },
      status: {
        type: "string",
        description: "action=update時の新しいステータス (todo/in_progress/blocked/done/archived)",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high", "urgent"],
        description: "タスク優先度 (add/update時)",
      },
      notes: {
        type: "string",
        description: "タスクのメモ/詳細",
      },
      filter: {
        type: "string",
        description: "list時のフィルタ (todo/in_progress/done/all、デフォルト=all)",
        default: "all",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;

    switch (action) {
      case "add": {
        const title = (args.title as string || "").trim();
        if (!title) return "[エラー] title が必要です";

        const id = `task-${Date.now().toString(36)}`;
        const priority = (args.priority as string) || "medium";
        const notes = (args.notes as string || "").trim();

        db.prepare(`
          INSERT INTO tasks (id, title, status, priority, notes, conversation_id)
          VALUES (?, ?, 'todo', ?, ?, ?)
        `).run(id, title, priority, notes, String(args._conversation_id || ""));

        logger.info(`タスク追加: ${id} "${title}"`);
        return `📋 タスク追加: **${title}**\nID: \`${id}\`\n優先度: ${priority}`;
      }

      case "list": {
        const filter = (args.filter as string) || "all";
        let rows: any[];

        if (filter === "all") {
          rows = db.prepare("SELECT * FROM tasks WHERE status != 'archived' ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC").all();
        } else {
          const st = normalizeStatus(filter);
          rows = db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(st);
        }

        if (rows.length === 0) {
          return `📋 タスクはありません。\n\`todo action=add title="..."\` で追加できます。`;
        }

        const statusIcons: Record<string, string> = {
          todo: "○", in_progress: "◉", blocked: "⊗", done: "✓", archived: "◌",
        };
        const priorityLabels: Record<string, string> = {
          urgent: "🔴", high: "🟠", medium: "🟢", low: "⚪",
        };

        const lines = rows.map((r: any) => {
          const icon = statusIcons[r.status] || "○";
          const prio = priorityLabels[r.priority] || "🟢";
          return `${icon} ${prio} **${r.title}** \`${r.id.slice(0, 16)}...\` [${r.status}]` +
            (r.priority !== "medium" ? ` (${r.priority})` : "") +
            (r.notes ? ` — ${r.notes.slice(0, 60)}` : "");
        });

        return `📋 **タスク一覧** (${rows.length}件)\n\n${lines.join("\n")}`;
      }

      case "done": {
        const id = args.id as string;
        if (!id) return "[エラー] id が必要です";
        const result = db.prepare("UPDATE tasks SET status='done', completed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?").run(id);
        if (result.changes === 0) return `📋 タスク \`${id}\` は見つかりません。`;
        return `📋 タスク \`${id}\` を完了しました ✅`;
      }

      case "delete": {
        const id = args.id as string;
        if (!id) return "[エラー] id が必要です";
        db.prepare("UPDATE tasks SET status='archived', updated_at=datetime('now','localtime') WHERE id=?").run(id);
        return `📋 タスク \`${id}\` をアーカイブしました。`;
      }

      case "update": {
        const id = args.id as string;
        if (!id) return "[エラー] id が必要です";

        const updates: string[] = ["updated_at=datetime('now','localtime')"];
        const params: any[] = [];

        if (args.status) {
          const st = normalizeStatus(args.status as string);
          updates.push("status=?");
          params.push(st);
          if (st === "done") updates.push("completed_at=datetime('now','localtime')");
        }
        if (args.priority) {
          updates.push("priority=?");
          params.push(args.priority);
        }
        if (args.notes !== undefined) {
          updates.push("notes=?");
          params.push(args.notes);
        }
        if (args.title) {
          updates.push("title=?");
          params.push(args.title);
        }

        if (updates.length <= 1) return "[エラー] 更新するフィールドを指定してください";

        params.push(id);
        db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id=?`).run(...params);

        return `📋 タスク \`${id}\` を更新しました。`;
      }

      default:
        return `[エラー] 不明なアクション: ${action}`;
    }
  },
};

toolRegistry.register(todoTool);
export { todoTool };
