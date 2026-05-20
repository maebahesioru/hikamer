// ==========================================
// Hikamer - サブコンシャス（OpenHuman subconscious由来）
// バックグラウンド定期思考・自己分析・傾向検出
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

interface SubconsciousConfig {
  /** 思考間隔（ミリ秒） */
  thinkingIntervalMs: number;
  /** 自己分析間隔（ミリ秒） */
  introspectionIntervalMs: number;
  /** セッション分析間隔（ミリ秒） */
  sessionAnalysisIntervalMs: number;
  /** 有効な思考モジュール */
  enabledModules: SubconsciousModule[];
}

type SubconsciousModule = "cost_analysis" | "session_analysis" | "health_check" | "trend_detection" | "report_generation";

const DEFAULT_CONFIG: SubconsciousConfig = {
  thinkingIntervalMs: 300000,        // 5分
  introspectionIntervalMs: 3600000,  // 1時間
  sessionAnalysisIntervalMs: 600000,  // 10分
  enabledModules: ["cost_analysis", "session_analysis", "health_check"],
};

// ==================== 思考エンジン ====================

interface ThinkingResult {
  timestamp: string;
  module: string;
  summary: string;
  data?: Record<string, unknown>;
  severity: "info" | "warn" | "alert";
}

class SubconsciousEngine {
  private config: SubconsciousConfig;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private running = false;
  private thinkingHistory: ThinkingResult[] = [];
  private startTime = 0;

  // 状態追跡
  private prevSessionCount = 0;
  private prevCostTotal = 0;

