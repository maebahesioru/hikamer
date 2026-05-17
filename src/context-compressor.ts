// ==========================================
// Aikata - コンテキスト圧縮（Hermes Agent由来）
// 会話履歴が肥大化したら自動圧縮
// 3-phase: tool結果重複除去 → 引数JSONトリム → 中間ターン要約
// ==========================================

import type { Message } from "./types";
import { logger } from "./utils/logger";

// ==================== 設定 ====================

const HEAD_PROTECT_COUNT = 6;       // システムプロンプト+最初のやり取りを保護
const TAIL_TOKEN_BUDGET = 20_000;   // 最新〜20Kトークンは保護
const MAX_HISTORY_PAIRS = 80;       // 会話ペア(assistant+user)の最大数
const DUPLICATE_RESULT_MIN = 200;   // これ以上の長さの結果のみ重複チェック対象
const ARG_TRUNCATE_LEN = 2000;      // ツール呼び出し引数の最大長
const MIN_SAVINGS_RATIO = 0.10;     // 前回圧縮からの圧縮率がこれ以下ならスキップ
const ANTI_THRASH_WINDOW = 5;       // 何回前までの圧縮率を確認するか

// 粗いトークン推定（英数は1文字≒0.4トークン、日本語は1文字≒1.5トークン）
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(ch)) {
      tokens += 1.5; // CJK
    } else if (/[\x20-\x7e]/.test(ch)) {
      tokens += 0.25; // ASCII
    } else {
      tokens += 0.5; // その他
    }
  }
  return Math.ceil(tokens);
}

// ==================== 統計 ====================

interface CompressStats {
  originalMessages: number;
  finalMessages: number;
  originalTokens: number;
  finalTokens: number;
  phasesApplied: string[];
}

// 直近の圧縮率をトラッキング（ant-thrash）
const recentSavings: number[] = [];

function shouldSkipCompression(savingsRatio: number): boolean {
  recentSavings.push(savingsRatio);
  if (recentSavings.length > ANTI_THRASH_WINDOW) recentSavings.shift();
  if (recentSavings.length < 2) return false;
  // 直近N回がすべて閾値以下ならスキップ
  return recentSavings.every(r => r < MIN_SAVINGS_RATIO);
}

// ==================== Phase 1: 重複ツール結果除去 ====================

/**
 * ツール結果メッセージのうち、完全に同一の内容のものを
 * 古い方だけ「[重複]」に置き換える。
 * MD5は使わず、文字列の完全一致で判定（軽量）。
 */
function phase1PruneDuplicates(messages: Message[]): { messages: Message[]; applied: boolean } {
  let applied = false;
  const seen = new Map<string, number>(); // hash → last index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!; // インデックス範囲内なので安全
    if (msg.role !== "tool") continue;
    if (msg.content.length < DUPLICATE_RESULT_MIN) continue;

    // 簡易ハッシュ: 先頭200文字+末尾200文字で判定
    const key = msg.content.slice(0, 200) + msg.content.slice(-200);
    const prev = seen.get(key);

    if (prev !== undefined && i - prev > 1) {
      // 古い方を置き換え
      const prevMsg = messages[prev]!;
      messages[prev] = {
        role: "tool",
        content: `[重複ツール結果: ${msg.content.slice(0, 100)}…]`,
        tool_call_id: prevMsg.tool_call_id,
      };
      applied = true;
    }
    seen.set(key, i);
  }

  return { messages, applied };
}

// ==================== Phase 2: ツール呼び出し引数トリム ====================

function phase2TrimToolArgs(messages: Message[]): { messages: Message[]; applied: boolean } {
  let applied = false;

  for (const msg of messages) {
    if (!msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (tc.function.arguments && tc.function.arguments.length > ARG_TRUNCATE_LEN) {
        try {
          const parsed = JSON.parse(tc.function.arguments);
          // JSONを保持しつつ大きな値をトリム
          const trimmed = trimLargeValues(parsed, ARG_TRUNCATE_LEN);
          tc.function.arguments = JSON.stringify(trimmed);
        } catch {
          // JSONパース不能ならそのまま
        }
        applied = true;
      }
    }
  }

  return { messages, applied };
}

function trimLargeValues(obj: any, maxLen: number): any {
  if (typeof obj === "string") {
    return obj.length > maxLen ? obj.slice(0, maxLen) + `…[${obj.length - maxLen}文字省略]` : obj;
  }
  if (Array.isArray(obj)) {
    return obj.length > 20
      ? [...obj.slice(0, 10), `…[${obj.length - 20}件省略]`, ...obj.slice(-10)]
      : obj.map(v => trimLargeValues(v, maxLen));
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = trimLargeValues(val, maxLen);
    }
    return result;
  }
  return obj;
}

// ==================== Phase 3: 中間ターン圧縮 ====================

