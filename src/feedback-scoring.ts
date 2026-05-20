// ==========================================
// Hikamer - Feedback Scoring Engine（toprank openclaw/bin/score_feedback.py 由来）
// 自律アクションの結果を定量評価 → 学習・適応
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type Outcome = "win" | "neutral" | "loss" | "inconclusive";

export interface ScoringConfig {
  /** 高いほど良い指標か（true=高いほど良い, false=低いほど良い） */
  higherBetter: boolean;
  /** 閾値（変化率） */
  thresholdPct: number;
  /** ガードレール指標（これを超えると自動loss） */
  guardrailThreshold?: number;
  /** ガードレール方向（higherBetterと同じ意味） */
  guardrailHigherBetter?: boolean;
  /** 最小サンプルサイズ */
  minSampleSize?: number;
}

export interface ScoreResult {
  outcome: Outcome;
  changePct: number;
  confidence: number;
  details: string;
}

export interface LearnedPrior {
  actionType: string;
  primaryMetric: string;
  sampleSize: number;
  wins: number;
  losses: number;
  avgPrimaryChange: number;
  confidence: number;
  lastUpdated: number;
}

// ==================== スコアリングエンジン ====================

/** 変化率を計算（0除算対策） */
function calcChangePct(baseline: number, observed: number): number {
  if (baseline === 0) return observed > 0 ? 100 : observed < 0 ? -100 : 0;
  return ((observed - baseline) / Math.abs(baseline)) * 100;
}

/** 方向を考慮した変化率 */
function directionalChange(baseline: number, observed: number, higherBetter: boolean): number {
  const raw = calcChangePct(baseline, observed);
  return higherBetter ? raw : -raw;
}

/** サンプルサイズに基づく確信度 */
function sampleConfidence(sampleSize: number): number {
  if (sampleSize <= 0) return 0;
  // ソフト指数曲線: サンプル10で~0.5, サンプル50で~0.83, サンプル100で~0.91
  return 1 - Math.exp(-sampleSize / 15);
}

/** 1件の結果をスコアリング */
export function scoreItem(
  baseline: number,
  observed: number,
  config: ScoringConfig,
): ScoreResult {
  const changePct = calcChangePct(baseline, observed);
  const dirChange = directionalChange(baseline, observed, config.higherBetter);

  // ガードレールチェック
  if (config.guardrailThreshold !== undefined) {
    const guardrailChange = directionalChange(
      baseline,
      observed,
      config.guardrailHigherBetter ?? config.higherBetter,
    );
    if (guardrailChange < -Math.abs(config.guardrailThreshold)) {
      return {
        outcome: "loss",
        changePct,
        confidence: 0.9,
        details: `ガードレール違反: 変化率 ${guardrailChange.toFixed(1)}% が閾値 ${config.guardrailThreshold}% を超過`,
      };
    }
  }

  // 方向別評価
  const threshold = config.thresholdPct || 5;
  const confidence = sampleConfidence(config.minSampleSize ?? 1);

  if (dirChange > threshold) {
    return {
      outcome: "win",
      changePct,
      confidence,
      details: `${config.higherBetter ? "上昇" : "下降"}: ${Math.abs(changePct).toFixed(1)}% (確信度: ${(confidence * 100).toFixed(0)}%)`,
    };
  }

  if (dirChange < -threshold) {
    return {
      outcome: "loss",
      changePct,
      confidence,
      details: `${!config.higherBetter ? "上昇" : "下降"}: ${Math.abs(changePct).toFixed(1)}% (確信度: ${(confidence * 100).toFixed(0)}%)`,
    };
  }

  if (Math.abs(dirChange) <= threshold) {
    return {
      outcome: "neutral",
      changePct,
      confidence,
      details: `変化なし: ${changePct.toFixed(1)}% (閾値内)`,
    };
  }

  return {
    outcome: "inconclusive",
    changePct,
    confidence: 0,
    details: "判定不能",
  };
}

// ==================== 適応的学習 ====================

/** 学習済み事前分布 */
class LearningStore {
  private priors = new Map<string, LearnedPrior>();

  private key(actionType: string, primaryMetric: string): string {
    return `${actionType}::${primaryMetric}`;
  }

  /** 事前分布を更新 */
  update(
    actionType: string,
    primaryMetric: string,
    outcome: Outcome,
    changePct: number,
  ): LearnedPrior {
    const k = this.key(actionType, primaryMetric);
    const existing = this.priors.get(k) ?? {
      actionType,
      primaryMetric,
      sampleSize: 0,
      wins: 0,
      losses: 0,
      avgPrimaryChange: 0,
      confidence: 0,
      lastUpdated: 0,
    };

    existing.sampleSize++;
    if (outcome === "win") existing.wins++;
    if (outcome === "loss") existing.losses++;
    existing.avgPrimaryChange = (existing.avgPrimaryChange * (existing.sampleSize - 1) + changePct) / existing.sampleSize;
    existing.confidence = sampleConfidence(existing.sampleSize);
    existing.lastUpdated = Date.now();

    this.priors.set(k, existing);
    return existing;
  }

  /** 学習済み乗数を取得（バイアス: 0.7〜1.5） */
  getMultiplier(actionType: string, primaryMetric: string): number {
    const prior = this.priors.get(this.key(actionType, primaryMetric));
    if (!prior || prior.sampleSize < 3) return 1.0;

    const winRate = prior.wins / prior.sampleSize;
    const avgChange = prior.avgPrimaryChange;

    // 勝率と平均変化率から乗数を計算
    let multiplier = 1.0;
    if (winRate > 0.6 && avgChange > 5) multiplier = 1.3;
    else if (winRate > 0.4 && avgChange > 2) multiplier = 1.15;
    else if (winRate < 0.3 || avgChange < -5) multiplier = 0.7;
    else if (winRate < 0.4 || avgChange < -2) multiplier = 0.85;

    return Math.max(0.7, Math.min(1.5, multiplier));
  }

  /** 全事前分布 */
  getAll(): LearnedPrior[] {
    return Array.from(this.priors.values()).sort((a, b) => b.sampleSize - a.sampleSize);
  }

  /** リセット */
  clear(): void {
    this.priors.clear();
  }

  formatStatus(): string {
    const all = this.getAll();
    if (all.length === 0) return "📊 **学習データ**: まだありません。";
    const lines: string[] = ["📊 **学習データ**"];
    for (const p of all.slice(0, 10)) {
      const winRate = p.sampleSize > 0 ? (p.wins / p.sampleSize * 100).toFixed(0) : "0";
      const mult = this.getMultiplier(p.actionType, p.primaryMetric).toFixed(2);
      lines.push(`  • ${p.actionType}/${p.primaryMetric}: ${p.sampleSize}回 勝率${winRate}% 乗数${mult}`);
    }
    return lines.join("\n");
  }
}

export const learningStore = new LearningStore();

// ==================== スコアリング実行 ====================

/** 結果を評価して学習（ショートカット） */
export function evaluateAndLearn(
  actionType: string,
  primaryMetric: string,
  baseline: number,
  observed: number,
  config: ScoringConfig,
): { score: ScoreResult; prior: LearnedPrior } {
  const score = scoreItem(baseline, observed, config);
  const prior = learningStore.update(actionType, primaryMetric, score.outcome, score.changePct);
  logger.info(`[Feedback] ${actionType}/${primaryMetric}: ${score.outcome} (${score.changePct.toFixed(1)}%)`);
  return { score, prior };
}
