// ==========================================
// Aikata - スキルシステム（OpenClaw .agents/skills/ 由来）
// SKILL.md形式のスキル定義・自動発見・実行
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface SkillDefinition {
  name: string;
  description: string;
  category: string;
  version: string;
  author?: string;
  triggers: string[];
  tools: string[];
  prompt: string;
  scripts: string[];
  references: string[];
  enabled: boolean;
  /** アンチ合理化テーブル：AIがよく使う言い訳とその現実 */
  rationalizations: { rationalization: string; reality: string }[];
  /** 検証ゲート：スキル実行後の確認項目（全項目満たす必要あり） */
  verification: string[];
  /** レッドフラグ：危険シグナル（1つでも発火したら即時停止＝Stop The Line） */
  redFlags: string[];
}

export interface SkillFile {
  path: string;
  name: string;
  type: "skill.md" | "agent.yaml" | "script" | "reference";
  content: string;
  loaded: boolean;
}

/** スキル実行の検証結果 */
export interface ValidationResult {
  passed: boolean;
  failures: string[];
  redFlagsTriggered: string[];
  /** Stop The Line: レッドフラグ発火で即時停止が必要 */
  stopTheLine: boolean;
}

// ==================== スキルシステム ====================

class SkillSystem {
  private skills: Map<string, SkillDefinition> = new Map();
  private skillDirs: string[] = [];
  private initialized = false;

  // デフォルトスキルディレクトリ
  private readonly DEFAULT_SKILL_DIRS = [
    "./skills",
    "./.agents/skills",
    process.env.HOME ? path.join(process.env.HOME, ".aikata", "skills") : "",
  ].filter(Boolean);

  init(): void {
    if (this.initialized) return;
    this.skillDirs.push(...this.DEFAULT_SKILL_DIRS);
    this.discoverSkills();
    this.initialized = true;
    logger.info(`[Skills] initialized: ${this.skills.size} skills`);
  }

  /** スキルを発見 */
  discoverSkills(): number {
    let found = 0;
    for (const dir of this.skillDirs) {
      if (!fs.existsSync(dir)) continue;
      found += this.scanDirectory(dir);
    }
    return found;
  }

