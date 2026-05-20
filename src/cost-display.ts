// ==========================================
// Hikamer - リアルタイムコスト表示
// 出典: claude-pulse (NoobyGains/claude-pulse)
// モデル価格テーブル + セッションコスト + マルチカレンシー
// ==========================================

import { logger } from "./utils/logger";

// ==================== モデル価格テーブル（claude-pulse由来） ====================

interface ModelPrice {
  input: number;     // $ per 1M tokens
  output: number;    // $ per 1M tokens
  cacheRead?: number;
}

const MODEL_PRICING: Record<string, ModelPrice> = {
  // Claude
  "claude-sonnet-4":      { input: 3.0, output: 15.0, cacheRead: 0.30 },
  "claude-opus-4":        { input: 15.0, output: 75.0, cacheRead: 1.50 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.30 },
  "claude-3-5-sonnet":    { input: 3.0, output: 15.0, cacheRead: 0.30 },
  "claude-3-opus":        { input: 15.0, output: 75.0, cacheRead: 1.50 },
  "claude-3-haiku":       { input: 0.25, output: 1.25, cacheRead: 0.03 },

  // DeepSeek
  "deepseek-chat":        { input: 0.14, output: 0.28 },
  "deepseek-reasoner":    { input: 0.55, output: 2.19, cacheRead: 0.14 },
  "deepseek/deepseek-v4-pro": { input: 2.0, output: 8.0 },

  // OpenAI
  "gpt-4o":              { input: 2.50, output: 10.00 },
  "gpt-4o-mini":         { input: 0.15, output: 0.60 },
  "gpt-5.5":             { input: 10.0, output: 40.0 },
  "o3-mini":             { input: 1.10, output: 4.40 },
  "o4-mini":             { input: 1.10, output: 4.40 },

  // Anthropic
  "claude-4-7-opus":     { input: 15.0, output: 75.0, cacheRead: 1.50 },

  // Gemini
  "gemini-2.0-flash":    { input: 0.10, output: 0.40 },
  "gemini-2.5-pro":      { input: 1.25, output: 5.00 },

  // Grok
  "grok-4.3":            { input: 2.0, output: 10.0 },
  "grok-3":              { input: 2.0, output: 8.0 },

  // MiniMax
  "minimax":             { input: 0.50, output: 2.0 },
};

// ==================== 為替レート（簡易版） ====================

type CurrencyCode = "USD" | "JPY" | "EUR" | "GBP" | "CNY" | "KRW";

const EXCHANGE_RATES: Record<CurrencyCode, number> = {
  USD: 1.0,
  JPY: 149.5,
  EUR: 0.92,
  GBP: 0.79,
  CNY: 7.24,
  KRW: 1320,
};

// ==================== コスト計算 ====================

export interface CostBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  inputCost: number;
  outputCost: number;
  cacheSavings: number;
  totalCost: number;
  currency: CurrencyCode;
  displayTotal: string;
}

/**
 * モデル名から価格情報を取得（部分一致対応）
 */
function findModelPrice(modelName: string): ModelPrice | null {
  // 完全一致
  if (MODEL_PRICING[modelName]) return MODEL_PRICING[modelName];

  // 部分一致
  const lower = modelName.toLowerCase();
  const match = Object.entries(MODEL_PRICING).find(([key]) => lower.includes(key));
  return match ? match[1] : null;
}

/**
 * トークン使用量からコストを計算
 */
export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number = 0,
  currency: CurrencyCode = "USD"
): CostBreakdown {
  const pricing = findModelPrice(modelName);

  if (!pricing) {
    return {
      modelName,
      inputTokens,
      outputTokens,
      inputCost: 0,
      outputCost: 0,
      cacheSavings: 0,
      totalCost: 0,
      currency,
      displayTotal: `N/A (${modelName})`,
    };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheSavings = pricing.cacheRead
    ? (cacheTokens / 1_000_000) * (pricing.input - pricing.cacheRead)
    : 0;

  const totalCost = Math.max(0, inputCost + outputCost - cacheSavings);
  const rate = EXCHANGE_RATES[currency] ?? 1;
  const displayTotal = formatCurrency(totalCost * rate, currency);

  return {
    modelName,
    inputTokens,
    outputTokens,
    cacheTokens,
    inputCost,
    outputCost,
    cacheSavings,
    totalCost,
    currency,
    displayTotal,
  };
}

/**
 * 金額をフォーマット
 */
function formatCurrency(amount: number, currency: CurrencyCode): string {
  const symbols: Record<CurrencyCode, string> = {
    USD: "$", JPY: "¥", EUR: "€", GBP: "£", CNY: "¥", KRW: "₩",
  };
  const sym = symbols[currency] || "$";

  if (amount < 0.01) return `${sym}${(amount * 100).toFixed(1)}¢`;
  if (amount < 1) return `${sym}${amount.toFixed(4)}`;
  return `${sym}${amount.toFixed(2)}`;
}

// ==================== コストトラッカー（セッション単位） ====================

interface SessionCostEntry {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  timestamp: number;
}

class CostTracker {
  private entries: SessionCostEntry[] = [];
  private currency: CurrencyCode = "JPY";

  setCurrency(currency: CurrencyCode): void {
    this.currency = currency;
  }

  /**
   * API呼び出しのコストを記録
   */
  recordCall(modelName: string, inputTokens: number, outputTokens: number, cacheTokens: number = 0): void {
    const breakdown = calculateCost(modelName, inputTokens, outputTokens, cacheTokens, this.currency);
    this.entries.push({
      modelName,
      inputTokens,
      outputTokens,
      cacheTokens,
      cost: breakdown.totalCost,
      timestamp: Date.now(),
    });

    logger.debug(`[CostTracker] ${modelName}: ${breakdown.displayTotal} (in=${inputTokens}, out=${outputTokens})`);
  }

  /**
   * セッション合計コスト
   */
  getSessionCost(): { totalCost: number; displayTotal: string; callCount: number } {
    const totalCost = this.entries.reduce((s, e) => s + e.cost, 0);
    const rate = EXCHANGE_RATES[this.currency] ?? 1;
    return {
      totalCost,
      displayTotal: formatCurrency(totalCost * rate, this.currency),
      callCount: this.entries.length,
    };
  }

  /**
   * コストサマリーを表示
   * claude-pulse: real-time cost display widget
   */
  formatSummary(): string {
    const session = this.getSessionCost();
    if (session.callCount === 0) return "📊 コストデータなし";

    const byModel = new Map<string, { calls: number; cost: number }>();
    for (const e of this.entries) {
      const m = byModel.get(e.modelName) ?? { calls: 0, cost: 0 };
      m.calls++;
      m.cost += e.cost;
      byModel.set(e.modelName, m);
    }

    const lines: string[] = [`📊 **コストサマリー**`];
    lines.push(`総呼出: ${session.callCount}回 | 合計: ${session.displayTotal}`);

    Array.from(byModel.entries()).forEach(([model, stat]) => {
      const rate = EXCHANGE_RATES[this.currency] ?? 1;
      lines.push(`  - ${model}: ${stat.calls}回 ${formatCurrency(stat.cost * rate, this.currency)}`);
    });

    return lines.join("\n");
  }

  /**
   * セッションリセット
   */
  reset(): void {
    this.entries = [];
  }
}

export const costTracker = new CostTracker();
export { MODEL_PRICING, EXCHANGE_RATES, CurrencyCode };
