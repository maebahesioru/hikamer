// ==========================================
// Aikata - 学習リフレクション（OpenHuman learning/reflection.rs 由来）
// ユーザーインタラクションからの学習・パターン抽出
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface LearnedRule {
  id: string;
  pattern: string;
  action: string;
  confidence: number;
  source: "correction" | "feedback" | "observation" | "extraction";
  createdAt: number;
  lastUsed: number;
  useCount: number;
  category: string;
  enabled: boolean;
}

export interface UserPreference {
  key: string;
  value: string;
  confidence: number;
  source: string;
  updatedAt: number;
}

export interface FeedbackEntry {
  id: string;
  userId: string;
  type: "positive" | "negative" | "correction" | "suggestion";
  content: string;
  context: string;
  timestamp: number;
  applied: boolean;
}

// ==================== 学習マネージャー ====================

class LearningManager {
  private rules: LearnedRule[] = [];
  private preferences: UserPreference[] = [];
  private feedback: FeedbackEntry[] = [];
  private maxRules = 200;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Learning] reflection engine initialized");
  }

  /** ユーザーの修正から学習 */
  learnFromCorrection(
    original: string,
    corrected: string,
    context?: string
  ): LearnedRule | null {
    if (original === corrected) return null;

    // パターンを抽出
    const pattern = this.extractPattern(original, corrected);
    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const rule: LearnedRule = {
      id,
      pattern,
      action: corrected,
      confidence: 0.3, // 初期信頼度は低め
      source: "correction",
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 1,
      category: this.categorizePattern(pattern),
      enabled: true,
    };

    this.rules.push(rule);
    this.pruneRules();
    logger.debug(`[Learning] new rule: ${pattern} -> ${corrected.slice(0, 30)}`);
    return rule;
  }

  /** フィードバックを記録 */
  recordFeedback(feedback: Omit<FeedbackEntry, "id" | "timestamp" | "applied">): FeedbackEntry {
    const entry: FeedbackEntry = {
      ...feedback,
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      applied: false,
    };
    this.feedback.push(entry);
    if (this.feedback.length > 500) {
      this.feedback = this.feedback.slice(-500);
    }
    return entry;
  }

  /** ユーザー設定を学習 */
  learnPreference(key: string, value: string, source: string): UserPreference {
    const existing = this.preferences.find((p) => p.key === key);
    if (existing) {
      existing.value = value;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.updatedAt = Date.now();
      return existing;
    }

    const pref: UserPreference = {
      key,
      value,
      confidence: 0.5,
      source,
      updatedAt: Date.now(),
    };
    this.preferences.push(pref);
    return pref;
  }

  /** ルールの信頼度を更新 */
  reinforceRule(ruleId: string): LearnedRule | null {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return null;
    rule.confidence = Math.min(1, rule.confidence + 0.1);
    rule.useCount++;
    rule.lastUsed = Date.now();
    return rule;
  }

  /** ルールの信頼度を減衰 */
  decayRule(ruleId: string): LearnedRule | null {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return null;
    rule.confidence = Math.max(0, rule.confidence - 0.05);
    return rule;
  }

  /** 高信頼度ルールを取得 */
  getHighConfidenceRules(threshold = 0.6): LearnedRule[] {
    return this.rules.filter((r) => r.confidence >= threshold && r.enabled);
  }

  /** カテゴリ別のルールを取得 */
  getRulesByCategory(category: string): LearnedRule[] {
    return this.rules.filter((r) => r.category === category);
  }

  /** ルール一覧 */
  listRules(): LearnedRule[] {
    return [...this.rules];
  }

  /** ユーザー設定一覧 */
  listPreferences(): UserPreference[] {
    return [...this.preferences];
  }

  /** 直近のフィードバック */
  getRecentFeedback(count = 20): FeedbackEntry[] {
    return this.feedback.slice(-count).reverse();
  }

  /** 統計 */
  getStats() {
    return {
      totalRules: this.rules.length,
      activeRules: this.rules.filter((r) => r.enabled).length,
      highConfidence: this.rules.filter((r) => r.confidence >= 0.6).length,
      totalFeedback: this.feedback.length,
      totalPreferences: this.preferences.length,
      avgConfidence: this.rules.length > 0
        ? this.rules.reduce((s, r) => s + r.confidence, 0) / this.rules.length
        : 0,
    };
  }

  // ---- 内部 ----

  private extractPattern(original: string, corrected: string): string {
    // 簡易パターン抽出: 異なる部分のみ
    const minLen = Math.min(original.length, corrected.length);
    let diffStart = 0;
    let diffEnd = 0;

    for (let i = 0; i < minLen; i++) {
      if (original[i] !== corrected[i]) {
        diffStart = i;
        break;
      }
    }

    for (let i = 0; i < minLen; i++) {
      if (original[original.length - 1 - i] !== corrected[corrected.length - 1 - i]) {
        diffEnd = i;
        break;
      }
    }

    const originalPattern = original.slice(diffStart, original.length - diffEnd);
    return originalPattern.length > 0 ? originalPattern : original;
  }

  private categorizePattern(pattern: string): string {
    const lower = pattern.toLowerCase();
    if (lower.includes("http") || lower.includes("www")) return "url";
    if (lower.includes("@")) return "mention";
    if (lower.includes("/")) return "command";
    if (pattern.length < 10) return "short";
    return "general";
  }

  private pruneRules(): void {
    if (this.rules.length <= this.maxRules) return;
    // 信頼度が低く、使われていないルールを削除
    this.rules.sort(
      (a, b) => a.confidence * a.useCount - b.confidence * b.useCount
    );
    this.rules = this.rules.slice(-this.maxRules);
  }

  formatRule(rule: LearnedRule): string {
    const confidenceBar = "🟩".repeat(Math.round(rule.confidence * 5)) +
      "⬜".repeat(5 - Math.round(rule.confidence * 5));
    return (
      `${rule.enabled ? "✅" : "⛔"} **${rule.pattern.slice(0, 40)}**\n` +
      `   → ${rule.action.slice(0, 60)}\n` +
      `   信頼度: ${(rule.confidence * 100).toFixed(0)}% ${confidenceBar}\n` +
      `   使用: ${rule.useCount}回 | ${rule.category} | ${rule.source}`
    );
  }

  formatStats(): string {
    const s = this.getStats();
    return (
      `🧠 **学習統計**\n` +
      `ルール総数: ${s.totalRules}\n` +
      `アクティブ: ${s.activeRules}\n` +
      `高信頼度: ${s.highConfidence}\n` +
      `フィードバック: ${s.totalFeedback}\n` +
      `ユーザー設定: ${s.totalPreferences}\n` +
      `平均信頼度: ${(s.avgConfidence * 100).toFixed(0)}%`
    );
  }
}

// ==================== シングルトン ====================

export const learningManager = new LearningManager();

export default LearningManager;
