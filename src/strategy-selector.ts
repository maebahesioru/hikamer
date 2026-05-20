// ==========================================
// Hikamer - Strategy Selector (v1.62)
// 出典: EvoMap/evolver — Strategy Presets + Selector pattern
// タスク内容から最適な実行戦略を自動選択
// subagents.ts の SpecializedAgentPool と連携
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type StrategyPreset = "speed" | "quality" | "balanced" | "cost-saving";

export interface StrategyConfig {
  preset: StrategyPreset;
  /** 最大ツール反復回数 */
  maxIterations: number;
  /** 使用モデル（未指定時はデフォルト） */
  model?: string;
  /** 思考モード（reasoning）有効か */
  thinking: boolean;
  /** 並列実行を許可するか */
  allowParallel: boolean;
  /** 自動再試行回数 */
  retries: number;
  /** コンテキスト圧縮を積極的に行うか */
  aggressiveCompression: boolean;
}

export interface StrategyMatch {
  config: StrategyConfig;
  reason: string;
  confidence: number; // 0-100
}

// ==================== 戦略プリセット ====================

const PRESETS: Record<StrategyPreset, StrategyConfig> = {
  "speed": {
    preset: "speed",
    maxIterations: 10,
    thinking: false,
    allowParallel: true,
    retries: 1,
    aggressiveCompression: true,
  },
  "quality": {
    preset: "quality",
    maxIterations: 90,
    thinking: true,
    allowParallel: false,
    retries: 3,
    aggressiveCompression: false,
  },
  "balanced": {
    preset: "balanced",
    maxIterations: 30,
    thinking: true,
    allowParallel: true,
    retries: 2,
    aggressiveCompression: false,
  },
  "cost-saving": {
    preset: "cost-saving",
    maxIterations: 15,
    thinking: false,
    allowParallel: false,
    retries: 0,
    aggressiveCompression: true,
  },
};

// ==================== キーワードマッチャー ====================

interface KeywordRule {
  keywords: string[];
  strategy: StrategyPreset;
  confidence: number;
  reason: string;
}

const RULES: KeywordRule[] = [
  // Quality: 複雑・重要・正確性重視
  {
    keywords: ["debug", "fix", "バグ", "error", "修正", "bug", "security", "セキュリティ", "vulnerability", "脆弱性"],
    strategy: "quality",
    confidence: 85,
    reason: "バグ修正・セキュリティ → 正確性重視 (quality)",
  },
  {
    keywords: ["production", "本番", "deploy", "デプロイ", "release", "リリース"],
    strategy: "quality",
    confidence: 80,
    reason: "本番関連操作 → 品質重視 (quality)",
  },
  {
    keywords: ["refactor", "リファクタ", "restructure", "architecture", "アーキテクチャ"],
    strategy: "quality",
    confidence: 75,
    reason: "リファクタリング → 品質重視 (quality)",
  },

  // Speed: 軽量・即答・単純
  {
    keywords: ["search", "検索", "lookup", "find", "調べて", "what is", "とは"],
    strategy: "speed",
    confidence: 85,
    reason: "検索・調べ物 → 速度重視 (speed)",
  },
  {
    keywords: ["status", "状態", "check", "確認", "list", "一覧", "how many"],
    strategy: "speed",
    confidence: 80,
    reason: "状態確認・一覧 → 速度重視 (speed)",
  },
  {
    keywords: ["translate", "翻訳", "summarize", "要約", "format", "整形"],
    strategy: "speed",
    confidence: 75,
    reason: "翻訳・要約・整形 → 速度重視 (speed)",
  },

  // Cost-saving: 低優先度・実験・下書き
  {
    keywords: ["draft", "下書き", "sketch", "実験", "experiment", "test idea", "試し"],
    strategy: "cost-saving",
    confidence: 85,
    reason: "実験・下書き → コスト節約 (cost-saving)",
  },
  {
    keywords: ["maybe", "多分", "できれば", "もしよければ", "optional", "任意"],
    strategy: "cost-saving",
    confidence: 70,
    reason: "任意タスク → コスト節約 (cost-saving)",
  },
];

// ==================== 戦略セレクター ====================

