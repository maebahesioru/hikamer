// ==========================================
// Aikata - ペーパーポートフォリオ (v1.60)
// 出典: TradingAgents + OpenTrader のパターン
// 実金ゼロの仮想取引で投資を学ぶ
// wallet.ts と統合、goal-system.ts と連携
// ==========================================

import { logger } from "./utils/logger";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { analyzeStock, StockCard, formatSimpleStockCard } from "./stock-card";

// ==================== 型定義 ====================

export type TradeType = "buy" | "sell";
export type TradeStatus = "open" | "closed";

export interface PaperTrade {
  id: string;
  symbol: string;
  type: TradeType;
  quantity: number;
  price: number;         // 約定価格
  totalCost: number;     // 数量 × 価格
  fee: number;           // 手数料 (0.1%想定)
  status: TradeStatus;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  pnl: number | null;   // 損益
  pnlPercent: number | null;
  note: string;
}

export interface PaperPosition {
  symbol: string;
  name?: string;
  quantity: number;
  avgCost: number;         // 平均取得単価
  totalInvested: number;   // 総投資額
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  openedAt: number;
}

export interface PaperPortfolioSummary {
  totalInvested: number;
  totalMarketValue: number | null;
  totalPnl: number | null;
  totalPnlPercent: number | null;
  cashBalance: number;
  totalTrades: number;
  openPositions: number;
  winRate: number | null;
  positions: PaperPosition[];
}

// ==================== ペーパーポートフォリオ管理 ====================

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const PORTFOLIO_FILE = resolve(DATA_DIR, "paper-portfolio.json");
const TRADES_FILE = resolve(DATA_DIR, "paper-trades.json");

class PaperPortfolio {
  private positions: Map<string, PaperPosition> = new Map();
  private trades: PaperTrade[] = [];
  private cashBalance: number;
  private initialized = false;

  constructor(initialCash: number = 1_000_000) { // 100万円スタート
    this.cashBalance = initialCash;
  }

