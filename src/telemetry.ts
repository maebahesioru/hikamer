// ==========================================
// Aikata - Agent Telemetry (v1.68)
// 出典: langfuse (YC W23, 7K+★) 軽量版 + Hermes Agent GEPAパターン
// 構造化トレーシング: 全ツール呼び出し・レイテンシ・成功率を追跡
// 改善しようにも計測できてなかった問題を解決
// ==========================================

import { logger } from "./utils/logger";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

// ==================== 型定義 ====================

export interface ToolTrace {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  sessionId: string;
  iteration: number;
}

export interface TurnTrace {
  turnNumber: number;
  sessionId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: ToolTrace[];
  success: boolean;
  error?: string;
}

export interface SessionStats {
  sessionId: string;
  totalTurns: number;
  totalDurationMs: number;
  totalTokens: number;
  totalCost: number;
  successRate: number;
  avgTurnDurationMs: number;
  topTools: { name: string; count: number }[];
  topErrors: { message: string; count: number }[];
  startedAt: number;
  lastActivity: number;
}

export interface TelemetryReport {
  sessions: SessionStats[];
  globalStats: {
    totalSessions: number;
    totalTurns: number;
    totalTokens: number;
    totalCost: number;
    overallSuccessRate: number;
    avgTurnsPerSession: number;
  };
}

// ==================== テレメトリーエンジン ====================

const DATA_DIR = resolve(process.env.DATA_DIR || "./data", "telemetry");
const TRACES_FILE = resolve(DATA_DIR, "traces.json");

