// ==========================================
// Hikamer - 使用分析（Hermes Agent insights.py 由来）
// 使用パターン分析・統計・インサイト
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface UsageStats {
  periodStart: number;
  periodEnd: number;
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  activeUsers: number;
  activeSessions: number;
  topModels: Array<{ model: string; requests: number; tokens: number; cost: number }>;
  topTools: Array<{ tool: string; calls: number }>;
  errorRate: number;
  avgLatencyMs: number;
}

export interface DailyUsage {
  date: string;
  requests: number;
  tokens: number;
  cost: number;
  errors: number;
  users: number;
}

export interface Insight {
  id: string;
  type: "trend" | "anomaly" | "optimization" | "usage";
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  data: Record<string, unknown>;
  timestamp: number;
}

// ==================== 分析エンジン ====================

class InsightsEngine {
  private dailyUsage: DailyUsage[] = [];
  private insights: Insight[] = [];
  private stats: UsageStats | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Insights] engine initialized");
  }

  /** 使用統計を記録 */
  recordUsage(entry: {
    model: string;
    tool?: string;
    tokens: number;
    cost: number;
    latencyMs: number;
    success: boolean;
    user?: string;
    session?: string;
  }): void {
    const today = new Date().toISOString().slice(0, 10);
    let day = this.dailyUsage.find((d) => d.date === today);

    if (!day) {
      day = { date: today, requests: 0, tokens: 0, cost: 0, errors: 0, users: 0 };
      this.dailyUsage.push(day);
      if (this.dailyUsage.length > 90) this.dailyUsage.shift();
    }

    day.requests++;
    day.tokens += entry.tokens;
    day.cost += entry.cost;
    if (!entry.success) day.errors++;
    if (entry.user) day.users = Math.max(day.users, 1);
  }

  /** 期間指定で統計を計算 */
  computeStats(days = 7): UsageStats {
    const cutoff = Date.now() - days * 86400000;
    const relevant = this.dailyUsage.filter(
      (d) => new Date(d.date).getTime() > cutoff
    );

    const totalRequests = relevant.reduce((s, d) => s + d.requests, 0);
    const totalTokens = relevant.reduce((s, d) => s + d.tokens, 0);
    const totalCost = relevant.reduce((s, d) => s + d.cost, 0);
    const totalErrors = relevant.reduce((s, d) => s + d.errors, 0);

    this.stats = {
      periodStart: cutoff,
      periodEnd: Date.now(),
      totalRequests,
      totalTokens,
      totalCost,
      activeUsers: relevant.reduce((s, d) => Math.max(s, d.users), 0),
      activeSessions: 0,
      topModels: [],
      topTools: [],
      errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
      avgLatencyMs: 0,
    };

    return this.stats;
  }

  /** インサイトを生成 */
  generateInsights(): Insight[] {
    this.insights = [];
    const stats = this.computeStats(7);

    // 使用量トレンド
    if (this.dailyUsage.length >= 7) {
      const recent = this.dailyUsage.slice(-7);
      const avgRequests = recent.reduce((s, d) => s + d.requests, 0) / recent.length;
      const yesterday = recent[recent.length - 1]!;

      if (yesterday.requests > avgRequests * 1.5) {
        this.insights.push({
          id: `insight-${Date.now()}-1`,
          type: "trend",
          title: "使用量増加",
          description: `昨日のリクエスト数が平均の${(yesterday.requests / avgRequests * 100).toFixed(0)}%`,
          severity: "info",
          data: { average: avgRequests, yesterday: yesterday.requests },
          timestamp: Date.now(),
        });
      }

      // エラー率
      if (stats.errorRate > 0.1) {
        this.insights.push({
          id: `insight-${Date.now()}-2`,
          type: "anomaly",
          title: "高エラー率",
          description: `エラー率 ${(stats.errorRate * 100).toFixed(1)}%（7日間）`,
          severity: "warning",
          data: { errorRate: stats.errorRate },
          timestamp: Date.now(),
        });
      }
    }

    // コスト分析
    if (stats.totalCost > 0) {
      const avgDailyCost = stats.totalCost / 7;
      this.insights.push({
        id: `insight-${Date.now()}-3`,
        type: "optimization",
        title: "コスト分析",
        description: `7日間の総コスト: $${stats.totalCost.toFixed(4)} (1日平均 $${avgDailyCost.toFixed(4)})`,
        severity: "info",
        data: { totalCost: stats.totalCost, avgDailyCost },
        timestamp: Date.now(),
      });
    }

    return this.insights;
  }

  /** 日別使用量 */
  getDailyUsage(days = 30): DailyUsage[] {
    return this.dailyUsage.slice(-days);
  }

  /** インサイト一覧 */
  getInsights(): Insight[] {
    return [...this.insights];
  }

  /** データをクリア */
  clear(): void {
    this.dailyUsage = [];
    this.insights = [];
    this.stats = null;
  }

  formatStats(stats: UsageStats): string {
    return (
      `📊 **使用分析 (7日間)**\n` +
      `リクエスト: ${stats.totalRequests.toLocaleString()}\n` +
      `トークン: ${(stats.totalTokens / 1000).toFixed(1)}K\n` +
      `コスト: $${stats.totalCost.toFixed(4)}\n` +
      `エラー率: ${(stats.errorRate * 100).toFixed(1)}%\n` +
      `アクティブユーザー: ${stats.activeUsers}\n\n` +
      (this.insights.length > 0
        ? `**インサイト**\n` +
          this.insights
            .map(
              (i) =>
                `${i.severity === "critical" ? "🔴" : i.severity === "warning" ? "🟡" : "💡"} **${i.title}**: ${i.description}`
            )
            .join("\n")
        : "")
    );
  }

  formatDailyUsage(): string {
    return this.dailyUsage
      .slice(-7)
      .map(
        (d) =>
          `${d.date}: ${d.requests}req / ${(d.tokens / 1000).toFixed(0)}K tok / $${d.cost.toFixed(4)}` +
          (d.errors > 0 ? ` (${d.errors}err)` : "")
      )
      .join("\n");
  }
}

// ==================== シングルトン ====================

export const insightsEngine = new InsightsEngine();

export default InsightsEngine;
