// ==========================================
// Hikamer - SQLite データベース初期化
// ==========================================

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

const dataDir = process.env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });

const dbPath = resolve(dataDir, "hikamer.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    thread_id TEXT,
    platform TEXT DEFAULT 'discord',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_call_id TEXT,
    tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS tool_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args TEXT NOT NULL,
    result TEXT,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_tool_logs_conv
    ON tool_logs(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('discord', 'telegram', 'cli')),
    chat_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    prompt TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    last_run TEXT,
    next_run TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled
    ON cron_jobs(enabled, next_run);

  -- FTS5全文検索（会話メッセージ検索用）
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    conversation_id UNINDEXED,
    role UNINDEXED,
    content='messages',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, conversation_id, role)
    VALUES (new.id, new.content, new.conversation_id, new.role);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role)
    VALUES ('delete', old.id, old.content, old.conversation_id, old.role);
  END;

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

logger.info(`SQLite: ${dbPath}`);

export { db };
