// ==========================================
// Hikamer - チーム/連絡先管理（OpenHuman team + people由来）
// ユーザープロファイル・連絡先・チーム管理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface Contact {
  id: string;
  name: string;
  displayName: string;
  platform: string;
  platformId: string;
  email?: string;
  phone?: string;
  notes?: string;
  tags: string[];
  groups: string[];
  metadata: Record<string, string>;
  firstContact: number;
  lastContact: number;
  contactCount: number;
  favorite: boolean;
  blocked: boolean;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: number;
}

// ==================== 連絡先管理 ====================

class ContactManager {
  private contacts = new Map<string, Contact>();
  private groups = new Map<string, Group>();
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "contacts.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        if (data.contacts) {
          for (const c of data.contacts) this.contacts.set(c.id, c);
        }
        if (data.groups) {
          for (const g of data.groups) this.groups.set(g.id, g);
        }
        logger.info(`[Contacts] 復元: ${this.contacts.size}連絡先, ${this.groups.size}グループ`);
      }
    } catch (e) {
      logger.warn(`[Contacts] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({
        contacts: Array.from(this.contacts.values()),
        groups: Array.from(this.groups.values()),
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Contacts] 保存失敗: ${e}`);
    }
  }

  /** 連絡先追加/更新 */
  upsertContact(
    platformId: string,
    platform: string,
    name: string,
    options?: {
      displayName?: string;
      email?: string;
      phone?: string;
      notes?: string;
      tags?: string[];
      groups?: string[];
    },
  ): Contact {
    // 既存検索
    const existing = Array.from(this.contacts.values())
      .find(c => c.platformId === platformId && c.platform === platform);

    if (existing) {
      existing.name = name;
      existing.displayName = options?.displayName || options?.displayName || name;
      if (options?.email) existing.email = options.email;
      if (options?.phone) existing.phone = options.phone;
      if (options?.notes) existing.notes = options.notes;
      if (options?.tags) existing.tags = [...new Set([...existing.tags, ...options.tags])];
      if (options?.groups) {
        for (const g of options.groups) {
          if (!existing.groups.includes(g)) existing.groups.push(g);
        }
      }
      existing.lastContact = Date.now();
      existing.contactCount++;
      this.save();
      return existing;
    }

    // 新規
    const contact: Contact = {
      id: `contact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      displayName: options?.displayName || name,
      platform,
      platformId,
      email: options?.email,
      phone: options?.phone,
      notes: options?.notes,
      tags: options?.tags || [],
      groups: options?.groups || [],
      metadata: {},
      firstContact: Date.now(),
      lastContact: Date.now(),
      contactCount: 1,
      favorite: false,
      blocked: false,
    };

    this.contacts.set(contact.id, contact);
    this.save();
    logger.info(`[Contacts] 追加: ${name} (${platform}/${platformId})`);
    return contact;
  }

  /** 連絡先取得 */
  getContact(id: string): Contact | undefined {
    return this.contacts.get(id);
  }

  /** プラットフォームIDで検索 */
  findByPlatform(platformId: string, platform?: string): Contact | undefined {
    return Array.from(this.contacts.values())
      .find(c => c.platformId === platformId && (!platform || c.platform === platform));
  }

  /** 名前検索 */
  search(query: string): Contact[] {
    const q = query.toLowerCase();
    return Array.from(this.contacts.values())
      .filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.displayName.toLowerCase().includes(q) ||
        c.tags.some(t => t.toLowerCase().includes(q)) ||
        c.notes?.toLowerCase().includes(q)
      )
      .sort((a, b) => b.contactCount - a.contactCount);
  }

  /** お気に入り */
  toggleFavorite(id: string): boolean {
    const c = this.contacts.get(id);
    if (!c) return false;
    c.favorite = !c.favorite;
    this.save();
    return true;
  }

  /** ブロック */
  toggleBlock(id: string): boolean {
    const c = this.contacts.get(id);
    if (!c) return false;
    c.blocked = !c.blocked;
    this.save();
    return true;
  }

  /** 削除 */
  deleteContact(id: string): boolean {
    const existed = this.contacts.delete(id);
    if (existed) this.save();
    return existed;
  }

  // ==================== グループ ====================

  createGroup(name: string, description?: string): Group {
    const id = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const group: Group = { id, name, description: description || "", memberIds: [], createdAt: Date.now() };
    this.groups.set(id, group);
    this.save();
    return group;
  }

  addToGroup(groupId: string, contactId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (!group.memberIds.includes(contactId)) {
      group.memberIds.push(contactId);
      this.save();
    }
    return true;
  }

  removeFromGroup(groupId: string, contactId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.memberIds = group.memberIds.filter(id => id !== contactId);
    this.save();
    return true;
  }

  listGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  // ==================== 一覧 ====================

  listContacts(filter?: { favorite?: boolean; blocked?: boolean; group?: string }): Contact[] {
    let results = Array.from(this.contacts.values());
    if (filter?.favorite) results = results.filter(c => c.favorite);
    if (filter?.blocked) results = results.filter(c => c.blocked);
    if (filter?.group) results = results.filter(c => c.groups.includes(filter.group!));
    return results.sort((a, b) => b.lastContact - a.lastContact);
  }

  getStats(): { total: number; favorite: number; blocked: number; groups: number } {
    const all = Array.from(this.contacts.values());
    return {
      total: all.length,
      favorite: all.filter(c => c.favorite).length,
      blocked: all.filter(c => c.blocked).length,
      groups: this.groups.size,
    };
  }

  // ==================== フォーマット ====================

  formatContacts(list: Contact[]): string {
    if (list.length === 0) return "👤 連絡先はありません。";

    return [
      "👤 **連絡先一覧**",
      "",
      ...list.map(c => {
        const fav = c.favorite ? "⭐ " : "";
        const blk = c.blocked ? "🚫 " : "";
        const tagStr = c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
        const groupStr = c.groups.length > 0 ? ` (${c.groups.join(", ")})` : "";
        const count = c.contactCount > 1 ? ` ${c.contactCount}回` : "";
        return `${fav}${blk}**${c.displayName}** (@${c.name})${tagStr}${groupStr}${count}`;
      }),
      "",
      `合計: ${list.length}人`,
    ].join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const contactManager = new ContactManager(DATA_DIR);
