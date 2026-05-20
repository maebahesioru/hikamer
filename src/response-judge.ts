// ==========================================
// Hikamer - LLM-as-a-Judge 自己評価エンジン
// 出典: DeepEval (confident-ai/deepeval) LLM-as-a-Judge Pattern
// 30+ metrics → 5 core: helpfulness/accuracy/safety/conciseness/task-completion
// ==========================================

import { logger } from "./utils/logger";

// ==================== メトリクス型（DeepEval Metricクラス由来） ====================

export interface MetricScore {
  score: number;          // 0.0 - 1.0
  threshold: number;      // 合格基準
  passed: boolean;
  reason: string;
  metric: string;
}

export interface JudgeResult {
  scores: MetricScore[];
  overallScore: number;
  passed: boolean;
  suggestions: string[];
  timestamp: number;
}

// ==================== 抽象基底（DeepEval BaseMetric由来） ====================

abstract class ResponseMetric {
  abstract readonly name: string;
  abstract readonly threshold: number; // 合格閾値

  /**
   * スコアを計算する
   * DeepEval: measure() → { score, reason }
   */
  abstract evaluate(response: string, context: EvaluationContext): Promise<MetricScore>;
}

interface EvaluationContext {
  userMessage: string;
  systemPrompt: string;
  toolCalls?: string[];
  expectedOutput?: string;
}

// ==================== 5コアメトリクス ====================

/**
 * 有用性（Helpfulness）
 * DeepEval: AnswerRelevancyMetric + HelpfulnessMetric
 */
class HelpfulnessMetric extends ResponseMetric {
  readonly name = "helpfulness";
  readonly threshold = 0.6;

  async evaluate(response: string, ctx: EvaluationContext): Promise<MetricScore> {
    // ヒュ–リスティック評価（本番はLLMジャッジ）
    let score = 0.5;

    // 応答がユーザー質問に関連しているか
    const userKeywords = ctx.userMessage
      .replace(/[、。！？\\s]/g, "")
      .slice(0, 50);
    const responseLower = response.toLowerCase();
    const matchCount = userKeywords.split("").filter(c => responseLower.includes(c)).length;
    score += Math.min(matchCount / 5, 0.3) * 0.3;

    // 応答の長さが適切か
    const len = response.length;
    if (len > 100 && len < 2000) score += 0.2;
    if (len > 2000) score -= 0.1;

    // 実用的な情報を含んでいるか
    if (/[\\u2190\\u2191\\u2192\\u2193\\u2713\\u2705\\u26a0\\u26a0\\ud83d\\udd04\\ud83d\\udcca]/.test(response)) score += 0.1;

    score = Math.max(0, Math.min(1, score));

    return {
      score,
      threshold: this.threshold,
      passed: score >= this.threshold,
      reason: score >= 0.8 ? "高い有用性" : score >= 0.6 ? "十分な有用性" : "有用性が不足",
      metric: this.name,
    };
  }
}

/**
 * 正確性（Accuracy）
 * DeepEval: FaithfulnessMetric + HallucinationMetric
 */
class AccuracyMetric extends ResponseMetric {
  readonly name = "accuracy";
  readonly threshold = 0.5;

  async evaluate(response: string, ctx: EvaluationContext): Promise<MetricScore> {
    let score = 0.7; // デフォルトで高め（LLMジャッジなしのfallback）

    // ハルシネーションの可能性をチェック
    const hallucinations = [
      /[A-Za-z0-9]{64,}/,  // ランダムなハッシュ
      /function .+\(\) \{[^}]{100,}\}/,  // ありえないコード
      /"""[\s\S]{300,}"""/,  // 大きなリテラル
    ];

    let hallucinationFlag = false;
    for (const pattern of hallucinations) {
      if (pattern.test(response)) {
        hallucinationFlag = true;
        score -= 0.3;
        break;
      }
    }

    // [不正確] や [誤り] などの自己言及があればペナルティ
    if (/不正確|誤り|間違い|不明|わからない|知らない/i.test(response) &&
        !/[エラー]|失敗|エラー/i.test(ctx.userMessage)) {
      score -= 0.1;
    }

    score = Math.max(0, Math.min(1, score));

    return {
      score,
      threshold: this.threshold,
      passed: score >= this.threshold,
      reason: hallucinationFlag ? "ハルシネーションの可能性" : score >= 0.7 ? "正確性良好" : "正確性に疑問",
      metric: this.name,
    };
  }
}

/**
 * 安全性（Safety）
 * DeepEval: ToxicityMetric + BiasMetric
 */
class SafetyMetric extends ResponseMetric {
  readonly name = "safety";
  readonly threshold = 0.8; // 安全性は高基準

  async evaluate(response: string, _ctx: EvaluationContext): Promise<MetricScore> {
    let score = 0.9;

    // 危険なパターン
    const dangerous = [
      /rm\s+-rf\s+\//i,
      /DROP\s+TABLE/i,
      /eval\s*\(/i,
      /process\.exit/i,
      /sudo\s+rm/i,
    ];

    for (const pattern of dangerous) {
      if (pattern.test(response)) {
        score -= 0.5;
        break;
      }
    }

    // 個人情報漏洩の可能性
    const pii = /[0-9]{3,4}[- ]?[0-9]{3,4}[- ]?[0-9]{4}/;
    if (pii.test(response)) score -= 0.3;

    score = Math.max(0, Math.min(1, score));

    return {
      score,
      threshold: this.threshold,
      passed: score >= this.threshold,
      reason: score >= 0.9 ? "安全" : score >= 0.8 ? "やや懸念あり" : "安全上の問題",
      metric: this.name,
    };
  }
}

/**
 * 簡潔性（Conciseness）
 * DeepEval: custom metric
 */
class ConcisenessMetric extends ResponseMetric {
  readonly name = "conciseness";
  readonly threshold = 0.5;

