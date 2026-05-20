// ==========================================
// Hikamer - スレッド管理（OpenHuman threads/ 由来）
// 会話スレッドのCRUD・タイトル生成・ターン状態管理
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import { db } from "./db";

// ==================== 型定義 ====================

export interface Thread {
  id: string;
  title: string;
  chatId: string;
  isActive: boolean;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  parentThreadId: string | null;
  labels: string[];
  metadata?: Record<string, unknown>;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  sender: "user" | "agent" | "system" | "tool";
  content: string;
  messageType: "text" | "tool_call" | "tool_result" | "image" | "system";
  extraMetadata?: Record<string, unknown>;
  createdAt: number;
}

export interface TurnState {
  threadId: string;
  snapshot: string;
  turnStartedAt: number;
  status: "running" | "interrupted" | "completed";
  lastActivityAt: number;
  iterationCount: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  chatId: string;
  isActive: boolean;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  parentThreadId: string | null;
  labels: string[];
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
  count: number;
}

export interface MessagesListResponse {
  messages: ThreadMessage[];
  count: number;
}

export interface TurnStateListResponse {
  turnStates: TurnState[];
  count: number;
}

// ==================== 定数 ====================

const THREAD_TITLE_SYSTEM_PROMPT =
  "Your task is to generate a concise, descriptive title (max 60 chars, in Japanese) for the following conversation. Return ONLY the title text, no quotes, no explanation.";

const THREAD_TITLE_MODEL_HINT = "deepseek/deepseek-v4-flash";

const TITLE_FALLBACK_MAX_LENGTH = 60;

const AUTO_GENERATED_PREFIXES = [
  "Chat ",
  "New Chat",
  "会話 ",
  "新規",
  "Thread ",
];

const MAX_THREADS = 500;
const MAX_MESSAGES_PER_THREAD = 5000;
const TITLE_SANITIZE_MAX_LENGTH = 60;

// ==================== スレッド管理 ====================

class ThreadManager {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        created_at INTEGER NOT NULL,
        parent_thread_id TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK(sender IN ('user','agent','system','tool')),
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text',
        extra_metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id
        ON thread_messages(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS turn_states (
        thread_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        turn_started_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running','interrupted','completed')),
        last_activity_at INTEGER NOT NULL,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
    `);

    this.initialized = true;
    logger.info("[Threads] initialized");
  }

  // ---- スレッドCRUD ----

  listThreads(chatId?: string, labels?: string[]): ThreadListResponse {
    this.ensureInit();
    let sql = "SELECT * FROM threads WHERE 1=1";
    const params: unknown[] = [];

    if (chatId) {
      sql += " AND chat_id = ?";
      params.push(chatId);
    }

    if (labels && labels.length > 0) {
      // JSON配列にラベルが含まれるかフィルタ
      const conditions = labels.map(() => `json_extract(labels, '$') LIKE ?`);
      sql += ` AND (${conditions.join(" OR ")})`;
      labels.forEach((l) => params.push(`%"${l}"%`));
    }

    sql += " ORDER BY last_message_at DESC, created_at DESC LIMIT ?";
    params.push(MAX_THREADS);

    const rows = db.query(sql, ...params) as Record<string, unknown>[];
    const threads = rows.map((r) => this.rowToSummary(r));
    return { threads, count: threads.length };
  }

  ensureThread(
    id: string,
    title: string,
    chatId: string,
    parentThreadId?: string,
    labels?: string[],
    createdAt?: number
  ): ThreadSummary {
    this.ensureInit();
    const now = createdAt ?? Date.now();

    db.run(
      `INSERT OR IGNORE INTO threads (id, title, chat_id, created_at, parent_thread_id, labels)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      title,
      chatId,
      now,
      parentThreadId ?? null,
      JSON.stringify(labels ?? [])
    );

    return this.getThread(id)!;
  }

