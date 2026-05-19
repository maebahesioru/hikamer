// ==========================================
// Aikata - 株カード簡易分析 (v1.60)
// 出典: TradingAgents (TauricResearch) + OpenTrader のパターン
// 高校生向け: 3指標 + ヘルススコア、LLM不要
// データソース: Yahoo Finance (無料・認証不要)
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface StockQuote {
  symbol: string;
  name?: string;
  price: number;
  change: number;       // 変化額
  changePercent: number; // 変化率(%)
  volume: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  currency?: string;
}

export interface TechnicalSignals {
  /** SMA50 > SMA200 なら上昇トレンド */
  trend: "up" | "down" | "neutral";
  trendStrength: number; // 0-100
  /** RSI (0-100) */
  rsi: number | null;
  rsiZone: "oversold" | "neutral" | "overbought" | "unknown";
  /** 出来高シグナル */
  volumeSignal: "high" | "normal" | "low";
  /** 総合ヘルススコア (0-100) */
  healthScore: number;
  /** 推奨アクション */
  recommendation: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell";
  recommendationLabel: string;
}

export interface StockCard {
  quote: StockQuote;
  technicals: TechnicalSignals;
  generatedAt: number;
}

// ==================== Yahoo Finance API ====================

// 日本株は .T サフィックス (例: 6758.T = ソニー)
// 米国株はそのまま (例: AAPL)

function normalizeSymbol(symbol: string): string {
  // 数字4桁の場合は .T を自動付与（日本株コードとみなす）
  if (/^\d{4}$/.test(symbol)) return `${symbol}.T`;
  return symbol;
}