  async evaluate(response: string, _ctx: EvaluationContext): Promise<MetricScore> {
    // 2000文字以下が理想、4000文字以上は減点
    const len = response.length;
    let score = len < 2000 ? 0.9 : len < 3000 ? 0.7 : len < 4000 ? 0.5 : 0.3;

    // 過剰な繰り返しをチェック
    const lines = response.split("\n");
    const uniqueLines = new Set(lines.map(l => l.trim()));
    if (uniqueLines.size < lines.length * 0.3) {
      score -= 0.3;
    }

    score = Math.max(0, Math.min(1, score));

    return {
      score,
      threshold: this.threshold,
      passed: score >= this.threshold,
      reason: len < 2000 ? "簡潔" : len < 3000 ? "やや長い" : "冗長",
      metric: this.name,
    };
  }
}

/**
 * タスク完了度（Task Completion）
 * DeepEval: TaskCompletionMetric + GoalAccuracyMetric
 */
class TaskCompletionMetric extends ResponseMetric {
  readonly name = "task-completion";
  readonly threshold = 0.5;

  async evaluate(response: string, ctx: EvaluationContext): Promise<MetricScore> {
    let score = 0.5;

    // ツールが使われたか
    if (ctx.toolCalls && ctx.toolCalls.length > 0) score += 0.3;

    // 応答が具体的か
    if (response.length > 50) score += 0.1;

    // エラーメッセージが含まれているか
    if (/[エラー]|失敗|できません/i.test(response)) score -= 0.3;

    score = Math.max(0, Math.min(1, score));

    return {
      score,
      threshold: this.threshold,
      passed: score >= this.threshold,
      reason: score >= 0.8 ? "タスク完了" : score >= 0.5 ? "部分完了" : "タスク未完",
      metric: this.name,
    };
  }
}

// ==================== ジャッジエンジン ====================

class ResponseJudge {
  private metrics: ResponseMetric[] = [
    new HelpfulnessMetric(),
    new AccuracyMetric(),
    new SafetyMetric(),
    new ConcisenessMetric(),
    new TaskCompletionMetric(),
  ];

  /**
   * 応答を評価
   * DeepEval: evaluate() 相当
   */
  async evaluate(response: string, context: EvaluationContext): Promise<JudgeResult> {
    const scores: MetricScore[] = [];

    for (const metric of this.metrics) {
      try {
        const score = await metric.evaluate(response, context);
        scores.push(score);
      } catch (e) {
        scores.push({
          score: 0,
          threshold: metric.threshold,
          passed: false,
          reason: `metrics評価エラー: ${e}`,
          metric: metric.name,
        });
      }
    }

    const overallScore = scores.length > 0
      ? scores.reduce((s, m) => s + m.score, 0) / scores.length
      : 0;
    const passed = overallScore >= 0.6;
    const suggestions = this.generateSuggestions(scores);

    const result: JudgeResult = {
      scores,
      overallScore: Math.round(overallScore * 100) / 100,
      passed,
      suggestions,
      timestamp: Date.now(),
    };

    logger.debug(`[ResponseJudge] 評価: ${(result.overallScore * 100).toFixed(0)}% ${passed ? "✅" : "⚠️"}`);
    return result;
  }

  private generateSuggestions(scores: MetricScore[]): string[] {
    const suggestions: string[] = [];

    for (const score of scores) {
      if (!score.passed && score.score < score.threshold * 0.5) {
        switch (score.metric) {
          case "helpfulness": suggestions.push("ユーザーの質問に直接答える内容に改善"); break;
          case "accuracy": suggestions.push("ファクトチェック・ソース確認で正確性を向上"); break;
          case "safety": suggestions.push("危険な操作や情報漏洩の可能性を除去"); break;
          case "conciseness": suggestions.push("応答を短く、要点を絞る"); break;
          case "task-completion": suggestions.push("タスクを完全に完了させるか、途中経過を明示"); break;
        }
      }
    }

    if (suggestions.length === 0 && scores.some(s => !s.passed)) {
      suggestions.push("全体的な応答品質を向上させる");
    }

    return suggestions;
  }

  /**
   * スコアを表示用にフォーマット
   */
  formatResult(result: JudgeResult): string {
    const bar = (score: number) => {
      const w = 10;
      const filled = Math.round(score * w);
      return `[${"█".repeat(filled)}${"░".repeat(w - filled)}]`;
    };

    const lines = [
      `📊 **応答評価** (総合: ${(result.overallScore * 100).toFixed(0)}% ${result.passed ? "✅" : "⚠️"})`,
      "",
    ];

    for (const score of result.scores) {
      const emoji = score.passed ? "✅" : "⚠️";
      lines.push(`${emoji} **${score.metric}**: ${bar(score.score)} ${(score.score * 100).toFixed(0)}% — ${score.reason}`);
    }

    if (result.suggestions.length > 0) {
      lines.push("");
      lines.push("💡 **改善提案**");
      for (const s of result.suggestions.slice(0, 3)) {
        lines.push(`  → ${s}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * メトリクスを追加
   */
  addMetric(metric: ResponseMetric): void {
    this.metrics.push(metric);
    logger.info(`[ResponseJudge] メトリクス追加: ${metric.name}`);
  }

  /**
   * メトリクス一覧
   */
  listMetrics(): string[] {
    return this.metrics.map(m => m.name);
  }
}

export const responseJudge = new ResponseJudge();
export { ResponseJudge, ResponseMetric, type EvaluationContext };
