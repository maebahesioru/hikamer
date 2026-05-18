// ==========================================
// Aikata - 累積コストキャッシュ
// 出典: claude-pulse (NoobyGains/claude-pulse) Cumulative Cost Tracking
// セッション跨ぎでAPIコストを永続化・集計
// ==========================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";
import { calculateCost, CurrencyCode, MODEL_PRICING } from "./cost-display";

const CACHE_FILE = resolve(process.env.DATA_DIR || "./data", "cost-cache.json");
const CACHE_REFRESH_MS = 5 * 60 * 1000; // 5分キャッシュ

interface CostRecord {
  date: string;       // YYYY-MM-DD
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

interface CostCache {
  records: CostRecord[];
  lastRefresh: number;
  currency: CurrencyCode;
}

class CumulativeCostCache {
  private cache: CostCache = {
    records: [],
    lastRefresh: 0,
    currency: "JPY",
  };
  private loaded = false;

  constructor() {
    this.load();
  }

  /**
   * ディスクからキャッシュを読み込み
   */
  private load(): void {
    try {
      if (existsSync(CACHE_FILE)) {
        const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
        this.cache = {
          records: data.records || [],
          lastRefresh: data.lastRefresh || 0,
          currency: data.currency || "JPY",
        };
        this.loaded = true;
        logger.debug(`[CostCache] ${this.cache.records.length}件のコスト記録を復元`);
      }
    } catch (e) {
      logger.warn(`[CostCache] 読み込み失敗: ${e}`);
    }
  }

  /**
   * ディスクに保存
   */
  private save(): void {
    try {
      const dir = resolve(process.env.DATA_DIR || "./data");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(this.cache, null, 2), "utf-8");
    } catch (e) {
      logger.warn(`[CostCache] 保存失敗: ${e}`);
    }
  }

  /**
   * API呼び出しのコストを記録
   */
  recordCall(modelName: string, inputTokens: number, outputTokens: number, cacheTokens: number = 0): void {
    const breakdown = calculateCost(modelName, inputTokens, outputTokens, cacheTokens, "USD");
    const today = new Date().toISOString().slice(0, 10);

    this.cache.records.push({
      date: today,
      model: modelName,
      inputTokens,
      outputTokens,
      cost: breakdown.totalCost,
      timestamp: Date.now(),
    });

    // 1000件を超えたら古いのを削除
    if (this.cache.records.length > 1000) {
      this.cache.records = this.cache.records.slice(-1000);
    }

    // 5分以上経過してたら保存
    if (Date.now() - this.cache.lastRefresh > CACHE_REFRESH_MS) {
      this.cache.lastRefresh = Date.now();
      this.save();
    }
  }

  /**
   * 今日のコスト合計
   */
  getTodayCost(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.cache.records
      .filter(r => r.date === today)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * 今月のコスト合計
   */
  getMonthCost(): number {
    const thisMonth = new Date().toISOString().slice(0, 7);
    return this.cache.records
      .filter(r => r.date.startsWith(thisMonth))
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * 全期間のコスト合計
   */
  getTotalCost(): number {
    return this.cache.records.reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * モデル別コスト
   */
  getCostByModel(): Record<string, number> {
    const byModel: Record<string, number> = {};
    for (const r of this.cache.records) {
      byModel[r.model] = (byModel[r.model] || 0) + r.cost;
    }
    return byModel;
  }

  /**
   * 日別コスト
   */
  getCostByDay(days: number = 30): Record<string, number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const byDay: Record<string, number> = {};

    for (const r of this.cache.records) {
      if (r.timestamp < cutoff) continue;
      byDay[r.date] = (byDay[r.date] || 0) + r.cost;
    }
    return byDay;
  }

  /**
   * 通貨を設定
   */
  setCurrency(currency: CurrencyCode): void {
    this.cache.currency = currency;
    this.save();
  }

  /**
   * 現在の通貨
   */
  get currency(): CurrencyCode {
    return this.cache.currency;
  }

  /**
   * USD→指定通貨変換
   */
  private convert(usd: number): string {
    const { EXCHANGE_RATES } = require("./cost-display");
    const rate = EXCHANGE_RATES[this.cache.currency] || 1;
    const converted = usd * rate;
    const symbols: Record<string, string> = { USD: "$", JPY: "¥", EUR: "€", GBP: "£" };
    const sym = symbols[this.cache.currency] || "$";

    if (converted < 1) return `${sym}${converted.toFixed(4)}`;
    if (converted < 100) return `${sym}${converted.toFixed(2)}`;
    return `${sym}${Math.round(converted).toLocaleString()}`;
  }

  /**
   * サマリーをフォーマット
   * claude-pulse: cumulative cost display
   */
  formatSummary(): string {
    const total = this.getTotalCost();
    const month = this.getMonthCost();
    const today = this.getTodayCost();
    const byModel = this.getCostByModel();
    const byDay = this.getCostByDay(7);

    if (this.cache.records.length === 0) {
      return "📊 **累積コスト**\nまだ記録がありません。APIを使用すると自動記録されます。";
    }

    const lines = [`📊 **APIコストサマリー**`];
    lines.push(`全期間: ${this.convert(total)} | 今月: ${this.convert(month)} | 今日: ${this.convert(today)}`);
    lines.push(`記録数: ${this.cache.records.length}件 | 通貨: ${this.cache.currency}`);

    if (Object.keys(byModel).length > 0) {
      lines.push(``);
      lines.push(`**モデル別**`);
      const sorted = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
      for (const [model, cost] of sorted) {
        lines.push(`  - ${model}: ${this.convert(cost)}`);
      }
    }

    if (Object.keys(byDay).length > 0) {
      lines.push(``);
      lines.push(`**直近7日間**`);
      for (const [date, cost] of Object.entries(byDay).sort()) {
        lines.push(`  - ${date}: ${this.convert(cost)}`);
      }
    }

    return lines.join("\n");
  }
}

export const cumulativeCost = new CumulativeCostCache();
