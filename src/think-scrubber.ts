// ==========================================
// Aikata - Streaming Think Scrubber（Hermes Agent think_scrubber.py由来）
// ストリーミング中の思考タグ（<think>...</think>、<reasoning>...</reasoning>など）を
// ステートマシンで追跡しながらリアルタイム除去
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

/** 除去対象タグ定義 */
interface ScrubTag {
  open: string;
  close: string;
}

/** スクラバー状態 */
interface ScrubberState {
  inBlock: boolean;
  buf: string;
  lastEmittedEndedNewline: boolean;
  depth: number;
  openTag: string;
}

// ==================== デフォルトタグ ====================

const DEFAULT_TAGS: ScrubTag[] = [
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thinking>", close: "</thinking>" },
];

// ==================== ストリーミングスクラバー ====================

export class StreamingThinkScrubber {
  private inBlock = false;
  private buf = "";
  private lastEmittedEndedNewline = false;
  private depth = 0;
  private openTag = "";
  private tags: ScrubTag[];
  private stats = { blocksScrubbed: 0, charsScrubbed: 0 };

  constructor(tags?: ScrubTag[]) {
    this.tags = tags ?? DEFAULT_TAGS;
  }

  /** チャンクを処理してクリーンなテキストを返す */
  process(chunk: string): string {
    this.buf += chunk;
    const result: string[] = [];
    let pos = 0;

    while (pos < this.buf.length) {
      if (!this.inBlock) {
        // オープンタグを探す
        let earliestOpen = -1;
        let matchedTag = "";
        for (const tag of this.tags) {
          const idx = this.buf.indexOf(tag.open, pos);
          if (idx !== -1 && (earliestOpen === -1 || idx < earliestOpen)) {
            earliestOpen = idx;
            matchedTag = tag.open;
          }
        }

        if (earliestOpen === -1) {
          // 開きタグなし → 残り全部出力
          result.push(this.buf.slice(pos));
          this.buf = "";
          break;
        }

        // 開始タグ前のテキストを出力
        const beforeText = this.buf.slice(pos, earliestOpen);
        if (beforeText) result.push(beforeText);

        // 状態更新
        this.inBlock = true;
        this.depth = 1;
        this.openTag = matchedTag;
        pos = earliestOpen + matchedTag.length;
      } else {
        // ブロック内 → 閉じタグを探す
        const closeTag = this.findCloseTag();
        const closeIdx = closeTag
          ? this.buf.indexOf(closeTag, pos)
          : -1;

        if (closeIdx === -1) {
          // 閉じタグまだ → 消費して保留
          this.stats.charsScrubbed += this.buf.length - pos;
          this.buf = "";
          break;
        }

        // 閉じタグまでスキップ
        this.stats.charsScrubbed += closeIdx - pos;
        pos = closeIdx + closeTag!.length;
        this.depth--;

        if (this.depth <= 0) {
          // 完全に閉じた
          this.inBlock = false;
          this.openTag = "";
          this.depth = 0;
          this.stats.blocksScrubbed++;
        }
      }
    }

    // バッファをクリーンアップ（消費済み部分を削除）
    if (pos > 0) {
      this.buf = this.buf.slice(pos);
    }

    const output = result.join("");
    this.lastEmittedEndedNewline = output.endsWith("\n");

    return output;
  }

  /** 残りチャンクをフラッシュ（閉じタグがない場合は残す） */
  flush(): string {
    if (!this.inBlock) {
      const remaining = this.buf;
      this.buf = "";
      return remaining;
    }

    // ブロック内で終了 → まだ閉じてないので何も出力しない
    this.buf = "";
    this.inBlock = false;
    this.depth = 0;
    this.openTag = "";
    return "";
  }

  /** 完全にリセット */
  reset(): void {
    this.inBlock = false;
    this.buf = "";
    this.lastEmittedEndedNewline = false;
    this.depth = 0;
    this.openTag = "";
  }

  /** 現在の状態 */
  getState(): Readonly<ScrubberState> {
    return {
      inBlock: this.inBlock,
      buf: this.buf,
      lastEmittedEndedNewline: this.lastEmittedEndedNewline,
      depth: this.depth,
      openTag: this.openTag,
    };
  }

  /** 統計 */
  getStats() {
    return { ...this.stats };
  }

  /** ブロック内か */
  get isInBlock(): boolean {
    return this.inBlock;
  }

  /** 対応する閉じタグを探す */
  private findCloseTag(): string | null {
    for (const tag of this.tags) {
      if (tag.open === this.openTag) {
        return tag.close;
      }
    }
    // 既知のタグパターンからcloseを推測
    const match = this.openTag.match(/^<(\w+)/);
    if (match) {
      return `</${match[1]}>`;
    }
    return null;
  }
}

// ==================== ユーティリティ ====================

/** 文字列全体から思考ブロックを一括除去（非ストリーミング用） */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** StreamingThinkScrubberのラッパー：AsyncIteratorを変換 */
export async function* scrubStream(
  iter: AsyncIterable<string>,
  scrubber?: StreamingThinkScrubber,
): AsyncIterable<string> {
  const s = scrubber ?? new StreamingThinkScrubber();
  for await (const chunk of iter) {
    const cleaned = s.process(chunk);
    if (cleaned) yield cleaned;
  }
  const remaining = s.flush();
  if (remaining) yield remaining;
}
