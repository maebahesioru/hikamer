// ==========================================
// Hikamer - スキルローダー（Hermes Agent + OpenHuman由来）
// data/skills/*/SKILL.md を動的ロードしてコンテキスト注入
// ==========================================

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const SKILLS_DIR = resolve(DATA_DIR, "skills");

// ==================== 型定義 ====================

export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  author?: string;
  userInvokable: boolean;
  requiresEnv?: string[];
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

// ==================== YAML簡易パーサー ====================

function parseYamlFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const lines = text.split("\n");
  const meta: Record<string, unknown> = {};
  let bodyStart = 0;

  if (lines[0]?.trim() !== "---") {
    return { meta, body: text };
  }

  let inFrontmatter = true;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      bodyStart = i + 1;
      break;
    }
    const colonIdx = lines[i]!.indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i]!.slice(0, colonIdx).trim();
      const val = lines[i]!.slice(colonIdx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        // 配列
        meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/["']/g, ""));
      } else if (val === "true" || val === "false") {
        meta[key] = val === "true";
      } else {
        meta[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  return { meta, body };
}

// ==================== スキル管理 ====================

class SkillLoader {
  private skills = new Map<string, Skill>();

  /** スキルディレクトリをスキャンしてロード */
  loadAll(): void {
    if (!existsSync(SKILLS_DIR)) {
      mkdirSync(SKILLS_DIR, { recursive: true });
      logger.info(`スキルディレクトリ作成: ${SKILLS_DIR}`);
      return;
    }

    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const skillPath = resolve(SKILLS_DIR, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      try {
        const skill = this.loadSkill(skillPath);
        if (skill) {
          this.skills.set(skill.meta.name, skill);
          count++;
        }
      } catch (e: any) {
        logger.warn(`スキル読み込み失敗: ${entry.name} — ${e.message}`);
      }
    }

    if (count > 0) logger.info(`スキル読み込み: ${count}件`);
  }

  private loadSkill(path: string): Skill | null {
    const content = readFileSync(path, "utf-8");
    const { meta: rawMeta, body } = parseYamlFrontmatter(content);

    const name = String(rawMeta.name || "").trim();
    if (!name) return null;

    const meta: SkillMeta = {
      name,
      description: String(rawMeta.description || rawMeta.desc || "").trim(),
      version: String(rawMeta.version || "").trim() || undefined,
      tags: Array.isArray(rawMeta.tags) ? rawMeta.tags as string[] : undefined,
      author: String(rawMeta.author || "").trim() || undefined,
      userInvokable: rawMeta.user_invokable !== false,
      requiresEnv: rawMeta.requires_env ? (rawMeta.requires_env as string[]) : undefined,
    };

    // 環境変数チェック
    if (meta.requiresEnv) {
      for (const key of meta.requiresEnv) {
        if (!process.env[key]) {
          logger.debug(`スキルスキップ ${name}: 環境変数 ${key} 未設定`);
          return null;
        }
      }
    }

    return { meta, body, path };
  }

  /** 全スキル一覧 */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** 名前でスキル検索 */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** ユーザーが呼び出し可能なスキル一覧 */
  listInvokable(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.meta.userInvokable);
  }

  /** テキスト内の@skill-name を解決して注入ブロック生成 */
  injectMentions(text: string): { text: string; injected: string[] } {
    const mentionPattern = /@([\w-]+)/g;
    const injected: string[] = [];
    let match: RegExpExecArray | null;
    const mentions = new Set<string>();

    while ((match = mentionPattern.exec(text)) !== null) {
      mentions.add(match[1]!);
    }

    let result = text;

    for (const name of mentions) {
      const skill = this.skills.get(name);
      if (skill) {
        injected.push(name);
        // @mention をスキル本文で置き換え
        const injectBlock = `\n[SKILL:${name}]\n${skill.body.slice(0, 4000)}\n[/SKILL]\n`;
        result = result.replace(new RegExp(`@${name}`, "g"), injectBlock);
      }
    }

    return { text: result, injected };
  }
}

export const skillLoader = new SkillLoader();

// 起動時に自動ロード
skillLoader.loadAll();