  /** スキルを手動登録 */
  registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    logger.info(`[Skills] registered: ${skill.name}`);
  }

  /** スキルを検索 */
  findSkill(nameOrTrigger: string): SkillDefinition | undefined {
    // 名前で検索
    const byName = this.skills.get(nameOrTrigger);
    if (byName) return byName;

    // トリガーで検索
    const byTrigger = this.findByTrigger(nameOrTrigger);
    if (byTrigger) return byTrigger;

    return undefined;
  }

  /** トリガーにマッチするスキルを検索 */
  findByTrigger(input: string): SkillDefinition | undefined {
    const lower = input.toLowerCase();
    for (const skill of this.skills.values()) {
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) return skill;
      }
    }
    return undefined;
  }

  /** カテゴリ別のスキル一覧 */
  listSkills(category?: string): SkillDefinition[] {
    const all = Array.from(this.skills.values());
    return category
      ? all.filter((s) => s.category === category)
      : all;
  }

  /** カテゴリ一覧 */
  listCategories(): string[] {
    return [...new Set(Array.from(this.skills.values()).map((s) => s.category))];
  }

  /** スキルディレクトリを追加 */
  addSkillDir(dir: string): void {
    if (!this.skillDirs.includes(dir)) {
      this.skillDirs.push(dir);
      this.scanDirectory(dir);
    }
  }

  /** SKILL.mdを解析 */
  parseSkillMd(content: string, filePath: string): Partial<SkillDefinition> {
    const skill: Partial<SkillDefinition> = {
      name: path.basename(path.dirname(filePath)),
      description: "",
      category: "general",
      version: "1.0.0",
      triggers: [],
      tools: [],
      prompt: "",
      scripts: [],
      references: [],
      enabled: true,
      rationalizations: [],
      verification: [],
      redFlags: [],
    };

    // YAML frontmatter解析
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1]!;
      const body = frontmatterMatch[2]!;

      // 簡易YAML解析
      const lines = frontmatter.split("\n");
      for (const line of lines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");

        switch (key) {
          case "name": skill.name = value; break;
          case "description": skill.description = value; break;
          case "category": skill.category = value; break;
          case "version": skill.version = value; break;
          case "author": skill.author = value; break;
          case "triggers": skill.triggers = value.split(",").map((s) => s.trim()); break;
          case "tools": skill.tools = value.split(",").map((s) => s.trim()); break;
          case "verification": skill.verification = value.split(",").map((s) => s.trim()); break;
          case "redFlags": skill.redFlags = value.split(",").map((s) => s.trim()); break;
          case "rationalizations":
            try {
              skill.rationalizations = JSON.parse(value);
            } catch {
              skill.rationalizations = [];
            }
            break;
        }
      }

      skill.prompt = body.trim();
    }

    return skill;
  }

  // ==================== 検証・安全 ====================

  /** スキル実行結果を検証（検証ゲート＋レッドフラグ） */
  validateSkillExecution(name: string, output: string): ValidationResult {
    const skill = this.skills.get(name);
    const result: ValidationResult = {
      passed: true,
      failures: [],
      redFlagsTriggered: [],
      stopTheLine: false,
    };

    if (!skill) {
      result.passed = false;
      result.failures.push(`スキル "${name}" が見つかりません`);
      return result;
    }

    // レッドフラグチェック（Stop The Line）
    result.redFlagsTriggered = this.checkRedFlags(name, output);
    if (result.redFlagsTriggered.length > 0) {
      result.stopTheLine = true;
      result.passed = false;
      result.failures.push(
        `🚨 Stop The Line: ${result.redFlagsTriggered.length}件のレッドフラグが発火しました`
      );
      logger.warn(
        `[Skills] Stop The Line: "${name}" red flags: ${result.redFlagsTriggered.join(", ")}`
      );
      return result;
    }

    // 検証ゲートチェック
    if (skill.verification.length > 0) {
      const lowerOutput = output.toLowerCase();
      for (const check of skill.verification) {
        if (!lowerOutput.includes(check.toLowerCase())) {
          result.passed = false;
          result.failures.push(`検証未完了: "${check}"`);
        }
      }
    }

    if (!result.passed) {
      logger.warn(
        `[Skills] validation failed for "${name}": ${result.failures.join("; ")}`
      );
    }

    return result;
  }

  /** レッドフラグをチェック（1つでもマッチしたら即時停止対象） */
  checkRedFlags(name: string, output: string): string[] {
    const skill = this.skills.get(name);
    if (!skill || skill.redFlags.length === 0) return [];

    const lowerOutput = output.toLowerCase();
    return skill.redFlags.filter((flag) =>
      lowerOutput.includes(flag.toLowerCase())
    );
  }

  /** アンチ合理化コンテキストを生成（システムプロンプト注入用） */
  getAntiRationalizationContext(skillName?: string): string {
    const skills = skillName
      ? [this.skills.get(skillName)].filter(Boolean) as SkillDefinition[]
      : Array.from(this.skills.values());

    const relevant = skills.filter((s) => s.rationalizations.length > 0);
    if (relevant.length === 0) return "";

    const parts: string[] = [];
    for (const skill of relevant) {
      const table = skill.rationalizations
        .map(
          (r) =>
            `  ❌ 「${r.rationalization}」\n  ✅ 実際: ${r.reality}`
        )
        .join("\n");

      parts.push(
        `### ${skill.name}\n${table}`
      );
    }

    return (
      "⚠️ **アンチ合理化ガード**\n" +
      "以下の言い訳パターンが検出された場合、それは誤った合理化です：\n\n" +
      parts.join("\n\n")
    );
  }

  // ---- 内部 ----

  private scanDirectory(dir: string): number {
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(dir, entry.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");

        if (fs.existsSync(skillMdPath)) {
          try {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            const parsed = this.parseSkillMd(content, skillMdPath);

            if (parsed.name && parsed.prompt) {
              // スクリプトと参照をスキャン
              const scriptsDir = path.join(skillDir, "scripts");
              const refsDir = path.join(skillDir, "references");
              const agentsDir = path.join(skillDir, "agents");

              if (fs.existsSync(scriptsDir)) {
                parsed.scripts = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".sh") || f.endsWith(".mjs") || f.endsWith(".py"));
              }
              if (fs.existsSync(refsDir)) {
                parsed.references = fs.readdirSync(refsDir);
              }

              this.skills.set(parsed.name, parsed as SkillDefinition);
              count++;
            }
          } catch {}
        }
      }
    } catch {}
    return count;
  }

  formatSkills(category?: string): string {
    const skills = this.listSkills(category);
    if (skills.length === 0) return "📭 スキルがありません";

    const categories = category ? [category] : this.listCategories();
    const parts: string[] = [];

    for (const cat of categories) {
      const catSkills = skills.filter((s) => s.category === cat);
      if (catSkills.length === 0) continue;
      parts.push(
        `**${cat}** (${catSkills.length})\n` +
        catSkills
          .map(
            (s) =>
              `${s.enabled ? "✅" : "⛔"} **${s.name}**: ${s.description.slice(0, 60)}` +
              (s.triggers.length > 0 ? ` [${s.triggers.join(", ")}]` : "")
          )
          .join("\n")
      );
    }

    return `📋 **スキル一覧 (${skills.length})**\n\n${parts.join("\n\n")}`;
  }
}

// ==================== シングルトン ====================

export const skillSystem = new SkillSystem();

export default SkillSystem;
