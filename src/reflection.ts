// ==========================================
// Aikata - リフレクションシステム（OpenHuman subconscious/reflection.rs 由来）
// サブコンシャスの深いリフレクション・自己分析
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface Reflection {
  id: string;
  content: string;
  summary: string;
  category: "insight" | "pattern" | "anomaly" | "improvement" | "decision" | "summary";
  confidence: number; // 0.0-1.0
  source: string;
  contextIds: string[];
  createdAt: number;
  relevanceScore: number;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface ReflectionStore {
  reflections: Reflection[];
  stats: {
    total: number;
    byCategory: Record<string, number>;
    avgConfidence: number;
    latestReflectionAt: number | null;
  };
}

export interface ReflectionQuery {
  category?: string;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
  since?: number;
}

// ==================== リフレクションエンジン ====================

class ReflectionEngine {
  private reflections: Reflection[] = [];
  private maxReflections = 200;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Reflection] engine initialized");
  }

  /** リフレクションを記録 */
  record(
    content: string,
    category: Reflection["category"],
    options?: {
      source?: string;
      contextIds?: string[];
      tags?: string[];
      confidence?: number;
      metadata?: Record<string, unknown>;
    }
  ): Reflection {
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const reflection: Reflection = {
      id,
      content,
      summary: this.generateSummary(content),
      category,
      confidence: options?.confidence ?? this.estimateConfidence(content, category),
      source: options?.source ?? "internal",
      contextIds: options?.contextIds ?? [],
      createdAt: now,
      relevanceScore: 1.0,
      tags: options?.tags ?? this.autoTag(content, category),
      metadata: options?.metadata,
    };

    this.reflections.push(reflection);

    // 上限超過
    if (this.reflections.length > this.maxReflections) {
      this.pruneOld();
    }

    // 高重要度リフレクションはブロードキャスト
    if (reflection.confidence > 0.8 || reflection.category === "anomaly") {
      eventBus.emit(createEvent("reflection:important", {
        id: reflection.id,
        category: reflection.category,
        summary: reflection.summary,
      }));
    }

    logger.debug(`[Reflection] ${category}: ${reflection.summary}`);
    return reflection;
  }

  /** リフレクションを検索 */
  query(query: ReflectionQuery): Reflection[] {
    let results = [...this.reflections];

    if (query.category) {
      results = results.filter((r) => r.category === query.category);
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((r) =>
        query.tags!.some((t) => r.tags.includes(t))
      );
    }
    if (query.minConfidence !== undefined) {
      results = results.filter((r) => r.confidence >= query.minConfidence!);
    }
    if (query.since) {
      results = results.filter((r) => r.createdAt >= query.since!);
    }

    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, query.limit ?? 20);
  }

  /** カテゴリ別のリフレクションを取得 */
  getByCategory(category: Reflection["category"], limit = 10): Reflection[] {
    return this.reflections
      .filter((r) => r.category === category)
      .slice(-limit)
      .reverse();
  }

  /** 直近のリフレクションを取得 */
  getRecent(count = 10): Reflection[] {
    return this.reflections.slice(-count).reverse();
  }

  /** 高信頼性リフレクションを取得 */
  getHighConfidence(threshold = 0.7, limit = 20): Reflection[] {
    return this.reflections
      .filter((r) => r.confidence >= threshold)
      .slice(-limit)
      .reverse();
  }

  /** ストアの状態を取得 */
  getStore(): ReflectionStore {
    const byCategory: Record<string, number> = {};
    let totalConfidence = 0;

    for (const r of this.reflections) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      totalConfidence += r.confidence;
    }

    return {
      reflections: this.reflections,
      stats: {
        total: this.reflections.length,
        byCategory,
        avgConfidence:
          this.reflections.length > 0
            ? totalConfidence / this.reflections.length
            : 0,
        latestReflectionAt:
          this.reflections.length > 0
            ? this.reflections[this.reflections.length - 1]!.createdAt
            : null,
      },
    };
  }

  /** リフレクションをクリア */
  clear(): void {
    this.reflections = [];
    logger.info("[Reflection] cleared all reflections");
  }

  /** 定期的リフレクション実行 */
  async periodicReflection(context: {
    totalTurns: number;
    totalErrors: number;
    recentToolCalls: string[];
    uptimeMs: number;
    sessionsActive: number;
  }): Promise<Reflection | null> {
    const patterns = this.detectPatterns(context);
    if (!patterns) return null;

    return this.record(
      patterns.content,
      patterns.category,
      {
        source: "periodic",
        confidence: patterns.confidence,
        tags: ["auto", "periodic", ...(patterns.tags ?? [])],
      }
    );
  }

  // ---- 内部 ----

  private generateSummary(content: string): string {
    if (content.length <= 80) return content;
    return content.slice(0, 77) + "...";
  }

  private estimateConfidence(
    content: string,
    category: Reflection["category"]
  ): number {
    // 長いほど高信頼性（より具体的）
    const lengthFactor = Math.min(content.length / 200, 1);
    const categoryBase =
      category === "anomaly" ? 0.6 :
      category === "insight" ? 0.5 :
      category === "pattern" ? 0.4 :
      0.3;
    return Math.min(0.95, categoryBase + lengthFactor * 0.4);
  }

  private autoTag(content: string, category: string): string[] {
    const tags: string[] = [category];
    const lower = content.toLowerCase();

    if (lower.includes("error") || lower.includes("fail")) tags.push("error");
    if (lower.includes("improve") || lower.includes("optimize")) tags.push("improvement");
    if (lower.includes("pattern") || lower.includes("trend")) tags.push("trend");
    if (lower.includes("user") || lower.includes("request")) tags.push("user-feedback");
    if (lower.includes("tool") || lower.includes("function")) tags.push("tool");

    return tags;
  }

  private detectPatterns(context: {
    totalTurns: number;
    totalErrors: number;
    recentToolCalls: string[];
    uptimeMs: number;
    sessionsActive: number;
  }): { content: string; category: Reflection["category"]; confidence: number; tags?: string[] } | null {
    // エラー率が高い
    if (context.totalTurns > 10 && context.totalErrors / context.totalTurns > 0.3) {
      return {
        content: `高エラー率検出: ${((context.totalErrors / context.totalTurns) * 100).toFixed(0)}%（${context.totalErrors}/${context.totalTurns}）`,
        category: "anomaly",
        confidence: 0.75,
        tags: ["alert", "high-error-rate"],
      };
    }

    return {
      content: `定期チェック: ${context.totalTurns}ターン, ${context.sessionsActive}アクティブセッション, 稼働${Math.floor(context.uptimeMs / 3600000)}時間`,
      category: "summary",
      confidence: 0.5,
      tags: ["periodic"],
    };
  }

  private pruneOld(): void {
    // 最も関連性の低いものを削除
    this.reflections.sort((a, b) => a.relevanceScore - b.relevanceScore);
    this.reflections = this.reflections.slice(-this.maxReflections);
  }

  formatReflection(ref: Reflection): string {
    const confidenceBar = "🟩".repeat(Math.round(ref.confidence * 5)) +
      "⬜".repeat(5 - Math.round(ref.confidence * 5));

    return (
      `💭 **${ref.category}** [${(ref.confidence * 100).toFixed(0)}% ${confidenceBar}]\n` +
      `${ref.content}\n` +
      `🏷️ ${ref.tags.join(", ")} | 📍 ${ref.source}` +
      (ref.contextIds.length > 0 ? ` | 🔗 ${ref.contextIds.length}件` : "") +
      `\n🕐 ${new Date(ref.createdAt).toLocaleString("ja-JP")}`
    );
  }
}

// ==================== シングルトン ====================

export const reflectionEngine = new ReflectionEngine();

export default ReflectionEngine;
