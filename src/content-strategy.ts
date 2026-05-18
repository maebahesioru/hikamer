// ==========================================
// Aikata - コンテンツ戦略エンジン
// 出典: SEO Sprint (initialcommit.co) スキルアーキテクチャ
// キーワード分析 + コンテンツプラン生成 + 最適化提案
// ==========================================

import { logger } from "./utils/logger";

// ==================== コンテンツタイプ ====================

type ContentType =
  | "blog"
  | "thread"      // X/Twitter thread
  | "newsletter"
  | "guide"
  | "comparison"
  | "alternative"
  | "landing_page";

interface ContentItem {
  type: ContentType;
  title: string;
  description: string;
  targetKeywords: string[];
  priority: "high" | "medium" | "low";
  estimatedImpact: "high" | "medium" | "low";
  status: "planned" | "drafting" | "published";
}

// ==================== キーワード分析 ====================

interface KeywordAnalysis {
  primaryKeyword: string;
  searchIntent: "informational" | "navigational" | "commercial" | "transactional";
  difficulty: "low" | "medium" | "high";
  suggestedTopics: string[];
  competitorKeywords: string[];
}

class KeywordAnalyzer {
  /**
   * キーワードを分析（ヒューリスティック）
   */
  analyze(keyword: string, context?: string): KeywordAnalysis {
    const kw = keyword.toLowerCase();

    // 検索意図の推定
    let intent: KeywordAnalysis["searchIntent"] = "informational";
    if (/\b(buy|price|cheap|best|deal|review|vs|comparison|alternative)\b/i.test(kw)) {
      intent = "commercial";
    } else if (/\b(login|download|api|docs|setup|install|config|sign up)\b/i.test(kw)) {
      intent = "navigational";
    } else if (/\b(how to|tutorial|guide|learn|beginner|example|fix|error|setup)\b/i.test(kw)) {
      intent = "informational";
    }

    const suggestions = this.generateTopics(kw);
    const competitorKws = this.extractCompetitorKeywords(kw);

    return {
      primaryKeyword: kw,
      searchIntent: intent,
      difficulty: kw.length < 15 ? "high" : kw.length < 30 ? "medium" : "low",
      suggestedTopics: suggestions,
      competitorKeywords: competitorKws,
    };
  }

  /**
   * コンテンツプランを生成
   * SEO Sprint: conversion-first (alternatives+comparison before blogs)
   */
  generateContentPlan(keyword: string, siteName?: string): ContentItem[] {
    const base = keyword.toLowerCase();
    const name = siteName || "your product";

    return [
      {
        type: "comparison",
        title: `${base} alternatives — Why ${name} is different`,
        description: `Compare ${base} options with specific criteria relevant to decision-makers.`,
        targetKeywords: [`${base} alternatives`, `${base} comparisons`, `best ${base}`],
        priority: "high",
        estimatedImpact: "high",
        status: "planned",
      },
      {
        type: "alternative",
        title: `${base} vs ${name}: 2026 comparison`,
        description: `Direct comparison focused on the specific migration path from ${base}.`,
        targetKeywords: [`${base} vs ${name}`, `${base} ${name} comparison`],
        priority: "high",
        estimatedImpact: "high",
        status: "planned",
      },
      {
        type: "guide",
        title: `${base}: The Complete Guide`,
        description: `Comprehensive guide covering everything a beginner needs to start with ${base}.`,
        targetKeywords: [`${base} guide`, `${base} tutorial`, `how to ${base}`],
        priority: "medium",
        estimatedImpact: "high",
        status: "planned",
      },
      {
        type: "blog",
        title: `Common ${base} problems and how to solve them`,
        description: `Solution-focused content that captures problem-solving intent.`,
        targetKeywords: [`${base} problems`, `${base} error`, `${base} fix`],
        priority: "low",
        estimatedImpact: "medium",
        status: "planned",
      },
    ];
  }

  private generateTopics(kw: string): string[] {
    const base = kw.replace(/\s+/g, " ").trim();
    return [
      `${base} best practices`,
      `${base} for beginners`,
      `${base} advanced techniques`,
      `Common ${base} mistakes`,
      `${base} tools and resources`,
      `How to automate ${base}`,
      `${base} case study`,
      `${base} trends 2026`,
    ];
  }