function phase3CompressMiddle(messages: Message[]): { messages: Message[]; applied: boolean } {
  if (messages.length <= HEAD_PROTECT_COUNT + 4) return { messages, applied: false };

  // ヘッド保護: システムプロンプト + 最初のやり取り
  const head = messages.slice(0, HEAD_PROTECT_COUNT);

  // テール保護: トークン予算ベースで最新を保護
  const tail: Message[] = [];
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= HEAD_PROTECT_COUNT; i--) {
    const m = messages[i]!;
    const tokens = estimateTokens(
      m.role + m.content +
      (m.tool_calls ? JSON.stringify(m.tool_calls) : "")
    );
    if (tailTokens + tokens > TAIL_TOKEN_BUDGET && tail.length >= 4) break;
    tailTokens += tokens;
    tail.unshift(m);
  }

  // 中間部分
  const middleStart = head.length;
  const middleEnd = messages.length - tail.length;
  if (middleStart >= middleEnd) return { messages, applied: false };
  const middle = messages.slice(middleStart, middleEnd);

  if (middle.length < 2) return { messages, applied: false };

  // 中間を圧縮: 統計情報を抽出
  const userMsgs = middle.filter(m => m.role === "user").length;
  const toolMsgs = middle.filter(m => m.role === "tool").length;
  const assistantMsgs = middle.filter(m => m.role === "assistant" && !m.tool_calls).length;
  const toolCallMsgs = middle.filter(m => m.role === "assistant" && m.tool_calls).length;

  // 最初と最後の中間メッセージからコンテキストを抽出
  const firstUserMsg = middle.find(m => m.role === "user");
  const lastUserMsg = [...middle].reverse().find(m => m.role === "user");
  const firstContent = firstUserMsg?.content.slice(0, 300) || "";
  const lastContent = lastUserMsg?.content.slice(0, 300) || "";

  const summaryMsg: Message = {
    role: "user",
    content: `[圧縮された会話履歴: 中間 ${middle.length}メッセージを省略]` +
      `\n- ユーザー発言: ${userMsgs}件` +
      `\n- アシスタント応答: ${assistantMsgs}件` +
      `\n- ツール呼び出し: ${toolCallMsgs}件` +
      `\n- ツール結果: ${toolMsgs}件` +
      (firstContent ? `\n- 前半トピック例: "${firstContent}"` : "") +
      (lastContent ? `\n- 後半トピック例: "${lastContent}"` : ""),
  };

  return { messages: [...head, summaryMsg, ...tail], applied: true };
}

// ==================== メインエントリポイント ====================

export function compressHistory(
  messages: Message[],
  force: boolean = false,
): { messages: Message[]; stats: CompressStats } {
  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const originalCount = messages.length;

  let working = [...messages];
  const phasesApplied: string[] = [];

  // そもそも少なければスキップ
  if (!force && messages.length <= MAX_HISTORY_PAIRS * 2) {
    return {
      messages,
      stats: {
        originalMessages: originalCount,
        finalMessages: originalCount,
        originalTokens,
        finalTokens: originalTokens,
        phasesApplied: [],
      },
    };
  }

  // Phase 1: 重複ツール結果除去
  const p1 = phase1PruneDuplicates(working);
  if (p1.applied) {
    phasesApplied.push("dedup_tool_results");
    working = p1.messages;
  }

  // Phase 2: ツール引数トリム
  const p2 = phase2TrimToolArgs(working);
  if (p2.applied) {
    phasesApplied.push("trim_tool_args");
    working = p2.messages;
  }

  // Phase 3: 中間圧縮
  const p3 = phase3CompressMiddle(working);
  if (p3.applied) {
    phasesApplied.push("compress_middle_turns");
    working = p3.messages;
  }

  const finalTokens = working.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const savingsRatio = 1 - (finalTokens / originalTokens);

  // アンチスラッシング
  if (!force && phasesApplied.length > 0 && shouldSkipCompression(savingsRatio)) {
    logger.debug(`圧縮スキップ: 圧縮率(${(savingsRatio * 100).toFixed(1)}%)が直近平均を下回る`);
    return {
      messages,
      stats: {
        originalMessages: originalCount,
        finalMessages: originalCount,
        originalTokens,
        finalTokens: originalTokens,
        phasesApplied: [],
      },
    };
  }

  if (phasesApplied.length > 0) {
    logger.info(
      `コンテキスト圧縮: ${originalCount}→${working.length}メッセージ, ` +
      `${originalTokens}→${finalTokens}トークン ` +
      `(${(savingsRatio * 100).toFixed(1)}%削減) ` +
      `[${phasesApplied.join(", ")}]`
    );
  }

  return {
    messages: working,
    stats: {
      originalMessages: originalCount,
      finalMessages: working.length,
      originalTokens,
      finalTokens,
      phasesApplied,
    },
  };
}

/** 会話履歴が圧縮を必要とするサイズかチェック */
export function needsCompression(messages: Message[]): boolean {
  if (messages.length > MAX_HISTORY_PAIRS * 2) return true;
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return totalTokens > TAIL_TOKEN_BUDGET * 2;
}

export { estimateTokens };
