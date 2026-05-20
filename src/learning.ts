// ==========================================
// Hikamer - フィードバック学習（OpenHuman learning由来）
// ユーザー修正・好みから学習して行動を改善
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type FeedbackType = "correction" | "preference" | "praise" | "complaint" | "custom";

export interface FeedbackEntry {
  id: string;
  userId: string;
  type: FeedbackType;
  category: string;
  originalText: string;
  correctedText?: string;
  toolName?: string;
  rating?: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  timestamp: number;
  applied: boolean;
}

export interface LearnedRule {
  id: string;
  pattern: string;
  action: string;
  confidence: number;
  source: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  active: boolean;
}

// ==================== 学習エンジン ====================

class LearningEngine {
  private feedback: FeedbackEntry[] = [];
  private rules: LearnedRule[] = [];
  private userPreferences = new Map<string, Map<string, string>>();
  private persistPath: string;
  private maxHistory = 200;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "learning.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        this.feedback = data.feedback || [];
        this.rules = data.rules || [];
        if (data.preferences) {
          for (const [userId, prefs] of Object.entries(data.preferences)) {
            this.userPreferences.set(userId, new Map(Object.entries(prefs as Record<string, string>)));
          }
        }
        logger.info(`[Learning] 復元: ${this.feedback.length}件, ${this.rules.length}ルール`);
      }
    } catch (e) {
      logger.warn(`[Learning] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const prefs: Record<string, Record<string, string>> = {};
      for (const [userId, map] of Array.from(this.userPreferences)) {
        prefs[userId] = Object.fromEntries(map);
      }

      writeFileSync(this.persistPath, JSON.stringify({
        feedback: this.feedback,
        rules: this.rules,
        preferences: prefs,
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Learning] 保存失敗: ${e}`);
    }
  }

  /** フィードバックを記録 */
  recordFeedback(userId: string, type: FeedbackType, category: string, options?: {
    originalText?: string;
    correctedText?: string;
    toolName?: string;
    rating?: 1 | 2 | 3 | 4 | 5;
    comment?: string;
  }): FeedbackEntry {
    const entry: FeedbackEntry = {
      id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userId,
      type,
      category,
      originalText: options?.originalText || "",
      correctedText: options?.correctedText,
      toolName: options?.toolName,
      rating: options?.rating,
      comment: options?.comment,
      timestamp: Date.now(),
      applied: false,
    };

    this.feedback.push(entry);
    if (this.feedback.length > this.maxHistory) this.feedback.shift();

    // 修正からルールを自動生成
    if (options?.correctedText && options?.originalText) {
      this.learnFromCorrection(entry);
    }

    // 評価から好みを学習
    if (options?.rating) {
      this.learnFromRating(userId, type, options.rating);
    }

    this.save();
    logger.info(`[Learning] 記録: ${type}(${category}) by ${userId}`);
    return entry;
  }

  /** 修正からルール抽出 */
  private learnFromCorrection(entry: FeedbackEntry): void {
    const orig = entry.originalText;
    const corrected = entry.correctedText;
    if (!corrected || !orig) return;

    // パターン抽出（単純な置換パターン）
    const commonWords = this.findCommonChanges(orig, corrected);
    for (const change of commonWords) {
      // 既存ルールと重複チェック
      const existing = this.rules.find(r => r.pattern === change.pattern);
      if (existing) {
        existing.confidence = Math.min(1, existing.confidence + 0.1);
        existing.useCount++;
        existing.lastUsedAt = Date.now();
      } else {
        this.rules.push({
          id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          pattern: change.pattern,
          action: change.action,
          confidence: 0.3,
          source: `user:${entry.userId}`,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          useCount: 1,
          active: true,
        });
      }
    }
  }

  /** テキスト間の変更点を検出 */
  private findCommonChanges(orig: string, corrected: string): Array<{ pattern: string; action: string }> {
    const changes: Array<{ pattern: string; action: string }> = [];
    const origWords = orig.split(/\s+/);
    const corWords = corrected.split(/\s+/);

    const minLen = Math.min(origWords.length, corWords.length);
    for (let i = 0; i < minLen; i++) {
      if (origWords[i] !== corWords[i]) {
        changes.push({
          pattern: origWords[i]!,
          action: corWords[i]!,
        });
      }
    }

    return changes.slice(0, 5); // 最大5ルール
  }

  /** 評価から好み学習 */
  private learnFromRating(userId: string, category: string, rating: number): void {
    let prefs = this.userPreferences.get(userId);
    if (!prefs) {
      prefs = new Map();
      this.userPreferences.set(userId, prefs);
    }

    const key = `rating_${category}`;
    const current = prefs.get(key);
    const avgRating = current ? (parseFloat(current) + rating) / 2 : rating;
    prefs.set(key, avgRating.toFixed(1));
  }

  /** 好みの取得 */
  getPreference(userId: string, key: string): string | undefined {
    return this.userPreferences.get(userId)?.get(key);
  }

  /** ユーザー別の全好み */
  getPreferences(userId: string): Record<string, string> {
    const prefs = this.userPreferences.get(userId);
    return prefs ? Object.fromEntries(prefs) : {};
  }

  /** 明示的な好み設定 */
  setPreference(userId: string, key: string, value: string): void {
    let prefs = this.userPreferences.get(userId);
    if (!prefs) {
      prefs = new Map();
      this.userPreferences.set(userId, prefs);
    }
    prefs.set(key, value);
    this.save();
    logger.info(`[Learning] 好み設定: ${userId} → ${key}=${value}`);
  }

  /** アクティブルール一覧 */
  getActiveRules(): LearnedRule[] {
    return this.rules.filter(r => r.active).sort((a, b) => b.confidence - a.confidence);
  }

  /** ルール適用可能性チェック */
  findMatchingRules(text: string): LearnedRule[] {
    return this.rules
      .filter(r => r.active && text.includes(r.pattern))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  /** フィードバック履歴 */
  getFeedback(userId?: string, limit = 20): FeedbackEntry[] {
    let results = this.feedback;
    if (userId) results = results.filter(f => f.userId === userId);
    return results.slice(-limit).reverse();
  }

  /** 統計 */
  getStats(): {
    totalFeedback: number;
    totalRules: number;
    activeRules: number;
    corrections: number;
    userPreferences: number;
    topCategory: string;
  } {
    const categories = new Map<string, number>();
    for (const f of this.feedback) {
      categories.set(f.category, (categories.get(f.category) || 0) + 1);
    }
    const topCat = Array.from(categories.entries()).sort((a, b) => b[1] - a[1])[0];

    return {
      totalFeedback: this.feedback.length,
      totalRules: this.rules.length,
      activeRules: this.rules.filter(r => r.active).length,
      corrections: this.feedback.filter(f => f.type === "correction").length,
      userPreferences: this.userPreferences.size,
      topCategory: topCat?.[0] || "なし",
    };
  }

  /** フォーマット */
  formatStats(): string {
    const stats = this.getStats();
    const rules = this.getActiveRules().slice(0, 5);

    const lines = [
      "🧠 **学習状態**",
      `フィードバック: ${stats.totalFeedback}件`,
      `アクティブルール: ${stats.activeRules}件 (全${stats.totalRules}件)`,
      `修正: ${stats.corrections}件`,
      `ユーザー好み: ${stats.userPreferences}人`,
      `トップカテゴリ: ${stats.topCategory}`,
    ];

    if (rules.length > 0) {
      lines.push("", "**学習済みルール（TOP5）:**");
      for (const r of rules) {
        const conf = Math.round(r.confidence * 100);
        lines.push(`• "${r.pattern}" → "${r.action}" (信頼度${conf}%, ${r.useCount}回)`);
      }
    }

    return lines.join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const learningEngine = new LearningEngine(DATA_DIR);
