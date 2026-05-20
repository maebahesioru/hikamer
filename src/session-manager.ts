// ==========================================
// Hikamer - セッション管理（OpenHuman threads由来）
// 会話セッションのピン留め・アーカイブ・命名・整理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  messageCount: number;
  platform: string;
  channelId: string;
  userId: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  starred: boolean;
  summary?: string;
  metadata: Record<string, string>;
}

// ==================== セッション管理 ====================

class SessionManager {
  private sessions = new Map<string, Session>();
  private persistPath: string;
  private maxSessions = 500;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "sessions.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data: Session[] = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        for (const s of data) this.sessions.set(s.id, s);
        logger.info(`[Sessions] 復元: ${this.sessions.size}セッション`);
      }
    } catch (e) {
      logger.warn(`[Sessions] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(Array.from(this.sessions.values()), null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Sessions] 保存失敗: ${e}`);
    }
  }

  /** セッションを登録または更新 */
  updateSession(id: string, updates: Partial<Session>): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        title: updates.title || "新規会話",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastMessageAt: Date.now(),
        messageCount: 0,
        platform: updates.platform || "unknown",
        channelId: updates.channelId || "",
        userId: updates.userId || "",
        tags: [],
        pinned: false,
        archived: false,
        starred: false,
        metadata: {},
      };
      this.sessions.set(id, session);
    }

    Object.assign(session, updates);
    session.updatedAt = Date.now();
    if (updates.messageCount !== undefined) session.messageCount = updates.messageCount;
    if (updates.lastMessageAt) session.lastMessageAt = updates.lastMessageAt;

    // 最大数制限
    this.enforceLimit();
    this.save();
    return session;
  }

  /** メッセージカウント増加 */
  incrementMessageCount(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.messageCount++;
      session.lastMessageAt = Date.now();
      session.updatedAt = Date.now();
      this.save();
    }
  }

  /** タイトル更新 */
  setTitle(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.title = title.slice(0, 200);
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** サマリ設定 */
  setSummary(id: string, summary: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.summary = summary.slice(0, 1000);
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** ピン留め */
  togglePin(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pinned = !session.pinned;
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** アーカイブ */
  toggleArchive(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.archived = !session.archived;
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** スター */
  toggleStar(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.starred = !session.starred;
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** タグ追加 */
  addTag(id: string, tag: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!session.tags.includes(tag)) {
      session.tags.push(tag);
      session.updatedAt = Date.now();
      this.save();
    }
    return true;
  }

  /** タグ削除 */
  removeTag(id: string, tag: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.tags = session.tags.filter(t => t !== tag);
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** メタデータ設定 */
  setMetadata(id: string, key: string, value: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.metadata[key] = value;
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** セッション取得 */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** アクティブセッション一覧 */
  listActive(platform?: string, limit = 20): Session[] {
    let results = Array.from(this.sessions.values()).filter(s => !s.archived);
    if (platform) results = results.filter(s => s.platform === platform);
    return results.sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, limit);
  }

  /** ピン留め一覧 */
  listPinned(): Session[] {
    return Array.from(this.sessions.values())
      .filter(s => s.pinned && !s.archived)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  /** アーカイブ一覧 */
  listArchived(limit = 20): Session[] {
    return Array.from(this.sessions.values())
      .filter(s => s.archived)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, limit);
  }

  /** 検索 */
  search(query: string): Session[] {
    const q = query.toLowerCase();
    return Array.from(this.sessions.values())
      .filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.summary?.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      )
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, 20);
  }

  /** 統計 */
  getStats(): {
    total: number;
    active: number;
    archived: number;
    pinned: number;
    starred: number;
    totalMessages: number;
  } {
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      active: all.filter(s => !s.archived).length,
      archived: all.filter(s => s.archived).length,
      pinned: all.filter(s => s.pinned).length,
      starred: all.filter(s => s.starred).length,
      totalMessages: all.reduce((sum, s) => sum + s.messageCount, 0),
    };
  }

  /** 最大数制限 */
  private enforceLimit(): void {
    if (this.sessions.size > this.maxSessions) {
      const sorted = Array.from(this.sessions.values())
        .sort((a, b) => a.lastMessageAt - b.lastMessageAt);
      const toRemove = sorted.slice(0, this.sessions.size - this.maxSessions);
      for (const s of toRemove) {
        if (!s.pinned) this.sessions.delete(s.id);
      }
    }
  }

  /** フォーマット */
  formatSessions(list: Session[], title: string = "セッション一覧"): string {
    if (list.length === 0) return `📋 **${title}**\n該当するセッションはありません。`;

    return [
      `📋 **${title}** (${list.length}件)`,
      "",
      ...list.map(s => {
        const pin = s.pinned ? "📌 " : "";
        const star = s.starred ? "⭐ " : "";
        const arch = s.archived ? "🗄️ " : "";
        const ago = this.fmtAgo(s.lastMessageAt);
        const tagStr = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
        return `${pin}${star}${arch}\`${s.id.slice(0, 10)}…\` **${s.title}** (${ago}, ${s.messageCount}msg)${tagStr}`;
      }),
    ].join("\n");
  }

  private fmtAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "たった今";
    if (mins < 60) return `${mins}分前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    return `${days}日前`;
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const sessionManager = new SessionManager(DATA_DIR);