async function fetchYahooFinance(symbol: string): Promise<any> {
  const normalized = normalizeSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?interval=1d&range=6mo`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Aikata/1.0 stock-card)",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

// ==================== テクニカル分析 ====================

function calcSMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcRSI(prices: number[], period: number = 14): number | null {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcAvgVolume(volumes: number[], period: number): number {
  if (volumes.length < period) return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcHealthScore(
  trend: TechnicalSignals["trend"],
  trendStrength: number,
  rsiZone: TechnicalSignals["rsiZone"],
  volumeSignal: TechnicalSignals["volumeSignal"],
  changePercent: number,
): number {
  let score = 50; // ベース

  // トレンド (最大±20)
  if (trend === "up") score += trendStrength * 0.2;
  else if (trend === "down") score -= (100 - trendStrength) * 0.2;
  // neutral: 変化なし

  // RSI (最大±15)
  if (rsiZone === "neutral") score += 10;
  else if (rsiZone === "oversold") score += 5; // 売られすぎ=割安の可能性
  else if (rsiZone === "overbought") score -= 15;

  // 出来高 (最大±10)
  if (volumeSignal === "high") score += 5;
  else if (volumeSignal === "low") score -= 5;

  // 直近変化率 (最大±15)
  score += Math.min(Math.max(changePercent * 2, -15), 15);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getRecommendation(
  healthScore: number,
  trend: TechnicalSignals["trend"],
): { recommendation: TechnicalSignals["recommendation"]; label: string } {
  if (trend === "down" && healthScore < 30) return { recommendation: "strong_sell", label: "⚠️ 強く売り" };
  if (healthScore < 30) return { recommendation: "sell", label: "🔻 売り推奨" };
  if (healthScore < 40) return { recommendation: "sell", label: "📉 様子見(弱気)" };
  if (healthScore < 55) return { recommendation: "hold", label: "⏸️ ホールド" };
  if (healthScore < 65) return { recommendation: "hold", label: "📊 様子見(強気)" };
  if (healthScore < 80) return { recommendation: "buy", label: "📈 買い推奨" };
  return { recommendation: "strong_buy", label: "🚀 強く買い" };
}

// ==================== メインAPI ====================

export async function analyzeStock(symbol: string): Promise<StockCard> {
  const raw = await fetchYahooFinance(symbol);

  const chart = raw?.chart?.result?.[0];
  if (!chart) throw new Error(`銘柄 ${symbol} のデータが見つかりません`);

  const meta = chart.meta;
  const quotes = chart.indicators?.quote?.[0];
  const adjclose = chart.indicators?.adjclose?.[0];
  const timestamps = chart.timestamp as number[];

  if (!quotes || !timestamps || timestamps.length < 30) {
    throw new Error(`銘柄 ${symbol} の履歴データが不足しています（${timestamps?.length || 0}日分）`);
  }

  const prices = (adjclose?.adjclose ?? quotes.close).filter((v: any) => v != null) as number[];
  const volumes = quotes.volume?.filter((v: any) => v != null) as number[];
  const latestPrice = meta.regularMarketPrice;
  const prevClose = meta.previousClose || meta.chartPreviousClose;
  const change = latestPrice - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  // テクニカル指標計算
  const sma50 = calcSMA(prices, 50);
  const sma200 = calcSMA(prices, 200);
  const rsi = calcRSI(prices, 14);
  const avgVolume20 = calcAvgVolume(volumes, 20);
  const latestVolume = volumes[volumes.length - 1] ?? 0;

  // トレンド判定
  let trend: TechnicalSignals["trend"] = "neutral";
  let trendStrength = 50;
  if (sma50 && sma200) {
    const diff = ((sma50 - sma200) / sma200) * 100;
    if (diff > 1) { trend = "up"; trendStrength = Math.min(100, 50 + diff * 10); }
    else if (diff < -1) { trend = "down"; trendStrength = Math.min(100, 50 + Math.abs(diff) * 10); }
    else { trendStrength = 50; }
  }

  // RSIゾーン
  let rsiZone: TechnicalSignals["rsiZone"] = "unknown";
  if (rsi !== null) {
    if (rsi < 30) rsiZone = "oversold";
    else if (rsi > 70) rsiZone = "overbought";
    else rsiZone = "neutral";
  }

  // 出来高シグナル
  let volumeSignal: TechnicalSignals["volumeSignal"] = "normal";
  if (avgVolume20 > 0) {
    const ratio = latestVolume / avgVolume20;
    if (ratio > 2) volumeSignal = "high";
    else if (ratio < 0.5) volumeSignal = "low";
  }

  const healthScore = calcHealthScore(trend, trendStrength, rsiZone, volumeSignal, changePercent);
  const rec = getRecommendation(healthScore, trend);

  const quote: StockQuote = {
    symbol: normalizeSymbol(symbol),
    name: meta.longName || meta.shortName,
    price: latestPrice,
    change,
    changePercent,
    volume: latestVolume,
    high: meta.regularMarketDayHigh ?? latestPrice,
    low: meta.regularMarketDayLow ?? latestPrice,
    open: meta.regularMarketOpen ?? latestPrice,
    prevClose,
    currency: meta.currency || "JPY",
  };

  const technicals: TechnicalSignals = {
    trend,
    trendStrength,
    rsi,
    rsiZone,
    volumeSignal,
    healthScore,
    recommendation: rec.recommendation,
    recommendationLabel: rec.label,
  };

  logger.info(`[StockCard] ${symbol}: score=${healthScore} trend=${trend} rsi=${rsi?.toFixed(1)}`);

  return { quote, technicals, generatedAt: Date.now() };
}

// ==================== フォーマット ====================

function trendEmoji(trend: TechnicalSignals["trend"]): string {
  if (trend === "up") return "🟢";
  if (trend === "down") return "🔴";
  return "🟡";
}

function rsiEmoji(zone: TechnicalSignals["rsiZone"]): string {
  if (zone === "oversold") return "🟢";
  if (zone === "overbought") return "🔴";
  if (zone === "neutral") return "🟡";
  return "⚪";
}

function volumeEmoji(signal: TechnicalSignals["volumeSignal"]): string {
  if (signal === "high") return "🔥";
  if (signal === "low") return "💤";
  return "📊";
}

function healthBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  let color: string;
  if (score >= 70) color = "🟢";
  else if (score >= 40) color = "🟡";
  else color = "🔴";
  return color.repeat(filled) + "⬛".repeat(empty);
}

export function formatStockCard(card: StockCard): string {
  const { quote, technicals } = card;

  const changeSign = quote.change >= 0 ? "+" : "";
  const changeLine = `${changeSign}${quote.change.toFixed(2)} (${changeSign}${quote.changePercent.toFixed(2)}%)`;

  return [
    `📊 **${quote.name || quote.symbol}** (\`${quote.symbol}\`)`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `💰 現在価格: **${quote.currency === "JPY" ? "¥" : "$"}${quote.price.toLocaleString()}**  ${changeSign}${changeLine}`,
    `📈 高値/安値: ${quote.high.toLocaleString()} / ${quote.low.toLocaleString()}`,
    `📊 始値/前日終値: ${quote.open.toLocaleString()} / ${quote.prevClose.toLocaleString()}`,
    ``,
    `**📈 テクニカル分析**`,
    `${trendEmoji(technicals.trend)} トレンド: ${technicals.trend === "up" ? "上昇 📈" : technicals.trend === "down" ? "下降 📉" : "横ばい ➡️"} (強度: ${technicals.trendStrength}/100)`,
    `${rsiEmoji(technicals.rsiZone)} RSI: ${technicals.rsi !== null ? technicals.rsi.toFixed(1) : "N/A"} (${technicals.rsiZone})`,
    `${volumeEmoji(technicals.volumeSignal)} 出来高: ${technicals.volumeSignal} (${quote.volume.toLocaleString()})`,
    ``,
    `🩺 **ヘルススコア: ${technicals.healthScore}/100**`,
    `${healthBar(technicals.healthScore)}`,
    `👉 ${technicals.recommendationLabel}`,
    ``,
    `⚠️ *これはAIによる簡易分析です。投資は自己責任で。高校生は実金を使わずに学習しましょう。*`,
  ].join("\n");
}

export function formatSimpleStockCard(card: StockCard): string {
  const { quote, technicals } = card;
  return (
    `📊 **${quote.name || quote.symbol}** | ` +
    `${quote.currency === "JPY" ? "¥" : "$"}${quote.price.toLocaleString()} | ` +
    `スコア **${technicals.healthScore}/100** ${technicals.recommendationLabel}`
  );
}
