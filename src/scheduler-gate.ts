// ==========================================
// Aikata - スケジューラーゲート（OpenHuman scheduler_gate/ 由来）
// LLM呼び出しのアクセス制御・レート制限・ポリシー
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type PermitStatus = "granted" | "queued" | "denied" | "throttled";

export interface LlmPermit {
  id: string;
  status: PermitStatus;
  queuePosition: number;
  estimatedWaitMs: number;
  grantedAt?: number;
  ttlMs: number;
  priority: number;
  source: string;
}

export interface GateStats {
  totalRequests: number;
  granted: number;
  denied: number;
  throttled: number;
  queueLength: number;
  avgWaitMs: number;
  peakConcurrent: number;
}

export interface GateRule {
  name: string;
  description: string;
  /** 同時実行制限 */
  maxConcurrent: number;
  /** レート制限（1分あたり） */
  rateLimitPerMin: number;
  /** 優先度 */
  priority: number;
  /** 許可TTL（ms） */
  ttlMs: number;
}

// ==================== スケジューラーゲート ====================

class SchedulerGate {
  private activePermits: Map<string, LlmPermit> = new Map();
  private requestQueue: LlmPermit[] = [];
  private requestHistory: number[] = []; // タイムスタンプ
  private stats: GateStats = {
    totalRequests: 0,
    granted: 0,
    denied: 0,
    throttled: 0,
    queueLength: 0,
    avgWaitMs: 0,
    peakConcurrent: 0,
  };

  private rule: GateRule = {
    name: "default",
    description: "デフォルトゲートルール",
    maxConcurrent: 3,
    rateLimitPerMin: 30,
    priority: 5,
    ttlMs: 30000,
  };

  private initialized = false;

  init(): void {
    if (this.initialized) return;
    // クリーンアップ定期実行
    setInterval(() => this.cleanup(), 10000);
    this.initialized = true;
    logger.info(`[Gate] initialized: max=${this.rule.maxConcurrent} concurrent, ${this.rule.rateLimitPerMin}/min`);
  }

  /** LLM実行許可を取得 */
  async acquirePermit(source: string, priority?: number): Promise<LlmPermit> {
    this.stats.totalRequests++;
    this.pruneHistory();

    // レート制限チェック
    if (!this.checkRateLimit()) {
      this.stats.throttled++;
      return {
        id: `denied-${Date.now()}`,
        status: "throttled",
        queuePosition: -1,
        estimatedWaitMs: this.getRateLimitWaitMs(),
        ttlMs: 0,
        priority: priority ?? this.rule.priority,
        source,
      };
    }

    // 同時実行数チェック
    if (this.activePermits.size >= this.rule.maxConcurrent) {
      // キューに追加
      const permit: LlmPermit = {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: "queued",
        queuePosition: this.requestQueue.length + 1,
        estimatedWaitMs: this.estimateWaitTime(),
        ttlMs: this.rule.ttlMs,
        priority: priority ?? this.rule.priority,
        source,
      };
      this.requestQueue.push(permit);
      this.stats.queueLength = this.requestQueue.length;
      return permit;
    }

    // 許可
    return this.grantPermit(source, priority);
  }

  /** 許可を解放 */
  releasePermit(permitId: string): void {
    this.activePermits.delete(permitId);

    // キューから次のリクエストを処理
    this.processQueue();
  }

  /** 許可の状態を確認 */
  checkPermit(permitId: string): PermitStatus {
    const permit = this.activePermits.get(permitId);
    if (!permit) return "denied";
    if (Date.now() - (permit.grantedAt ?? 0) > permit.ttlMs) {
      this.activePermits.delete(permitId);
      return "denied";
    }
    return "granted";
  }

