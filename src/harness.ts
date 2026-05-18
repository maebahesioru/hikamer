// ==========================================
// Aikata - セッションハーネス（OpenHuman agent/harness/session/ 由来）
// エージェントセッションの完全ライフサイクル管理
// ビルダー・ランタイム・トランスクリプト・ターン管理
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

/** メッセージロール */
export type SessionMessageRole = "user" | "assistant" | "system" | "tool";

/** ターン状態 */
export type TurnStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

/** セッション状態 */
export type SessionStatus = "active" | "paused" | "completed" | "archived";

/** メッセージ */
export interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/** ターン（1往復） */
export interface SessionTurn {
  id: string;
  index: number;
  status: TurnStatus;
  userMessage: SessionMessage;
  assistantMessages: SessionMessage[];
  toolCalls: SessionToolCall[];
  startedAt: number;
  completedAt?: number;
  latencyMs: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

/** ツール呼び出し記録 */
export interface SessionToolCall {
  id: string;
  turnId: string;
  toolName: string;
  args: string;
  result: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** セッション */
export interface AgentSession {
  id: string;
  threadId: string;
  status: SessionStatus;
  turns: SessionTurn[];
  messages: SessionMessage[];
  metadata: {
    model: string;
    provider: string;
    startedAt: number;
    lastActivityAt: number;
    totalTurns: number;
    totalTokens: number;
    totalCost: number;
    tags: string[];
  };
  config?: {
    maxTokens: number;
    maxTurns: number;
    temperature: number;
    model: string;
  };
}

/** セッションサマリー */
export interface SessionSummary {
  id: string;
  threadId: string;
  status: SessionStatus;
  totalTurns: number;
  totalTokens: number;
  totalCost: number;
  lastActivityAt: number;
  model: string;
}

/** ビルダー設定 */
export interface SessionBuilderConfig {
  threadId: string;
  model?: string;
  provider?: string;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  tags?: string[];
}

// ==================== セッションハーネス ====================

class SessionHarness {
  private sessions: Map<string, AgentSession> = new Map();
  private initialized = false;
  private stats = {
    created: 0,
    completed: 0,
    failed: 0,
    totalTurns: 0,
    totalTokens: 0,
  };

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[SessionHarness] initialized");
  }

  /** セッションを生成 */
  createSession(config: SessionBuilderConfig): AgentSession {
    const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const session: AgentSession = {
      id,
      threadId: config.threadId,
      status: "active",
      turns: [],
      messages: [],
      metadata: {
        model: config.model ?? "deepseek/deepseek-v4-flash",
        provider: config.provider ?? "openrouter",
        startedAt: now,
        lastActivityAt: now,
        totalTurns: 0,
        totalTokens: 0,
        totalCost: 0,
        tags: config.tags ?? [],
      },
      config: {
        maxTokens: config.maxTokens ?? 128000,
        maxTurns: config.maxTurns ?? 50,
        temperature: config.temperature ?? 0.7,
        model: config.model ?? "deepseek/deepseek-v4-flash",
      },
    };

    this.sessions.set(id, session);
    this.stats.created++;
    eventBus.publish(createEvent("harness:session_created", { sessionId: id, threadId: config.threadId }));
    return session;
  }

  /** セッション一覧 */
  listSessions(status?: SessionStatus, limit = 50): SessionSummary[] {
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((s) => s.status === status) : all;
    return filtered.slice(0, limit).map((s) => ({
      id: s.id,
      threadId: s.threadId,
      status: s.status,
      totalTurns: s.metadata.totalTurns,
      totalTokens: s.metadata.totalTokens,
      totalCost: s.metadata.totalCost,
      lastActivityAt: s.metadata.lastActivityAt,
      model: s.metadata.model,
    }));
  }

