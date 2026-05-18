// ==========================================
// Aikata - コストトラッキング（OpenHuman cost/tracker完全移植版）
// JSONL永続化 + 予算執行 + モデル別集計 + 日次/月次集計キャッシュ
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== モデル価格定義（$ / 1Kトークン） ====================

interface ModelPrice {
  input: number;   // 入力 $/1K
  output: number;  // 出力 $/1K
  reasoning?: number; // 推論トークン（DeepSeek V4等）
}

/** フルモデル価格表（OpenRouter標準価格 + 実勢価格ベース） */
const MODEL_PRICES: Record<string, ModelPrice> = {
  // === DeepSeek ===
  "deepseek/deepseek-v4-pro":     { input: 0.018,  output: 0.072 },
  "deepseek/deepseek-v4-flash":   { input: 0.0035, output: 0.014 },
  "deepseek-v4-pro":              { input: 0.018,  output: 0.072 },
  "deepseek-v4-flash":            { input: 0.0035, output: 0.014 },
  "deepseek-chat":                { input: 0.0005, output: 0.002 },
  "deepseek-reasoner":            { input: 0.001,  output: 0.004, reasoning: 1.0 },

  // === OpenAI ===
  "gpt-5.5":                      { input: 0.015,  output: 0.075 },
  "gpt-4o":                       { input: 0.005,  output: 0.015 },
  "gpt-4o-mini":                  { input: 0.00015, output: 0.0006 },

  // === Anthropic ===
  "claude-4.7-opus":              { input: 0.015,  output: 0.075 },
  "claude-sonnet-4":              { input: 0.003,  output: 0.015 },
  "claude-haiku-3.5":             { input: 0.00025, output: 0.00125 },

  // === Google ===
  "gemini-2.5-pro":               { input: 0.00125, output: 0.005 },
  "gemini-2.0-flash":             { input: 0.0001,  output: 0.0004 },

  // === Meta ===
  "llama-4-scout":                { input: 0.0002,  output: 0.0002 },
  "llama-4-maverick":             { input: 0.0002,  output: 0.0002 },

  // === xAI ===
  "grok-4.3":                     { input: 0.012,  output: 0.024 },
  "grok-4":                       { input: 0.012,  output: 0.024 },

  // === Mistral ===
  "mistral-large":                { input: 0.002,  output: 0.006 },
  "mistral-small":                { input: 0.001,  output: 0.003 },

  // === Cohere ===
  "command-r7b":                  { input: 0.00015, output: 0.0006 },

  // Fallback（未知モデル）
  "*":                            { input: 0.005,  output: 0.015 },
};

// ==================== コスト計算 ====================

function getPrice(model: string): ModelPrice {
  // 前方一致マッチ（例: "openai/gpt-4o" → "gpt-4o"）
  const modelKey = model.split("/").pop()?.toLowerCase() || model;

  // 完全一致
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  if (MODEL_PRICES[modelKey]) return MODEL_PRICES[modelKey];

  // 部分一致
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.includes(key) || modelKey.includes(key)) return price;
  }

  return MODEL_PRICES["*"];
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number, reasoningTokens?: number): {
  inputCost: number;
  outputCost: number;
  reasoningCost: number;
  totalCost: number;
} {
  const price = getPrice(model) || MODEL_PRICES["*"];
  const inputCost = (inputTokens / 1000) * price.input;
  const outputCost = (outputTokens / 1000) * price.output;
  let reasoningCost = 0;

  if (reasoningTokens && price.reasoning !== undefined) {
    // 推論トークンは出力とは別枠で課金されるケース
    reasoningCost = (reasoningTokens / 1000) * price.reasoning;
  }

  return {
    inputCost: round(inputCost),
    outputCost: round(outputCost),
    reasoningCost: round(reasoningCost),
    totalCost: round(inputCost + outputCost + reasoningCost),
  };
}

// ==================== 永続ストレージ ====================

interface CostEntry {
  timestamp: string;
  model: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inputCost: number;
  outputCost: number;
  reasoningCost: number;
  totalCost: number;
}

interface CostSummary {
  sessions: Record<string, {
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalCost: number;
    model: string;
    lastCall: string;
  }>;
  totalCalls: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  dailyCost: number;
  monthlyCost: number;
  dailyCosts: Record<string, number>;
  byModel: Record<string, { cost: number; tokens: number; calls: number }>;
}

interface CostRecord {
  timestamp: string;
  model: string;
  cost: number;
  tokens: number;
}