  /** 初期化＋ディスクから復元 */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadFromDisk();
    logger.info(`[PaperPortfolio] 初期化完了: 現金 ¥${this.cashBalance.toLocaleString()}, ${this.positions.size}ポジション`);
  }

  // ========== 取引 ==========

  /** 買い注文 */
  async buy(symbol: string, quantity: number, note?: string): Promise<PaperTrade | null> {
    const card = await analyzeStock(symbol);
    const price = card.quote.price;
    const fee = price * quantity * 0.001; // 0.1%
    const totalCost = price * quantity + fee;

    if (totalCost > this.cashBalance) {
      logger.warn(`[PaperPortfolio] 資金不足: 必要 ¥${totalCost.toLocaleString()} / 残高 ¥${this.cashBalance.toLocaleString()}`);
      return null;
    }

    this.cashBalance -= totalCost;

    // ポジション更新
    const existing = this.positions.get(symbol);
    if (existing) {
      const totalQty = existing.quantity + quantity;
      const totalInvested = existing.totalInvested + totalCost;
      existing.quantity = totalQty;
      existing.avgCost = totalInvested / totalQty;
      existing.totalInvested = totalInvested;
    } else {
      this.positions.set(symbol, {
        symbol,
        name: card.quote.name,
        quantity,
        avgCost: price,
        totalInvested: totalCost,
        currentPrice: null,
        marketValue: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        openedAt: Date.now(),
      });
    }

    const trade: PaperTrade = {
      id: `pt_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      symbol,
      type: "buy",
      quantity,
      price,
      totalCost,
      fee,
      status: "open",
      openedAt: Date.now(),
      closedAt: null,
      closePrice: null,
      pnl: null,
      pnlPercent: null,
      note: note || "",
    };

    this.trades.push(trade);
    this.saveToDisk();

    logger.info(`[PaperPortfolio] BUY ${symbol} ×${quantity} @¥${price.toLocaleString()} = ¥${totalCost.toLocaleString()}`);
    return trade;
  }

  /** 売り注文 */
  async sell(symbol: string, quantity?: number, note?: string): Promise<PaperTrade | null> {
    const position = this.positions.get(symbol);
    if (!position) {
      logger.warn(`[PaperPortfolio] ポジションなし: ${symbol}`);
      return null;
    }

    const sellQty = quantity ?? position.quantity;
    if (sellQty > position.quantity) {
      logger.warn(`[PaperPortfolio] 数量不足: ${symbol} 保有=${position.quantity} 売却=${sellQty}`);
      return null;
    }

    const card = await analyzeStock(symbol);
    const price = card.quote.price;
    const fee = price * sellQty * 0.001;
    const totalProceeds = price * sellQty - fee;

    // 損益計算
    const costBasis = position.avgCost * sellQty;
    const pnl = totalProceeds - costBasis;
    const pnlPercent = (pnl / costBasis) * 100;

    this.cashBalance += totalProceeds;

    // ポジション更新
    position.quantity -= sellQty;
    position.totalInvested -= costBasis;
    if (position.quantity <= 0) {
      this.positions.delete(symbol);
    }

    const trade: PaperTrade = {
      id: `pt_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      symbol,
      type: "sell",
      quantity: sellQty,
      price,
      totalCost: totalProceeds,
      fee,
      status: "closed",
      openedAt: Date.now(),
      closedAt: Date.now(),
      closePrice: price,
      pnl,
      pnlPercent,
      note: note || "",
    };

    this.trades.push(trade);
    this.saveToDisk();

    const pnlSign = pnl >= 0 ? "+" : "";
    logger.info(`[PaperPortfolio] SELL ${symbol} ×${sellQty} @¥${price.toLocaleString()} P&L: ${pnlSign}¥${pnl.toLocaleString()}`);
    return trade;
  }

  // ========== 評価 ==========

  /** 現在の時価評価（株価をリアルタイム取得） */
  async refreshPrices(): Promise<void> {
    const symbols = [...this.positions.keys()];
    for (const symbol of symbols) {
      try {
        const card = await analyzeStock(symbol);
        const position = this.positions.get(symbol);
        if (!position) continue;

        position.currentPrice = card.quote.price;
        position.name = card.quote.name || position.name;
        position.marketValue = card.quote.price * position.quantity;
        position.unrealizedPnl = position.marketValue - position.totalInvested;
        position.unrealizedPnlPercent = (position.unrealizedPnl / position.totalInvested) * 100;
      } catch (e: any) {
        logger.warn(`[PaperPortfolio] 価格取得失敗 ${symbol}: ${e.message}`);
      }
    }
  }

  /** ポートフォリオサマリー */
  async getSummary(): Promise<PaperPortfolioSummary> {
    await this.refreshPrices();

    const positions = [...this.positions.values()];
    const totalInvested = positions.reduce((sum, p) => sum + p.totalInvested, 0);
    const totalMarketValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const totalPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

    // 勝率（決済済みのみ）
    const closedTrades = this.trades.filter(t => t.status === "closed" && t.pnl !== null);
    const wins = closedTrades.filter(t => t.pnl! > 0).length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : null;

    return {
      totalInvested,
      totalMarketValue: totalMarketValue || null,
      totalPnl: totalPnl || null,
      totalPnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : null,
      cashBalance: this.cashBalance,
      totalTrades: this.trades.length,
      openPositions: positions.length,
      winRate,
      positions,
    };
  }

  // ========== フォーマット ==========

  formatSummary(summary: PaperPortfolioSummary): string {
    const pnlSign = (summary.totalPnl ?? 0) >= 0 ? "+" : "";
    const lines: string[] = [
      `💼 **ペーパーポートフォリオ** (仮想取引)`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `💰 現金残高: **¥${summary.cashBalance.toLocaleString()}**`,
      `📈 投資総額: ¥${summary.totalInvested.toLocaleString()}`,
      `📊 時価総額: ${summary.totalMarketValue ? `¥${summary.totalMarketValue.toLocaleString()}` : "N/A"}`,
      `📉 含み損益: ${summary.totalPnl !== null ? `${pnlSign}¥${summary.totalPnl.toLocaleString()} (${pnlSign}${summary.totalPnlPercent?.toFixed(2)}%)` : "N/A"}`,
      ``,
      `🏆 勝率: ${summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : "N/A"} (${summary.totalTrades}取引中)`,
      `📋 保有ポジション: ${summary.openPositions}銘柄`,
    ];

    if (summary.positions.length > 0) {
      lines.push(``);
      lines.push(`**📋 保有銘柄**`);
      // P&L降順
      const sorted = [...summary.positions].sort((a, b) => (b.unrealizedPnl ?? 0) - (a.unrealizedPnl ?? 0));
      for (const p of sorted) {
        const pnlSign = (p.unrealizedPnl ?? 0) >= 0 ? "+" : "";
        lines.push(
          `• **${p.name || p.symbol}** (${p.symbol}) | ` +
          `${p.quantity}株 @¥${p.avgCost.toLocaleString()} | ` +
          `現在: ${p.currentPrice ? `¥${p.currentPrice.toLocaleString()}` : "N/A"} | ` +
          `損益: ${p.unrealizedPnl !== null ? `${pnlSign}¥${Math.abs(p.unrealizedPnl).toLocaleString()}` : "N/A"}`
        );
      }
    }

    lines.push(``);
    lines.push(`⚠️ *これはペーパートレード（仮想取引）です。実金は一切動きません。*`);
    return lines.join("\n");
  }

  formatTradeHistory(limit: number = 10): string {
    const recent = this.trades.slice(-limit).reverse();
    if (recent.length === 0) return "📋 取引履歴がありません。";

    const lines: string[] = [`📋 **取引履歴**（直近${Math.min(limit, recent.length)}件）`, ``];
    for (const t of recent) {
      const typeIcon = t.type === "buy" ? "🟢買" : "🔴売";
      const pnlStr = t.pnl !== null
        ? ` | P&L: ${t.pnl >= 0 ? "+" : ""}¥${t.pnl.toLocaleString()} (${t.pnlPercent?.toFixed(2)}%)`
        : "";
      lines.push(
        `• ${typeIcon} **${t.symbol}** ×${t.quantity} @¥${t.price.toLocaleString()} ` +
        `= ¥${t.totalCost.toLocaleString()}${pnlStr}${t.note ? ` [${t.note}]` : ""}`
      );
    }
    return lines.join("\n");
  }

  // ========== 永続化 ==========

  private saveToDisk(): void {
    try {
      const dataDir = resolve(DATA_DIR);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      writeFileSync(PORTFOLIO_FILE, JSON.stringify({
        positions: [...this.positions.values()],
        cashBalance: this.cashBalance,
        savedAt: Date.now(),
      }, null, 2), "utf-8");

      writeFileSync(TRADES_FILE, JSON.stringify({
        trades: this.trades,
        savedAt: Date.now(),
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[PaperPortfolio] 保存エラー: ${e}`);
    }
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(PORTFOLIO_FILE)) {
        const data = JSON.parse(readFileSync(PORTFOLIO_FILE, "utf-8"));
        if (data.positions) {
          for (const p of data.positions) {
            this.positions.set(p.symbol, p);
          }
        }
        if (typeof data.cashBalance === "number") {
          this.cashBalance = data.cashBalance;
        }
      }
      if (existsSync(TRADES_FILE)) {
        const data = JSON.parse(readFileSync(TRADES_FILE, "utf-8"));
        if (Array.isArray(data.trades)) {
          this.trades = data.trades;
        }
      }
      logger.info(`[PaperPortfolio] 復元: ${this.positions.size}ポジション, ${this.trades.length}取引`);
    } catch (e) {
      logger.warn(`[PaperPortfolio] 復元エラー（新規開始）: ${e}`);
    }
  }

  /** ポートフォリオリセット */
  reset(initialCash: number = 1_000_000): void {
    this.positions.clear();
    this.trades = [];
    this.cashBalance = initialCash;
    this.saveToDisk();
    logger.info(`[PaperPortfolio] リセット完了: ¥${initialCash.toLocaleString()}`);
  }
}

// ==================== シングルトン ====================

export const paperPortfolio = new PaperPortfolio();
export default PaperPortfolio;