class StrategySelector {
  private history: { taskHash: string; chosen: StrategyPreset; success: boolean; durationMs: number }[] = [];
  private maxHistory = 100;

  /**
   * タスク内容から最適な戦略を選択
   * 1. キーワードルールマッチ
   * 2. マッチしない場合は balanced
   * 3. 過去の成功率で微調整
   */
  select(taskDescription: string): StrategyMatch {
    const lower = taskDescription.toLowerCase();
    let bestRule: KeywordRule | null = null;
    let bestConfidence = 0;

    for (const rule of RULES) {
      const matchCount = rule.keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
      if (matchCount > 0) {
        const adjustedConfidence = rule.confidence + matchCount * 5; // 複数マッチでブースト
        if (adjustedConfidence > bestConfidence) {
          bestConfidence = adjustedConfidence;
          bestRule = rule;
        }
      }
    }

    if (bestRule) {
      return {
        config: { ...PRESETS[bestRule.strategy] },
        reason: bestRule.reason,
        confidence: Math.min(100, bestConfidence),
      };
    }

    // デフォルト: balanced
    return {
      config: { ...PRESETS["balanced"] },
      reason: "特にルールにマッチせず → バランス戦略 (balanced)",
      confidence: 50,
    };
  }

  /**
   * 特定の戦略を強制指定（オーバーライド用）
   */
  force(preset: StrategyPreset): StrategyConfig {
    return { ...PRESETS[preset] };
  }

  /**
   * カスタム戦略をマージ
   */
  custom(overrides: Partial<StrategyConfig>): StrategyConfig {
    const base = overrides.preset ? { ...PRESETS[overrides.preset] } : { ...PRESETS["balanced"] };
    return { ...base, ...overrides };
  }

  /**
   * 実行結果を学習に記録
   * Evolver: Geneパターン — 成功/失敗パターンを蓄積
   */
  recordResult(taskDescription: string, strategy: StrategyPreset, success: boolean, durationMs: number): void {
    const taskHash = this.hashTask(taskDescription);
    this.history.push({ taskHash, chosen: strategy, success, durationMs });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    logger.debug(`[StrategySelector] 記録: ${strategy} success=${success} ${durationMs}ms`);
  }

  /**
   * 過去の実績から戦略の成功率を取得
   */
  getSuccessRate(strategy: StrategyPreset): number | null {
    const records = this.history.filter(r => r.chosen === strategy);
    if (records.length < 3) return null;
    const successes = records.filter(r => r.success).length;
    return (successes / records.length) * 100;
  }

  /**
   * 全戦略の統計情報
   */
  getStats(): Record<StrategyPreset, { count: number; successRate: number | null; avgDurationMs: number | null }> {
    const stats: Record<string, any> = {};
    for (const preset of Object.keys(PRESETS) as StrategyPreset[]) {
      const records = this.history.filter(r => r.chosen === preset);
      stats[preset] = {
        count: records.length,
        successRate: records.length >= 3
          ? Math.round((records.filter(r => r.success).length / records.length) * 100)
          : null,
        avgDurationMs: records.length > 0
          ? Math.round(records.reduce((sum, r) => sum + r.durationMs, 0) / records.length)
          : null,
      };
    }
    return stats;
  }

  formatStats(): string {
    const stats = this.getStats();
    const lines: string[] = ["🎯 **戦略セレクター統計**", ""];
    for (const [preset, s] of Object.entries(stats)) {
      const emoji: Record<string, string> = { speed: "⚡", quality: "💎", balanced: "⚖️", "cost-saving": "💰" };
      lines.push(`${emoji[preset] || "•"} **${preset}**: ${s.count}回 | 成功率: ${s.successRate !== null ? `${s.successRate}%` : "N/A"} | 平均: ${s.avgDurationMs !== null ? `${(s.avgDurationMs / 1000).toFixed(1)}s` : "N/A"}`);
    }
    return lines.join("\n");
  }

  private hashTask(task: string): string {
    // 簡易ハッシュ（類似タスクのグルーピング用）
    return task.slice(0, 80).toLowerCase().replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/g, "");
  }
}

// ==================== シングルトン ====================

export const strategySelector = new StrategySelector();
export default StrategySelector;