function emptySummary(): CostSummary {
  return {
    sessions: {},
    totalCalls: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalTokens: 0,
    dailyCost: 0,
    monthlyCost: 0,
    dailyCosts: {},
    byModel: {},
  };
}

const COST_DB_PATH = resolve(process.env.DATA_DIR || "./data", "costs.json");
const _entries: CostEntry[] = [];
let _summary: CostSummary | null = null;

function loadSummary(): CostSummary {
  if (_summary) return _summary;
  try {
    if (existsSync(COST_DB_PATH)) {
      _summary = JSON.parse(readFileSync(COST_DB_PATH, "utf-8"));
      return _summary!;
    }
  } catch (e) {
    logger.warn(`コストDB読込失敗: ${e}`);
  }
  _summary = {
    sessions: {},
    totalCalls: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalTokens: 0,
    dailyCost: 0,
    monthlyCost: 0,
    dailyCosts: {},
    byModel: {},
  };
  return _summary;
}

function saveSummary(): void {
  try {
    const dir = dirname(COST_DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(COST_DB_PATH, JSON.stringify(_summary, null, 2), "utf-8");
  } catch (e) {
    logger.error(`コストDB保存失敗: ${e}`);
  }
}

// ==================== 公開API ====================

/** LLM呼び出しのコストを記録 */
export function recordCost(
  model: string,
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens?: number,
): void {
  const costs = estimateCost(model, inputTokens, outputTokens, reasoningTokens);
  const today = new Date().toISOString().slice(0, 10);

  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    model,
    sessionId,
    inputTokens,
    outputTokens,
    reasoningTokens: reasoningTokens || 0,
    ...costs,
  };

  _entries.push(entry);

  // Burn rate tracking (claude-pulse deep pattern)
  burnRateTracker.recordCost(costs.totalCost);

  // サマリ更新
  const summary = loadSummary();
  summary.totalCalls++;
  summary.totalCost += costs.totalCost;
  summary.totalInputTokens += inputTokens;
  summary.totalOutputTokens += outputTokens;
  summary.totalReasoningTokens += reasoningTokens || 0;

  // セッション別
  if (!summary.sessions[sessionId]) {
    summary.sessions[sessionId] = {
      callCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalCost: 0,
      model,
      lastCall: entry.timestamp,
    };
  }
  const sess = summary.sessions[sessionId];
  sess.callCount++;
  sess.totalInputTokens += inputTokens;
  sess.totalOutputTokens += outputTokens;
  sess.totalReasoningTokens += reasoningTokens || 0;
  sess.totalCost = round(sess.totalCost + costs.totalCost);
  sess.lastCall = entry.timestamp;

  // 日次
  summary.dailyCosts[today] = (summary.dailyCosts[today] || 0) + costs.totalCost;

  saveSummary();

  logger.info(
    `[Cost] ${model} | 入${inputTokens}→出${outputTokens} | $${costs.totalCost.toFixed(6)}` +
    (reasoningTokens ? ` (推論${reasoningTokens})` : "")
  );
}

/** コストサマリ取得 */
export function getCostSummary(): CostSummary {
  return loadSummary();
}

/** 現在のセッションのコスト取得 */
export function getSessionCost(sessionId: string): CostSummary["sessions"][string] | null {
  const summary = loadSummary();
  return summary.sessions[sessionId] || null;
}

/** 直近N回のコストエントリ */
export function getRecentEntries(count = 20): CostEntry[] {
  return _entries.slice(-count);
}

