// ==========================================
// Aikata - テキスト入力（OpenHuman text_input/ 由来）
// テキスト入力処理・マルチライン編集・IME対応
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface TextBuffer {
  id: string;
  content: string;
  cursorPosition: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  modifiedAt: number;
  lines: number;
}

export interface TextEdit {
  type: "insert" | "delete" | "replace";
  position: number;
  length?: number;
  text?: string;
}

export interface AutoCompleteResult {
  prefix: string;
  suggestions: string[];
  matched: boolean;
}

// ==================== テキスト入力マネージャー ====================

class TextInputManager {
  private buffers: Map<string, TextBuffer> = new Map();
  private history: string[] = [];
  private historyIndex = -1;
  private maxHistory = 100;
  private initialized = false;

  // 共通補完候補
  private commonCompletions = new Set([
    "help", "status", "info", "list", "show", "get", "set",
    "create", "delete", "update", "search", "find",
    "start", "stop", "restart", "reload",
    "enable", "disable", "config", "settings",
  ]);

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[TextInput] initialized");
  }

  /** バッファを作成 */
  createBuffer(initialContent?: string): TextBuffer {
    const id = `buf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const content = initialContent ?? "";
    const buffer: TextBuffer = {
      id,
      content,
      cursorPosition: content.length,
      selectionStart: null,
      selectionEnd: null,
      modifiedAt: Date.now(),
      lines: content.split("\n").length,
    };
    this.buffers.set(id, buffer);
    return buffer;
  }

  /** バッファにテキストを挿入 */
  insert(bufferId: string, text: string, position?: number): TextBuffer | null {
    const buf = this.buffers.get(bufferId);
    if (!buf) return null;

    const pos = position ?? buf.cursorPosition;
    buf.content = buf.content.slice(0, pos) + text + buf.content.slice(pos);
    buf.cursorPosition = pos + text.length;
    buf.modifiedAt = Date.now();
    buf.lines = buf.content.split("\n").length;
    return buf;
  }

  /** バッファからテキストを削除 */
  delete(bufferId: string, start: number, end: number): TextBuffer | null {
    const buf = this.buffers.get(bufferId);
    if (!buf) return null;

    buf.content = buf.content.slice(0, start) + buf.content.slice(end);
    buf.cursorPosition = start;
    buf.modifiedAt = Date.now();
    buf.lines = buf.content.split("\n").length;
    return buf;
  }

  /** バッファの内容を取得 */
  getBuffer(bufferId: string): TextBuffer | undefined {
    return this.buffers.get(bufferId);
  }

  /** バッファを閉じる */
  closeBuffer(bufferId: string): boolean {
    return this.buffers.delete(bufferId);
  }

  /** 入力を履歴に追加 */
  addToHistory(input: string): void {
    if (!input.trim()) return;
    if (this.history[this.history.length - 1] === input) return;

    this.history.push(input);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    this.historyIndex = this.history.length;
  }

  /** 履歴をさかのぼる */
  historyBack(): string | null {
    if (this.history.length === 0) return null;
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    return this.history[this.historyIndex] ?? null;
  }

  /** 履歴を進む */
  historyForward(): string | null {
    if (this.historyIndex >= this.history.length - 1) return null;
    this.historyIndex++;
    return this.history[this.historyIndex] ?? null;
  }

  /** 入力補完 */
  autocomplete(prefix: string): AutoCompleteResult {
    if (!prefix.trim()) {
      return { prefix, suggestions: [], matched: false };
    }

    const lower = prefix.toLowerCase();
    const suggestions = [...this.commonCompletions]
      .filter((c) => c.startsWith(lower))
      .sort()
      .slice(0, 10);

    return {
      prefix,
      suggestions,
      matched: suggestions.length > 0,
    };
  }

  /** コマンドを解析 */
  parseCommand(input: string): { command: string; args: string[]; flags: Record<string, string> } {
    const parts = input.trim().split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase().replace(/^\//, "");
    const args: string[] = [];
    const flags: Record<string, string> = {};

    let i = 1;
    while (i < parts.length) {
      const part = parts[i]!;
      if (part.startsWith("--")) {
        const flagName = part.slice(2);
        const flagValue = parts[i + 1];
        if (flagValue && !flagValue.startsWith("--")) {
          flags[flagName] = flagValue;
          i += 2;
        } else {
          flags[flagName] = "true";
          i++;
        }
      } else if (part.startsWith("-")) {
        flags[part.slice(1)] = "true";
        i++;
      } else {
        args.push(part);
        i++;
      }
    }

    return { command, args, flags };
  }

  /** テキストの統計 */
  getTextStats(text: string): { chars: number; words: number; lines: number; jap: number } {
    const jap = (text.match(/[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff]/g)?.length ?? 0);
    return {
      chars: text.length,
      words: text.split(/\s+/).filter(Boolean).length,
      lines: text.split("\n").length,
      jap,
    };
  }

  formatStatus(): string {
    return (
      `⌨️ **テキスト入力**\n` +
      `アクティブバッファ: ${this.buffers.size}\n` +
      `履歴: ${this.history.length}件\n` +
      `補完候補: ${this.commonCompletions.size}件`
    );
  }
}

// ==================== シングルトン ====================

export const textInputManager = new TextInputManager();

export default TextInputManager;
