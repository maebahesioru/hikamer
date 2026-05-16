// ==========================================
// Aikata - DBリポジトリ (トリミング削除)
// ==========================================

import { db } from "./db";
import type { Message, MessageRow, ToolLogEntry } from "./types";
import { logger } from "./utils/logger";

export function ensureConversation(id: string, title?: string, threadId?: string, platform?: string) {
  const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(id) as any;
  if (!existing) {
    db.prepare(`
      INSERT INTO conversations (id, title, thread_id, platform) VALUES (?, ?, ?, ?)
    `).run(id, title || id, threadId || null, platform || "discord");
    logger.debug(`新規会話: ${id}`);
  } else {
    const updates: string[] = [];
    const params: any[] = [];
    if (title) { updates.push("title = ?"); params.push(title); }
    if (threadId) { updates.push("thread_id = ?"); params.push(threadId); }
    updates.push("updated_at = datetime('now', 'localtime')");
    params.push(id);
    db.prepare(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }
}

export function updateConversationTitle(id: string, title: string): void {
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(title, id);
}

export function getConversationThreadId(id: string): string | null {
  const row = db.prepare("SELECT thread_id FROM conversations WHERE id = ?").get(id) as any;
  return row?.thread_id || null;
}

export function getHistory(conversationId: string, limit = 99999): Message[] {
  const rows = db.prepare(`
    SELECT role, content, tool_calls, tool_call_id
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(conversationId, limit) as MessageRow[];

  return rows.reverse().map(row => toMessage(row));
}

export function saveMessage(conversationId: string, msg: Message): number {
  const result = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    conversationId,
    msg.role,
    msg.content,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null
  );
  return Number(result.lastInsertRowid);
}

export function saveMessages(conversationId: string, msgs: Message[]): void {
  const insert = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const msg of msgs) {
      insert.run(
        conversationId,
        msg.role,
        msg.content,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id || null
      );
    }
  });
  tx();
}

export function logToolCall(conversationId: string, entry: ToolLogEntry): void {
  db.prepare(`
    INSERT INTO tool_logs (conversation_id, tool_name, args, result, duration_ms, success, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    entry.tool_name,
    JSON.stringify(entry.args),
    entry.result,
    entry.duration_ms,
    entry.success ? 1 : 0,
    entry.error || null
  );
}

export function resetConversation(conversationId: string): void {
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  db.prepare("DELETE FROM tool_logs WHERE conversation_id = ?").run(conversationId);
  logger.info(`会話リセット: ${conversationId}`);
}

// ==================== Cron ====================

export interface CronJobRow {
  id: string;
  conversation_id: string;
  platform: string;
  chat_id: string;
  cron_expr: string;
  prompt: string;
  label: string | null;
  enabled: number;
  created_at: string;
  last_run: string | null;
  next_run: string | null;
}

export function createCronJob(job: {
  id: string; conversation_id: string; platform: string;
  chat_id: string; cron_expr: string; prompt: string; label?: string;
}): void {
  db.prepare(`
    INSERT INTO cron_jobs (id, conversation_id, platform, chat_id, cron_expr, prompt, label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(job.id, job.conversation_id, job.platform, job.chat_id, job.cron_expr, job.prompt, job.label || null);
}

export function deleteCronJob(id: string): boolean {
  return db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id).changes > 0;
}

export function listCronJobs(conversationId?: string): CronJobRow[] {
  if (conversationId) {
    return db.prepare("SELECT * FROM cron_jobs WHERE conversation_id = ? ORDER BY created_at DESC").all(conversationId) as CronJobRow[];
  }
  return db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() as CronJobRow[];
}

export function getEnabledCronJobs(): CronJobRow[] {
  return db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run ASC").all() as CronJobRow[];
}

export function updateCronJobLastRun(id: string): void {
  db.prepare("UPDATE cron_jobs SET last_run = datetime('now', 'localtime') WHERE id = ?").run(id);
}

export function toggleCronJob(id: string, enabled: boolean): boolean {
  return db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
}

// ==================== Config ====================

export function getDbConfig(key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as any;
  return row?.value || null;
}

export function setDbConfig(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))").run(key, value);
}

// ==================== 内部 ====================

function toMessage(row: MessageRow): Message {
  return {
    role: row.role as Message["role"],
    content: row.content,
    ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
    ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
  };
}
