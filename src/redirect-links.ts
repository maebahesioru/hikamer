// ==========================================
// Hikamer - リンクリダイレクト（OpenHuman redirect_links/ 由来）
// URL短縮・リダイレクト管理・クリック追跡
// ==========================================

import { logger } from "./utils/logger";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface RedirectLink {
  id: string;
  code: string;
  url: string;
  title: string;
  createdAt: number;
  expiresAt: number | null;
  clickCount: number;
  lastClickedAt: number | null;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface RedirectStats {
  totalLinks: number;
  totalClicks: number;
  activeLinks: number;
  expiredLinks: number;
  topLinks: Array<{ code: string; url: string; clicks: number }>;
  clicksByDay: Record<string, number>;
}

// ==================== リダイレクトマネージャー ====================

class RedirectManager {
  private links: Map<string, RedirectLink> = new Map();
  private initialized = false;
  private maxLinks = 500;
  private baseUrl = process.env.REDIRECT_BASE_URL || "https://hikamer.app/r";

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Redirect] link manager initialized");
  }

  /** リダイレクトリンクを作成 */
  createLink(
    url: string,
    options?: {
      title?: string;
      code?: string;
      tags?: string[];
      expiresInMs?: number;
      metadata?: Record<string, unknown>;
    }
  ): RedirectLink {
    const id = `redir-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const code = options?.code ?? this.generateCode();
    const now = Date.now();

    // コードの重複チェック
    if (this.getByCode(code)) {
      throw new Error(`Code "${code}" already exists`);
    }

    const link: RedirectLink = {
      id,
      code,
      url,
      title: options?.title ?? url.slice(0, 60),
      createdAt: now,
      expiresAt: options?.expiresInMs ? now + options.expiresInMs : null,
      clickCount: 0,
      lastClickedAt: null,
      tags: options?.tags ?? [],
      metadata: options?.metadata,
    };

    this.links.set(id, link);

    // 上限超過時は最もクリック数の少ないものを削除
    if (this.links.size > this.maxLinks) {
      this.pruneOldest();
    }

    logger.info(`[Redirect] created: ${code} -> ${url}`);
    return link;
  }

  /** コードからリンクを解決 */
  resolve(code: string): RedirectLink | null {
    const link = this.getByCode(code);
    if (!link) return null;

    // 有効期限チェック
    if (link.expiresAt && Date.now() > link.expiresAt) {
      return null;
    }

    // クリックを記録
    link.clickCount++;
    link.lastClickedAt = Date.now();
    return link;
  }

  /** リンクを削除 */
  deleteLink(code: string): boolean {
    const link = this.getByCode(code);
    if (!link) return false;
    return this.links.delete(link.id);
  }

  /** リンク一覧 */
  listLinks(tag?: string): RedirectLink[] {
    const all = Array.from(this.links.values());
    return tag
      ? all.filter((l) => l.tags.includes(tag))
      : all;
  }

  /** タグ一覧 */
  listTags(): string[] {
    const tags = new Set<string>();
    for (const link of this.links.values()) {
      for (const tag of link.tags) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }

  /** 統計 */
  getStats(): RedirectStats {
    const now = Date.now();
    const all = Array.from(this.links.values());
    const clicksByDay: Record<string, number> = {};

    return {
      totalLinks: all.length,
      totalClicks: all.reduce((s, l) => s + l.clickCount, 0),
      activeLinks: all.filter((l) => !l.expiresAt || now < l.expiresAt).length,
      expiredLinks: all.filter((l) => l.expiresAt && now >= l.expiresAt).length,
      topLinks: all
        .sort((a, b) => b.clickCount - a.clickCount)
        .slice(0, 10)
        .map((l) => ({
          code: l.code,
          url: l.url.slice(0, 50),
          clicks: l.clickCount,
        })),
      clicksByDay,
    };
  }

  /** 期限切れリンクをクリーンアップ */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, link] of this.links) {
      if (link.expiresAt && now >= link.expiresAt) {
        this.links.delete(id);
        removed++;
      }
    }
    if (removed > 0) logger.debug(`[Redirect] cleaned ${removed} expired links`);
    return removed;
  }

  /** 短縮URLを生成 */
  getShortUrl(code: string): string {
    return `${this.baseUrl}/${code}`;
  }

  // ---- 内部 ----

  private generateCode(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // 重複チェック
    if (this.getByCode(code)) return this.generateCode();
    return code;
  }

  private getByCode(code: string): RedirectLink | null {
    for (const link of this.links.values()) {
      if (link.code === code) return link;
    }
    return null;
  }

  private pruneOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [id, link] of this.links) {
      if (link.createdAt < oldestTime) {
        oldestTime = link.createdAt;
        oldestKey = id;
      }
    }
    if (oldestKey) this.links.delete(oldestKey);
  }

  formatLink(link: RedirectLink): string {
    return (
      `🔗 **/${link.code}** -> ${link.url.slice(0, 60)}\n` +
      `クリック: ${link.clickCount}回` +
      (link.lastClickedAt ? ` | 最終: ${new Date(link.lastClickedAt).toLocaleString("ja-JP")}` : "") +
      (link.expiresAt ? `\n有効期限: ${new Date(link.expiresAt).toLocaleString("ja-JP")}` : "") +
      (link.tags.length > 0 ? `\n🏷️ ${link.tags.join(", ")}` : "") +
      `\n🔗 ${this.getShortUrl(link.code)}`
    );
  }

  formatStats(): string {
    const s = this.getStats();
    return (
      `🔗 **リダイレクト管理**\n` +
      `総リンク: ${s.totalLinks}\n` +
      `アクティブ: ${s.activeLinks}\n` +
      `期限切れ: ${s.expiredLinks}\n` +
      `総クリック: ${s.totalClicks}\n\n` +
      (s.topLinks.length > 0
        ? `**人気リンク**\n` +
          s.topLinks.map((l, i) => `${i + 1}. /${l.code} (${l.clicks}クリック) ${l.url}`).join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const redirectManager = new RedirectManager();

export default RedirectManager;
