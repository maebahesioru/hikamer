// ==========================================
// Hikamer - Context Budget Monitor (v1.63)
// 出典: GSD (gsd-build/get-shit-done) context-monitor hook パターン
// コンテキスト使用率が高いときにエージェントに警告を注入
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type ContextLevel = "normal" | "warning" | "critical";

export interface ContextBudget {
  /** 最大トークン数（推定） */
  maxTokens: number;
  /** 現在の使用トークン数（推定） */
  usedTokens: number;
  /** 残りトークン数 */
  remainingTokens: number;
  /** 残り割合 (0-100) */
  remainingPercent: number;
  /** 警告レベル */
  level: ContextLevel;
}

// ==================== デフォルト設定 ====================

const DEFAULT_MAX_TOKENS = 180_000; // 標準的な200K window、余裕を持って180K
const WARNING_THRESHOLD = 35;       // 残り35%以下で警告
const CRITICAL_THRESHOLD = 25;      // 残り25%以下でクリティカル
const DEBOUNCE_TOOL_CALLS = 5;      // 警告間の最小ツール呼び出し数
const ESTIMATED_TOKENS_PER_ITERATION = 3_000; // 1反復あたりの推定トークン消費

// ==================== Context Monitor ====================

class ContextMonitor {
  private maxTokens: number;
  private currentLevel: ContextLevel = "normal";
  private warningsIssued = 0;
  private toolsSinceLastWarning = 0;
  private enabled = true;

  constructor(maxTokens?: number) {
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * 現在のコンテキスト使用量を推定
   * 簡易版: 反復回数 × 平均トークン消費で推定
   */
  estimate(iterations: number, estimatedTokensPerIteration?: number): ContextBudget {
    const perIter = estimatedTokensPerIteration ?? ESTIMATED_TOKENS_PER_ITERATION;
    const usedTokens = Math.min(iterations * perIter, this.maxTokens);
    const remainingTokens = Math.max(0, this.maxTokens - usedTokens);
    const remainingPercent = (remainingTokens / this.maxTokens) * 100;

    let level: ContextLevel = "normal";
    if (remainingPercent <= CRITICAL_THRESHOLD) level = "critical";
    else if (remainingPercent <= WARNING_THRESHOLD) level = "warning";

    return { maxTokens: this.maxTokens, usedTokens, remainingTokens, remainingPercent, level };
  }

  /**
   * ツール実行後に呼び出し。警告レベルに応じたメッセージを返す。
   * デバウンス: 警告間で最低5回のツール呼び出しが必要
   */
  afterToolCall(iterations: number, maxIterations: number): string | null {
    if (!this.enabled) return null;

    const budget = this.estimate(iterations);
    const prevLevel = this.currentLevel;
    this.currentLevel = budget.level;
    this.toolsSinceLastWarning++;

    // 初回警告またはエスカレーションは即時発火
    const isEscalation = this.getLevelRank(budget.level) > this.getLevelRank(prevLevel);
    const isFirstWarning = this.warningsIssued === 0;

    if (budget.level === "normal") {
      this.toolsSinceLastWarning = 0;
      return null;
    }

    // デバウンス: 最低5回のツール呼び出し後
    if (!isEscalation && !isFirstWarning && this.toolsSinceLastWarning < DEBOUNCE_TOOL_CALLS) {
      return null;
    }

    this.toolsSinceLastWarning = 0;
    this.warningsIssued++;

    if (budget.level === "critical") {
      logger.warn(`[ContextMonitor] CRITICAL: 残り${budget.remainingPercent.toFixed(0)}% (${iterations}/${maxIterations}反復)`);
      return this.buildCriticalMessage(budget, iterations, maxIterations);
    }

    logger.info(`[ContextMonitor] WARNING: 残り${budget.remainingPercent.toFixed(0)}% (${iterations}/${maxIterations}反復)`);
    return this.buildWarningMessage(budget, iterations, maxIterations);
  }

  /** 指定された反復回数でコンテキストが十分か事前チェック */
  preCheck(plannedIterations: number): ContextBudget {
    const usedEstimate = plannedIterations * ESTIMATED_TOKENS_PER_ITERATION;
    if (usedEstimate > this.maxTokens * 0.7) {
      logger.warn(`[ContextMonitor] 事前チェック: ${plannedIterations}反復でコンテキスト逼迫の可能性 (推定${usedEstimate.toLocaleString()} tokens)`);
    }
    return this.estimate(0);
  }

  /** 手動でトークン使用量を更新（外部から実際のトークン数を注入） */
  updateActualTokens(usedTokens: number): void {
    // 実際のトークン数で推定値を補正
    const actualPerIter = usedTokens / Math.max(this.warningsIssued + 1, 1);
    // ここでは簡易的に記録のみ。将来の改善で推定精度向上に使う
    logger.debug(`[ContextMonitor] 実トークン: ${usedTokens.toLocaleString()}`);
  }

  /** 有効/無効の切り替え */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** リセット */
  reset(): void {
    this.currentLevel = "normal";
    this.warningsIssued = 0;
    this.toolsSinceLastWarning = 0;
  }

  formatStatus(): string {
    const emoji: Record<ContextLevel, string> = { normal: "🟢", warning: "🟡", critical: "🔴" };
    return `📊 **Context Monitor** ${emoji[this.currentLevel]} ${this.currentLevel}\n` +
      `最大: ${(this.maxTokens / 1000).toFixed(0)}K tokens | ` +
      `警告閾値: ${WARNING_THRESHOLD}% | クリティカル閾値: ${CRITICAL_THRESHOLD}%\n` +
      `発行済み警告: ${this.warningsIssued}回 | ` +
      `状態: ${this.enabled ? "有効" : "無効"}`;
  }

  private buildWarningMessage(budget: ContextBudget, iterations: number, maxIterations: number): string {
    return [
      `[システム] ⚠️ **コンテキスト警告** — 残り約 ${budget.remainingPercent.toFixed(0)}%`,
      `現在のタスクを完了させ、新しい複雑な作業を始めないでください。`,
      `反復: ${iterations}/${maxIterations}`,
      `ヒント: 長い出力は避け、必要に応じて中間結果をファイルに保存してください。`,
    ].join("\n");
  }

  private buildCriticalMessage(budget: ContextBudget, iterations: number, maxIterations: number): string {
    return [
      `[システム] 🔴 **コンテキスト限界** — 残り約 ${budget.remainingPercent.toFixed(0)}%`,
      `直ちに作業を中断し、現在の状態を保存してください。`,
      `次のメッセージでコンテキストが枯渇する可能性があります。`,
      `反復: ${iterations}/${maxIterations}`,
      `緊急指示: 最終応答を生成し、ツール呼び出しは行わないでください。`,
    ].join("\n");
  }

  private getLevelRank(level: ContextLevel): number {
    return level === "critical" ? 3 : level === "warning" ? 2 : 1;
  }
}

// ==================== シングルトン ====================

export const contextMonitor = new ContextMonitor();
export default ContextMonitor;
