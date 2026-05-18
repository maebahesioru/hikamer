// ==========================================
// Aikata - バックグラウンドレビュー（Hermes Agent background_review.py 由来）
// 会話の自動バックグラウンドレビュー・品質チェック
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface ReviewContext {
  sessionId: string;
  threadId: string;
  messages: ReviewMessage[];
  totalTurns: number;
  totalTokens: number;
  durationMs: number;
  toolsUsed: string[];
  errors: string[];
}

export interface ReviewMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  success?: boolean;
}

export interface ReviewResult {
  id: string;
  timestamp: number;
  sessionId: string;
  score: number; // 0.0 - 1.0
  summary: string;
  issues: ReviewIssue[];
  suggestions: string[];
  safetyFlag: boolean;
}

export interface ReviewIssue {
  type: "error" | "warning" | "info";
  category: "quality" | "safety" | "efficiency" | "accuracy";
  description: string;
  severity: "low" | "medium" | "high";
  suggestedFix?: string;
}

export type ReviewTrigger = "on_complete" | "periodic" | "manual";

// ==================== レビューアー ====================

class BackgroundReviewer {
  private results: ReviewResult[] = [];
  private reviewHistory: Map<string, ReviewResult[]> = new Map();
  private initialized = false;
  private maxResults = 500;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Reviewer] background review initialized");
  }

  /** セッションをレビュー */
  async review(context: ReviewContext): Promise<ReviewResult> {
    const issues: ReviewIssue[] = [];
    const suggestions: string[] = [];
    let safetyFlag = false;

    // 1. 静的チェック
    this.checkQuality(context, issues, suggestions);
    this.checkSafety(context, issues, suggestions, safetyFlagResult => { safetyFlag = safetyFlagResult; });
    this.checkEfficiency(context, issues, suggestions);

    // 2. スコア計算
    const score = this.calculateScore(issues);

    // 3. サマリー生成
    const summary = this.generateSummary(context, issues, suggestions);

    const result: ReviewResult = {
      id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      sessionId: context.sessionId,
      score,
      summary,
      issues,
      suggestions,
      safetyFlag,
    };

    this.results.push(result);

    // セッションごとに保存
    const existing = this.reviewHistory.get(context.sessionId) ?? [];
    existing.push(result);
    if (existing.length > 20) existing.shift();
    this.reviewHistory.set(context.sessionId, existing);

    // 上限
    if (this.results.length > this.maxResults) {
      this.results = this.results.slice(-this.maxResults);
    }

    // 安全フラグが立ったら通知
    if (safetyFlag) {
      eventBus.emit(createEvent("review:safety_flag", {
        sessionId: context.sessionId,
        reviewId: result.id,
        score,
        issues: issues.filter((i) => i.severity === "high"),
      }));
    }

    logger.debug(
      `[Reviewer] session ${context.sessionId.slice(0, 8)}... score: ${(score * 100).toFixed(0)}% ` +
      `issues: ${issues.length} safety: ${safetyFlag}`
    );

    return result;
  }

  /** セッションのレビュー履歴を取得 */
  getSessionReviews(sessionId: string): ReviewResult[] {
    return this.reviewHistory.get(sessionId) ?? [];
  }

  /** 直近のレビュー結果を取得 */
  getRecentReviews(limit = 10): ReviewResult[] {
    return this.results.slice(-limit).reverse();
  }

  /** 低スコアのレビューを取得 */
  getLowScoreReviews(threshold = 0.5, limit = 20): ReviewResult[] {
    return this.results
      .filter((r) => r.score < threshold)
      .slice(-limit)
      .reverse();
  }

  /** 安全フラグが立ったレビューを取得 */
  getSafetyFlags(limit = 20): ReviewResult[] {
    return this.results
      .filter((r) => r.safetyFlag)
      .slice(-limit)
      .reverse();
  }

  /** 統計を取得 */
  getStats() {
    const total = this.results.length;
    if (total === 0) return { total: 0, avgScore: 0, safetyFlags: 0 };
    return {
      total,
      avgScore: this.results.reduce((s, r) => s + r.score, 0) / total,
      safetyFlags: this.results.filter((r) => r.safetyFlag).length,
      lowScores: this.results.filter((r) => r.score < 0.5).length,
    };
  }

  // ---- 品質チェック ---- //

  private checkQuality(
    context: ReviewContext,
    issues: ReviewIssue[],
    suggestions: string[]
  ): void {
    // 空のアシスタント応答
    const emptyResponses = context.messages.filter(
      (m) => m.role === "assistant" && m.content.trim().length < 10
    );
    if (emptyResponses.length > 0) {
      issues.push({
        type: "warning",
        category: "quality",
        severity: emptyResponses.length > 3 ? "high" : "medium",
        description: `${emptyResponses.length}件の空または短すぎる応答`,
        suggestedFix: "モデルのtemperature調整やプロンプトの改善を検討",
      });
    }

    // 失敗したツール呼び出し
    const failedTools = context.messages.filter(
      (m) => m.role === "tool" && m.success === false
    );
    if (failedTools.length > 0) {
      issues.push({
        type: "error",
        category: "quality",
        severity: failedTools.length > 5 ? "high" : "medium",
        description: `${failedTools.length}件のツール実行失敗`,
        suggestedFix: "ツールの引数や権限設定を確認",
      });
    }

    // ツールの過剰使用
    if (context.toolsUsed.length > 20) {
      issues.push({
        type: "warning",
        category: "efficiency",
        severity: "medium",
        description: `ツール呼び出し過多: ${context.toolsUsed.length}回`,
        suggestedFix: "バッチ処理や集約を検討",
      });
      suggestions.push("複数のツール呼び出しを1回にまとめられないか検討する");
    }
  }

  private checkSafety(
    context: ReviewContext,
    issues: ReviewIssue[],
    suggestions: string[],
    setSafetyFlag: (flag: boolean) => void
  ): void {
    let hasSafetyIssue = false;

    // 機密情報の漏洩パターン
    const sensitivePatterns = [
      /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"][^'"]+['"]/i,
      /(?:-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
      /sk-[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{36}/,
    ];

    for (const msg of context.messages) {
      for (const pattern of sensitivePatterns) {
        if (pattern.test(msg.content)) {
          issues.push({
            type: "error",
            category: "safety",
            severity: "high",
            description: "機密情報（APIキー・トークン）が会話に含まれている可能性",
            suggestedFix: "該当メッセージを編集または削除してください",
          });
          hasSafetyIssue = true;
          suggestions.push("APIキーやトークンは環境変数で管理する");
          break;
        }
      }
    }

    // 危険なコマンド実行
    const dangerousPattern = /(?:rm\s+-rf\s+\/|dd\s+if=|>\s*\/dev\/sda|:\(\)\s*\{)/i;
    for (const msg of context.messages) {
      if (dangerousPattern.test(msg.content)) {
        issues.push({
          type: "error",
          category: "safety",
          severity: "high",
          description: "危険なシステムコマンドが実行されました",
          suggestedFix: "コマンドの影響範囲を確認し、必要に応じてロールバック",
        });
        hasSafetyIssue = true;
        break;
      }
    }

    setSafetyFlag(hasSafetyIssue);
  }

  private checkEfficiency(
    context: ReviewContext,
    issues: ReviewIssue[],
    suggestions: string[]
  ): void {
    // 長時間セッション
    if (context.durationMs > 5 * 60 * 1000) {
      issues.push({
        type: "warning",
        category: "efficiency",
        severity: "medium",
        description: `長時間セッション: ${(context.durationMs / 1000 / 60).toFixed(0)}分`,
        suggestedFix: "セッション分割やコンテキスト圧縮を検討",
      });
    }

    // トークン過多
    if (context.totalTokens > 100000) {
      issues.push({
        type: "info",
        category: "efficiency",
        severity: "low",
        description: `トークン消費大: ${(context.totalTokens / 1000).toFixed(0)}K`,
        suggestedFix: "コンテキスト圧縮の閾値を下げることを検討",
      });
    }

    // エラー多発
    if (context.errors.length > 5) {
      issues.push({
        type: "error",
        category: "quality",
        severity: "high",
        description: `${context.errors.length}件のエラーが発生`,
        suggestedFix: "エラーログを確認し、根本原因を特定する",
      });
    }
  }

  /** スコア計算 */
  private calculateScore(issues: ReviewIssue[]): number {
    let score = 1.0;

    for (const issue of issues) {
      const penalty =
        issue.severity === "high"
          ? 0.3
          : issue.severity === "medium"
            ? 0.08
              : 0.03;

      const typeMultiplier =
        issue.type === "error" ? 1.5 : issue.type === "warning" ? 1.0 : 0.5;

      score -= penalty * typeMultiplier;
    }

    return Math.max(0, Math.min(1, score));
  }

  /** サマリー生成 */
  private generateSummary(
    context: ReviewContext,
    issues: ReviewIssue[],
    suggestions: string[]
  ): string {
    const parts: string[] = [];

    const errors = issues.filter((i) => i.type === "error");
    const warnings = issues.filter((i) => i.type === "warning");
    const infos = issues.filter((i) => i.type === "info");

    if (errors.length > 0) parts.push(`${errors.length}件の問題`);
    if (warnings.length > 0) parts.push(`${warnings.length}件の警告`);
    if (infos.length > 0) parts.push(`${infos.length}件の情報`);

    const toolStr =
      context.toolsUsed.length > 5
        ? `${context.toolsUsed.slice(0, 5).join(", ")}... 他${context.toolsUsed.length - 5}`
        : context.toolsUsed.join(", ");

    return (
      `セッション ${context.totalTurns}ターン / ${(context.totalTokens / 1000).toFixed(0)}Kトークン` +
      ` / ${(context.durationMs / 1000).toFixed(0)}秒` +
      (parts.length > 0 ? ` / ${parts.join(", ")}` : "") +
      (toolStr ? ` / ツール: ${toolStr}` : "") +
      (suggestions.length > 0 ? ` / 提案: ${suggestions.slice(0, 2).join("; ")}` : "")
    );
  }

  /** 結果をフォーマット */
  formatResult(result: ReviewResult): string {
    const scoreBar =
      "🟩".repeat(Math.round(result.score * 10)) +
      "⬜".repeat(10 - Math.round(result.score * 10));

    const issuesBySeverity = result.issues.reduce(
      (acc, i) => {
        acc[i.severity] = (acc[i.severity] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return (
      `📋 **バックグラウンドレビュー**\n` +
      `スコア: ${(result.score * 100).toFixed(0)}% ${scoreBar}\n` +
      `${result.safetyFlag ? "🚨 安全フラグ検出\n" : ""}` +
      `${result.summary}\n\n` +
      (result.issues.length > 0
        ? `**指摘事項 (${result.issues.length})**\n` +
          `critical: ${issuesBySeverity.critical ?? 0} | ` +
          `high: ${issuesBySeverity.high ?? 0} | ` +
          `medium: ${issuesBySeverity.medium ?? 0} | ` +
          `low: ${issuesBySeverity.low ?? 0}\n\n` +
          result.issues
            .slice(0, 5)
            .map((i) => `${i.type === "error" ? "❌" : i.type === "warning" ? "⚠️" : "ℹ️"} ${i.description}`)
            .join("\n") +
          (result.issues.length > 5 ? `\n...他${result.issues.length - 5}件` : "")
        : "✅ 問題なし") +
      (result.suggestions.length > 0
        ? `\n\n**提案**\n${result.suggestions.map((s) => `- ${s}`).join("\n")}`
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const reviewer = new BackgroundReviewer();

// ==================== システムコマンド ====================

export function getReviewCommands(): Record<string, (args: string[]) => string> {
  return {
    "/review": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "recent":
        case "list": {
          const reviews = reviewer.getRecentReviews();
          if (reviews.length === 0) return "📭 レビュー結果はありません";
          return (
            `📋 **直近のレビュー (${reviews.length})**\n\n` +
            reviews
              .map(
                (r, i) =>
                  `${i + 1}. ${r.safetyFlag ? "🚨" : "✅"} スコア: ${(r.score * 100).toFixed(0)}%` +
                  ` | ${r.issues.length}件の指摘` +
                  ` | ${r.summary.slice(0, 60)}...`
              )
              .join("\n\n")
          );
        }

        case "low":
        case "bad": {
          const reviews = reviewer.getLowScoreReviews();
          if (reviews.length === 0) return "✅ 低スコアのレビューはありません";
          return (
            `⚠️ **低スコアレビュー (${reviews.length})**\n\n` +
            reviews.map((r) => reviewer.formatResult(r)).join("\n\n---\n\n")
          );
        }

        case "alerts":
        case "safety": {
          const flags = reviewer.getSafetyFlags();
          if (flags.length === 0) return "✅ 安全フラグはありません";
          return (
            `🚨 **安全フラグ一覧 (${flags.length})**\n\n` +
            flags
              .map(
                (r, i) =>
                  `${i + 1}. スコア: ${(r.score * 100).toFixed(0)}%\n` +
                  r.issues
                    .filter((i) => i.category === "safety")
                    .map((i) => `   🔴 ${i.description}`)
                    .join("\n")
              )
              .join("\n\n")
          );
        }

        case "stats": {
          const stats = reviewer.getStats();
          return (
            `📊 **レビュー統計**\n` +
            `総レビュー数: ${stats.total}\n` +
            `平均スコア: ${(stats.avgScore * 100).toFixed(0)}%\n` +
            `安全フラグ: ${stats.safetyFlags}\n` +
            `低スコア: ${stats.lowScores}`
          );
        }

        default:
          return (
            `📋 **バックグラウンドレビュー**\n` +
            `/review recent — 直近のレビュー\n` +
            `/review low — 低スコアレビュー\n` +
            `/review safety — 安全フラグ\n` +
            `/review stats — 統計`
          );
      }
    },
  };
}

export default BackgroundReviewer;
