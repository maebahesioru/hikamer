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
