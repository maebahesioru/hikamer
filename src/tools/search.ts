// ==========================================
// Aikata - FTS5全文検索ツール（Hermes Agent由来）
// 会話履歴をFTS5で高速検索
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { db } from "../db";
import { logger } from "../utils/logger";

// ==================== FTS5セットアップ ====================

/** FTS5テーブルが存在するか確認し、なければ作成 */
export function ensureFts5Table(): void {
  const hasMessages = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get();
  if (!hasMessages) return;

  // 古い外部コンテンツモードのテーブルがあれば再作成
  db.exec(`DROP TABLE IF EXISTS messages_fts`);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, tool_name, tool_calls,
      tokenize='unicode61'
    );
  `);

  const hasTriggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='messages_ftsi'"
  ).get();

  if (!hasTriggers) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ftsi AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
        VALUES (new.id, new.content, new.role, COALESCE(new.tool_calls, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ftsd AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
        VALUES ('delete', old.id, old.content, old.role, COALESCE(old.tool_calls, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ftsu AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
        VALUES ('delete', old.id, old.content, old.role, COALESCE(old.tool_calls, ''));
        INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
        VALUES (new.id, new.content, new.role, COALESCE(new.tool_calls, ''));
      END;
    `);
    logger.info("FTS5トリガー作成完了");
  }
}

// ==================== バックフィル ====================

/** 既存メッセージをFTS5にバックフィル */
export function backfillFts5(): number {
  ensureFts5Table();
  const count = db.prepare(`
    INSERT OR IGNORE INTO messages_fts(rowid, content, tool_name, tool_calls)
    SELECT id, content, role, COALESCE(tool_calls, '') FROM messages
    WHERE id NOT IN (SELECT rowid FROM messages_fts)
  `).run().changes;
  if (count > 0) logger.info(`FTS5バックフィル: ${count}件`);
  return count;
}

// ==================== CJK検出 ====================

function isCjkCodepoint(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0x3040 && cp <= 0x309F) ||
    (cp >= 0x30A0 && cp <= 0x30FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x2E80 && cp <= 0x2EFF) ||
    (cp >= 0x3000 && cp <= 0x303F);
}

function countCjk(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (isCjkCodepoint(ch.codePointAt(0) || 0)) count++;
  }
  return count;
}

// ==================== 検索 ====================

export interface SearchResult {
  conversationId: string;
  role: string;
  content: string;
  snippet: string;
  createdAt: string;
}

/**
 * 会話履歴をFTS5で検索
 * CJK（3文字以上）の場合はLIKEフォールバック
 */
export function searchConversations(
  query: string,
  limit = 20,
  offset = 0,
): SearchResult[] {
  try {
    ensureFts5Table();
    backfillFts5();

    if (!query.trim()) return [];

    const hasCjk = countCjk(query) >= 3;

    if (hasCjk) {
      const pattern = `%${query}%`;
      return db.prepare(`
        SELECT m.conversation_id as conversationId, m.role, m.content,
               substr(m.content, 1, 200) as snippet, m.created_at as createdAt
        FROM messages m
        WHERE m.content LIKE ?
        ORDER BY m.id DESC
        LIMIT ? OFFSET ?
      `).all(pattern, limit, offset) as SearchResult[];
    }

    return db.prepare(`
      SELECT m.conversation_id as conversationId, m.role, m.content,
             snippet(messages_fts, 0, '【', '】', '…', 40) as snippet,
             m.created_at as createdAt
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(query, limit, offset) as SearchResult[];
  } catch (e: any) {
    logger.warn(`FTS5検索エラー: ${e.message}`);
    return [];
  }
}

// ==================== ツール登録 ====================

const searchTool: ToolDescriptor = {
  name: "search_conversations",
  emoji: "🔍",
  owner: "core",
  description: "過去の会話履歴を全文検索します。会話ID、発言ロール、内容の断片を返します。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ（日本語可）。例: '設定方法' 'API key'",
      },
      limit: {
        type: "number",
        description: "最大結果件数（1〜50、デフォルト10）",
        default: 10,
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query || "").trim();
    const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);

    if (!query) return "[エラー] 検索クエリを入力してください";

    const results = searchConversations(query, limit);

    if (results.length === 0) {
      return `🔍 「${query}」に一致する会話は見つかりませんでした。`;
    }

    const lines = results.map((r, i) =>
      `**${i + 1}.** ${r.conversationId.slice(0, 16)}... | ${r.role} | ${(r.snippet || r.content).slice(0, 200)}`
    );

    return `🔍 **「${query}」の検索結果** (${results.length}件)\n\n${lines.join("\n")}`;
  },
};

toolRegistry.register(searchTool);
export { searchTool };

// 起動時にFTS5初期化
ensureFts5Table();
backfillFts5();