  constructor(config: Partial<SubconsciousConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    logger.info(`[Subconscious] 起動 (interval=${this.config.thinkingIntervalMs}ms)`);
    eventBus.publish(createEvent("system", "subconsciousStarted", {
      modules: this.config.enabledModules,
    }));

    // 思考ループ
    if (this.config.enabledModules.length > 0) {
      this.timers.push(setInterval(() => {
        this.think().catch(e => logger.error(`[Subconscious] 思考エラー: ${e.message}`));
      }, this.config.thinkingIntervalMs));
    }

    // 自己分析（初回は遅延）
    if (this.config.enabledModules.includes("session_analysis")) {
      this.timers.push(setInterval(() => {
        this.analyzeSessions().catch(e => logger.error(`[Subconscious] 分析エラー: ${e.message}`));
      }, this.config.introspectionIntervalMs));
    }

    // 初回思考は30秒後
    setTimeout(() => {
      this.think().catch(e => logger.error(`[Subconscious] 初回思考エラー: ${e.message}`));
    }, 30000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    logger.info("[Subconscious] 停止");
    eventBus.publish(createEvent("system", "subconsciousStopped", {}));
  }

  /** 思考サイクル */
  private async think(): Promise<void> {
    const results: ThinkingResult[] = [];

    for (const module of this.config.enabledModules) {
      try {
        switch (module) {
          case "cost_analysis":
            results.push(await this.analyzeCosts());
            break;
          case "health_check":
            results.push(await this.checkHealth());
            break;
          case "trend_detection":
            results.push(await this.detectTrends());
            break;
          case "report_generation":
            // レポート生成は間隔が別
            break;
        }
      } catch (e: any) {
        logger.error(`[Subconscious] モジュール失敗: ${module} — ${e.message}`);
      }
    }

    // 重要結果をイベントバスに発行
    for (const r of results) {
      if (r.severity === "alert") {
        eventBus.publish(createEvent("system", "subconsciousAlert", {
          module: r.module,
          summary: r.summary,
          data: r.data,
        }));
        logger.warn(`[Subconscious] ${r.module}: ${r.summary}`);
      }
    }

    this.thinkingHistory.push(...results);
    if (this.thinkingHistory.length > 100) {
      this.thinkingHistory.splice(0, this.thinkingHistory.length - 100);
    }
  }

  // ==================== 分析モジュール ====================

  private async analyzeCosts(): Promise<ThinkingResult> {
    try {
      const { getCostSummary } = await import("./cost-tracker");
      const summary = getCostSummary();
      const costDelta = summary.totalCost - this.prevCostTotal;
      this.prevCostTotal = summary.totalCost;

      const result: ThinkingResult = {
        timestamp: new Date().toISOString(),
        module: "cost_analysis",
        summary: `コスト: 累計$${summary.totalCost.toFixed(4)} (前回比+$${costDelta.toFixed(4)})`,
        data: {
          totalCost: summary.totalCost,
          costDelta,
          totalCalls: summary.totalCalls,
        },
        severity: summary.totalCost > 1 ? "warn" : "info",
      };

      // コスト急増検出
      if (costDelta > 0.5) {
        result.severity = "alert";
        result.summary = `⚠️ コスト急増検出: +$${costDelta.toFixed(4)} (累計$${summary.totalCost.toFixed(4)})`;
      }

      return result;
    } catch {
      return {
        timestamp: new Date().toISOString(),
        module: "cost_analysis",
        summary: "コストデータなし",
        severity: "info",
      };
    }
  }

  private async checkHealth(): Promise<ThinkingResult> {
    try {
      const { runHealthCheck } = await import("./health");
      const health = await runHealthCheck();

      return {
        timestamp: new Date().toISOString(),
        module: "health_check",
        summary: `ヘルス: ${health.status} (${health.memoryMB}MB, ${Math.floor(health.uptime / 60)}分稼働)`,
        data: {
          status: health.status,
          memoryMB: health.memoryMB,
          uptime: health.uptime,
          toolCount: health.toolCount,
          sessionCount: health.sessionCount,
        },
        severity: health.status === "down" ? "alert" : health.status === "degraded" ? "warn" : "info",
      };
    } catch {
      return {
        timestamp: new Date().toISOString(),
        module: "health_check",
        summary: "ヘルスチェック失敗",
        severity: "warn",
      };
    }
  }

  private async analyzeSessions(): Promise<ThinkingResult> {
    try {
      const { getCostSummary } = await import("./cost-tracker");
      const summary = getCostSummary();
      const sessionDelta = Object.keys(summary.sessions).length - this.prevSessionCount;
      this.prevSessionCount = Object.keys(summary.sessions).length;

      return {
        timestamp: new Date().toISOString(),
        module: "session_analysis",
        summary: `セッション: ${Object.keys(summary.sessions).length}件 (新規+${sessionDelta})`,
        data: {
          totalSessions: Object.keys(summary.sessions).length,
          newSessions: sessionDelta,
        },
        severity: sessionDelta > 10 ? "warn" : "info",
      };
    } catch {
      return {
        timestamp: new Date().toISOString(),
        module: "session_analysis",
        summary: "セッション分析失敗",
        severity: "info",
      };
    }
  }

  private async detectTrends(): Promise<ThinkingResult> {
    try {
      const { runHealthCheck } = await import("./health");
      const health = await runHealthCheck();

      // メモリリーク検出（簡易）
      let severity: ThinkingResult["severity"] = "info";
      let summary = "傾向: 正常";

      if (health.memoryMB > 400) {
        severity = "warn";
        summary = `⚠️ メモリ増加傾向: ${health.memoryMB}MB (リークの可能性)`;
      }

      return {
        timestamp: new Date().toISOString(),
        module: "trend_detection",
        summary,
        data: { memoryMB: health.memoryMB },
        severity,
      };
    } catch {
      return {
        timestamp: new Date().toISOString(),
        module: "trend_detection",
        summary: "傾向分析失敗",
        severity: "info",
      };
    }
  }

  // ==================== 履歴 ====================

  getHistory(module?: string, limit = 20): ThinkingResult[] {
    let results = this.thinkingHistory;
    if (module) results = results.filter(r => r.module === module);
    return results.slice(-limit);
  }

  /** アラートのみ取得 */
  getAlerts(limit = 10): ThinkingResult[] {
    return this.thinkingHistory.filter(r => r.severity === "alert").slice(-limit);
  }

  getUptime(): number {
    return this.running ? Date.now() - this.startTime : 0;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// ==================== シングルトン ====================

export const subconscious = new SubconsciousEngine();
