// ==========================================
// Aikata - 並列エージェントWorktree分離
// 出典: Orca (stablyai/orca) Parallel Agent Worktree Strategy
// 各サブエージェントに独立したGit Worktreeを割り当て
// ==========================================

import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

const WORKTREE_BASE = resolve(process.env.DATA_DIR || "./data", "agent-worktrees");
const MAX_CONCURRENT = parseInt(process.env.MAX_WORKTREES || "3", 10);

// ==================== Worktree ====================

interface Worktree {
  id: string;
  path: string;
  branch: string;
  agentId: string;
  locked: boolean;
  createdAt: number;
  lastUsedAt: number;
}

// ==================== WorktreeManager ====================

class WorktreeManager {
  private worktrees = new Map<string, Worktree>();
  private nextId = 1;
  private baseRepo: string;

  constructor(baseRepo?: string) {
    this.baseRepo = baseRepo || resolve(process.env.HOME || "/root", "Desktop/Aikata");
    if (!existsSync(WORKTREE_BASE)) {
      mkdirSync(WORKTREE_BASE, { recursive: true });
    }
  }

  /**
   * 新しいエージェント用に独立したWorktreeを作成
   * Orca: git worktree add --detach
   */
  create(agentId: string, label?: string): Worktree | null {
    if (this.worktrees.size >= MAX_CONCURRENT) {
      logger.warn(`[WorktreeManager] 上限到達: ${MAX_CONCURRENT}台`);
      return null;
    }

    const id = `wt-${this.nextId++}`;
    const branch = `agent/${agentId.slice(0, 12)}/${Date.now().toString(36)}`;
    const path = resolve(WORKTREE_BASE, id);

    try {
      // 専用ブランチを作成
      execSync(`git branch ${branch} 2>/dev/null || true`, {
        cwd: this.baseRepo, stdio: "pipe", timeout: 5000,
      });

      // Worktreeを作成
      execSync(`git worktree add --detach "${path}" ${branch} 2>/dev/null || mkdir -p "${path}"`, {
        cwd: this.baseRepo, stdio: "pipe", timeout: 10000,
      });

      const wt: Worktree = {
        id, path, branch, agentId, locked: false,
        createdAt: Date.now(), lastUsedAt: Date.now(),
      };

      this.worktrees.set(id, wt);
      logger.info(`[WorktreeManager] 作成: ${id} agent=${agentId} branch=${branch}`);
      return wt;
    } catch (e: any) {
      logger.warn(`[WorktreeManager] 作成失敗: ${agentId} — ${e.message}`);
      return null;
    }
  }

  /**
   * エージェントにWorktreeを割り当て（再利用または新規作成）
   */
  assign(agentId: string): Worktree | null {
    // 既存の割り当てを探す（10分以内の未使用）
    const now = Date.now();
    const reusable = Array.from(this.worktrees.values())
      .find(w => !w.locked && w.agentId === agentId && now - w.lastUsedAt < 600000);

    if (reusable) {
      reusable.locked = true;
      reusable.lastUsedAt = now;
      logger.debug(`[WorktreeManager] 再利用: ${reusable.id}`);
      return reusable;
    }

    return this.create(agentId);
  }

  /**
   * Worktreeのロックを解除
   */
  release(worktreeId: string): void {
    const wt = this.worktrees.get(worktreeId);
    if (wt) {
      wt.locked = false;
      wt.lastUsedAt = Date.now();
    }
  }

  /**
   * Worktreeを破棄（エージェント完了時）
   * Orca: cleanup after agent completes
   */
  destroy(worktreeId: string): boolean {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return false;

    try {
      // Worktreeを削除
      execSync(`git worktree remove --force "${wt.path}" 2>/dev/null || true`, {
        cwd: this.baseRepo, stdio: "pipe", timeout: 10000,
      });
      // ブランチを削除
      execSync(`git branch -D ${wt.branch} 2>/dev/null || true`, {
        cwd: this.baseRepo, stdio: "pipe", timeout: 5000,
      });
      // ディレクトリを削除
      rmSync(wt.path, { recursive: true, force: true });

      this.worktrees.delete(worktreeId);
      logger.info(`[WorktreeManager] 破棄: ${worktreeId}`);
      return true;
    } catch (e: any) {
      logger.warn(`[WorktreeManager] 破棄失敗: ${worktreeId} — ${e.message}`);
      return false;
    }
  }

