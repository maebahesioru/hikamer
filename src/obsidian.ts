// ==========================================
// Hikamer - Obsidian/ノート統合（OpenHuman memory/Obsidian由来）
// Obsidian Vaultの読み書き・ノート管理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname, basename, extname, join } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface Note {
  path: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];     // [[wikilinks]]
  createdAt: Date;
  updatedAt: Date;
  frontmatter: Record<string, any>;
}

export interface VaultConfig {
  path: string;
  name: string;
  autoSync: boolean;
}

// ==================== Obsidian Vault操作 ====================

class ObsidianVault {
  private vaultPath: string;
  private vaultName: string;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath || process.env.OBSIDIAN_VAULT || "";
    this.vaultName = basename(resolve(this.vaultPath)) || "obsidian";
  }

  /** Vaultが利用可能か */
  isAvailable(): boolean {
    if (!this.vaultPath) return false;
    return existsSync(resolve(this.vaultPath, ".obsidian"));
  }

  /** 利用可能なVault情報 */
  getInfo(): { available: boolean; path: string; name: string; noteCount: number } {
    let noteCount = 0;
    if (this.isAvailable()) {
      noteCount = this.scanNotes().length;
    }
    return { available: this.isAvailable(), path: this.vaultPath, name: this.vaultName, noteCount };
  }

  /** ノートを読む */
  readNote(notePath: string): Note | null {
    const fullPath = resolve(this.vaultPath, notePath);
    if (!existsSync(fullPath)) return null;

    try {
      const content = readFileSync(fullPath, "utf-8");
      const parsed = this.parseNote(content, notePath);
      return parsed;
    } catch (e: any) {
      logger.warn(`[Obsidian] 読込失敗: ${notePath} — ${e.message}`);
      return null;
    }
  }

  /** ノートを書く */
  writeNote(notePath: string, content: string, frontmatter?: Record<string, any>): boolean {
    const fullPath = resolve(this.vaultPath, notePath);

    // .md拡張子自動付与
    const finalPath = notePath.endsWith(".md") ? fullPath : `${fullPath}.md`;

    try {
      const dir = dirname(finalPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let fullContent = content;
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        const yaml = Object.entries(frontmatter)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
        fullContent = `---\n${yaml}\n---\n\n${content}`;
      }

      writeFileSync(finalPath, fullContent, "utf-8");
      logger.info(`[Obsidian] 書込: ${notePath}`);
      return true;
    } catch (e: any) {
      logger.error(`[Obsidian] 書込失敗: ${notePath} — ${e.message}`);
      return false;
    }
  }

  /** ノートを検索 */
  searchNotes(query: string): Note[] {
    const notes = this.scanNotes();
    const q = query.toLowerCase();
    return notes
      .filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some(t => t.toLowerCase().includes(q))
      )
      .slice(0, 20);
  }

  /** タグ検索 */
  findByTag(tag: string): Note[] {
    const notes = this.scanNotes();
    return notes.filter(n => n.tags.includes(tag)).slice(0, 20);
  }

  /** 全ノートスキャン */
  scanNotes(): Note[] {
    if (!this.isAvailable()) return [];

    const notes: Note[] = [];
    const scanDir = (dir: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "_resources") {
              scanDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const relativePath = fullPath.replace(this.vaultPath, "").replace(/^\//, "");
            try {
              const content = readFileSync(fullPath, "utf-8");
              const parsed = this.parseNote(content, relativePath);
              notes.push(parsed);
            } catch {}
          }
        }
      } catch {}
    };

    scanDir(this.vaultPath);
    return notes;
  }

  /** ノートパース */
  private parseNote(content: string, notePath: string): Note {
    const title = basename(notePath, ".md").replace(/[-_]/g, " ");
    let body = content;
    let frontmatter: Record<string, any> = {};

    // Frontmatter抽出
    if (body.startsWith("---")) {
      const endIdx = body.indexOf("---", 3);
      if (endIdx !== -1) {
        const yamlStr = body.slice(3, endIdx).trim();
        body = body.slice(endIdx + 3).trim();

        // 簡易YAMLパース
        for (const line of yamlStr.split("\n")) {
          const colonIdx = line.indexOf(":");
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
            frontmatter[key] = value;
          }
        }
      }
    }

    // タグ抽出
    const tags: string[] = [];
    const tagRegex = /#([\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF/-]+)/g;
    let match;
    while ((match = tagRegex.exec(body)) !== null) {
      tags.push(match[1]!);
    }

    // ウィキリンク抽出
    const links: string[] = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    while ((match = linkRegex.exec(body)) !== null) {
      links.push(match[1]!);
    }

    // stat
    let stat;
    try { stat = require("fs").statSync(resolve(this.vaultPath, notePath)); } catch {}

    return {
      path: notePath,
      title,
      content: body,
      tags: Array.from(new Set(tags)),
      links: Array.from(new Set(links)),
      createdAt: stat?.birthtime || new Date(),
      updatedAt: stat?.mtime || new Date(),
      frontmatter,
    };
  }

  /** ノート作成 */
  createNote(title: string, content: string, tags?: string[]): string {
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100);
    const notePath = `${safeTitle}.md`;

    const frontmatter: Record<string, any> = {
      created: new Date().toISOString().slice(0, 10),
    };
    if (tags && tags.length > 0) frontmatter.tags = tags.join(", ");

    this.writeNote(notePath, content, frontmatter);
    return notePath;
  }

  /** フォーマット */
  formatNotes(notes: Note[]): string {
    if (notes.length === 0) return "📓 該当するノートはありません。";

    return [
      `📓 **${this.vaultName} — ノート一覧** (${notes.length}件)`,
      "",
      ...notes.map(n => {
        const tagStr = n.tags.length > 0 ? ` [${n.tags.slice(0, 3).join(", ")}]` : "";
        const date = n.updatedAt.toLocaleDateString("ja-JP");
        const preview = n.content.replace(/^#{1,6}\s+/gm, "").slice(0, 60).replace(/\n/g, " ");
        return `• **${n.title}** ${date}${tagStr}\n  ${preview}…`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const obsidianVault = new ObsidianVault();
