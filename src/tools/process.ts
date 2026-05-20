// ==========================================
// Hikamer - バックグラウンドプロセス管理（OpenClaw由来）
// 長時間プロセスのライフサイクル管理
// ==========================================

import { spawn, ChildProcess } from "child_process";
import { platform } from "os";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";
import { cleanTerminalOutput } from "../ansi-strip";

const isWindows = platform() === "win32";

// ==================== プロセス管理 ====================

interface ProcessEntry {
  id: string;
  proc: ChildProcess;
  command: string;
  startedAt: number;
  status: "running" | "exited" | "killed" | "error";
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  label?: string;
}

class ProcessRegistry {
  private processes = new Map<string, ProcessEntry>();
  private nextId = 0;

  /** プロセスを生成して起動 */
  spawn(
    command: string,
    options?: {
      args?: string[];
      workdir?: string;
      label?: string;
      timeoutMs?: number;
    },
  ): string {
    const id = `proc-${++this.nextId}-${Date.now().toString(36)}`;

    const shell = isWindows ? "cmd.exe" : "/bin/bash";
    const proc = spawn(shell, isWindows ? ["/c", command] : ["-c", command], {
      cwd: options?.workdir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    });

    const entry: ProcessEntry = {
      id,
      proc,
      command,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      stdout: [],
      stderr: [],
      label: options?.label,
    };

    proc.stdout?.on("data", (data: Buffer) => {
      entry.stdout.push(data.toString());
      // 出力が肥大化しないように制限
      if (entry.stdout.length > 100) entry.stdout.shift();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      entry.stderr.push(data.toString());
      if (entry.stderr.length > 100) entry.stderr.shift();
    });

    proc.on("exit", (code) => {
      entry.status = code === 0 ? "exited" : "error";
      entry.exitCode = code;
      logger.info(`プロセス終了: ${id} (code=${code})`);
    });

    proc.on("error", (err) => {
      entry.status = "error";
      logger.error(`プロセスエラー: ${id} — ${err.message}`);
    });

    // タイムアウト
    if (options?.timeoutMs && options.timeoutMs > 0) {
      setTimeout(() => {
        if (entry.status === "running") {
          this.kill(id);
        }
      }, options.timeoutMs);
    }

    this.processes.set(id, entry);
    logger.info(`プロセス開始: ${id} → "${command.slice(0, 80)}"`);

    return id;
  }

  /** プロセス状態取得 */
  getStatus(id: string): ProcessEntry | undefined {
    return this.processes.get(id);
  }

  /** 全プロセス一覧 */
  list(): ProcessEntry[] {
    return Array.from(this.processes.values());
  }

  /** 実行中のプロセス一覧 */
  listRunning(): ProcessEntry[] {
    return Array.from(this.processes.values()).filter(p => p.status === "running");
  }

  /** プロセス強制終了 */
  kill(id: string, graceMs = 3000): boolean {
    const entry = this.processes.get(id);
    if (!entry) return false;
    if (entry.status !== "running") return true;

    entry.status = "killed";

    try {
      if (isWindows) {
        // Windows: taskkill /T でプロセスツリーごと
        spawn("taskkill", ["/PID", String(entry.proc.pid), "/T", "/F"]);
      } else {
        // Unix: プロセスグループごとSIGTERM → SIGKILL
        const pgid = -entry.proc.pid!;
        process.kill(pgid, "SIGTERM");
        setTimeout(() => {
          try { process.kill(pgid, "SIGKILL"); } catch {}
        }, graceMs);
      }
    } catch {
      entry.proc.kill("SIGKILL");
    }

    return true;
  }

  /** 全プロセス強制終了 */
  killAll(): void {
    for (const id of this.processes.keys()) {
      this.kill(id);
    }
  }

  /** プロセスの出力取得 */
  getOutput(id: string, maxLines = 200): string {
    const entry = this.processes.get(id);
    if (!entry) return "[プロセスが見つかりません]";

    const stdout = entry.stdout.join("").split("\n").slice(-maxLines).join("\n");
    const stderr = entry.stderr.join("").split("\n").slice(-Math.floor(maxLines / 2)).join("\n");

    let result = `[PID: ${entry.proc.pid}] 状態: ${entry.status}`;
    if (entry.exitCode !== null) result += ` (exit=${entry.exitCode})`;
    if (entry.label) result += ` ラベル: ${entry.label}`;
    result += `\nコマンド: ${entry.command}\n`;

    if (stdout) result += `\n--- stdout ---\n${cleanTerminalOutput(stdout)}`;
    if (stderr) result += `\n--- stderr ---\n${cleanTerminalOutput(stderr)}`;

    return result;
  }
}

