// ==========================================
// Hikamer - URL管理/短縮（OpenHuman redirect_links由来）
// URL解決・短縮生成・リンク管理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface ShortLink {
  code: string;
  url: string;
  title?: string;
  createdBy: string;
  createdAt: number;
  clickCount: number;
  lastClickedAt?: number;
  expiresAt?: number;
  tags: string[];
}

export interface RedirectRule {
  pattern: RegExp;
  replacement: string;
  description: string;
  enabled: boolean;
}

// ==================== URL管理 ====================

class URLManager {
  private shortLinks = new Map<string, ShortLink>();
  private redirectRules: RedirectRule[] = [];
  private persistPath: string;
  private counter = 0;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "urls.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        if (data.shortLinks) for (const s of data.shortLinks) this.shortLinks.set(s.code, s);
        if (data.rules) this.redirectRules = data.rules;
        logger.info(`[URL] 復元: ${this.shortLinks.size}短縮, ${this.redirectRules.length}ルール`);
      }
    } catch (e) {
      logger.warn(`[URL] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({
        shortLinks: Array.from(this.shortLinks.values()),
        rules: this.redirectRules,
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[URL] 保存失敗: ${e}`);
    }
  }

  /** URL短縮 */
  shorten(url: string, userId: string, options?: { title?: string; tags?: string[]; ttlHours?: number }): ShortLink {
    this.counter++;
    const code = this.generateCode(url);

    const link: ShortLink = {
      code,
      url,
      title: options?.title,
      createdBy: userId,
      createdAt: Date.now(),
      clickCount: 0,
      expiresAt: options?.ttlHours ? Date.now() + options.ttlHours * 3600000 : undefined,
      tags: options?.tags || [],
    };

    this.shortLinks.set(code, link);
    this.save();
    logger.info(`[URL] 短縮: ${url} → ${code}`);
    return link;
  }

  /** 短縮コード解決 */
  resolve(code: string): ShortLink | null {
    const link = this.shortLinks.get(code);
    if (!link) return null;

    if (link.expiresAt && Date.now() > link.expiresAt) {
      this.shortLinks.delete(code);
      this.save();
      return null;
    }

    link.clickCount++;
    link.lastClickedAt = Date.now();
    this.save();
    return link;
  }

  /** URL安全チェック */
  async checkSafety(url: string): Promise<{ safe: boolean; reason?: string }> {
    try {
      const parsed = new URL(url);
      // 既知の危険パターン
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { safe: false, reason: "http/https以外のプロトコル" };
      }
      // IP直リンクチェック
      const hostParts = parsed.hostname.split(".");
      const isIP = hostParts.every(p => /^\d+$/.test(p));
      if (isIP && hostParts.length === 4) {
        return { safe: false, reason: "IPアドレス直指定" };
      }
      return { safe: true };
    } catch {
      return { safe: false, reason: "URL形式が不正" };
    }
  }

  /** リダイレクトルール追加 */
  addRedirectRule(pattern: string, replacement: string, description: string): void {
    this.redirectRules.push({
      pattern: new RegExp(pattern, "i"),
      replacement,
      description,
      enabled: true,
    });
    this.save();
  }

  /** URLにルール適用 */
  applyRedirectRules(url: string): string {
    let result = url;
    for (const rule of this.redirectRules) {
      if (rule.enabled && rule.pattern.test(result)) {
        result = result.replace(rule.pattern, rule.replacement);
      }
    }
    return result;
  }

  /** タグ検索 */
  searchByTag(tag: string): ShortLink[] {
    return Array.from(this.shortLinks.values())
      .filter(l => l.tags.includes(tag))
      .sort((a, b) => b.clickCount - a.clickCount);
  }

  /** 短縮コード生成 */
  private generateCode(url: string): string {
    const hash = this.hashString(url + Date.now().toString(36));
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    let h = hash;
    for (let i = 0; i < 5; i++) {
      code += chars[h % chars.length];
      h = Math.floor(h / chars.length);
    }
    // 重複チェック
    if (this.shortLinks.has(code)) return this.generateCode(url + Math.random().toString(36).slice(2));
    return code;
  }

  private hashString(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /** フォーマット */
  formatLinks(links: ShortLink[]): string {
    if (links.length === 0) return "🔗 短縮リンクはありません。";

    return [
      "🔗 **短縮リンク一覧**",
      "",
      ...links.map(l => {
        const clicks = l.clickCount > 0 ? ` (${l.clickCount}クリック)` : "";
        const tags = l.tags.length > 0 ? ` [${l.tags.join(", ")}]` : "";
        return `• \`${l.code}\` → ${l.url.slice(0, 80)}${clicks}${tags}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const urlManager = new URLManager(DATA_DIR);
