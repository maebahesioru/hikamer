// ==========================================
// Hikamer - Sub-Agent System（OpenClaw subagent/ 由来）
// バックグラウンド分離エージェント生成・ライフサイクル管理
// ==========================================

import { logger } from "./utils/logger";
import { createHash, randomBytes } from "crypto";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface SubagentConfig {
  model?: string;
  provider?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  maxToolIterations?: number;
  thinking?: "off" | "on";
  contextFork?: boolean;
}

export interface SubagentRecord {
  id: string;
  parentId: string | null;
  status: SubagentStatus;
  goal: string;
  config: SubagentConfig;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  descendantCount: number;
  announceAttempts: number;
}

// ==================== レジストリ ====================

class SubagentRegistry {
  private records = new Map<string, SubagentRecord>();
  private maxRecords = 500;

  create(parentId: string | null, goal: string, config: SubagentConfig = {}): SubagentRecord {
    const id = `sub_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    const record: SubagentRecord = {
      id,
      parentId,
      status: "pending",
      goal,
      config,
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      descendantCount: 0,
      announceAttempts: 0,
    };
    this.records.set(id, record);
    this.enforceLimit();
    logger.info(`[SubAgent] 作成: ${id} (parent=${parentId || "none"})`);
    return record;
  }

  update(id: string, patch: Partial<SubagentRecord>): void {
    const r = this.records.get(id);
    if (r) Object.assign(r, patch);
  }

  get(id: string): SubagentRecord | undefined {
    return this.records.get(id);
  }

  /** 子孫をBFSで取得 */
  getDescendants(parentId: string): SubagentRecord[] {
    const result: SubagentRecord[] = [];
    const queue = [parentId];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const r of this.records.values()) {
        if (r.parentId === pid && r.id !== parentId) {
          result.push(r);
          queue.push(r.id);
        }
      }
    }
    return result;
  }

  getByStatus(status: SubagentStatus): SubagentRecord[] {
    return Array.from(this.records.values()).filter((r) => r.status === status);
  }

  getActiveCount(): number {
    return this.getByStatus("running").length + this.getByStatus("pending").length;
  }

  /** タイムアウトしたサブエージェントを回収 */
  expireTimeouts(): number {
    const now = Date.now();
    let expired = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.config.timeoutMs) {
        if (r.startedAt && now - r.startedAt > r.config.timeoutMs) {
          r.status = "timed_out";
          r.error = `Timeout after ${r.config.timeoutMs}ms`;
          r.completedAt = now;
          expired++;
        }
      }
    }
    return expired;
  }

  /** 7日以上前の完了済みを削除 */
  pruneOld(): number {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [id, r] of this.records) {
      if (r.completedAt && r.completedAt < cutoff) {
        this.records.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private enforceLimit(): void {
    if (this.records.size > this.maxRecords) {
      const sorted = Array.from(this.records.entries())
        .sort(([, a], [, b]) => (a.createdAt - b.createdAt));
      const toRemove = sorted.slice(0, this.records.size - this.maxRecords);
      for (const [id] of toRemove) this.records.delete(id);
    }
  }

  formatStats(): string {
    const statusCounts = new Map<SubagentStatus, number>();
    for (const r of this.records.values()) {
      statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
    }

    const lines: string[] = ["🤖 **Sub-Agent Registry**"];
    for (const [status, count] of statusCounts) {
      const icon = status === "running" ? "🟢" : status === "pending" ? "🟡" : status === "completed" ? "✅" : status === "failed" ? "❌" : status === "cancelled" ? "🚫" : "⏰";
      lines.push(`  ${icon} ${status}: ${count}`);
    }
    lines.push(`  📊 合計: ${this.records.size}`);
    return lines.join("\n");
  }
}

export const subagentRegistry = new SubagentRegistry();

// ==================== サブエージェント生成 ====================

// v1.43: Worktree分離（Orca由来）
// lazy import to avoid circular deps
let worktreeManager: any = null;
async function getWorktreeManager() {
  if (!worktreeManager) {
    worktreeManager = (await import("./parallel-agents")).worktreeManager;
  }
  return worktreeManager;
}

/** サブエージェントを生成（バックグラウンド + Worktree分離） */
export async function spawnSubagent(
  goal: string,
  config?: SubagentConfig,
  parentId?: string,
): Promise<SubagentRecord> {
  // 深さ制限
  if (parentId) {
    const parent = subagentRegistry.get(parentId);
    if (parent && parent.descendantCount >= 5) {
      throw new Error("Max subagent depth exceeded (max descendants: 5)");
    }
  }

  const record = subagentRegistry.create(parentId || null, goal, config);

  // 親の子孫カウントを更新
  if (parentId) {
    let current = parentId;
    while (current) {
      const r = subagentRegistry.get(current);
      if (r) {
        r.descendantCount++;
        current = r.parentId || "";
      } else break;
    }
  }

  // 非同期実行（ここではeventBusで通知、実際の実行は外部ハンドラに委譲）
  eventBus.publish(createEvent("subagent", "spawned", {
    id: record.id,
    goal: goal.slice(0, 200),
    parentId: parentId || null,
  }));

  // v1.43: Worktreeの割り当て（Orca由来の分離実行）
  getWorktreeManager().then(wtm => {
    const wt = wtm.assign(record.id);
    if (wt) {
      logger.debug(`[SubAgent] Worktree割当: ${record.id} → ${wt.id}`);
      (record as any)._worktreeId = wt.id;
    }
  }).catch(() => {});

  return record;
}

/** サブエージェントの結果を記録 */
export function completeSubagent(id: string, result: string, error?: string): void {
  const r = subagentRegistry.get(id);
  if (!r) return;

  r.status = error ? "failed" : "completed";
  r.result = result;
  r.error = error || null;
  r.completedAt = Date.now();
  r.durationMs = r.startedAt ? Date.now() - r.startedAt : null;

  eventBus.publish(createEvent("subagent", "completed", {
    id,
    status: r.status,
    resultLength: result.length,
    parentId: r.parentId,
  }));

  // 親への通知
  if (r.parentId) {
    announceToParent(r);
  }

  // v1.43: Worktreeの解放
  const wtId = (r as any)._worktreeId as string | undefined;
  if (wtId) {
    getWorktreeManager().then(wtm => wtm.release(wtId)).catch(() => {});
  }
}

/** サブエージェントをキャンセル（子孫も含む） */
export function cancelSubagent(id: string): number {
  const descendants = subagentRegistry.getDescendants(id);
  let cancelled = 0;

  for (const d of descendants) {
    if (d.status === "running" || d.status === "pending") {
      d.status = "cancelled";
      d.completedAt = Date.now();
      cancelled++;
    }
  }

  const main = subagentRegistry.get(id);
  if (main && (main.status === "running" || main.status === "pending")) {
    main.status = "cancelled";
    main.completedAt = Date.now();
    cancelled++;
  }

  logger.info(`[SubAgent] キャンセル: ${id} (${cancelled}件)`);
  return cancelled;
}

/** 親エージェントに結果を通知 */
function announceToParent(record: SubagentRecord): void {
  const parent = subagentRegistry.get(record.parentId!);
  if (!parent) return;

  parent.announceAttempts++;
  const resultText = record.result ? record.result.slice(0, 10000) : "";
  const errorText = record.error ? record.error.slice(0, 500) : "";

  eventBus.publish(createEvent("subagent", "announce", {
    subagentId: record.id,
    parentId: record.parentId,
    status: record.status,
    resultPreview: resultText.slice(0, 200),
    error: errorText || undefined,
  }));
}

// ==================== メンテナンス ====================

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

export function startSubagentMaintenance(intervalMs = 60000): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    const expired = subagentRegistry.expireTimeouts();
    const pruned = subagentRegistry.pruneOld();
    if (expired > 0 || pruned > 0) {
      logger.info(`[SubAgent] メンテナンス: ${expired}タイムアウト, ${pruned}削除`);
    }
  }, intervalMs);
  logger.info(`[SubAgent] メンテナンス開始 (interval=${intervalMs / 1000}s)`);
}

export function stopSubagentMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

// ==================== コマンド ====================

export function formatSubagentDetail(id: string): string {
  const r = subagentRegistry.get(id);
  if (!r) return "❌ サブエージェントが見つかりません。";

  const statusIcon: Record<SubagentStatus, string> = {
    pending: "🟡", running: "🟢", completed: "✅", failed: "❌", cancelled: "🚫", timed_out: "⏰",
  };

  return [
    `${statusIcon[r.status] ?? "❓"} **Sub-Agent: ${r.id}**`,
    `  目標: ${r.goal.slice(0, 100)}`,
    `  状態: ${r.status}`,
    `  作成: ${new Date(r.createdAt).toLocaleString()}`,
    r.startedAt ? `  開始: ${new Date(r.startedAt).toLocaleString()}` : "",
    r.durationMs ? `  実行時間: ${(r.durationMs / 1000).toFixed(1)}秒` : "",
    r.result ? `  結果: ${r.result.slice(0, 200)}...` : "",
    r.error ? `  エラー: ${r.error.slice(0, 200)}` : "",
    r.parentId ? `  親: ${r.parentId}` : "",
    `  子孫数: ${r.descendantCount}`,
  ].filter(Boolean).join("\n");
}

// ==========================================
// v1.61: SpecializedAgentPool（crewAI Workforce + OWL パターン）
// ロールベースの専門エージェントプール。タスクに最適なエージェントを自動選択
// ==========================================

/** 専門エージェント定義 */
export interface SpecializedAgent {
  role: string;           // 役割名（例: "Web Researcher"）
  description: string;    // 得意分野の説明（マッチングに使用）
  tools: string[];        // 利用可能なツール名リスト
  model?: string;         // 専用モデル（未指定時はデフォルト）
  priority: number;       // 優先度（高いほど先に選択）
  maxConcurrent: number;  // 最大同時実行数
  currentLoad: number;    // 現在の実行数
}

/** タスク→エージェントのマッチング結果 */
export interface AgentMatch {
  agent: SpecializedAgent;
  score: number;          // 0-100のマッチングスコア
  reason: string;         // 選択理由
}

class SpecializedAgentPool {
  private agents: Map<string, SpecializedAgent> = new Map();

  /** 専門エージェントを登録 */
  register(agent: SpecializedAgent): void {
    this.agents.set(agent.role, agent);
    logger.info(`[AgentPool] 登録: ${agent.role} (tools: ${agent.tools.join(", ")})`);
  }

  /** 登録解除 */
  unregister(role: string): boolean {
    return this.agents.delete(role);
  }

  /**
   * タスク内容から最適なエージェントを選択
   * 説明文のキーワードマッチング + 負荷分散
   */
  findBestAgent(taskDescription: string): AgentMatch | null {
    const lowerTask = taskDescription.toLowerCase();
    let bestMatch: AgentMatch | null = null;
    let bestScore = -1;

    for (const agent of this.agents.values()) {
      // 満杯チェック
      if (agent.currentLoad >= agent.maxConcurrent) continue;

      // スコア計算: 説明文のキーワードマッチ
      const keywords = agent.description.toLowerCase().split(/[\s,、]+/);
      let matchCount = 0;
      let totalKeywords = 0;

      for (const kw of keywords) {
        if (kw.length < 2) continue; // 短すぎる単語はスキップ
        totalKeywords++;
        if (lowerTask.includes(kw)) matchCount++;
      }

      const keywordScore = totalKeywords > 0 ? (matchCount / totalKeywords) * 60 : 0;
      const priorityBonus = Math.min(agent.priority * 4, 20);
      const loadPenalty = (agent.currentLoad / Math.max(agent.maxConcurrent, 1)) * 20;
      const score = Math.round(keywordScore + priorityBonus - loadPenalty);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          agent,
          score: Math.max(0, Math.min(100, score)),
          reason: this.buildReason(agent, matchCount, totalKeywords),
        };
      }
    }

    return bestMatch;
  }

  /** 全エージェントをスコア順に取得 */
  rankAll(taskDescription: string): AgentMatch[] {
    const lowerTask = taskDescription.toLowerCase();
    const results: AgentMatch[] = [];

    for (const agent of this.agents.values()) {
      const keywords = agent.description.toLowerCase().split(/[\s,、]+/);
      let matchCount = 0;
      let totalKeywords = 0;

      for (const kw of keywords) {
        if (kw.length < 2) continue;
        totalKeywords++;
        if (lowerTask.includes(kw)) matchCount++;
      }

      const keywordScore = totalKeywords > 0 ? (matchCount / totalKeywords) * 60 : 0;
      const priorityBonus = Math.min(agent.priority * 4, 20);
      const score = Math.round(keywordScore + priorityBonus);

      results.push({
        agent,
        score: Math.max(0, Math.min(100, score)),
        reason: this.buildReason(agent, matchCount, totalKeywords),
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /** エージェントの負荷を増加 */
  acquireSlot(role: string): boolean {
    const agent = this.agents.get(role);
    if (!agent || agent.currentLoad >= agent.maxConcurrent) return false;
    agent.currentLoad++;
    return true;
  }

  /** エージェントの負荷を解放 */
  releaseSlot(role: string): void {
    const agent = this.agents.get(role);
    if (agent && agent.currentLoad > 0) agent.currentLoad--;
  }

  /** デフォルトの専門エージェント群を一括登録 */
  registerDefaults(): void {
    const defaults: SpecializedAgent[] = [
      {
        role: "Web Researcher",
        description: "web search, browser, scraping, research, information gathering, fact checking",
        tools: ["web_search", "browser", "url_fetch"],
        priority: 5,
        maxConcurrent: 3,
        currentLoad: 0,
      },
      {
        role: "Code Engineer",
        description: "code, programming, file write, terminal, shell, debug, git, development",
        tools: ["terminal", "file_write", "file_read", "code_execute", "search_files"],
        priority: 5,
        maxConcurrent: 2,
        currentLoad: 0,
      },
      {
        role: "Data Analyst",
        description: "data, analysis, statistics, csv, json, chart, visualization, numbers",
        tools: ["terminal", "file_read", "code_execute", "web_search"],
        priority: 3,
        maxConcurrent: 2,
        currentLoad: 0,
      },
      {
        role: "Content Writer",
        description: "writing, content, blog, article, summary, translation, social media, post",
        tools: ["file_write", "web_search", "url_fetch"],
        priority: 3,
        maxConcurrent: 3,
        currentLoad: 0,
      },
      {
        role: "Stock Analyst",
        description: "stock, trading, investment, finance, market, portfolio, analysis",
        tools: ["web_search", "terminal", "file_read"],
        priority: 4,
        maxConcurrent: 2,
        currentLoad: 0,
      },
    ];

    for (const agent of defaults) {
      this.register(agent);
    }
  }

  private buildReason(agent: SpecializedAgent, matched: number, total: number): string {
    if (total === 0) return `${agent.role}: キーワードなし（優先度による選択）`;
    const pct = Math.round((matched / total) * 100);
    return `${agent.role}: ${matched}/${total} キーワード一致 (${pct}%)`;
  }

  formatPool(): string {
    const lines: string[] = ["🤖 **Specialized Agent Pool**", ""];
    for (const agent of this.agents.values()) {
      const loadBar = "█".repeat(agent.currentLoad) + "░".repeat(agent.maxConcurrent - agent.currentLoad);
      lines.push(
        `**${agent.role}** P:${agent.priority} [${loadBar}] ${agent.currentLoad}/${agent.maxConcurrent}` +
        `\n  └ ${agent.description.slice(0, 100)}`
      );
    }
    return lines.join("\n");
  }
}

export const agentPool = new SpecializedAgentPool();

// ==========================================
// Agent Identity System（openpencil 3k stars パターン）
// サブエージェントに色+名前を割り当てて視覚的追跡を可能に
// ==========================================

/** エージェント識別子 */
export interface AgentIdentity {
  color: string;
  name: string;
  emoji: string;
}

const AGENT_COLORS = [
  "#FF6B6B", // coral red
  "#4ECDC4", // teal
  "#FFD93D", // golden yellow
  "#6C5CE7", // purple
  "#A8E6CF", // mint green
  "#FF8A5C", // warm orange
];

const AGENT_NAMES = [
  "Kiki", "Mochi", "Pixel", "Nova", "Zuri", "Cleo",
  "Boba", "Rune", "Fern", "Echo", "Puck", "Sage",
];

const AGENT_EMOJIS = ["🤖", "🦊", "🐱", "🐙", "🦉", "🐉", "🦋", "🐺", "🦊", "🐰"];

/**
 * 指定数分のユニークなエージェント識別子を割り当て。
 * 色は循環、名前と絵文字はシャッフル。
 */
export function assignAgentIdentities(count: number): AgentIdentity[] {
  const shuffledNames = [...AGENT_NAMES].sort(() => Math.random() - 0.5);
  const shuffledEmojis = [...AGENT_EMOJIS].sort(() => Math.random() - 0.5);

  return Array.from({ length: count }, (_, i) => ({
    color: AGENT_COLORS[i % AGENT_COLORS.length]!,
    name: shuffledNames[i % shuffledNames.length]!,
    emoji: shuffledEmojis[i % shuffledEmojis.length]!,
  }));
}

// ==========================================
// サブエージェント再試行 + コンテンツブロック検出（openpencil パターン）
// ==========================================

/** 再試行不可能なエラーパターン（コンテンツモデレーション拒否等） */
const NON_RETRYABLE_PATTERNS = [
  /HTTP 4(?:0[01]|29|51)/i,      // 400/401/429/451
  /content blocked/i,
  /authentication failed/i,
  /censorship/i,
  /rate limit/i,
  /quota exceeded/i,
  /invalid request/i,
];

/**
 * エラーメッセージが再試行不可能か判定。
 * openpencilの isNonRetryable パターン。
 */
export function isNonRetryableError(errorMessage: string): boolean {
  return NON_RETRYABLE_PATTERNS.some(p => p.test(errorMessage));
}

/**
 * サブエージェントの結果が失敗で再試行すべきか判定。
 * 再試行条件: エラーあり AND ノードなし AND 中断されてない AND 再試行不可能なエラーでない
 */
export function shouldRetrySubAgent(
  error: string | null,
  resultCount: number,
  aborted: boolean,
): boolean {
  if (!error) return false;
  if (resultCount > 0) return false; // 部分的な結果があるなら再試行しない
  if (aborted) return false;
  if (isNonRetryableError(error)) return false;
  return true;
}