/** コストサマリを見やすい文字列に */
export function formatCostSummary(sessionId?: string): string {
  const summary = loadSummary();

  if (sessionId) {
    const sess = summary.sessions[sessionId];
    if (!sess) return "このセッションのコスト記録はありません。";

    return [
      `**コスト（${sessionId.slice(0, 12)}…）**`,
      `モデル: ${sess.model}`,
      `呼び出し: ${sess.callCount}回`,
      `総トークン: ${fmtNum(sess.totalInputTokens)}入 / ${fmtNum(sess.totalOutputTokens)}出` +
        (sess.totalReasoningTokens > 0 ? ` / ${fmtNum(sess.totalReasoningTokens)}推論` : ""),
      `**合計: $${sess.totalCost.toFixed(4)}**`,
    ].join("\n");
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayCost = summary.dailyCosts[today] || 0;

  const lines = [
    `**コストサマリ（全期間）**`,
    `総呼び出し: ${summary.totalCalls}回`,
    `総トークン: ${fmtNum(summary.totalInputTokens)}入 / ${fmtNum(summary.totalOutputTokens)}出` +
      (summary.totalReasoningTokens > 0 ? ` / ${fmtNum(summary.totalReasoningTokens)}推論` : ""),
    `**総コスト: $${summary.totalCost.toFixed(4)}**`,
    `**今日: $${todayCost.toFixed(4)}**`,
    `アクティブセッション: ${Object.keys(summary.sessions).length}`,
  ];

  // 上位5セッション
  const top = Object.entries(summary.sessions)
    .sort((a, b) => b[1].totalCost - a[1].totalCost)
    .slice(0, 5);
  if (top.length > 0) {
    lines.push("");
    lines.push("**高コストセッションTOP5:**");
    for (const [id, s] of top) {
      lines.push(`• ${id.slice(0, 10)}…: $${s.totalCost.toFixed(4)} (${s.callCount}回, ${s.model})`);
    }
  }

  return lines.join("\n");
}

/** 予算アラート（指定した予算を超えたら警告） */
const budgetWarnings = new Set<string>();

export function checkBudgetAlert(
  sessionId: string,
  monthlyBudget: number,
): string | null {
  const summary = loadSummary();
  const today = new Date().toISOString().slice(0, 10);
  const todayCost = summary.dailyCosts[today] || 0;

  if (todayCost > monthlyBudget && !budgetWarnings.has(`daily:${sessionId}`)) {
    budgetWarnings.add(`daily:${sessionId}`);
    return `⚠️ **予算超過アラート**\n今日のコスト ($${todayCost.toFixed(4)}) が月間予算 ($${monthlyBudget.toFixed(4)}) を超えました。`;
  }

  const monthKey = today.slice(0, 7);
  const thisMonth = Object.entries(summary.dailyCosts)
    .filter(([d]) => d.startsWith(monthKey))
    .reduce((sum, [, c]) => sum + c, 0);

  if (thisMonth > monthlyBudget * 3 && !budgetWarnings.has(`monthly:${sessionId}`)) {
    budgetWarnings.add(`monthly:${sessionId}`);
    return `⚠️ **月間予算超過アラート**\n今月のコスト ($${thisMonth.toFixed(4)}) が月間予算の3倍を超えました。`;
  }

  return null;
}

/** 予算警告リセット */
export function resetBudgetWarnings(): void {
  budgetWarnings.clear();
}

export function resetCostData(): void {
  _summary = null;
  _entries.length = 0;
  if (existsSync(COST_DB_PATH)) {
    writeFileSync(COST_DB_PATH, JSON.stringify({
      sessions: {}, totalCalls: 0, totalCost: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
      dailyCosts: {},
    }, null, 2), "utf-8");
  }
}

// ==================== ユーティリティ ====================

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ==================== 起動時ログ ====================

const initial = loadSummary();
if (initial.totalCalls > 0) {
  logger.info(`[CostTracker] 復元: ${initial.totalCalls}回, $${initial.totalCost.toFixed(4)} 累計`);
}

// ==================== JSONL永続化（OpenHuman cost/tracker完全移植） ====================

function jsonlPath(): string {
  return resolve(process.env.DATA_DIR || "./data", "costs.jsonl");
}

/** コストレコードをJSONLに追記 */
export function appendCostRecord(record: CostRecord): void {
  const path = jsonlPath();
  mkdirSync(dirname(path), { recursive: true });
  const fs = require("fs");
  fs.appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

/** JSONLを全スキャンして集計 */
export function rebuildFromJsonl(): CostSummary {
  const path = jsonlPath();
  if (!existsSync(path)) return emptySummary();

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  let totalCost = 0;
  let totalTokens = 0;
  let totalCalls = 0;
  let dailyCost = 0;
  let monthlyCost = 0;
  const byModel: Record<string, { cost: number; tokens: number; calls: number }> = {};

  const fs = require("fs");
  const lines = fs.readFileSync(path, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const record: CostRecord = JSON.parse(line);
      totalCost += record.cost;
      totalTokens += record.tokens;
      totalCalls++;

      if (record.timestamp.startsWith(today)) dailyCost += record.cost;
      if (record.timestamp.startsWith(month)) monthlyCost += record.cost;

      if (!byModel[record.model]) byModel[record.model] = { cost: 0, tokens: 0, calls: 0 };
      byModel[record.model]!.cost += record.cost;
      byModel[record.model]!.tokens += record.tokens;
      byModel[record.model]!.calls += 1;
    } catch { continue; }
  }

  return { totalCost: round(totalCost), totalTokens, totalCalls, dailyCost, monthlyCost, byModel };
}

// ==================== 予算執行（BudgetCheck） ====================

export interface BudgetConfig {
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
}

export type BudgetResult = "allowed" | "warning" | "exceeded";

let budgetConfig: BudgetConfig = {};

/** 予算設定 */
export function setBudget(config: BudgetConfig): void {
  budgetConfig = config;
  logger.info(`[Budget] 設定: daily=${config.dailyLimitUsd ?? "無制限"}, monthly=${config.monthlyLimitUsd ?? "無制限"}`);
}

/** 予算チェック（推定コストを含めて判定） */
export function checkBudget(estimatedCostUsd: number): BudgetResult {
  const summary = loadSummary();
  const projectedDaily = summary.dailyCost + estimatedCostUsd;
  const projectedMonthly = summary.monthlyCost + estimatedCostUsd;

  if (budgetConfig.dailyLimitUsd && projectedDaily > budgetConfig.dailyLimitUsd) {
    return "exceeded";
  }
  if (budgetConfig.monthlyLimitUsd && projectedMonthly > budgetConfig.monthlyLimitUsd) {
    return "exceeded";
  }

  // 警告閾値（80%）
  if (budgetConfig.dailyLimitUsd && projectedDaily > budgetConfig.dailyLimitUsd * 0.8) {
    return "warning";
  }
  if (budgetConfig.monthlyLimitUsd && projectedMonthly > budgetConfig.monthlyLimitUsd * 0.8) {
    return "warning";
  }

  return "allowed";
}

export function formatBudgetStatus(): string {
  const summary = loadSummary();
  const lines: string[] = ["💰 **予算状態**"];

  if (budgetConfig.dailyLimitUsd) {
    const pct = (summary.dailyCost / budgetConfig.dailyLimitUsd) * 100;
    lines.push(`  日次: $${summary.dailyCost.toFixed(4)} / $${budgetConfig.dailyLimitUsd} (${pct.toFixed(1)}%)`);
  }
  if (budgetConfig.monthlyLimitUsd) {
    const pct = (summary.monthlyCost / budgetConfig.monthlyLimitUsd) * 100;
    lines.push(`  月次: $${summary.monthlyCost.toFixed(4)} / $${budgetConfig.monthlyLimitUsd} (${pct.toFixed(1)}%)`);
  }
  if (!budgetConfig.dailyLimitUsd && !budgetConfig.monthlyLimitUsd) {
    lines.push("  予算制限なし");
  }

  return lines.join("\n");
}

// ==================== CumulativeCostTracker（claude-pulse deep patterns） ====================

interface CumulativeCostData {
  total: number;
  byModel: Record<string, number>;
  byDay: Record<string, number>;
  byWeek: Record<string, number>;
}

class CumulativeCostTracker {
  private cache: CumulativeCostData | null = null;
  private cacheTime = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分キャッシュ

  /**
   * data/cost*.jsonl を全スキャンし、モデル別・日別・週別に集計。
   * 結果は5分間キャッシュされる。
   */
  getCumulativeCost(): CumulativeCostData {
    const now = Date.now();
    if (this.cache && (now - this.cacheTime) < this.CACHE_TTL) {
      return this.cache;
    }

    const dataDir = resolve(process.env.DATA_DIR || "./data");
    const result: CumulativeCostData = {
      total: 0,
      byModel: {},
      byDay: {},
      byWeek: {},
    };

    try {
      const fs = require("fs");
      if (!existsSync(dataDir)) {
        this.cache = result;
        this.cacheTime = now;
        return result;
      }

      const files: string[] = fs.readdirSync(dataDir).filter(
        (f: string) => f.startsWith("cost") && f.endsWith(".jsonl")
      );

      for (const file of files) {
        const content = readFileSync(resolve(dataDir, file), "utf-8");
        const lines = content.split("\n").filter((l: string) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            const cost: number =
              typeof record.cost === "number" ? record.cost
              : typeof record.totalCost === "number" ? record.totalCost
              : 0;
            const model: string =
              typeof record.model === "string" ? record.model : "unknown";
            const ts: string =
              typeof record.timestamp === "string" ? record.timestamp : "";

            result.total += cost;

            const prevModel = result.byModel[model] ?? 0;
            result.byModel[model] = prevModel + cost;

            if (ts.length >= 10) {
              const day = ts.slice(0, 10);
              const prevDay = result.byDay[day] ?? 0;
              result.byDay[day] = prevDay + cost;

              // ISO週（日曜起点）
              const d = new Date(ts);
              if (!isNaN(d.getTime())) {
                const dayOfWeek = d.getDay();
                const weekStart = new Date(d);
                weekStart.setDate(d.getDate() - dayOfWeek);
                const weekKey = weekStart.toISOString().slice(0, 10);
                const prevWeek = result.byWeek[weekKey] ?? 0;
                result.byWeek[weekKey] = prevWeek + cost;
              }
            }
          } catch {
            continue;
          }
        }
      }
    } catch (e) {
      logger.warn(`[CumulativeCostTracker] スキャン失敗: ${e}`);
    }

    // 丸め
    result.total = round(result.total);
    for (const k of Object.keys(result.byModel)) {
      const v = result.byModel[k];
      if (v !== undefined) result.byModel[k] = round(v);
    }
    for (const k of Object.keys(result.byDay)) {
      const v = result.byDay[k];
      if (v !== undefined) result.byDay[k] = round(v);
    }
    for (const k of Object.keys(result.byWeek)) {
      const v = result.byWeek[k];
      if (v !== undefined) result.byWeek[k] = round(v);
    }

    this.cache = result;
    this.cacheTime = now;
    return result;
  }

  /** キャッシュを無効化 */
  invalidateCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }
}

