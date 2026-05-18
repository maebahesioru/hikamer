// ==========================================
// Aikata - DAG Executor（ViMax agents/camera_image_generator.py 由来）
// 非同期依存タスクグラフ + asyncio.Event連携
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface TaskNode<T = any> {
  id: string;
  label: string;
  /** このタスクの前に完了すべきタスクID */
  dependencies: string[];
  /** 実行関数 */
  execute: (context: ExecutionContext) => Promise<T>;
  /** 結果 */
  result?: T;
  /** 状態 */
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface ExecutionContext {
  getResult: <T>(taskId: string) => T | undefined;
  signal: (taskId: string) => void;
  waitFor: (taskId: string) => Promise<void>;
  abort: () => void;
  isAborted: boolean;
}

// ==================== シグナル ====================

class Signal {
  private resolvers: Array<() => void> = [];
  private _signaled = false;

  signal(): void {
    if (this._signaled) return;
    this._signaled = true;
    for (const r of this.resolvers) r();
    this.resolvers = [];
  }

  async wait(): Promise<void> {
    if (this._signaled) return;
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  reset(): void {
    this._signaled = false;
  }
}

// ==================== DAGエグゼキューター ====================

export class DagExecutor {
  private nodes = new Map<string, TaskNode>();
  private signals = new Map<string, Signal>();
  private aborted = false;
  private concurrency: number;

  constructor(concurrency = 4) {
    this.concurrency = concurrency;
  }

  /** タスクを追加 */
  addNode(node: TaskNode): void {
    this.nodes.set(node.id, { ...node, status: "pending" });
    this.signals.set(node.id, new Signal());
  }

  /** 全タスクを実行 */
  async executeAll(): Promise<void> {
    this.aborted = false;
    const readyQueue: string[] = [];
    const running = new Set<string>();

    // 初期準備完了タスク（依存なし）
    for (const [id, node] of this.nodes) {
      node.status = "pending";
      if (node.dependencies.length === 0) readyQueue.push(id);
    }

    const context: ExecutionContext = {
      getResult: (taskId) => this.nodes.get(taskId)?.result as any,
      signal: (taskId) => this.signals.get(taskId)?.signal(),
      waitFor: async (taskId) => this.signals.get(taskId)?.wait() || Promise.resolve(),
      abort: () => { this.aborted = true; },
      isAborted: false,
    };

    // ワーカー関数
    const worker = async () => {
      while (readyQueue.length > 0 && !this.aborted) {
        const taskId = readyQueue.shift()!;
        if (running.has(taskId)) continue;
        running.add(taskId);

        const node = this.nodes.get(taskId)!;
        node.status = "running";

        try {
          node.result = await node.execute(context);
          node.status = "completed";
          logger.info(`[DAG] ✅ ${node.label} (${node.id})`);

          // 依存が解決したタスクをキューに追加
          for (const [id, n] of this.nodes) {
            if (n.status === "pending" && n.dependencies.every((d) => this.nodes.get(d)?.status === "completed")) {
              if (!running.has(id) && !readyQueue.includes(id)) {
                readyQueue.push(id);
              }
            }
          }

          // シグナル発行
          this.signals.get(taskId)?.signal();
        } catch (e: any) {
          node.status = "failed";
          node.error = e.message;
          logger.error(`[DAG] ❌ ${node.label}: ${e.message}`);

          // 失敗したタスクに依存するタスクをスキップ
          for (const [id, n] of this.nodes) {
            if (n.dependencies.includes(taskId) && n.status === "pending") {
              n.status = "skipped";
              n.error = `Dependency ${taskId} failed`;
              this.signals.get(id)?.signal();
            }
          }
        } finally {
          running.delete(taskId);
        }
      }
    };

    // 並列実行
    const workers = Array.from({ length: Math.min(this.concurrency, this.nodes.size) }, () => worker());
    await Promise.all(workers);
  }

  /** 結果取得 */
  getResult<T>(taskId: string): T | undefined {
    return this.nodes.get(taskId)?.result as T;
  }

  /** 状態 */
  getStatus(): Array<{ id: string; label: string; status: string; error?: string }> {
    return Array.from(this.nodes.values()).map((n) => ({
      id: n.id,
      label: n.label,
      status: n.status,
      error: n.error,
    }));
  }

  formatStatus(): string {
    const statuses = this.getStatus();
    const lines: string[] = ["🔀 **DAG Executor**"];
    for (const s of statuses) {
      const icon = s.status === "completed" ? "✅" : s.status === "running" ? "🟢" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "⏳";
      lines.push(`  ${icon} ${s.label} (${s.id})${s.error ? `: ${s.error}` : ""}`);
    }
    return lines.join("\n");
  }

  /** クリア */
  clear(): void {
    this.nodes.clear();
    this.signals.clear();
    this.aborted = false;
  }
}
