// ==========================================
// Hikamer - セッションキュレーター（Hermes Agent curator.py 由来）
// セッションの自動整理・タグ付け・アーカイブ
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface SessionGroup {
  id: string;
  name: string;
  description: string;
  sessionIds: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CuratorRule {
  name: string;
  description: string;
  condition: (session: { id: string; tags: string[]; turnCount: number; ageMs: number }) => boolean;
  action: "tag" | "archive" | "group" | "delete";
  actionParam: string;
  enabled: boolean;
}

export interface CuratorStats {
  totalSessions: number;
  groups: number;
  archived: number;
  rules: number;
  tagsInUse: string[];
}

// ==================== キュレーター ====================

class Curator {
  private groups: SessionGroup[] = [];
  private rules: CuratorRule[] = [];
  private sessionTags: Map<string, string[]> = new Map();
  private archivedSessions: Set<string> = new Set();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.loadDefaultRules();
    this.initialized = true;
    logger.info("[Curator] initialized");
  }

  /** セッションにタグを追加 */
  tagSession(sessionId: string, tags: string[]): void {
    const existing = this.sessionTags.get(sessionId) ?? [];
    this.sessionTags.set(sessionId, [...new Set([...existing, ...tags])]);
  }

  /** セッションのタグを取得 */
  getSessionTags(sessionId: string): string[] {
    return this.sessionTags.get(sessionId) ?? [];
  }

  /** グループを作成 */
  createGroup(name: string, description?: string): SessionGroup {
    const group: SessionGroup = {
      id: `group-${Date.now()}`,
      name,
      description: description ?? "",
      sessionIds: [],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.groups.push(group);
    return group;
  }

  /** セッションをグループに追加 */
  addToGroup(groupId: string, sessionId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;
    if (!group.sessionIds.includes(sessionId)) {
      group.sessionIds.push(sessionId);
      group.updatedAt = Date.now();
    }
    return true;
  }

  /** セッションをアーカイブ */
  archiveSession(sessionId: string): void {
    this.archivedSessions.add(sessionId);
    logger.debug(`[Curator] archived session ${sessionId.slice(0, 12)}...`);
  }

  /** セッションを復元 */
  unarchiveSession(sessionId: string): boolean {
    return this.archivedSessions.delete(sessionId);
  }

  /** ルールに基づいて自動処理 */
  applyRules(sessions: Array<{
    id: string; tags: string[]; turnCount: number; ageMs: number;
  }>): Array<{ sessionId: string; action: string; ruleName: string }> {
    const actions: Array<{ sessionId: string; action: string; ruleName: string }> = [];

    for (const session of sessions) {
      for (const rule of this.rules) {
        if (!rule.enabled) continue;
        try {
          if (rule.condition(session)) {
            switch (rule.action) {
              case "tag":
                this.tagSession(session.id, [rule.actionParam]);
                break;
              case "archive":
                this.archiveSession(session.id);
                break;
              case "group": {
                let group = this.groups.find((g) => g.name === rule.actionParam);
                if (!group) group = this.createGroup(rule.actionParam);
                this.addToGroup(group.id, session.id);
                break;
              }
            }
            actions.push({
              sessionId: session.id,
              action: `${rule.action}:${rule.actionParam}`,
              ruleName: rule.name,
            });
          }
        } catch {}
      }
    }

    return actions;
  }

  /** ルールを追加 */
  addRule(rule: CuratorRule): void {
    this.rules.push(rule);
  }

  /** ルール一覧 */
  listRules(): CuratorRule[] {
    return [...this.rules];
  }

  /** グループ一覧 */
  listGroups(): SessionGroup[] {
    return [...this.groups];
  }

  /** アーカイブ一覧 */
  getArchivedSessions(): string[] {
    return Array.from(this.archivedSessions);
  }

  /** 統計 */
  getStats(): CuratorStats {
    const allTags = new Set<string>();
    for (const tags of this.sessionTags.values()) {
      for (const tag of tags) allTags.add(tag);
    }
    return {
      totalSessions: this.sessionTags.size,
      groups: this.groups.length,
      archived: this.archivedSessions.size,
      rules: this.rules.length,
      tagsInUse: Array.from(allTags),
    };
  }

  private loadDefaultRules(): void {
    this.addRule({
      name: "archive-old",
      description: "24時間以上前のセッションをアーカイブ",
      condition: (s) => s.ageMs > 86400000,
      action: "archive",
      actionParam: "auto",
      enabled: true,
    });
    this.addRule({
      name: "tag-empty",
      description: "会話の少ないセッションにタグ",
      condition: (s) => s.turnCount <= 2,
      action: "tag",
      actionParam: "brief",
      enabled: true,
    });
  }

  formatStats(): string {
    const s = this.getStats();
    return (
      `📚 **セッションキュレーター**\n` +
      `管理セッション: ${s.totalSessions}\n` +
      `グループ: ${s.groups}\n` +
      `アーカイブ: ${s.archived}\n` +
      `ルール: ${s.rules}\n` +
      `タグ: ${s.tagsInUse.join(", ") || "なし"}`
    );
  }
}

// ==================== シングルトン ====================

export const curator = new Curator();

export default Curator;