class AgentTelemetry {
  private traces: TurnTrace[] = [];
  private maxTraces = 500;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadFromDisk();
    logger.info(`[Telemetry] 初期化: ${this.traces.length}トレース`);
  }

  /** ターンのトレースを記録 */
  recordTurn(trace: TurnTrace): void {
    this.traces.push(trace);

    if (this.traces.length > this.maxTraces) {
      this.traces = this.traces.slice(-this.maxTraces);
    }

    // 10ターンごとにディスクに保存
    if (this.traces.length % 10 === 0) {
      this.saveToDisk();
    }

    logger.debug(`[Telemetry] Turn#${trace.turnNumber}: ${trace.durationMs}ms, ${trace.toolCalls.length}tools, ${trace.success ? "✅" : "❌"}`);
  }

  /** セッション統計を生成 */
  getSessionStats(sessionId?: string): SessionStats[] {
    const sessions = new Map<string, TurnTrace[]>();

    for (const trace of this.traces) {
      if (sessionId && trace.sessionId !== sessionId) continue;
      const arr = sessions.get(trace.sessionId) || [];
      arr.push(trace);
      sessions.set(trace.sessionId, arr);
    }

    const stats: SessionStats[] = [];

    for (const [sid, turns] of sessions) {
      const successCount = turns.filter(t => t.success).length;

      // ツール使用頻度
      const toolCounts = new Map<string, number>();
      const errorCounts = new Map<string, number>();
      for (const t of turns) {
        for (const tc of t.toolCalls) {
          toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
        }
        if (t.error) {
          const shortError = t.error.slice(0, 60);
          errorCounts.set(shortError, (errorCounts.get(shortError) || 0) + 1);
        }
      }

      const totalDuration = turns.reduce((sum, t) => sum + t.durationMs, 0);
      const totalTokens = turns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens + t.reasoningTokens, 0);

      stats.push({
        sessionId: sid,
        totalTurns: turns.length,
        totalDurationMs: totalDuration,
        totalTokens,
        totalCost: this.estimateCost(totalTokens, turns[0]?.modelUsed),
        successRate: turns.length > 0 ? (successCount / turns.length) * 100 : 0,
        avgTurnDurationMs: turns.length > 0 ? totalDuration / turns.length : 0,
        topTools: [...toolCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => ({ name, count })),
        topErrors: [...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([message, count]) => ({ message, count })),
        startedAt: turns[0]?.startTime || 0,
        lastActivity: turns[turns.length - 1]?.endTime || 0,
      });
    }

    return stats.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** 全体レポート */
  getReport(): TelemetryReport {
    const sessions = this.getSessionStats();
    const totalTurns = sessions.reduce((s, ss) => s + ss.totalTurns, 0);
    const totalTokens = sessions.reduce((s, ss) => s + ss.totalTokens, 0);
    const totalCost = sessions.reduce((s, ss) => s + ss.totalCost, 0);
    const totalSuccesses = sessions.reduce((s, ss) => s + (ss.successRate / 100) * ss.totalTurns, 0);

    return {
      sessions,
      globalStats: {
        totalSessions: sessions.length,
        totalTurns,
        totalTokens,
        totalCost,
        overallSuccessRate: totalTurns > 0 ? (totalSuccesses / totalTurns) * 100 : 0,
        avgTurnsPerSession: sessions.length > 0 ? totalTurns / sessions.length : 0,
      },
    };
  }

  /** 失敗パターン検出 (GEPA: 同じエラーが3回以上なら要注意) */
  detectFailurePatterns(): { pattern: string; count: number; sessions: string[] }[] {
    const errorMap = new Map<string, { count: number; sessions: Set<string> }>();

    for (const trace of this.traces) {
      if (!trace.error) continue;
      // エラーメッセージを正規化
      const normalized = trace.error
        .replace(/\d+/g, "N")
        .replace(/0x[0-9a-f]+/gi, "HEX")
        .slice(0, 80);

      const existing = errorMap.get(normalized);
      if (existing) {
        existing.count++;
        existing.sessions.add(trace.sessionId);
      } else {
        errorMap.set(normalized, { count: 1, sessions: new Set([trace.sessionId]) });
      }
    }

    return [...errorMap.entries()]
      .filter(([, v]) => v.count >= 3) // GEPA: 3回以上でパターン認定
      .map(([pattern, v]) => ({
        pattern,
        count: v.count,
        sessions: [...v.sessions],
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** 改善提案を生成 (GEPA: 失敗パターンから学習) */
  generateRecommendations(): string[] {
    const patterns = this.detectFailurePatterns();
    if (patterns.length === 0) return [];

    const recs: string[] = [];
    for (const p of patterns.slice(0, 3)) {
      if (p.pattern.includes("timeout") || p.pattern.includes("ETIMEDOUT")) {
        recs.push(`⏱️ タイムアウト多発 (${p.count}回): ツールタイムアウト値を増やすか、ネットワーク状況を確認`);
      } else if (p.pattern.includes("rate limit") || p.pattern.includes("429")) {
        recs.push(`🚦 レート制限 (${p.count}回): リクエスト間隔を空けるか、別のAPIキーを使用`);
      } else if (p.pattern.includes("auth") || p.pattern.includes("401") || p.pattern.includes("403")) {
        recs.push(`🔐 認証エラー (${p.count}回): APIキーの有効期限・権限を確認`);
      } else if (p.pattern.includes("not found") || p.pattern.includes("404")) {
        recs.push(`🔍 リソース未検出 (${p.count}回): URLやファイルパスの確認`);
      } else {
        recs.push(`⚠️ エラーパターン「${p.pattern.slice(0, 50)}」(${p.count}回): 要調査`);
      }
    }

    return recs;
  }

  // ========== フォーマット ==========

  formatReport(report: TelemetryReport): string {
    const g = report.globalStats;
    const lines: string[] = [
      `📊 **Aikata テレメトリーレポート**`,
      ``,
      `**全体統計**`,
      `セッション数: ${g.totalSessions}`,
      `総ターン数: ${g.totalTurns}`,
      `総トークン: ${g.totalTokens.toLocaleString()}`,
      `総コスト: $${g.totalCost.toFixed(4)}`,
      `成功率: ${g.overallSuccessRate.toFixed(1)}%`,
      `平均ターン/セッション: ${g.avgTurnsPerSession.toFixed(1)}`,
    ];

    // 最近のセッション
    if (report.sessions.length > 0) {
      lines.push(``, `**最近のセッション**`);
      for (const s of report.sessions.slice(0, 5)) {
        const icon = s.successRate >= 80 ? "🟢" : s.successRate >= 50 ? "🟡" : "🔴";
        const duration = s.totalDurationMs > 60000
          ? `${(s.totalDurationMs / 60000).toFixed(1)}分`
          : `${(s.totalDurationMs / 1000).toFixed(1)}秒`;
        lines.push(
          `${icon} \`${s.sessionId.slice(0, 12)}\`: ${s.totalTurns}ターン | ${duration} | ` +
          `成功率${s.successRate.toFixed(0)}% | $${s.totalCost.toFixed(4)}`
        );
        if (s.topTools.length > 0) {
          lines.push(`  🔧 ${s.topTools.map(t => `${t.name}×${t.count}`).join(", ")}`);
        }
      }
    }

    // 改善提案
    const recs = this.generateRecommendations();
    if (recs.length > 0) {
      lines.push(``, `**💡 改善提案 (GEPA自己進化)**`);
      for (const r of recs) lines.push(r);
    }

    return lines.join("\n");
  }

  formatSessionDetail(sessionId: string): string {
    const sessions = this.getSessionStats(sessionId);
    if (sessions.length === 0) return "📭 セッションが見つかりません。";

    const s = sessions[0]!;
    const turns = this.traces.filter(t => t.sessionId === sessionId);

    const lines: string[] = [
      `📊 **セッション詳細**: \`${sessionId.slice(0, 16)}\``,
      `ターン数: ${s.totalTurns} | 成功率: ${s.successRate.toFixed(0)}%`,
      `総時間: ${(s.totalDurationMs / 1000).toFixed(1)}秒 | 平均: ${(s.avgTurnDurationMs / 1000).toFixed(1)}秒/ターン`,
      `トークン: ${s.totalTokens.toLocaleString()} | コスト: $${s.totalCost.toFixed(4)}`,
      ``,
      `**ターン詳細**`,
    ];

    for (const t of turns.slice(-20)) {
      const icon = t.success ? "✅" : "❌";
      const toolNames = t.toolCalls.map(tc => tc.toolName).join(", ") || "(テキストのみ)";
      lines.push(
        `${icon} Turn#${t.turnNumber}: ${t.durationMs}ms | ${t.modelUsed} | ` +
        `${toolNames}${t.error ? ` | ❌ ${t.error.slice(0, 50)}` : ""}`
      );
    }

    return lines.join("\n");
  }

  formatFailurePatterns(): string {
    const patterns = this.detectFailurePatterns();
    if (patterns.length === 0) return "✅ 失敗パターンは検出されていません。";

    const lines: string[] = [`🔍 **失敗パターン分析** (GEPA)`, ``];
    for (const p of patterns.slice(0, 5)) {
      lines.push(`⚠️ **${p.count}回**: ${p.pattern.slice(0, 100)}`);
    }

    const recs = this.generateRecommendations();
    if (recs.length > 0) {
      lines.push(``, `**💡 改善提案**`);
      for (const r of recs) lines.push(r);
    }

    return lines.join("\n");
  }

  /** 全トレースをクリア */
  reset(): void {
    this.traces = [];
    this.saveToDisk();
    logger.info("[Telemetry] リセット");
  }

  // ========== 永続化 ==========

  private saveToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(TRACES_FILE, JSON.stringify(this.traces, null, 2), "utf-8");
    } catch {}
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(TRACES_FILE)) {
        const data = JSON.parse(readFileSync(TRACES_FILE, "utf-8"));
        if (Array.isArray(data)) this.traces = data.slice(-this.maxTraces);
      }
    } catch {}
  }

  private estimateCost(tokens: number, model?: string): number {
    // 簡易コスト推定 ($/1K tokens)
    const rates: Record<string, number> = {
      "claude-sonnet-4": 0.003,
      "claude-opus-4": 0.015,
      "gpt-5": 0.005,
      "deepseek-v4": 0.001,
    };
    const rate = model ? (rates[model] || 0.003) : 0.003;
    return (tokens / 1000) * rate;
  }
}

// ==================== シングルトン ====================

export const telemetry = new AgentTelemetry();
export default AgentTelemetry;