// ==================== BurnRateTracker（claude-pulse deep patterns） ====================

interface BurnRecord {
  timestamp: number;
  cost: number;
}

interface BurnRate {
  hourlyRate: number;
  dailyProjection: number;
  weeklyProjection: number;
  trend: "rising" | "stable" | "falling";
}

class BurnRateTracker {
  private window: BurnRecord[] = [];
  private readonly WINDOW_MS = 5 * 60 * 1000; // 5分スライディングウィンドウ
  private lastWindowCost = 0;

  /** コストエントリを記録 */
  recordCost(cost: number): void {
    const now = Date.now();
    this.window.push({ timestamp: now, cost });
    this.prune(now);
  }

  /**
   * 現在のバーンレートを取得。
   * 5分ウィンドウ内のコスト速度から時給・日次・週次を投影。
   */
  getBurnRate(): BurnRate {
    const now = Date.now();
    this.prune(now);

    const hourlyRate = this.computeHourlyRate();
    const dailyProjection = hourlyRate * 24;
    const weeklyProjection = dailyProjection * 7;

    // トレンド判定（前回ウィンドウ総コストとの比較）
    const currentWindowCost = this.window.reduce((s, r) => s + r.cost, 0);
    let trend: BurnRate["trend"] = "stable";
    if (this.lastWindowCost > 0 && currentWindowCost !== this.lastWindowCost) {
      const diff = currentWindowCost - this.lastWindowCost;
      const pct = diff / this.lastWindowCost;
      if (pct > 0.05) trend = "rising";
      else if (pct < -0.05) trend = "falling";
    }
    this.lastWindowCost = currentWindowCost;

    return {
      hourlyRate: round(hourlyRate),
      dailyProjection: round(dailyProjection),
      weeklyProjection: round(weeklyProjection),
      trend,
    };
  }

