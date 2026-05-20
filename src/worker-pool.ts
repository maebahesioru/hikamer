// ==========================================
// Hikamer - Worker Pool（roborev internal/daemon/worker.go + storage/jobs.go由来）
// DBバックアップジョブ管理 + クレーム/リトライ/フェイルオーバー
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type JobStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface Job {
  id: string;
  type: string;
  data: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  workerId?: string;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs: number;
  cooldownUntil?: number;
}

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  jobTimeoutMs: number;
  retryDelayMs: number;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: WorkerConfig = {
  concurrency: 4,
  pollIntervalMs: 2000,
  jobTimeoutMs: 300000, // 5分
  retryDelayMs: 10000,
};

// ==================== ジョブストア（インメモリ＋JSONL永続化） ====================

class JobStore {
  private jobs = new Map<string, Job>();
  private jobsByStatus = new Map<JobStatus, Set<string>>();
  private maxJobs = 500;

  constructor() {
    for (const s of ["pending", "claimed", "running", "completed", "failed", "cancelled", "timed_out"] as JobStatus[]) {
      this.jobsByStatus.set(s, new Set());
    }
  }

  create(type: string, data: Record<string, unknown>, options?: Partial<Job>): Job {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const job: Job = {
      id,
      type,
      data,
      status: "pending",
      priority: options?.priority ?? 5,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      createdAt: Date.now(),
      timeoutMs: options?.timeoutMs ?? DEFAULT_CONFIG.jobTimeoutMs,
      ...options,
    };
    this.jobs.set(id, job);
    this.jobsByStatus.get("pending")!.add(id);
    this.enforceLimit();
    return job;
  }

  claim(workerId: string, types?: string[]): Job | null {
    const pending = Array.from(this.jobsByStatus.get("pending")!)
      .map((id) => this.jobs.get(id)!)
      .filter((j) => !types || types.includes(j.type))
      .filter((j) => !j.cooldownUntil || j.cooldownUntil < Date.now())
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    for (const job of pending) {
      if (this.transition(job.id, "pending", "claimed")) {
        job.workerId = workerId;
        job.startedAt = Date.now();
        return job;
      }
    }
    return null;
  }

  start(id: string): boolean {
    return this.transition(id, "claimed", "running");
  }

  complete(id: string): boolean {
    const job = this.jobs.get(id);
    if (job) {
      job.completedAt = Date.now();
    }
    return this.transition(id, "running", "completed");
  }

  fail(id: string, error?: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.attempts++;
    job.error = error;

    if (job.attempts >= job.maxAttempts) {
      // 最大リトライ到達
      this.transition(id, "running", "failed");
    } else {
      // リトライ（cooldown付きでpendingに戻す）
      job.cooldownUntil = Date.now() + DEFAULT_CONFIG.retryDelayMs * Math.pow(2, job.attempts);
      this.transition(id, "running", "pending");
    }
    return true;
  }

  cancel(id: string): boolean {
    return this.transition(id, "pending", "cancelled") ||
           this.transition(id, "claimed", "cancelled") ||
           this.transition(id, "running", "cancelled");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listByStatus(status: JobStatus): Job[] {
    return Array.from(this.jobsByStatus.get(status) || [])
      .map((id) => this.jobs.get(id)!)
      .filter(Boolean);
  }

  /** タイムアウトしたジョブを回収 */
  expireTimeouts(): number {
    const now = Date.now();
    let expired = 0;
    for (const job of this.listByStatus("running")) {
      if (job.startedAt && now - job.startedAt > job.timeoutMs) {
        job.error = `Timeout after ${job.timeoutMs}ms`;
        job.completedAt = now;
        this.transition(job.id, "running", "timed_out");
        expired++;
      }
    }
    return expired;
  }

  getStats(): { total: number; byStatus: Record<JobStatus, number> } {
    const byStatus: Record<string, number> = {};
    for (const [status, set] of this.jobsByStatus) {
      byStatus[status] = set.size;
    }
    return { total: this.jobs.size, byStatus: byStatus as Record<JobStatus, number> };
  }

  private transition(id: string, from: JobStatus, to: JobStatus): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== from) return false;