  /**
   * 全Worktreeをクリーンアップ
   */
  cleanupAll(): number {
    let count = 0;
    Array.from(this.worktrees.keys()).forEach(id => {
      if (this.destroy(id)) count++;
    });
    return count;
  }

  /**
   * 統計情報
   */
  getStats(): { total: number; locked: number; available: number; max: number } {
    let locked = 0;
    Array.from(this.worktrees.values()).forEach(wt => {
      if (wt.locked) locked++;
    });
    return {
      total: this.worktrees.size,
      locked,
      available: this.worktrees.size - locked,
      max: MAX_CONCURRENT,
    };
  }

  /**
   * 全Worktreeを表示
   */
  list(): Worktree[] {
    return Array.from(this.worktrees.values());
  }
}

// ==================== ParallelAgentPool (Orcaのパターン) ====================

// ==================== ParallelAgentPool (Orcaのパターン) ====================

interface PoolTask {
  id: string;
  agentId: string;
  command: string;
  args: string[];
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

class ParallelAgentPool {
  private worktrees: WorktreeManager;
  private queue: PoolTask[] = [];
  private active = new Map<string, PoolTask>();
  private completed: PoolTask[] = [];

  constructor(worktrees?: WorktreeManager) {
    this.worktrees = worktrees || new WorktreeManager();
  }

  /**
   * タスクをキューに追加
   */
  enqueue(agentId: string, command: string, args: string[]): PoolTask {
    const task: PoolTask = {
      id: `task-${Date.now().toString(36)}`,
      agentId, command, args, status: "queued",
    };
    this.queue.push(task);
    logger.info(`[AgentPool] キュー追加: ${task.id} ${command}`);
    return task;
  }

  /**
   * 可能な限りタスクを並列実行
   */
  async executeAll(): Promise<PoolTask[]> {
    const results: PoolTask[] = [];

    while (this.queue.length > 0 || this.active.size > 0) {
      // 空きがあればキューから取って実行
      while (this.queue.length > 0 && this.active.size < MAX_CONCURRENT) {
        const task = this.queue.shift()!;
        this.runTask(task);
      }

      // アクティブタスクをチェック
      await new Promise(r => setTimeout(r, 1000));
      this.sweepCompleted();
    }

    return [...this.completed];
  }

  private async runTask(task: PoolTask): Promise<void> {
    const wt = this.worktrees.assign(task.agentId);
    if (!wt) {
      task.status = "failed";
      task.error = "Worktree不足";
      task.completedAt = Date.now();
      this.completed.push(task);
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();
    this.active.set(task.id, task);

    try {
      const fullCmd = `${task.command} ${task.args.join(" ")}`;
      const result = execSync(fullCmd, {
        cwd: wt.path, stdio: "pipe", timeout: 300000,
      });

      task.status = "completed";
      task.result = result.toString("utf-8").slice(0, 5000);
      logger.info(`[AgentPool] 完了: ${task.id}`);
    } catch (e: any) {
      task.status = "failed";
      task.error = e.message;
      task.result = e.stdout?.toString("utf-8").slice(0, 1000) || "";
      logger.warn(`[AgentPool] 失敗: ${task.id} — ${e.message}`);
    }

    task.completedAt = Date.now();
    this.active.delete(task.id);
    this.worktrees.release(wt.id);
    this.completed.push(task);
  }

  private sweepCompleted(): void {
    const now = Date.now();
    Array.from(this.active.entries()).forEach(([id, task]) => {
      if (task.startedAt && now - task.startedAt > 600000) {
        task.status = "failed";
        task.error = "タイムアウト";
        task.completedAt = now;
        this.active.delete(id);
        this.completed.push(task);
      }
    });
  }

  getQueueLength(): number { return this.queue.length; }
  getActiveCount(): number { return this.active.size; }
  getCompletedCount(): number { return this.completed.length; }
}

export const worktreeManager = new WorktreeManager();
export { WorktreeManager, ParallelAgentPool };