  private extractCompetitorKeywords(kw: string): string[] {
    return [
      `best ${kw} tools`,
      `${kw} alternatives`,
      `${kw} free`,
      `${kw} open source`,
    ];
  }
}

// ==================== コンテンツ最適化 ====================

class ContentOptimizer {
  /**
   * 記事/スレッドを分析して改善案を提案
   * SEO Sprint: quality scoring
   */
  analyze(draft: string, keyword: string): { score: number; suggestions: string[] } {
    let score = 5;
    const suggestions: string[] = [];

    // 長さチェック
    if (draft.length < 200) {
      suggestions.push("コンテンツが短すぎます（最低300語推奨）");
      score -= 2;
    }

    // キーワード密度
    const kwCount = (draft.match(new RegExp(keyword, "gi")) || []).length;
    if (kwCount < 2) {
      suggestions.push(`キーワード "${keyword}" の使用回数が少なすぎます（最低3回推奨）`);
      score -= 1;
    } else if (kwCount > 15) {
      suggestions.push("キーワードが過剰です（キーワードスタッフィングの可能性）");
      score -= 1;
    }

    // 見出し構造
    if (!/#{1,3}\s/.test(draft)) {
      suggestions.push("見出し（H1-H3）がありません。構造化を改善してください");
      score -= 1;
    }

    // CTA（Call to Action）
    if (!/リンク|チェック|試|登録|ダウンロード|読|共有/.test(draft)) {
      suggestions.push("CTA（Call to Action）が不足しています");
      score -= 1;
    }

    // リスト/箇条書き
    if (draft.length > 500 && !/^[-*•]|[0-9]+\./.test(draft)) {
      suggestions.push("箇条書きやリスト形式でスキャン容易性を向上できます");
    }

    score = Math.max(0, Math.min(10, score));

    return { score, suggestions };
  }

  /**
   * X/Twitterスレッド用に最適化
   */
  optimizeForThread(draft: string, maxPosts: number = 6): string[] {
    const lines = draft.split("\n").filter(l => l.trim());

    if (lines.length <= maxPosts) return lines;

    // マージしてmaxPosts以内に
    const result: string[] = [];
    const perPost = Math.ceil(lines.length / maxPosts);

    for (let i = 0; i < lines.length; i += perPost) {
      result.push(lines.slice(i, i + perPost).join("\n"));
    }

    return result.slice(0, maxPosts);
  }
}

// ==================== コンテンツカレンダー ====================

class ContentCalendar {
  private items: ContentItem[] = [];

  /** アイテムを追加 */
  add(item: ContentItem): void {
    this.items.push(item);
  }

  /** 優先度順でアイテムを取得 */
  getByPriority(priority: ContentItem["priority"]): ContentItem[] {
    return this.items.filter(i => i.priority === priority);
  }

  /** 未公開のアイテム */
  getPending(): ContentItem[] {
    return this.items.filter(i => i.status !== "published");
  }

  /** フォーマットされた表示 */
  formatCalendar(): string {
    const lines: string[] = ["📅 **コンテンツカレンダー**"];
    const categories: Array<{ priority: ContentItem["priority"]; emoji: string }> = [
      { priority: "high", emoji: "🔥" },
      { priority: "medium", emoji: "📌" },
      { priority: "low", emoji: "📎" },
    ];

    for (const { priority, emoji } of categories) {
      const items = this.getByPriority(priority);
      if (items.length > 0) {
        for (const item of items) {
          const status = item.status === "published" ? "✅" : item.status === "drafting" ? "✍️" : "⏳";
          lines.push(`${emoji}${status} **${item.title}** (${item.type})`);
        }
      }
    }

    return lines.join("\n");
  }
}

export const keywordAnalyzer = new KeywordAnalyzer();
export const contentOptimizer = new ContentOptimizer();
export const contentCalendar = new ContentCalendar();
export { type ContentItem, type ContentType };