  /** セッションを取得 */
  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /** スレッドIDからセッションを検索 */
  findSessionsByThread(threadId: string): AgentSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.threadId === threadId && s.status === "active"
    );
  }

  /** セッションを閉じる */
  closeSession(id: string, status?: SessionStatus): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.status = status ?? "completed";
    session.metadata.lastActivityAt = Date.now();

    if (session.status === "completed") this.stats.completed++;
    else if (session.status === "archived") this.stats.completed++;

    eventBus.publish(createEvent("harness:session_closed", { sessionId: id, status: session.status }));
    return true;
  }

  /** メッセージを追加 */
  addMessage(sessionId: string, message: Omit<SessionMessage, "id" | "timestamp">): SessionMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") return null;

    const msg: SessionMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    session.messages.push(msg);
    session.metadata.lastActivityAt = Date.now();

    if (session.config && session.messages.length > session.config.maxTokens / 100) {
      this.compactSession(session);
    }

    return msg;
  }

  /** ターンを開始 */
  startTurn(sessionId: string, userMessage: SessionMessage): SessionTurn | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") return null;

    if (session.config && session.metadata.totalTurns >= session.config.maxTurns) {
      logger.warn(`[SessionHarness] session ${sessionId} max turns reached`);
      return null;
    }

    const turn: SessionTurn = {
      id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      index: session.metadata.totalTurns + 1,
      status: "running",
      userMessage,
      assistantMessages: [],
      toolCalls: [],
      startedAt: Date.now(),
      latencyMs: 0,
    };

    session.turns.push(turn);
    session.metadata.totalTurns++;
    this.stats.totalTurns++;
    session.messages.push(userMessage);

    return turn;
  }

  /** ターンにアシスタントメッセージを追加 */
  addAssistantMessage(sessionId: string, turnIndex: number, content: string): SessionMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const turn = session.turns[turnIndex - 1];
    if (!turn || turn.status !== "running") return null;

    const msg: SessionMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant",
      content,
      timestamp: Date.now(),
    };

    turn.assistantMessages.push(msg);
    session.messages.push(msg);
    return msg;
  }

  /** ツール呼び出しを記録 */
  recordToolCall(
    sessionId: string,
    turnIndex: number,
    toolCall: Omit<SessionToolCall, "id" | "turnId">
  ): SessionToolCall | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const turn = session.turns[turnIndex - 1];
    if (!turn) return null;

    const record: SessionToolCall = {
      ...toolCall,
      id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: turn.id,
    };

    turn.toolCalls.push(record);
    return record;
  }

  /** ターンを完了 */
  completeTurn(
    sessionId: string,
    turnIndex: number,
    status?: TurnStatus,
    tokenUsage?: { input: number; output: number }
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const turn = session.turns[turnIndex - 1];
    if (!turn) return false;

    turn.status = status ?? "completed";
    turn.completedAt = Date.now();
    turn.latencyMs = turn.completedAt - turn.startedAt;

    if (tokenUsage) {
      turn.tokenUsage = {
        ...tokenUsage,
        total: tokenUsage.input + tokenUsage.output,
      };
      session.metadata.totalTokens += turn.tokenUsage.total;
    }

    if (status === "failed") {
      this.stats.failed++;
    }

    eventBus.publish(createEvent("harness:turn_completed", {
      sessionId,
      turnIndex,
      status: turn.status,
      latencyMs: turn.latencyMs,
    }));

    return true;
  }

  /** セッションのトランスクリプトを取得 */
  getTranscript(sessionId: string, format?: "text" | "json"): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "Session not found";

    if (format === "json") {
      return JSON.stringify(session.messages, null, 2);
    }

    const lines: string[] = [
      `=== Session: ${session.id} ===`,
      `Model: ${session.metadata.model}`,
      `Turns: ${session.metadata.totalTurns}`,
      `Tokens: ${session.metadata.totalTokens}`,
      `Status: ${session.status}`,
      `Started: ${new Date(session.metadata.startedAt).toISOString()}`,
      "",
    ];

    for (const turn of session.turns) {
      lines.push(`--- Turn ${turn.index} [${turn.status}] (${turn.latencyMs}ms) ---`);
      lines.push(`User: ${turn.userMessage.content.slice(0, 200)}`);

      for (const msg of turn.assistantMessages) {
        lines.push(`Assistant: ${msg.content.slice(0, 200)}`);
      }

      for (const tc of turn.toolCalls) {
        lines.push(
          `  Tool: ${tc.toolName} ${tc.success ? "✅" : "❌"} (${tc.durationMs}ms)${tc.error ? `: ${tc.error.slice(0, 100)}` : ""}`
        );
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** 古いセッションを自動アーカイブ */
  autoArchive(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let archived = 0;

    for (const session of this.sessions.values()) {
      if (
        session.status === "active" &&
        now - session.metadata.lastActivityAt > maxAgeMs
      ) {
        session.status = "archived";
        archived++;
      }
    }

    if (archived > 0) {
      logger.info(`[SessionHarness] auto-archived ${archived} sessions`);
    }
    return archived;
  }

  /** セッションをコンパクト化（メモリ節約） */
  private compactSession(session: AgentSession): void {
    // 完了したターンのトランスクリプトを要約
    const completedTurns = session.turns.filter(
      (t) => t.status === "completed"
    );

    if (completedTurns.length > 10) {
      // 古いターンの詳細メッセージを削減
      const oldTurns = completedTurns.slice(0, completedTurns.length - 5);
      for (const turn of oldTurns) {
        turn.assistantMessages = turn.assistantMessages.map((m) => ({
          ...m,
          content: m.content.slice(0, 500),
        }));
      }
    }
  }

  /** 統計を取得 */
  getStats() {
    return { ...this.stats };
  }

  /** セッション情報をフォーマット */
  formatSession(session: AgentSession): string {
    const statusIcon =
      session.status === "active"
        ? "🟢"
        : session.status === "paused"
          ? "🟡"
          : session.status === "completed"
            ? "✅"
            : "⚪";
    const costStr =
      session.metadata.totalCost > 0
        ? `$${session.metadata.totalCost.toFixed(4)}`
        : "N/A";

    return (
      `${statusIcon} **セッション** \`${session.id.slice(0, 16)}...\`\n` +
      `スレッド: \`${session.threadId.slice(0, 16)}...\`\n` +
      `モデル: ${session.metadata.model}\n` +
      `ターン: ${session.metadata.totalTurns}/${session.config?.maxTurns ?? "∞"}\n` +
      `トークン: ${session.metadata.totalTokens.toLocaleString()}\n` +
      `コスト: ${costStr}\n` +
      `タグ: ${session.metadata.tags.join(", ") || "なし"}\n` +
      `状態: ${session.status}\n` +
      `開始: ${new Date(session.metadata.startedAt).toLocaleString("ja-JP")}\n` +
      `最終活動: ${new Date(session.metadata.lastActivityAt).toLocaleString("ja-JP")}`
    );
  }
}

// ==================== シングルトン ====================

export const sessionHarness = new SessionHarness();

// ==================== システムコマンド ====================

export function getHarnessCommands(): Record<
  string,
  (args: string[]) => string
> {
  return {
    "/harness": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "list":
        case "ls": {
          const sessions = sessionHarness.listSessions();
          if (sessions.length === 0) return "📭 アクティブなセッションはありません";
          return (
            `🔧 **セッション一覧 (${sessions.length})**\n\n` +
            sessions
              .map(
                (s, i) =>
                  `${i + 1}. ${s.status === "active" ? "🟢" : "⚪"} **${s.id.slice(0, 12)}...**` +
                  ` ${s.totalTurns}ターン | ${(s.totalTokens / 1000).toFixed(1)}Kトークン` +
                  ` | ${s.model.slice(0, 20)}`
              )
              .join("\n")
          );
        }

        case "get":
        case "info": {
          const id = args[1];
          if (!id) return "⚠️ セッションIDが必要です";
          const session = sessionHarness.getSession(id);
          if (!session) return "❌ セッションが見つかりません";
          return sessionHarness.formatSession(session);
        }

        case "transcript":
        case "log": {
          const id = args[1];
          if (!id) return "⚠️ セッションIDが必要です";
          const format = args[2] === "json" ? "json" as const : "text" as const;
          return sessionHarness.getTranscript(id, format);
        }

        case "stats": {
          const stats = sessionHarness.getStats();
          return (
            `📊 **セッション統計**\n` +
            `作成: ${stats.created}\n` +
            `完了: ${stats.completed}\n` +
            `失敗: ${stats.failed}\n` +
            `総ターン数: ${stats.totalTurns}\n` +
            `総トークン: ${stats.totalTokens.toLocaleString()}`
          );
        }

        case "archive": {
          const count = sessionHarness.autoArchive();
          return count > 0 ? `📦 ${count}セッションをアーカイブしました` : "📭 アーカイブ対象なし";
        }

        default:
          return (
            `🔧 **セッションハーネスコマンド**\n` +
            `/harness list — セッション一覧\n` +
            `/harness get <id> — セッション詳細\n` +
            `/harness transcript <id> [json] — トランスクリプト\n` +
            `/harness stats — 統計\n` +
            `/harness archive — 古いセッションをアーカイブ`
          );
      }
    },
  };
}

export default SessionHarness;