    this.jobsByStatus.get(from)!.delete(id);
    job.status = to;
    this.jobsByStatus.get(to)!.add(id);
    return true;
  }

  private enforceLimit(): void {
    if (this.jobs.size > this.maxJobs) {
      const sorted = Array.from(this.jobs.entries())
        .filter(([, j]) => j.status === "completed" || j.status === "failed" || j.status === "cancelled")
        .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      const toRemove = sorted.slice(0, this.jobs.size - this.maxJobs);
      for (const [id] of toRemove) {
        this.jobs.delete(id);
        this.jobsByStatus.get("completed")?.delete(id);
        this.jobsByStatus.get("failed")?.delete(id);
        this.jobsByStatus.get("cancelled")?.delete(id);
      }
    }
  }
}

// ==================== ワーカープール ====================

class WorkerPool {
  private store = new JobStore();
  private config: WorkerConfig;
  private activeWorkers = 0;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private workerPrefix = `worker_${Date.now().toString(36)}`;

  constructor(config?: Partial<WorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 開始 */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(`[WorkerPool] 開始 (concurrency=${this.config.concurrency})`);
    this.startPolling();
  }

  /** 停止 */
  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    logger.info("[WorkerPool] 停止");
  }

  /** ジョブ作成 */
  createJob(type: string, data: Record<string, unknown>, options?: Partial<Job>): Job {
    return this.store.create(type, data, options);
  }

  /** ジョブ状態取得 */
  getJob(id: string): Job | undefined {
    return this.store.get(id);
  }

  /** ジョブキャンセル */
  cancelJob(id: string): boolean {
    return this.store.cancel(id);
  }

  /** ジョブ完了 */
  completeJob(id: string, result?: Record<string, unknown>): boolean {
    if (result) {
      const job = this.store.get(id);
      if (job) job.data = { ...job.data, result };
    }
    return this.store.complete(id);
  }

  /** ジョブ失敗 */
  failJob(id: string, error?: string): boolean {
    const failed = this.store.fail(id, error);
    if (failed) {
      const job = this.store.get(id);
      if (job && job.status === "failed") {
        eventBus.publish(createEvent("system", "jobFailed", { id, type: job.type, error }));
      }
    }
    return failed;
  }

  /** ワーカー処理関数を登録 */
  registerHandler(type: string, handler: (job: Job) => Promise<void>): void {
    this.handlers.set(type, handler);
  }

  private handlers = new Map<string, (job: Job) => Promise<void>>();

  /** 状態取得 */
  getStats() {
    return {
      ...this.store.getStats(),
      activeWorkers: this.activeWorkers,
      config: this.config,
    };
  }

  /** ポーリングループ */
  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;

      // タイムアウト回収
      this.store.expireTimeouts();

      // ジョブ取得と実行
      while (this.activeWorkers < this.config.concurrency) {
        const job = this.store.claim(this.workerPrefix);
        if (!job) break;

        this.activeWorkers++;
        this.spawnWorker(job);
      }

      this.pollTimer = setTimeout(poll, this.config.pollIntervalMs);
    };
    this.pollTimer = setTimeout(poll, 100);
  }

  /** ワーカースレッド起動 */
  private spawnWorker(job: Job): void {
    const workerId = this.workerPrefix;

    logger.info(`[Worker] ${workerId}: ${job.type} (${job.id})`);

    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.failJob(job.id, `No handler registered for type: ${job.type}`);
      this.activeWorkers--;
      return;
    }

    this.store.start(job.id);

    const timeout = setTimeout(() => {
      logger.warn(`[Worker] ${job.id}: タイムアウト (${job.timeoutMs}ms)`);
      this.failJob(job.id, "Worker timeout");
      this.activeWorkers--;
    }, job.timeoutMs);

    handler(job)
      .then(() => {
        clearTimeout(timeout);
        this.completeJob(job.id);
      })
      .catch((err) => {
        clearTimeout(timeout);
        this.failJob(job.id, err.message);
      })
      .finally(() => {
        this.activeWorkers--;
      });
  }

  formatStatus(): string {
    const stats = this.getStats();
    return [
      "🏭 **Worker Pool**",
      `  状態: ${this.running ? "🟢 動作中" : "🔴 停止中"}`,
      `  アクティブ: ${stats.activeWorkers}/${stats.config.concurrency}`,
      `  ジョブ合計: ${stats.total}`,
      ...Object.entries(stats.byStatus).map(([status, count]) => {
        const icon = status === "running" ? "🟢" : status === "pending" ? "🟡" : status === "completed" ? "✅" : status === "failed" ? "❌" : status === "cancelled" ? "🚫" : status === "timed_out" ? "⏰" : "⚪";
        return `  ${icon} ${status}: ${count}`;
      }),
    ].join("\n");
  }
}

export const workerPool = new WorkerPool();
