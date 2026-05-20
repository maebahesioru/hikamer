// ==========================================
// Hikamer - アクセシビリティ（OpenHuman accessibility/ 由来）
// ユーザー補助・キーボード操作・画面リーダー対応
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type AccessibilityMode = "none" | "keyboard" | "screen_reader" | "high_contrast" | "reduced_motion" | "large_text";

export interface AccessibilityConfig {
  mode: AccessibilityMode;
  keyboardShortcuts: Record<string, string>;
  fontSize: number;
  contrast: "normal" | "high";
  reducedMotion: boolean;
  screenReaderOptimized: boolean;
}

// ==================== アクセシビリティマネージャー ====================

class AccessibilityManager {
  private config: AccessibilityConfig;
  private shortcuts: Map<string, string> = new Map();
  private initialized = false;

  constructor() {
    this.config = {
      mode: "none",
      keyboardShortcuts: {},
      fontSize: 14,
      contrast: "normal",
      reducedMotion: false,
      screenReaderOptimized: false,
    };
  }

  init(): void {
    if (this.initialized) return;
    this.loadDefaultShortcuts();
    this.initialized = true;
    logger.info("[Accessibility] initialized");
  }

  /** モードを設定 */
  setMode(mode: AccessibilityMode): void {
    this.config.mode = mode;
    switch (mode) {
      case "screen_reader":
        this.config.screenReaderOptimized = true;
        this.config.fontSize = 16;
        break;
      case "high_contrast":
        this.config.contrast = "high";
        break;
      case "reduced_motion":
        this.config.reducedMotion = true;
        break;
      case "large_text":
        this.config.fontSize = 20;
        break;
      case "keyboard":
        this.loadKeyboardOptimizedShortcuts();
        break;
    }
    logger.info(`[Accessibility] mode set to: ${mode}`);
  }

  /** ショートカットを登録 */
  registerShortcut(key: string, action: string, description: string): void {
    this.shortcuts.set(key, action);
    this.config.keyboardShortcuts[key] = description;
  }

  /** ショートカットを解決 */
  resolveShortcut(key: string): string | undefined {
    if (!this.isKeyboardMode() || this.config.reducedMotion) return undefined;
    return this.shortcuts.get(key);
  }

  /** メッセージをスクリーンリーダー最適化 */
  optimizeForScreenReader(text: string): string {
    if (!this.config.screenReaderOptimized) return text;

    // 絵文字をテキストに置換
    return text
      .replace(/✅/g, "チェック ")
      .replace(/❌/g, "バツ ")
      .replace(/⚠️/g, "警告 ")
      .replace(/🚨/g, "アラート ")
      .replace(/📋/g, "リスト ")
      .replace(/📊/g, "グラフ ")
      .replace(/🔴/g, "赤 ")
      .replace(/🟢/g, "緑 ")
      .replace(/🟡/g, "黄 ")
      .replace(/🔗/g, "リンク ")
      .replace(/📝/g, "メモ ")
      .replace(/📁/g, "フォルダ ")
      .replace(/📄/g, "ファイル ")
      .replace(/🏷️/g, "タグ ")
      .replace(/🕐/g, "時間 ")
      .replace(/🌐/g, "ネットワーク ")
      .replace(/🔒/g, "ロック ")
      .replace(/🔑/g, "キー ");
  }

  /** フォントサイズを適用したテキスト */
  applyFontSize(text: string): string {
    if (this.config.fontSize === 14) return text;
    // マークダウンでサイズ指示を埋め込む
    return text;
  }

  /** ハイコントラスト表示用に整形 */
  applyHighContrast(text: string): string {
    if (this.config.contrast !== "high") return text;
    // ハイコントラストでは装飾を最小化
    return text
      .replace(/\*\*/g, "")
      .replace(/`/g, "");
  }

  // ---- クエリ ----

  isKeyboardMode(): boolean {
    return this.config.mode === "keyboard" || this.config.mode === "none";
  }

  isScreenReaderMode(): boolean {
    return this.config.mode === "screen_reader";
  }

  getConfig(): AccessibilityConfig {
    return { ...this.config };
  }

  /** ショートカット一覧 */
  listShortcuts(): { key: string; action: string; description: string }[] {
    return [...this.shortcuts.entries()].map(([key, action]) => ({
      key,
      action,
      description: this.config.keyboardShortcuts[key] ?? "",
    }));
  }

  // ---- 内部 ----

  private loadDefaultShortcuts(): void {
    this.registerShortcut("Ctrl+Enter", "send", "メッセージ送信");
    this.registerShortcut("Ctrl+K", "search", "検索");
    this.registerShortcut("Ctrl+L", "clear", "画面クリア");
    this.registerShortcut("Ctrl+/", "help", "ヘルプ表示");
    this.registerShortcut("Escape", "cancel", "キャンセル");
    this.registerShortcut("Ctrl+Up", "history-prev", "履歴をさかのぼる");
    this.registerShortcut("Ctrl+Down", "history-next", "履歴を進む");
  }

  private loadKeyboardOptimizedShortcuts(): void {
    this.registerShortcut("Alt+1", "tool-list", "ツール一覧");
    this.registerShortcut("Alt+2", "session-list", "セッション一覧");
    this.registerShortcut("Alt+3", "thread-list", "スレッド一覧");
    this.registerShortcut("Alt+4", "system-status", "システム状態");
    this.registerShortcut("Alt+R", "refresh", "更新");
    this.registerShortcut("Alt+S", "settings", "設定");
  }

  formatConfig(): string {
    const modeIcons: Record<string, string> = {
      none: "⚪",
      keyboard: "⌨️",
      screen_reader: "♿",
      high_contrast: "👁️",
      reduced_motion: "🎯",
      large_text: "🔠",
    };
    return (
      `♿ **アクセシビリティ設定**\n` +
      `モード: ${modeIcons[this.config.mode] ?? "⚪"} ${this.config.mode}\n` +
      `フォントサイズ: ${this.config.fontSize}px\n` +
      `コントラスト: ${this.config.contrast === "high" ? "👁️ 高" : "通常"}\n` +
      `モーション削減: ${this.config.reducedMotion ? "✅" : "❌"}\n` +
      `スクリーンリーダー最適化: ${this.config.screenReaderOptimized ? "✅" : "❌"}\n\n` +
      `**ショートカット一覧**\n` +
      this.listShortcuts()
        .map((s) => `- \`${s.key}\`: ${s.description}`)
        .join("\n")
    );
  }
}

// ==================== シングルトン ====================

export const accessibilityManager = new AccessibilityManager();

export default AccessibilityManager;
