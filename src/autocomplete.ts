// ==========================================
// Aikata - オートコンプリート/サジェスト（OpenHuman autocomplete由来）
// コマンド履歴・補完・インテリジェントサジェスト
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface CompletionEntry {
  input: string;
  output: string;
  context: string;
  timestamp: number;
  frequency: number;
  success: boolean;
}

export interface Suggestion {
  text: string;
  score: number;
  source: "history" | "command" | "tool" | "learned";
}

// ==================== サジェストエンジン ====================

class AutocompleteEngine {
  private history: CompletionEntry[] = [];
  private frequentCommands = new Map<string, number>();
  private persistPath: string;
  private maxHistory = 500;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "autocomplete.json");
    this.load();
    this.indexCommands();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        this.history = data.history || [];
        logger.info(`[Autocomplete] 復元: ${this.history.length}履歴`);
      }
    } catch (e) {
      logger.warn(`[Autocomplete] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({ history: this.history }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Autocomplete] 保存失敗: ${e}`);
    }
  }

  /** コマンドパターンをインデックス */
  private indexCommands(): void {
    const cmdPattern = /^\/(\w+)/;
    for (const entry of this.history) {
      const match = entry.input.match(cmdPattern);
      if (match) {
        const cmd = match[1]!;
        this.frequentCommands.set(cmd, (this.frequentCommands.get(cmd) || 0) + 1);
      }
    }
  }

  /** 実行を記録 */
  record(input: string, output: string, context: string, success: boolean): void {
    this.history.push({ input, output: output.slice(0, 200), context, timestamp: Date.now(), frequency: 1, success });
    if (this.history.length > this.maxHistory) this.history.shift();
    this.indexCommands();
    this.save();
  }

  /** サジェスト生成 */
  suggest(partial: string, limit: number = 5): Suggestion[] {
    const results: Suggestion[] = [];
    const lower = partial.toLowerCase();

    // 1. コマンド履歴からのサジェスト
    if (partial.startsWith("/")) {
      const cmd = partial.slice(1).toLowerCase();
      for (const [command, freq] of Array.from(this.frequentCommands)) {
        if (command.startsWith(cmd)) {
          results.push({ text: `/${command}`, score: freq * 0.1, source: "history" });
        }
      }
    }

    // 2. 入力履歴からのサジェスト
    for (const entry of this.history) {
      if (entry.input.toLowerCase().includes(lower) && entry.input !== partial) {
        results.push({ text: entry.input, score: entry.frequency * (entry.success ? 1 : 0.3), source: "history" });
      }
    }

    // 3. システムコマンド
    this.addBuiltinCommands(partial, results);

    // スコア降順
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** ビルトインコマンド追加 */
  private addBuiltinCommands(partial: string, results: Suggestion[]): void {
    const commands = [
      "/cost", "/health", "/tools", "/reset", "/ratelimit", "/inject",
      "/approve", "/reject", "/pending", "/creds", "/notif", "/routes",
      "/context", "/kanban", "/update", "/plugins", "/mail",
      "/sessions", "/ocr", "/heal", "/contacts",
      "/sandbox", "/config", "/usage", "/learn",
      "/flags", "/obsidian", "/supervisor",
    ];

    const lower = partial.toLowerCase();
    for (const cmd of commands) {
      if (cmd.startsWith(lower) && !results.some(r => r.text === cmd)) {
        results.push({ text: cmd, score: 5, source: "command" });
      }
    }
  }

  /** 人気コマンドTOP */
  getPopularCommands(limit: number = 10): string[] {
    return Array.from(this.frequentCommands.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([cmd]) => `/${cmd}`);
  }

  /** 最近の履歴 */
  getRecent(limit: number = 10): CompletionEntry[] {
    return this.history.slice(-limit).reverse();
  }

  get stats(): { totalEntries: number; uniqueCommands: number; popular: string } {
    return {
      totalEntries: this.history.length,
      uniqueCommands: this.frequentCommands.size,
      popular: this.getPopularCommands(5).join(", "),
    };
  }

  formatSuggestions(partial: string): string {
    const suggestions = this.suggest(partial);
    if (suggestions.length === 0) return "サジェストはありません。";
    return `💡 **サジェスト**: ${suggestions.map(s => `\`${s.text}\``).join(", ")}`;
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const autocomplete = new AutocompleteEngine(DATA_DIR);
