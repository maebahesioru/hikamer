// ==========================================
// Aikata - シェルフック（Hermes Agent shell_hooks.py 由来）
// シェル統合・コマンド履歴・環境管理
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ==================== 型定義 ====================

export type HookType = "pre_command" | "post_command" | "on_error" | "on_startup" | "on_shutdown";

export interface ShellHook {
  name: string;
  type: HookType;
  command: string;
  enabled: boolean;
  runCount: number;
  lastRun: number | null;
}

export interface CommandHistoryEntry {
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  timestamp: number;
  output: string;
}

export interface ShellConfig {
  shell: string;
  historySize: number;
  maxOutputLines: number;
  recordHistory: boolean;
  autoSourceRc: boolean;
  envVars: Record<string, string>;
}

// ==================== シェルマネージャー ====================

class ShellManager {
  private hooks: ShellHook[] = [];
  private history: CommandHistoryEntry[] = [];
  private config: ShellConfig;
  private initialized = false;
  private maxHistory = 200;

  constructor() {
    this.config = {
      shell: process.env.SHELL || "/bin/bash",
      historySize: 1000,
      maxOutputLines: 200,
      recordHistory: true,
      autoSourceRc: false,
      envVars: {},
    };
  }

  init(): void {
    if (this.initialized) return;
    this.loadDefaultHooks();
    this.initialized = true;
    logger.info(`[Shell] initialized: ${this.config.shell}`);
  }

  /** コマンドを実行 */
  async execute(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<CommandHistoryEntry> {
    const start = Date.now();
    const cwd = options?.cwd ?? process.cwd();

    // プリフックを実行
    await this.runHooks("pre_command");

    let exitCode = 0;
    let output = "";

    try {
      // 環境変数のマージ
      const env = {
        ...process.env,
        ...this.config.envVars,
        ...(options?.env ?? {}),
      };

      const result = execSync(command, {
        cwd,
        timeout: options?.timeout ?? 30000,
        env: env as NodeJS.ProcessEnv,
        maxBuffer: 1024 * 1024, // 1MB
      });
      output = result.toString().trim();
    } catch (err) {
      exitCode = 1;
      output = err instanceof Error ? err.message : String(err);
      await this.runHooks("on_error");
    }

    const entry: CommandHistoryEntry = {
      command,
      cwd,
      exitCode,
      durationMs: Date.now() - start,
      timestamp: Date.now(),
      output: this.truncateOutput(output),
    };

    // 履歴に追加
    if (this.config.recordHistory) {
      this.history.push(entry);
      if (this.history.length > this.maxHistory) {
        this.history = this.history.slice(-this.maxHistory);
      }
    }

    // ポストフック
    await this.runHooks("post_command");

    return entry;
  }

  /** フックを登録 */
  addHook(hook: ShellHook): void {
    this.hooks.push(hook);
  }

  /** フックの有効/無効 */
  setHookEnabled(name: string, enabled: boolean): boolean {
    const hook = this.hooks.find((h) => h.name === name);
    if (!hook) return false;
    hook.enabled = enabled;
    return true;
  }

  /** フック一覧 */
  listHooks(): ShellHook[] {
    return [...this.hooks];
  }

  /** コマンド履歴 */
  getHistory(limit = 20): CommandHistoryEntry[] {
    return this.history.slice(-limit).reverse();
  }

  /** 履歴を検索 */
  searchHistory(query: string): CommandHistoryEntry[] {
    const lower = query.toLowerCase();
    return this.history
      .filter((e) => e.command.toLowerCase().includes(lower))
      .slice(-20)
      .reverse();
  }

  /** 設定の更新 */
  setConfig(config: Partial<ShellConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 環境変数を設定 */
  setEnv(key: string, value: string): void {
    this.config.envVars[key] = value;
  }

  /** 起動スクリプトを生成 */
  generateRcScript(): string {
    const lines = [
      "# Aikata shell integration",
      "# Generated for " + this.config.shell,
      "",
      "# Aliases",
      'alias aikata="node /path/to/aikata"',
      'alias ai="aikata"',
      "",
      "# Environment",
      'export AIKATA_SHELL_INTEGRATION="1"',
    ];

    for (const [key, value] of Object.entries(this.config.envVars)) {
      lines.push(`export ${key}="${value}"`);
    }

    return lines.join("\n");
  }

  /** 履歴をクリア */
  clearHistory(): void {
    this.history = [];
  }

  // ---- 内部 ----

  private async runHooks(type: HookType): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.enabled || hook.type !== type) continue;
      try {
        execSync(hook.command, { timeout: 5000, stdio: "ignore" });
        hook.runCount++;
        hook.lastRun = Date.now();
      } catch {
        // フックの失敗は無視
      }
    }
  }

  private truncateOutput(output: string): string {
    const lines = output.split("\n");
    if (lines.length <= this.config.maxOutputLines) return output;
    return (
      lines.slice(0, this.config.maxOutputLines).join("\n") +
      `\n... [${lines.length - this.config.maxOutputLines} lines truncated]`
    );
  }

  private loadDefaultHooks(): void {
    this.addHook({
      name: "log-commands",
      type: "post_command",
      command: "echo",
      enabled: true,
      runCount: 0,
      lastRun: null,
    });
  }

  formatHistory(entries: CommandHistoryEntry[]): string {
    return entries
      .map(
        (e, i) =>
          `${i + 1}. ${e.exitCode === 0 ? "✅" : "❌"} \`${e.command.slice(0, 60)}\`` +
          ` (${e.durationMs}ms)` +
          (e.exitCode !== 0 ? ` exit: ${e.exitCode}` : "") +
          `\n   📂 ${e.cwd}`
      )
      .join("\n\n");
  }

  formatConfig(): string {
    return (
      `🐚 **シェル設定**\n` +
      `シェル: ${this.config.shell}\n` +
      `履歴記録: ${this.config.recordHistory ? "✅" : "❌"}\n` +
      `履歴件数: ${this.history.length}\n` +
      `フック数: ${this.hooks.length}\n` +
      `履歴最大: ${this.config.historySize}\n` +
      `最大出力行: ${this.config.maxOutputLines}`
    );
  }
}

// ==================== シングルトン ====================

export const shellManager = new ShellManager();

export default ShellManager;
