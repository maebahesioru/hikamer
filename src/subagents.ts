// ==========================================
// Aikata - Sub-Agent System（OpenClaw subagent/ 由来）
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
