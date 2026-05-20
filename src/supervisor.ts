// ==========================================
// Hikamer - プロセススーパーバイザー（OpenHuman core restart/shutdown由来）
// プロセス自動再起動・死活監視・クラッシュ検出
// ==========================================

import { fork, ChildProcess } from "child_process";
import { resolve } from "path";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface ManagedProcess {
  name: string;
  script: string;
  args: string[];
  pid: number | null;
  status: "stopped" | "running" | "crashed" | "restarting";
  startedAt: number;
  restartCount: number;
  maxRestarts: number;
  restartDelay: number;
  lastExitCode: number | null;
  watchInterval: number;
  healthCheck?: () => Promise<boolean>;
}

interface SupervisorConfig {
  maxConcurrentRestarts: number;
  defaultMaxRestarts: number;
  defaultRestartDelay: number;
  defaultWatchInterval: number;
}

// ==================== スーパーバイザー ====================

class ProcessSupervisor {
  private processes = new Map<string, ManagedProcess>();
  private children = new Map<string, ChildProcess>();
  private config: SupervisorConfig;
  private watchInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<SupervisorConfig>) {
    this.config = {
      maxConcurrentRestarts: 3,
      defaultMaxRestarts: 5,
      defaultRestartDelay: 2000,
      defaultWatchInterval: 15000,
      ...config,
    };
  }

  /** プロセス登録 */
  register(name: string, script: string, options?: {
    args?: string[];
    maxRestarts?: number;
    restartDelay?: number;
    watchInterval?: number;
    healthCheck?: () => Promise<boolean>;
  }): void {
    const process: ManagedProcess = {
      name,
      script,
      args: options?.args || [],
      pid: null,
      status: "stopped",
      startedAt: 0,
      restartCount: 0,
      maxRestarts: options?.maxRestarts || this.config.defaultMaxRestarts,
      restartDelay: options?.restartDelay || this.config.defaultRestartDelay,
      lastExitCode: null,
      watchInterval: options?.watchInterval || this.config.defaultWatchInterval,
      healthCheck: options?.healthCheck,
    };

    this.processes.set(name, process);
    logger.info(`[Supervisor] 登録: ${name} (${script})`);
  }

  /** プロセス開始 */
  start(name: string): boolean {
    const proc = this.processes.get(name);
    if (!proc) return false;
    if (proc.status === "running") return true;

    const scriptPath = resolve(proc.script);

    try {
      const child = fork(scriptPath, proc.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AIKATA_CHILD: "1", AIKATA_PARENT_PID: String(process.pid) },
      });

      proc.pid = child.pid || null;
      proc.status = "running";
      proc.startedAt = Date.now();

      const cp = child;

      child.stdout?.on("data", (data: Buffer) => {
        logger.info(`[${name}] ${data.toString().trim()}`);
      });

      child.stderr?.on("data", (data: Buffer) => {
        logger.warn(`[${name}] ${data.toString().trim()}`);
      });

      child.on("exit", (code, signal) => {
        proc.lastExitCode = code;
        const crashed = code !== 0 && code !== null;

        if (crashed) {
          proc.restartCount++;
          logger.warn(`[Supervisor] 異常終了: ${name} (code=${code}, signal=${signal}) — ${proc.restartCount}/${proc.maxRestarts}`);

          if (proc.restartCount <= proc.maxRestarts) {
            proc.status = "restarting";
            setTimeout(() => this.start(name), proc.restartDelay);
          } else {
            proc.status = "crashed";
            logger.error(`[Supervisor] 最大リトライ超過: ${name}`);
            eventBus.publish(createEvent("error", "processCrashed", { name, code, restartCount: proc.restartCount }));
          }
        } else {
          proc.status = "stopped";
          logger.info(`[Supervisor] 正常終了: ${name}`);
        }

        this.children.delete(name);
        proc.pid = null;
      });

      child.on("error", (err) => {
        logger.error(`[Supervisor] プロセスエラー: ${name} — ${err.message}`);
        this.children.delete(name);
      });

      this.children.set(name, child);
      logger.info(`[Supervisor] 開始: ${name} (pid=${proc.pid})`);
      eventBus.publish(createEvent("system", "processStarted", { name, pid: proc.pid }));
      return true;
    } catch (e: any) {
      logger.error(`[Supervisor] 起動失敗: ${name} — ${e.message}`);
      proc.status = "crashed";
      return false;
    }
  }

  /** プロセス停止 */
  stop(name: string, graceMs: number = 5000): boolean {
    const child = this.children.get(name);
    if (!child) return false;

    const proc = this.processes.get(name);
    if (proc) proc.status = "stopped";

    try {
      child.send({ type: "shutdown", graceMs });
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, graceMs);

      // SIGTERM
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
      }, 500);

      logger.info(`[Supervisor] 停止: ${name}`);
      return true;
    } catch {
      try { child.kill("SIGKILL"); } catch {}
      return true;
    }
  }

  /** 全停止 */
  stopAll(): void {
    for (const name of Array.from(this.children.keys())) {
      this.stop(name);
    }
  }

  /** 再起動 */
  restart(name: string): boolean {
    this.stop(name);
    const proc = this.processes.get(name);
    if (proc) proc.restartCount = 0;
    setTimeout(() => this.start(name), 1000);
    return true;
  }

  /** 全プロセスを起動 */
  startAll(): void {
    for (const name of Array.from(this.processes.keys())) {
      this.start(name);
    }
  }

  /** 状態一覧 */
  listProcesses(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  /** ヘルスチェック監視 */
  startHealthWatch(): void {
    if (this.watchInterval) return;

    this.watchInterval = setInterval(() => {
      for (const [name, proc] of Array.from(this.processes)) {
        if (proc.status === "running") {
          // 子プロセス生存確認
          const child = this.children.get(name);
          if (!child || child.killed || child.exitCode !== null) {
            logger.warn(`[Supervisor] プロセス消失検出: ${name}`);
            if (proc.restartCount < proc.maxRestarts) {
              proc.restartCount++;
              setTimeout(() => this.start(name), proc.restartDelay);
            } else {
              proc.status = "crashed";
            }
          }
        }
      }
    }, 5000);

    logger.info(`[Supervisor] ヘルス監視開始 (5秒間隔)`);
  }

  /** フォーマット */
  formatStatus(): string {
    const list = this.listProcesses();
    if (list.length === 0) return "🔄 管理下のプロセスはありません。";

    return [
      "🔄 **プロセススーパーバイザー**",
      "",
      ...list.map(p => {
        const icon = p.status === "running" ? "✅" : p.status === "crashed" ? "❌" : p.status === "restarting" ? "🔄" : "⏸️";
        const uptime = p.status === "running" ? ` (${Math.floor((Date.now() - p.startedAt) / 1000)}s)` : "";
        return `${icon} **${p.name}** [${p.status}]${uptime}\n` +
          `   スクリプト: ${p.script}\n` +
          `   PID: ${p.pid || "-"} | 再起動: ${p.restartCount}/${p.maxRestarts} | 最終exit: ${p.lastExitCode ?? "-"}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const supervisor = new ProcessSupervisor();