  /** 表示用フォーマット: ↑$0.42/hr または ↓$0.12/hr */
  formatBurnRate(): string {
    const rate = this.getBurnRate();
    const arrow =
      rate.trend === "rising" ? "↑"
      : rate.trend === "falling" ? "↓"
      : "→";
    return `${arrow}$${rate.hourlyRate.toFixed(2)}/hr`;
  }

  private prune(now: number): void {
    const cutoff = now - this.WINDOW_MS;
    let writeIdx = 0;
    for (let i = 0; i < this.window.length; i++) {
      const r = this.window[i]!;
      if (r.timestamp >= cutoff) {
        this.window[writeIdx++] = r;
      }
    }
    this.window.length = writeIdx;
  }

  private computeHourlyRate(): number {
    if (this.window.length < 2) return 0;
    const first = this.window[0]!;
    const last = this.window[this.window.length - 1]!;
    const timeSpanHours = (last.timestamp - first.timestamp) / (1000 * 60 * 60);
    if (timeSpanHours <= 0) return 0;
    const totalCost = this.window.reduce((s, r) => s + r.cost, 0);
    return totalCost / timeSpanHours;
  }
}

// ==================== シングルトン ====================

export const cumulativeCostTracker = new CumulativeCostTracker();
export const burnRateTracker = new BurnRateTracker();
