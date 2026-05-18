// ==========================================
// Aikata - Content Calendar + Portfolio（toprank bin/toprank-content-calendar + portfolio_review.py由来）
// コンテンツカレンダー管理 + マルチサイトポートフォリオ
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

export interface ContentItem {
  id: string;
  title: string;
  url: string;
  type: "blog" | "page" | "social" | "video" | "other";
  status: "draft" | "scheduled" | "published" | "archived";
  author: string;
  publishDate?: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  seoScore?: number;
}

export interface CalendarEntry {
  date: string;
  items: ContentItem[];
}

export interface SiteProfile {
  id: string;
  name: string;
  domain: string;
  cmsType: string;
  lastAuditAt?: string;
  overallScore?: number;
  contentCount: number;
  issues: number;
}

export class ContentCalendar {
  private items: ContentItem[] = [];
  private sites: SiteProfile[] = [];
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.load();
  }

  /** コンテンツ追加 */
  addItem(item: ContentItem): void {
    this.items.push(item);
    this.save();
  }

  /** 日付別カレンダー */
  getCalendar(year: number, month: number): CalendarEntry[] {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const monthItems = this.items.filter(
      (i) => i.publishDate?.startsWith(prefix),
    );

    const byDate = new Map<string, ContentItem[]>();
    for (const item of monthItems) {
      const date = item.publishDate!.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(item);
    }

    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }));
  }

  /** SEOスコア分布 */
  getScoreDistribution(): { excellent: number; good: number; needsWork: number; poor: number } {
    const scored = this.items.filter((i) => i.seoScore !== undefined);
    return {
      excellent: scored.filter((i) => (i.seoScore ?? 0) >= 90).length,
      good: scored.filter((i) => (i.seoScore ?? 0) >= 70 && (i.seoScore ?? 0) < 90).length,
      needsWork: scored.filter((i) => (i.seoScore ?? 0) >= 50 && (i.seoScore ?? 0) < 70).length,
      poor: scored.filter((i) => (i.seoScore ?? 0) < 50).length,
    };
  }

  // ==================== ポートフォリオ管理 ====================

  /** サイト追加 */
  addSite(site: SiteProfile): void {
    const existing = this.sites.findIndex((s) => s.id === site.id);
    if (existing >= 0) {
      this.sites[existing] = site;
    } else {
      this.sites.push(site);
    }
    this.save();
  }

  /** サイト削除 */
  removeSite(siteId: string): void {
    this.sites = this.sites.filter((s) => s.id !== siteId);
    this.save();
  }

  /** 全サイト */
  getSites(): SiteProfile[] {
    return [...this.sites];
  }

  /** 優先順位付きサイト一覧 */
  getPrioritizedSites(): SiteProfile[] {
    return [...this.sites].sort((a, b) => {
      // スコア低い順（改善余地が大きい順）
      const aScore = a.overallScore ?? 100;
      const bScore = b.overallScore ?? 100;
      if (aScore !== bScore) return aScore - bScore;
      // イシュー多い順
      return b.issues - a.issues;
    });
  }

  /** サイト間の共通イシュー */
  getCommonIssues(): Array<{ issue: string; affectedSites: string[]; avgScoreImpact: number }> {
    return []; // 実際の実装では全サイトの監査結果を集約
  }

  // ==================== 永続化 ====================

  private storagePath(): string {
    return resolve(this.baseDir, "content-calendar.json");
  }

  private portfolioPath(): string {
    return resolve(this.baseDir, "portfolio.json");
  }

  private load(): void {
    try {
      const calPath = this.storagePath();
      if (existsSync(calPath)) {
        this.items = JSON.parse(readFileSync(calPath, "utf-8"));
      }
      const portPath = this.portfolioPath();
      if (existsSync(portPath)) {
        this.sites = JSON.parse(readFileSync(portPath, "utf-8"));
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(this.storagePath(), JSON.stringify(this.items, null, 2), "utf-8");
    writeFileSync(this.portfolioPath(), JSON.stringify(this.sites, null, 2), "utf-8");
  }

  formatStatus(): string {
    const score = this.getScoreDistribution();
    const sites = this.getSites();
    return [
      "📅 **Content Calendar**",
      `  コンテンツ数: ${this.items.length}`,
      `  SEOスコア: 🟢${score.excellent} 🟡${score.good} 🟠${score.needsWork} 🔴${score.poor}`,
      "",
      "📊 **Portfolio**",
      `  サイト数: ${sites.length}`,
      ...sites.map((s) => `  • ${s.name} (${s.domain})${s.overallScore ? ` [スコア: ${s.overallScore}]` : ""}`),
    ].join("\n");
  }
}