  /** キューからリクエストを処理 */
  private processQueue(): void {
    while (this.requestQueue.length > 0 && this.activePermits.size < this.rule.maxConcurrent) {
      const next = this.requestQueue.shift()!;
      if (Date.now() - this.getPermitTime(next) > this.rule.ttlMs) {
        // 期限切れはスキップ
        continue;
      }
      const granted = this.grantPermit(next.source, next.priority);
      if (granted.status === "granted") {
        eventBus.publish(createEvent("gate:queue_processed", {
          permitId: granted.id,
          source: next.source,
          waitMs: Date.now() - this.getPermitTime(next),
        }));
      }
    }
    this.stats.queueLength = this.requestQueue.length;
  }

  /** ゲートルールを設定 */
  setRule(rule: Partial<GateRule>): void {
    this.rule = { ...this.rule, ...rule };
    logger.info(`[Gate] rule updated: max=${this.rule.maxConcurrent} concurrent, ${this.rule.rateLimitPerMin}/min`);
  }

  /** 統計を取得 */
  getStats(): GateStats {
    return { ...this.stats, queueLength: this.requestQueue.length };
  }

  /** アクティブな許可一覧 */
  getActivePermits(): LlmPermit[] {
    return [...this.activePermits.values()];
  }

  /** キュー一覧 */
  getQueue(): LlmPermit[] {
    return [...this.requestQueue];
  }

  // ---- 内部 ----

  private grantPermit(source: string, priority?: number): LlmPermit {
    const id = `permit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.requestHistory.push(now);

    const permit: LlmPermit = {
      id,
      status: "granted",
      queuePosition: 0,
      estimatedWaitMs: 0,
      grantedAt: now,
      ttlMs: this.rule.ttlMs,
      priority: priority ?? this.rule.priority,
      source,
    };

    this.activePermits.set(id, permit);
    this.stats.granted++;
    this.stats.peakConcurrent = Math.max(this.stats.peakConcurrent, this.activePermits.size);

    return permit;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowMs = 60000;
    const recent = this.requestHistory.filter((t) => now - t < windowMs);
    return recent.length < this.rule.rateLimitPerMin;
  }

  private getRateLimitWaitMs(): number {
    const now = Date.now();
    const windowMs = 60000;
    const recent = this.requestHistory.filter((t) => now - t < windowMs);
    if (recent.length < this.rule.rateLimitPerMin) return 0;
    // 最も古いリクエストがウィンドウから出るまでの時間
    const oldest = recent[recent.length - this.rule.rateLimitPerMin];
    return oldest ? Math.max(0, windowMs - (now - oldest)) : 1000;
  }

  private estimateWaitTime(): number {
    if (this.activePermits.size < this.rule.maxConcurrent) return 0;
    // 平均実行時間を仮定
    return Math.ceil(this.requestQueue.length / this.rule.maxConcurrent) * 10000;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, permit] of this.activePermits) {
      if (now - (permit.grantedAt ?? 0) > permit.ttlMs) {
        this.activePermits.delete(id);
      }
    }
    // 期限切れキューを削除
    this.requestQueue = this.requestQueue.filter(
      (p) => now - this.getPermitTime(p) < this.rule.ttlMs
    );
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - 60000;
    this.requestHistory = this.requestHistory.filter((t) => t > cutoff);
  }

  private getPermitTime(permit: LlmPermit): number {
    return permit.grantedAt ?? Date.now();
  }

  formatStats(): string {
    const s = this.getStats();
    return (
      `🚦 **スケジューラーゲート**\n` +
      `ルール: max=${this.rule.maxConcurrent} concurrent, ${this.rule.rateLimitPerMin}/min\n` +
      `アクティブ: ${this.activePermits.size}/${this.rule.maxConcurrent}\n` +
      `キュー: ${s.queueLength}\n\n` +
      `**統計**\n` +
      `総リクエスト: ${s.totalRequests}\n` +
      `許可: ${s.granted}\n` +
      `拒否: ${s.denied}\n` +
      `スロットル: ${s.throttled}\n` +
      `ピーク同時実行: ${s.peakConcurrent}`
    );
  }
}

// ==================== シングルトン ====================

export const schedulerGate = new SchedulerGate();

export default SchedulerGate;
