// ==========================================
// Aikata - インラインオートコンプリート（OpenHuman autocomplete/ 完全移植）
// コンテキスト認識インライン補完 + 受入履歴 + セマンティック検索
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ==================== 型定義 ====================

export interface AutocompleteSuggestion {
  value: string;
  confidence: number;
}

export interface AutocompleteStatus {
  enabled: boolean;
  running: boolean;
  debounceMs: number;
  appName: string | null;
  lastError: string | null;
  suggestion: AutocompleteSuggestion | null;
}

export interface AutocompleteConfig {
  enabled: boolean;
  debounceMs: number;
  maxChars: number;
  disabledApps: string[];
  acceptWithTab: boolean;
}

export interface AcceptedCompletion {
  context: string;
  suggestion: string;
  appName: string | null;
  timestampMs: number;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: AutocompleteConfig = {
  enabled: true,
  debounceMs: 300,
  maxChars: 64,
  disabledApps: [],
  acceptWithTab: true,
};

// ==================== エンジン ====================

class AutocompleteEngine {
  private config: AutocompleteConfig = { ...DEFAULT_CONFIG };
  private enabled = false;
  private running = false;
  private appName: string | null = null;
  private context = "";
  private suggestion: AutocompleteSuggestion | null = null;
  private lastError: string | null = null;
  private history: AcceptedCompletion[] = [];
  private maxHistory = 50;

  /** 状態取得 */
  getStatus(): AutocompleteStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      debounceMs: this.config.debounceMs,
      appName: this.appName,
      lastError: this.lastError,
      suggestion: this.suggestion,
    };
  }

  /** 設定 */
  configure(cfg: Partial<AutocompleteConfig>): void {
    this.config = { ...this.config, ...cfg };
    logger.info(`[Autocomplete] 設定更新: debounce=${this.config.debounceMs}ms, tab=${this.config.acceptWithTab}`);
  }

  /** 有効化 */
  enable(): void {
    this.enabled = true;
    this.running = true;
    logger.info("[Autocomplete] 有効化");
  }

  /** 無効化 */
  disable(): void {
    this.enabled = false;
    this.running = false;
    this.suggestion = null;
    logger.info("[Autocomplete] 無効化");
  }

  /** コンテキストを設定（エディタ/ターミナルの前面テキスト） */
  setContext(text: string, appName?: string): void {
    this.context = text;
    if (appName) this.appName = appName;

    if (this.isAppDisabled()) {
      this.suggestion = null;
      return;
    }
  }

  /** LLMからの提案を受け付け */
  setSuggestion(suggestion: string, confidence: number): void {
    const sanitized = this.sanitizeSuggestion(suggestion);
    if (this.isLowQuality(sanitized)) {
      this.suggestion = null;
      return;
    }

    this.suggestion = { value: sanitized, confidence };
  }

  /** 提案を受理 */
  acceptSuggestion(suggestion?: string): AcceptedCompletion | null {
    const text = suggestion || this.suggestion?.value;
    if (!text) return null;

    const entry: AcceptedCompletion = {
      context: this.context.slice(-40),
      suggestion: text,
      appName: this.appName,
      timestampMs: Date.now(),
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.saveHistory();

    this.suggestion = null;
    return entry;
  }

  /** 提案を却下 */
  rejectSuggestion(): void {
    this.suggestion = null;
  }

  /** 最近の履歴を取得 */
  getRecentExamples(n = 5): string[] {
    return this.history.slice(-n).map(
      (h) => `Context: "${h.context}" → Accepted: "${h.suggestion}" (${h.appName || "unknown"})`,
    );
  }

  /** コンテキスト類似度で関連例を検索 */
  queryRelevantExamples(context: string, n = 3): string[] {
    const ctxTail = context.slice(-40).toLowerCase();
    return this.history
      .filter((h) => h.context.toLowerCase().includes(ctxTail) || ctxTail.includes(h.context.toLowerCase()))
      .slice(-n)
      .map((h) => `Context: "${h.context}" → "${h.suggestion}"`);
  }

  /** 履歴クリア */
  clearHistory(): number {
    const count = this.history.length;
    this.history = [];
    this.saveHistory();
    return count;
  }

  /** 状態ファイル関連 */
  private historyPath(): string {
    return resolve(process.env.DATA_DIR || "./data", "autocomplete-history.json");
  }

  private loadHistory(): void {
    const path = this.historyPath();
    try {
      if (existsSync(path)) {
        this.history = JSON.parse(readFileSync(path, "utf-8"));
      }
    } catch { /* ignore */ }
  }

  private saveHistory(): void {
    const path = this.historyPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.history.slice(-this.maxHistory)), "utf-8");
  }

  // ==================== ユーティリティ ====================

  /** 提案をサニタイズ */
  private sanitizeSuggestion(text: string): string {
    return text
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .replace(/^[-*+>]\s+/, "")
      .replace(/^\t+/, "")
      .split("\n")[0]!
      .slice(0, this.config.maxChars)
      .trim();
  }

  /** 低品質チェック */
  private isLowQuality(suggestion: string): boolean {
    if (!suggestion || suggestion.length < 3) return true;
    if (/^[^a-zA-Z0-9]+$/.test(suggestion)) return true; // 記号のみ
    if (this.context.endsWith(suggestion)) return true; // 単なるエコー
    return false;
  }

  /** 無効アプリチェック */
  private isAppDisabled(): boolean {
    if (!this.appName) return false;
    return this.config.disabledApps.some(
      (app) => this.appName!.toLowerCase().includes(app.toLowerCase()),
    );
  }

  /** 強制リセット */
  reset(): void {
    this.context = "";
    this.suggestion = null;
    this.lastError = null;
  }

  formatStatus(): string {
    return [
      "✏️ **Inline Autocomplete Engine**",
      `  状態: ${this.running ? "🟢 動作中" : "🔴 停止中"}`,
      `  デバウンス: ${this.config.debounceMs}ms`,
      `  Tab受理: ${this.config.acceptWithTab ? "ON" : "OFF"}`,
      `  最大文字数: ${this.config.maxChars}`,
      `  履歴: ${this.history.length}件`,
      this.appName ? `  フォーカス: ${this.appName}` : "",
      this.suggestion ? `  提案中: "${this.suggestion.value}" (確信度: ${(this.suggestion.confidence * 100).toFixed(0)}%)` : "",
    ].filter(Boolean).join("\n");
  }
}

export const autocompleteEngine = new AutocompleteEngine();

// 起動時に履歴読み込み
autocompleteEngine["loadHistory"]();
