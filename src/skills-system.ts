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

/** Chesterton's Fenceによるコード削除の品質チェック結果 */
export interface QualityCheckResult {
  safe: boolean;
  questions: string[];
  recommendation: string;
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
    this.registerBuiltinSkills();
    this.initialized = true;
    logger.info(`[Skills] initialized: ${this.skills.size} skills`);
  }

  /** 組み込みスキルを自動登録（doubt-driven-development, chestertons-fence） */
  private registerBuiltinSkills(): void {
    // ── doubt-driven-development ──
    this.registerSkill({
      name: "doubt-driven-development",
      description:
        "CLAIM→EXTRACT→DOUBT→RECONCILE→STOP: adversarially challenge every claim before acting",
      category: "safety",
      version: "1.0.0",
      author: "Aikata",
      triggers: [
        "doubt", "verify", "double-check", "skeptical",
        "challenge assumption", "fact check",
      ],
      tools: [],
      prompt: `You are in DOUBT-DRIVEN DEVELOPMENT mode. Follow this process strictly:

## Process
1. **CLAIM** – State what you're about to do or what you believe to be true.
2. **EXTRACT** – Find the evidence. Where did this claim come from? Code, docs, tests, or assumption?
3. **DOUBT** – Adversarially challenge every claim. Assume it's wrong and try to prove it.
4. **RECONCILE** – Resolve any doubts found. Can you verify the claim with independent evidence?
5. **STOP** – If any doubt remains unresolved, escalate to human. Do NOT proceed with uncertainty.

## Critical Rules
- Never accept your own output as ground truth.
- Evidence must be verifiable and independent, not self-referential.
- If you cannot find evidence for a claim, mark it UNVERIFIED.
- Small errors compound catastrophically in agentic loops — doubt even the trivial.`,
      scripts: [],
      references: [],
      enabled: true,
      rationalizations: [
        {
          rationalization: "It's probably fine",
          reality: "Probability is not verification. Either it IS verified or it is NOT.",
        },
        {
          rationalization: "This is too small to doubt",
          reality: "Small errors compound catastrophically in agentic loops.",
        },
        {
          rationalization: "I already checked that",
          reality: "Self-verification is not verification. Independent evidence required.",
        },
        {
          rationalization: "The tests pass so it's correct",
          reality: "Tests passing means tests pass. It does not mean correctness for all inputs.",
        },
      ],
      verification: [
        "All claims have cited evidence",
        "Doubt phase completed before action",
        "Unresolved doubts escalated to human",
      ],
      redFlags: [
        "confidence without evidence",
        "skipping doubt phase",
        "accepting own output as ground truth",
        "proceeding without verification",
        "rationalizing away a concern",
      ],
    });

    // ── chestertons-fence ──
    this.registerSkill({
      name: "chestertons-fence",
      description:
        "Chesterton's Fence: answer 6 questions before removing/modifying existing code. Never remove what you don't understand.",
      category: "safety",
      version: "1.0.0",
      author: "Aikata",
      triggers: [
        "refactor", "remove", "delete", "clean up", "simplify",
        "modernize", "rewrite", "deprecate", "get rid of",
      ],
      tools: [],
      prompt: `You are at CHESTERTON'S FENCE. Before removing or modifying any existing code, structure, or pattern, answer these 6 questions:

## The 6 Questions
1. **Why was this built?** – What was the original purpose?
2. **What problem did it solve?** – What specific issue did it address?
3. **Is that problem still real?** – Has the underlying need actually disappeared?
4. **What depends on this?** – Direct callers, indirect consumers, configs, docs, external systems.
5. **Could the apparent inefficiency be intentional?** – Performance tradeoffs, edge-case handling, backward compatibility.
6. **What's the blast radius?** – If removal goes wrong, what breaks? How fast can you detect it?

## Rules
- Apparent unnecessary complexity often hides real constraints you have not yet discovered.
- If there are no tests for what you're about to change, **add tests first**.
- If you cannot answer all 6 questions, **STOP and research** before touching anything.
- Document your answers before making changes.`,
      scripts: [],
      references: [],
      enabled: true,
      rationalizations: [
        {
          rationalization: "This looks unnecessary",
          reality: "Apparent unnecessary complexity often hides real constraints. Complexity is a signal, not always waste.",
        },
        {
          rationalization: "I'll refactor it",
          reality: "Refactor only if tests exist for the current behavior. If tests are missing, add them first.",
        },
        {
          rationalization: "Nobody uses this anymore",
          reality: "Assume nothing. Verify with actual usage data, git blame, and dependency analysis.",
        },
        {
          rationalization: "I can always revert if it breaks",
          reality: "Reverting after production breakage is not acceptable. Verify before, not after.",
        },
      ],
      verification: [
        "All 6 questions answered with evidence",
        "Blast radius documented",
        "Tests exist for current behavior",
        "Dependencies analyzed",
      ],
      redFlags: [
        "removing code without understanding it",
        "assuming something is unused without verification",
        "refactoring without test coverage",
        "dismissing complexity as unnecessary",
      ],
    });

    logger.info("[Skills] registered 2 built-in safety skills (doubt-driven-development, chestertons-fence)");
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

  /** Chesterton's Fenceによるコード削除前の品質チェック */
  qualityCheckCodeRemoval(target: string, reason: string): QualityCheckResult {
    const questions: string[] = [
      `Why was "${target}" built? What was its original purpose?`,
      `What problem did "${target}" solve?`,
      `Is that problem still real? (Stated reason: "${reason}")`,
      `What depends on "${target}"? (direct callers, indirect consumers, configs, docs, external systems)`,
      `Could the apparent inefficiency in "${target}" be intentional?`,
      `What's the blast radius if removal of "${target}" goes wrong?`,
    ];

    // ヒューリスティック: 理由に不確実な表現が含まれていないか
    const reasonLower = reason.toLowerCase();
    const redFlags: string[] = [];

    const uncertaintyPatterns = [
      { pattern: "probably", msg: "Reason contains 'probably' — verify with evidence, not probability." },
      { pattern: "seems", msg: "Reason contains 'seems' — impressions are not verification." },
      { pattern: "looks like", msg: "Reason contains 'looks like' — appearances can be deceiving." },
      { pattern: "maybe", msg: "Reason contains 'maybe' — uncertainty is a red flag for code removal." },
      { pattern: "i think", msg: "Reason contains 'I think' — verify with data, not hunches." },
      { pattern: "just", msg: "Reason minimizes complexity with 'just'. Apparent simplicity may hide real constraints." },
      { pattern: "simply", msg: "Reason minimizes complexity with 'simply'. Chesterton's Fence: understand before removing." },
      { pattern: "easy", msg: "Reason calls this 'easy'. Easy to remove does not mean safe to remove." },
    ];

    for (const { pattern, msg } of uncertaintyPatterns) {
      if (reasonLower.includes(pattern)) {
        redFlags.push(msg);
      }
    }

    const safe = redFlags.length === 0;

    const recommendation = safe
      ? `Proceed with caution. Answer all 6 Chesterton's Fence questions before touching "${target}". ` +
        `Verify dependencies and add tests for current behavior first.`
      : `⚠️ STOP: ${redFlags.join(" ")} ` +
        `Research "${target}" thoroughly before removal. The stated reason may rationalize away real complexity.`;

    return { safe, questions, recommendation };
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
