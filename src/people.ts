// ==========================================
// Aikata - ピープル/プロフィール（OpenHuman people由来）
// 詳細なユーザープロフィール管理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface Profile {
  userId: string;
  name: string;
  displayName: string;
  platform: string;
  bio?: string;
  timezone?: string;
  language?: string;
  preferences: Record<string, string>;
  badges: string[];
  contactInfo: { type: string; value: string; label: string }[];
  stats: {
    messagesSent: number;
    commandsUsed: number;
    firstSeen: number;
    lastSeen: number;
    averageRating: number;
  };
  tags: string[];
  notes?: string;
}

// ==================== プロフィール管理 ====================

class PeopleManager {
  private profiles = new Map<string, Profile>();
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "profiles.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data: Profile[] = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        for (const p of data) this.profiles.set(p.userId, p);
        logger.info(`[People] 復元: ${this.profiles.size}プロフィール`);
      }
    } catch (e) {
      logger.warn(`[People] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(Array.from(this.profiles.values()), null, 2), "utf-8");
    } catch (e) {
      logger.error(`[People] 保存失敗: ${e}`);
    }
  }

  /** プロフィール取得/作成 */
  getOrCreate(userId: string, platform: string, name: string): Profile {
    let profile = this.profiles.get(userId);
    if (!profile) {
      profile = {
        userId,
        name,
        displayName: name,
        platform,
        preferences: {},
        badges: [],
        contactInfo: [],
        stats: { messagesSent: 0, commandsUsed: 0, firstSeen: Date.now(), lastSeen: Date.now(), averageRating: 0 },
        tags: [],
      };
      this.profiles.set(userId, profile);
    }
    profile.stats.lastSeen = Date.now();
    this.save();
    return profile;
  }

  /** プロフィール更新 */
  update(userId: string, updates: Partial<Profile>): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;
    Object.assign(profile, updates);
    profile.stats.lastSeen = Date.now();
    this.save();
    return true;
  }

  /** メッセージカウント増加 */
  incrementMessages(userId: string): void {
    const profile = this.getOrCreate(userId, "unknown", "unknown");
    profile.stats.messagesSent++;
    this.save();
  }

  /** バッジ追加 */
  addBadge(userId: string, badge: string): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;
    if (!profile.badges.includes(badge)) {
      profile.badges.push(badge);
      this.save();
    }
    return true;
  }

  /** 評価記録 */
  recordRating(userId: string, rating: number): void {
    const profile = this.getOrCreate(userId, "unknown", "unknown");
    const oldAvg = profile.stats.averageRating;
    const oldCount = profile.stats.messagesSent || 1;
    profile.stats.averageRating = (oldAvg * oldCount + rating) / (oldCount + 1);
    this.save();
  }

  /** 検索 */
  search(query: string): Profile[] {
    const q = query.toLowerCase();
    return Array.from(this.profiles.values())
      .filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.displayName.toLowerCase().includes(q) ||
        p.tags.some(t => t.toLowerCase().includes(q)) ||
        p.bio?.toLowerCase().includes(q)
      )
      .sort((a, b) => b.stats.messagesSent - a.stats.messagesSent)
      .slice(0, 10);
  }

  /** 全ユーザー統計 */
  getStats(): { total: number; active24h: number; totalMessages: number } {
    const all = Array.from(this.profiles.values());
    const dayAgo = Date.now() - 86400000;
    return {
      total: all.length,
      active24h: all.filter(p => p.stats.lastSeen > dayAgo).length,
      totalMessages: all.reduce((s, p) => s + p.stats.messagesSent, 0),
    };
  }

  formatProfile(profile: Profile): string {
    const badges = profile.badges.length > 0 ? ` ${profile.badges.map(b => `🏅${b}`).join(" ")}` : "";
    const lastSeen = new Date(profile.stats.lastSeen).toLocaleDateString("ja-JP");
    const prefs = Object.keys(profile.preferences).length > 0
      ? `\n好み: ${Object.entries(profile.preferences).map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "";

    return [
      `👤 **${profile.displayName}** (@${profile.name})${badges}`,
      `プラットフォーム: ${profile.platform}`,
      `メッセージ: ${profile.stats.messagesSent} | コマンド: ${profile.stats.commandsUsed}`,
      `評価: ${profile.stats.averageRating.toFixed(1)}⭐ | 最終: ${lastSeen}`,
      profile.bio ? `\n${profile.bio}` : "",
      prefs,
      profile.notes ? `\nメモ: ${profile.notes}` : "",
    ].filter(Boolean).join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const peopleManager = new PeopleManager(DATA_DIR);