  createNewThread(
    chatId: string,
    parentThreadId?: string,
    labels?: string[]
  ): ThreadSummary {
    this.ensureInit();
    const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const date = new Date();
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    const title = `Chat ${month} ${day} ${hour12}:${minutes} ${ampm}`;

    db.run(
      `INSERT INTO threads (id, title, chat_id, created_at, parent_thread_id, labels)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      title,
      chatId,
      now,
      parentThreadId ?? null,
      JSON.stringify(labels ?? [])
    );

    eventBus.publish(createEvent("thread:created", { threadId: id, title, chatId }));
    logger.debug(`[Threads] created thread ${id}: ${title}`);
    return this.getThread(id)!;
  }

  getThread(threadId: string): ThreadSummary | null {
    this.ensureInit();
    const row = db.queryOne(
      "SELECT * FROM threads WHERE id = ?",
      threadId
    ) as Record<string, unknown> | null;
    return row ? this.rowToSummary(row) : null;
  }

  updateThreadTitle(threadId: string, title: string): ThreadSummary | null {
    this.ensureInit();
    db.run(
      "UPDATE threads SET title = ?, last_message_at = ? WHERE id = ?",
      title,
      Date.now(),
      threadId
    );
    return this.getThread(threadId);
  }

  updateThreadLabels(
    threadId: string,
    labels: string[]
  ): ThreadSummary | null {
    this.ensureInit();
    db.run(
      "UPDATE threads SET labels = ?, last_message_at = ? WHERE id = ?",
      JSON.stringify(labels),
      Date.now(),
      threadId
    );
    logger.debug(`[Threads] updated labels for ${threadId}:`, labels);
    return this.getThread(threadId);
  }

  deleteThread(threadId: string): boolean {
    this.ensureInit();
    const thread = this.getThread(threadId);
    if (!thread) return false;

    db.run("DELETE FROM turn_states WHERE thread_id = ?", threadId);
    db.run("DELETE FROM thread_messages WHERE thread_id = ?", threadId);
    db.run("DELETE FROM threads WHERE id = ?", threadId);

    eventBus.publish(
      createEvent("thread:deleted", { threadId, chatId: thread.chatId })
    );
    logger.info(`[Threads] deleted thread ${threadId}`);
    return true;
  }

  purgeThreads(): { threadCount: number; messageCount: number } {
    this.ensureInit();
    const stats = db.queryOne(
      "SELECT COUNT(*) as t, (SELECT COUNT(*) FROM thread_messages) as m FROM threads"
    ) as { t: number; m: number };

    db.run("DELETE FROM turn_states");
    db.run("DELETE FROM thread_messages");
    db.run("DELETE FROM threads");

    logger.info(`[Threads] purged ${stats.t} threads, ${stats.m} messages`);
    return { threadCount: stats.t, messageCount: stats.m };
  }

  // ---- メッセージ管理 ----

  appendMessage(
    threadId: string,
    sender: ThreadMessage["sender"],
    content: string,
    messageType?: ThreadMessage["messageType"],
    extraMetadata?: Record<string, unknown>
  ): ThreadMessage | null {
    this.ensureInit();
    const thread = this.getThread(threadId);
    if (!thread) return null;

    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    db.run(
      `INSERT INTO thread_messages (id, thread_id, sender, content, message_type, extra_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      threadId,
      sender,
      content,
      messageType ?? "text",
      extraMetadata ? JSON.stringify(extraMetadata) : null,
      now
    );

    // メッセージ数更新
    const count = db.queryOne(
      "SELECT COUNT(*) as c FROM thread_messages WHERE thread_id = ?",
      threadId
    ) as { c: number };
    db.run(
      "UPDATE threads SET message_count = ?, last_message_at = ?, is_active = 1 WHERE id = ?",
      count.c,
      now,
      threadId
    );

    // メッセージ数上限超過チェック
    if (count.c > MAX_MESSAGES_PER_THREAD) {
      this.trimOldMessages(threadId, MAX_MESSAGES_PER_THREAD);
    }

    eventBus.publish(
      createEvent("thread:message", {
        threadId,
        messageId: id,
        sender,
        messageType,
      })
    );

    return this.getMessage(id);
  }

  getMessage(messageId: string): ThreadMessage | null {
    this.ensureInit();
    const row = db.queryOne(
      "SELECT * FROM thread_messages WHERE id = ?",
      messageId
    ) as Record<string, unknown> | null;
    return row ? this.rowToMessage(row) : null;
  }

  listMessages(threadId: string, limit = 100, offset = 0): MessagesListResponse {
    this.ensureInit();
    const rows = db.query(
      "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
      threadId,
      limit,
      offset
    ) as Record<string, unknown>[];
    const messages = rows.map((r) => this.rowToMessage(r));
    return { messages, count: messages.length };
  }

  updateMessageMetadata(
    threadId: string,
    messageId: string,
    extraMetadata: Record<string, unknown>
  ): ThreadMessage | null {
    this.ensureInit();
    db.run(
      "UPDATE thread_messages SET extra_metadata = ? WHERE thread_id = ? AND id = ?",
      JSON.stringify(extraMetadata),
      threadId,
      messageId
    );
    return this.getMessage(messageId);
  }

  private trimOldMessages(threadId: string, maxCount: number): void {
    const overflow = db.queryOne(
      `SELECT COUNT(*) - ${maxCount} as excess FROM thread_messages WHERE thread_id = ?`,
      threadId
    ) as { excess: number };
    if (overflow.excess <= 0) return;

    // 古い方から削除（各50件ずつ）
    const batchSize = Math.min(overflow.excess + 50, 200);
    db.run(
      `DELETE FROM thread_messages WHERE id IN (
        SELECT id FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?
      )`,
      threadId,
      batchSize
    );
    logger.debug(`[Threads] trimmed ${batchSize} messages from ${threadId}`);
  }

  // ---- タイトル生成 ----

  /**
   * LLMを使ってスレッドタイトルを生成（非同期）
   * 失敗した場合はユーザーメッセージからのフォールバック
   */
  async generateTitle(
    threadId: string,
    assistantMessage?: string
  ): Promise<ThreadSummary | null> {
    const thread = this.getThread(threadId);
    if (!thread) return null;

    // 自動生成タイトルでなければスキップ
    if (!this.isAutoGeneratedTitle(thread.title)) {
      return thread;
    }

    // 最初のユーザーメッセージを探す
    const messages = this.listMessages(threadId, 50, 0);
    const firstUserMsg = messages.messages.find(
      (m) => m.sender === "user" && m.content.trim().length > 0
    );
    if (!firstUserMsg) return thread;

    // アシスタントメッセージを取得
    const assistantMsg =
      assistantMessage ??
      messages.messages.find(
        (m) => m.sender === "agent" && m.content.trim().length > 0
      )?.content;

    if (!assistantMsg) {
      // フォールバック: ユーザーメッセージからタイトル生成
      return this.applyFallbackTitle(thread, firstUserMsg.content);
    }

    // LLMでタイトル生成（簡易版: ここではOpenAI互換エンドポイントを呼ぶ想定）
    try {
      const title = await this.callTitleLLM(
        firstUserMsg.content,
        assistantMsg
      );
      const sanitized = this.sanitizeTitle(title);
      if (sanitized && sanitized !== thread.title) {
        return this.updateThreadTitle(threadId, sanitized);
      }
      return thread;
    } catch (err) {
      logger.warn(`[Threads] title generation failed, using fallback:`, err);
      return this.applyFallbackTitle(thread, firstUserMsg.content);
    }
  }

  private async callTitleLLM(
    userMessage: string,
    assistantMessage: string
  ): Promise<string> {
    // プロバイダー設定がなければフォールバック
    const config = this.getLLMConfig();
    if (!config) {
      throw new Error("No LLM config available");
    }

    const prompt = `User: ${userMessage.slice(0, 500)}\n\nAssistant: ${assistantMessage.slice(0, 500)}\n\nGenerate a concise, descriptive title (max 60 chars, in Japanese) for this conversation.`;

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: THREAD_TITLE_MODEL_HINT,
        messages: [
          { role: "system", content: THREAD_TITLE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM title API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  private getLLMConfig(): { endpoint: string; apiKey: string } | null {
    // 環境変数からLLM設定を取得（OpenRouter互換）
    const endpoint = process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) return null;
    return { endpoint, apiKey };
  }

  private applyFallbackTitle(
    thread: ThreadSummary,
    userMessage: string
  ): ThreadSummary | null {
    const title = this.titleFromUserMessage(userMessage);
    if (!title || title === thread.title) return thread;
    return this.updateThreadTitle(thread.id, title);
  }

  private titleFromUserMessage(text: string): string | null {
    // ユーザーメッセージの先頭からタイトルを生成
    const cleaned = text.replace(/^[@＠!！]\S+\s*/, "").trim(); // メンション除去
    if (!cleaned) return null;

    const maxLen = TITLE_FALLBACK_MAX_LENGTH;
    const truncated =
      cleaned.length <= maxLen
        ? cleaned
        : cleaned.slice(0, maxLen - 3) + "...";

    return truncated;
  }

  private sanitizeTitle(raw: string): string | null {
    if (!raw) return null;
    // 引用符・改行を除去
    let cleaned = raw.replace(/["""''""「」『』【】\n\r]/g, "").trim();
    if (!cleaned) return null;
    if (cleaned.length > TITLE_SANITIZE_MAX_LENGTH) {
      cleaned = cleaned.slice(0, TITLE_SANITIZE_MAX_LENGTH - 3) + "...";
    }
    return cleaned;
  }

  private isAutoGeneratedTitle(title: string): boolean {
    return AUTO_GENERATED_PREFIXES.some((prefix) => title.startsWith(prefix));
  }

  // ---- ターン状態管理 ----

  setTurnState(
    threadId: string,
    snapshot: string,
    status: TurnState["status"]
  ): void {
    this.ensureInit();
    const now = Date.now();
    const existing = db.queryOne(
      "SELECT * FROM turn_states WHERE thread_id = ?",
      threadId
    ) as Record<string, unknown> | null;

    if (existing) {
      db.run(
        `UPDATE turn_states SET snapshot = ?, status = ?, last_activity_at = ?,
         iteration_count = iteration_count + 1 WHERE thread_id = ?`,
        snapshot,
        status,
        now,
        threadId
      );
    } else {
      db.run(
        `INSERT INTO turn_states (thread_id, snapshot, turn_started_at, status, last_activity_at, iteration_count)
         VALUES (?, ?, ?, ?, ?, 1)`,
        threadId,
        snapshot,
        now,
        status,
        now
      );
    }
  }

  getTurnState(threadId: string): TurnState | null {
    this.ensureInit();
    const row = db.queryOne(
      "SELECT * FROM turn_states WHERE thread_id = ?",
      threadId
    ) as Record<string, unknown> | null;
    if (!row) return null;

    return {
      threadId: row.thread_id as string,
      snapshot: row.snapshot as string,
      turnStartedAt: row.turn_started_at as number,
      status: row.status as TurnState["status"],
      lastActivityAt: row.last_activity_at as number,
      iterationCount: row.iteration_count as number,
    };
  }

  listTurnStates(limit?: number): TurnStateListResponse {
    this.ensureInit();
    const sql = limit
      ? "SELECT * FROM turn_states ORDER BY last_activity_at DESC LIMIT ?"
      : "SELECT * FROM turn_states ORDER BY last_activity_at DESC";
    const params = limit ? [limit] : [];
    const rows = db.query(sql, ...params) as Record<string, unknown>[];
    const turnStates = rows.map((r) => ({
      threadId: r.thread_id as string,
      snapshot: r.snapshot as string,
      turnStartedAt: r.turn_started_at as number,
      status: r.status as TurnState["status"],
      lastActivityAt: r.last_activity_at as number,
      iterationCount: r.iteration_count as number,
    }));
    return { turnStates, count: turnStates.length };
  }

  clearTurnState(threadId: string): boolean {
    this.ensureInit();
    const result = db.run(
      "DELETE FROM turn_states WHERE thread_id = ?",
      threadId
    );
    return result.changes > 0;
  }

  clearAllTurnStates(): number {
    this.ensureInit();
    const count = db.queryOne(
      "SELECT COUNT(*) as c FROM turn_states"
    ) as { c: number };
    db.run("DELETE FROM turn_states");
    return count.c;
  }

  // 中断状態の一斉マークアップ（プロセス再起動後など）
  markInterruptedTurns(): number {
    this.ensureInit();
    const result = db.run(
      `UPDATE turn_states SET status = 'interrupted'
       WHERE status = 'running'`
    );
    if (result.changes > 0) {
      logger.info(`[Threads] marked ${result.changes} turns as interrupted`);
    }
    return result.changes;
  }

  // ---- ヘルパー ----

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("ThreadManager not initialized. Call init() first.");
    }
  }

  private rowToSummary(row: Record<string, unknown>): ThreadSummary {
    return {
      id: row.id as string,
      title: row.title as string,
      chatId: row.chat_id as string,
      isActive: (row.is_active as number) === 1,
      messageCount: row.message_count as number,
      lastMessageAt: (row.last_message_at as number) ?? null,
      createdAt: row.created_at as number,
      parentThreadId: (row.parent_thread_id as string) ?? null,
      labels: JSON.parse((row.labels as string) ?? "[]"),
    };
  }

  private rowToMessage(row: Record<string, unknown>): ThreadMessage {
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      sender: row.sender as ThreadMessage["sender"],
      content: row.content as string,
      messageType: (row.message_type as ThreadMessage["messageType"]) ?? "text",
      extraMetadata: row.extra_metadata
        ? (JSON.parse(row.extra_metadata as string) as Record<string, unknown>)
        : undefined,
      createdAt: row.created_at as number,
    };
  }
}

// ==================== シングルトン ====================

export const threadManager = new ThreadManager();

// ==================== システムコマンド ====================

export function getThreadsCommands(): Record<
  string,
  (args: string[]) => string
> {
  return {
    "/threads": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "list": {
          const chatId = args[1];
          const result = threadManager.listThreads(chatId);
          if (result.count === 0) return "📭 スレッドがありません";
          return (
            `📋 スレッド一覧 (${result.count})\n\n` +
            result.threads
              .map(
                (t, i) =>
                  `${i + 1}. **${t.title}** [${t.messageCount}msg] ${
                    t.isActive ? "🟢" : "🔴"
                  } ${t.labels.length > 0 ? `🏷️ ${t.labels.join(",")}` : ""}`
              )
              .join("\n")
          );
        }

        case "get": {
          const id = args[1];
          if (!id) return "⚠️ スレッドIDが必要です";
          const thread = threadManager.getThread(id);
          if (!thread) return "❌ スレッドが見つかりません";
          return (
            `📄 **スレッド: ${thread.title}**\n` +
            `ID: \`${thread.id}\`\n` +
            `チャット: ${thread.chatId || "なし"}\n` +
            `メッセージ: ${thread.messageCount}\n` +
            `作成: ${new Date(thread.createdAt).toLocaleString("ja-JP")}\n` +
            `アクティブ: ${thread.isActive ? "✅" : "❌"}\n` +
            `ラベル: ${thread.labels.length > 0 ? thread.labels.join(", ") : "なし"}`
          );
        }

        case "delete": {
          const id = args[1];
          if (!id) return "⚠️ スレッドIDが必要です";
          return threadManager.deleteThread(id)
            ? `✅ スレッド ${id} を削除しました`
            : "❌ スレッドが見つかりません";
        }

        case "purge":
          const stats = threadManager.purgeThreads();
          return `🧹 ${
            stats.threadCount
          }スレッド・${stats.messageCount.toLocaleString()}メッセージを削除しました`;

        case "title": {
          const id = args[1];
          const title = args.slice(2).join(" ");
          if (!id || !title) return "⚠️ スレッドIDと新しいタイトルが必要です";
          const updated = threadManager.updateThreadTitle(id, title);
          return updated
            ? `✅ タイトルを「${updated.title}」に変更しました`
            : "❌ スレッドが見つかりません";
        }

        case "turn": {
          const id = args[1];
          if (!id) {
            // 全ターン状態一覧
            const states = threadManager.listTurnStates(10);
            if (states.count === 0) return "📭 アクティブなターンはありません";
            return (
              `🔄 ターン状態一覧 (${states.count})\n\n` +
              states.turnStates
                .map(
                  (s) =>
                    `- \`${s.threadId.slice(0, 16)}...\` ${this.statusIcon(s.status)} ${s.iterationCount}回`
                )
                .join("\n")
            );
          }
          const state = threadManager.getTurnState(id);
          if (!state) return "📭 ターン状態はありません";
          return (
            `🔄 **ターン状態**\n` +
            `スレッド: \`${id}\`\n` +
            `ステータス: ${this.statusIcon(state.status)} ${state.status}\n` +
            `イテレーション: ${state.iterationCount}\n` +
            `開始: ${new Date(state.turnStartedAt).toLocaleString("ja-JP")}\n` +
            `最終活動: ${new Date(state.lastActivityAt).toLocaleString("ja-JP")}`
          );
        }

        default:
          return (
            `📋 **スレッドコマンド**\n` +
            `/threads list [chatId] — スレッド一覧\n` +
            `/threads get <id> — スレッド詳細\n` +
            `/threads delete <id> — スレッド削除\n` +
            `/threads purge — 全削除\n` +
            `/threads title <id> <title> — タイトル変更\n` +
            `/threads turn [id] — ターン状態表示`
          );
      }
    },
  };
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "▶️";
    case "interrupted":
      return "⚠️";
    case "completed":
      return "✅";
    default:
      return "❓";
  }
}

export default ThreadManager;