// ==================== グローバルインスタンス ====================

export const processRegistry = new ProcessRegistry();

// プロセス終了時にクリーンアップ
process.on("exit", () => processRegistry.killAll());
process.on("SIGINT", () => { processRegistry.killAll(); process.exit(0); });
process.on("SIGTERM", () => { processRegistry.killAll(); process.exit(0); });

// ==================== ツール ====================

const spawnTool: ToolDescriptor = {
  name: "spawn_process",
  emoji: "⚙️",
  owner: "core",
  description: "バックグラウンドでプロセスを起動します（長時間タスク/サーバー起動等）。戻り値はプロセスIDです。",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "実行するコマンド",
      },
      label: {
        type: "string",
        description: "プロセスの識別ラベル",
      },
      timeout: {
        type: "number",
        description: "タイムアウト（ミリ秒、0=無制限）",
        default: 0,
      },
      workdir: {
        type: "string",
        description: "作業ディレクトリ",
      },
    },
    required: ["command"],
  },
  async execute(args) {
    const command = args.command as string;
    const label = args.label as string | undefined;
    const timeout = (args.timeout as number) || 0;
    const workdir = args.workdir as string | undefined;

    const id = processRegistry.spawn(command, { label, timeoutMs: timeout || undefined, workdir });
    return `⚙️ プロセス開始: \`${id}\`\nコマンド: \`${command.slice(0, 200)}\`\n\n状態確認: \`process_status id=${id}\`\n出力確認: \`process_output id=${id}\``;
  },
};

const statusTool: ToolDescriptor = {
  name: "process_status",
  emoji: "📊",
  owner: "core",
  description: "バックグラウンドプロセスの状態を確認します。id省略時は全プロセス一覧。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "プロセスID（省略時は全プロセス一覧）",
      },
    },
    required: [],
  },
  async execute(args) {
    const id = args.id as string | undefined;

    if (id) {
      const entry = processRegistry.getStatus(id);
      if (!entry) return `📊 プロセス \`${id}\` は見つかりません。`;
      const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(1);
      return `📊 **${id}**\n` +
        `状態: ${entry.status}\n` +
        `コマンド: \`${entry.command.slice(0, 100)}\`\n` +
        `稼働時間: ${elapsed}s\n` +
        `PID: ${entry.proc.pid}\n` +
        (entry.label ? `ラベル: ${entry.label}\n` : "") +
        (entry.exitCode !== null ? `終了コード: ${entry.exitCode}\n` : "");
    }

    const all = processRegistry.list();
    if (all.length === 0) return "📊 アクティブなプロセスはありません。";

    const lines = all.map(e => {
      const elapsed = ((Date.now() - e.startedAt) / 1000).toFixed(1);
      return `• \`${e.id}\` [${e.status}] ${e.command.slice(0, 60)} — ${elapsed}s${e.label ? ` (${e.label})` : ""}`;
    });

    return `📊 **プロセス一覧** (${all.length}件)\n${lines.join("\n")}`;
  },
};

const outputTool: ToolDescriptor = {
  name: "process_output",
  emoji: "📄",
  owner: "core",
  description: "バックグラウンドプロセスの出力を取得します。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "プロセスID",
      },
      lines: {
        type: "number",
        description: "表示する行数（デフォルト100）",
        default: 100,
      },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = args.id as string;
    const lines = Math.min((args.lines as number) || 100, 500);
    if (!id) return "[エラー] id が必要です";
    const output = processRegistry.getOutput(id, lines);
    return output.slice(0, 15000);
  },
};

const killTool: ToolDescriptor = {
  name: "process_kill",
  emoji: "🛑",
  owner: "core",
  description: "バックグラウンドプロセスを強制終了します。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "強制終了するプロセスID",
      },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = args.id as string;
    if (!id) return "[エラー] id が必要です";
    const ok = processRegistry.kill(id);
    return ok ? `🛑 プロセス \`${id}\` を終了しました。` : `🛑 プロセス \`${id}\` は見つかりません。`;
  },
};

toolRegistry.register(spawnTool);
toolRegistry.register(statusTool);
toolRegistry.register(outputTool);
toolRegistry.register(killTool);

export { spawnTool, statusTool, outputTool, killTool };
