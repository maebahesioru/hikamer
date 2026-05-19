// ==========================================
// Aikata - 移行ツール v1
// openclaw / hermes-agent / openhuman → Aikata
// スキル・メモリ・設定のインポート
// ==========================================

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { resolve, join, basename, dirname, extname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface MigrationReport {
  source: string;
  skills: { total: number; imported: number; skipped: number; errors: string[] };
  memory: { imported: boolean; warnings: string[] };
  config: { sections: string[]; warnings: string[] };
  cron: { total: number; imported: number; skipped: number };
  durationMs: number;
}

export type MigrationSource = "openclaw" | "hermes-agent" | "openhuman" | "auto";

// ==================== スキル移行 ====================

/**
 * 外部フレームワークのskills/ディレクトリからAikataのskills/にSKILL.mdをインポート。
 * 
 * openclaw: ~/.openclaw/skills/<name>/SKILL.md → Aikata ./skills/<name>/SKILL.md
 * hermes-agent: ~/.hermes/skills/<name>/SKILL.md → Aikata ./skills/<name>/SKILL.md
 * 
 * 互換性: 全フレームワークが YAML frontmatter + Markdown body の同一フォーマット。
 * Aikataパーサーは未知のfrontmatterキーを無視するため、そのまま読める。
 */
export function migrateSkills(
  sourceDir: string,
  targetDir: string = "./skills",
  options?: { overwrite?: boolean; dryRun?: boolean },
): { total: number; imported: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  let imported = 0;
  let skipped = 0;

  if (!existsSync(sourceDir)) {
    errors.push(`Source directory not found: ${sourceDir}`);
    return { total, imported, skipped, errors };
  }

  if (!options?.dryRun && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(sourceDir, entry.name);
      const skillMdPath = join(skillDir, "SKILL.md");

      if (!existsSync(skillMdPath)) continue;
      total++;

      const targetSkillDir = join(targetDir, entry.name);
      const targetSkillMdPath = join(targetSkillDir, "SKILL.md");

      if (existsSync(targetSkillMdPath) && !options?.overwrite) {
        skipped++;
        continue;
      }

      if (!options?.dryRun) {
        // SKILL.md をコピー
        if (!existsSync(targetSkillDir)) mkdirSync(targetSkillDir, { recursive: true });
        copyFileSync(skillMdPath, targetSkillMdPath);

        // scripts/ と references/ があればコピー
        for (const sub of ["scripts", "references", "agents"]) {
          const subSrc = join(skillDir, sub);
          const subDst = join(targetSkillDir, sub);
          if (existsSync(subSrc)) {
            if (!existsSync(subDst)) mkdirSync(subDst, { recursive: true });
            const files = readdirSync(subSrc);
            for (const f of files) {
              copyFileSync(join(subSrc, f), join(subDst, f));
            }
          }
        }
      }

      imported++;
    }
  } catch (err) {
    errors.push(`Skill migration error: ${String(err)}`);
  }

  logger.info(`[Migration] Skills: ${imported} imported, ${skipped} skipped, ${total} total`);
  return { total, imported, skipped, errors };
}

// ==================== メモリ移行 ====================

/**
 * 外部フレームワークのメモリファイルをAikata形式にインポート。
 * 
 * hermes-agent: ~/.hermes/memory/MEMORY.md → Aikata ./data/memory/MEMORY.md
 * openclaw: ~/.openclaw/MEMORY.md → Aikata ./data/memory/MEMORY.md
 * 
 * 互換性: MEMORY.md と USER.md は全フレームワークで同一フォーマット。
 * § 区切り、プレーンMarkdown。ゼロ変換でそのまま使える。
 */
export function migrateMemory(
  sourceDir: string,
  targetDir: string = "./data/memory",
  options?: { dryRun?: boolean },
): { imported: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (!existsSync(sourceDir)) {
    warnings.push(`Source memory directory not found: ${sourceDir}`);
    return { imported: false, warnings };
  }

  if (!options?.dryRun && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // 移行対象ファイルとそのデフォルト名
  const files: { src: string; dst: string; required: boolean }[] = [
    // hermes-agent: 正確に MEMORY.md / USER.md
    { src: join(sourceDir, "MEMORY.md"), dst: join(targetDir, "MEMORY.md"), required: false },
    { src: join(sourceDir, "USER.md"), dst: join(targetDir, "USER.md"), required: false },
    // openclaw: メモリディレクトリの場合
    { src: join(sourceDir, "memory", "MEMORY.md"), dst: join(targetDir, "MEMORY.md"), required: false },
    // openclaw: ルート直下
    { src: join(sourceDir, "MEMORY.md"), dst: join(targetDir, "MEMORY.md"), required: false },
    // openhuman: data/memory/ 内
    { src: join(sourceDir, "data", "memory", "MEMORY.md"), dst: join(targetDir, "MEMORY.md"), required: false },
  ];

  let imported = false;
  for (const { src, dst, required } of files) {
    if (existsSync(src)) {
      if (!options?.dryRun && !existsSync(dst)) {
        copyFileSync(src, dst);
        imported = true;
        logger.info(`[Migration] Memory: ${basename(src)} → ${dst}`);
      } else if (options?.dryRun) {
        imported = true;
      }
    } else if (required) {
      warnings.push(`Required memory file not found: ${src}`);
    }
  }

  // openclaw の daily notes (memory/YYYY-MM-DD.md) があればコピー
  const dailyDir = join(sourceDir, "memory");
  if (existsSync(dailyDir)) {
    try {
      const dailyFiles = readdirSync(dailyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
      const dailyTargetDir = join(targetDir, "daily");
      if (!options?.dryRun && dailyFiles.length > 0) {
        if (!existsSync(dailyTargetDir)) mkdirSync(dailyTargetDir, { recursive: true });
        for (const f of dailyFiles) {
          copyFileSync(join(dailyDir, f), join(dailyTargetDir, f));
        }
        logger.info(`[Migration] Daily notes: ${dailyFiles.length} files`);
      }
    } catch {}
  }

  return { imported, warnings };
}

// ==================== 設定移行 ====================

/**
 * hermes-agent の config.yaml から使える部分を抽出。
 * Aikataは providers.json + .env 形式のため、変換が必要。
 * 
 * 抽出可能な項目:
 * - models.provider.*.api_key → .env または providers.json
 * - models.provider.*.base_url → providers.json
 * - agent.* → .env (AGENT_MODEL等)
 * - searxng → .env (SEARXNG_URL)
 */
export function migrateHermesConfig(
  configPath: string,
  dryRun: boolean = false,
): { sections: string[]; warnings: string[] } {
  const sections: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(configPath)) {
    warnings.push(`Config not found: ${configPath}`);
    return { sections, warnings };
  }

  try {
    // 簡易YAMLパース（本格的にはjs-yamlが必要だが、依存を避ける）
    const raw = readFileSync(configPath, "utf-8");
    const extracted: Record<string, string> = {};

    // models.providers からプロバイダー情報を抽出
    const providerRegex = /^\s{2}(\w+):\s*$/m;
    const apiKeyRegex = /^\s{4}api_key:\s*(.+)$/m;
    const baseUrlRegex = /^\s{4}base_url:\s*(.+)$/m;

    // 簡易: 行ごとにパース
    const lines = raw.split("\n");
    let currentProvider = "";
    for (const line of lines) {
      const provMatch = line.match(/^\s{2}(\w+):\s*$/);
      if (provMatch) {
        currentProvider = provMatch[1]!;
        sections.push(`provider: ${currentProvider}`);
        continue;
      }

      if (currentProvider) {
        const apiKey = line.match(/^\s{4}api_key:\s*(.+)$/);
        if (apiKey) {
          extracted[`${currentProvider.toUpperCase()}_API_KEY`] = apiKey[1]!.replace(/["']/g, "");
          sections.push(`  api_key: ${currentProvider}`);
        }
        const baseUrl = line.match(/^\s{4}base_url:\s*(.+)$/);
        if (baseUrl) {
          extracted[`${currentProvider.toUpperCase()}_BASE_URL`] = baseUrl[1]!.replace(/["']/g, "");
          sections.push(`  base_url: ${currentProvider}`);
        }
      }

      // agent model
      const agentModel = line.match(/^agent_model:\s*(.+)$/);
      if (agentModel) {
        extracted["AGENT_MODEL"] = agentModel[1]!;
        sections.push(`agent_model: ${agentModel[1]}`);
      }

      // searxng
      const searxng = line.match(/^searxng_url:\s*(.+)$/);
      if (searxng) {
        extracted["SEARXNG_URL"] = searxng[1]!;
        sections.push(`searxng_url: ${searxng[1]}`);
      }
    }

    if (!dryRun && Object.keys(extracted).length > 0) {
      // .env に追記
      const envPath = "./.env";
      let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
      for (const [key, value] of Object.entries(extracted)) {
        if (!envContent.includes(`${key}=`)) {
          envContent += `\n${key}=${value}`;
        }
      }
      writeFileSync(envPath, envContent);
      logger.info(`[Migration] Config: ${Object.keys(extracted).length} entries → .env`);
    }
  } catch (err) {
    warnings.push(`Config migration error: ${String(err)}`);
  }

  return { sections, warnings };
}

/**
 * openclaw の config.json から使える部分を抽出。
 */
export function migrateOpenclawConfig(
  configPath: string,
  dryRun: boolean = false,
): { sections: string[]; warnings: string[] } {
  const sections: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(configPath)) {
    warnings.push(`Config not found: ${configPath}`);
    return { sections, warnings };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw);
    } catch {
      // JSON5の場合、簡易クリーニング
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")  // コメント除去
        .replace(/,\s*}/g, "}")    // 末尾カンマ
        .replace(/,\s*\]/g, "]");
      config = JSON.parse(cleaned);
    }

    // providers
    if (config.providers && typeof config.providers === "object") {
      for (const [key, val] of Object.entries(config.providers as Record<string, unknown>)) {
        if (val && typeof val === "object") {
          const p = val as Record<string, unknown>;
          if (p.apiKey) sections.push(`provider: ${key} (api_key found)`);
          if (p.baseUrl) sections.push(`  base_url: ${key}`);
        }
      }
    }

    // model
    if (config.model && typeof config.model === "string") {
      sections.push(`model: ${config.model}`);
    }
  } catch (err) {
    warnings.push(`OpenClaw config migration error: ${String(err)}`);
  }

  return { sections, warnings };
}

// ==================== Cron移行 ====================

/**
 * hermes-agent の jobs.json からAikataのcronジョブに変換。
 * 
 * hermes-agent形式: { jobs: [{ id, schedule, prompt, deliver, skills }] }
 * Aikata形式: SQLite scheduler_jobs テーブル
 */
export async function migrateHermesCron(
  jobsPath: string,
  dryRun: boolean = false,
): Promise<{ total: number; imported: number; skipped: number }> {
  let total = 0;
  let imported = 0;
  let skipped = 0;

  if (!existsSync(jobsPath)) return { total, imported, skipped };

  try {
    const raw = readFileSync(jobsPath, "utf-8");
    const jobsData = JSON.parse(raw);
    const jobs = jobsData.jobs ?? [];

    total = jobs.length;

    if (!dryRun) {
      // Aikataのスケジューラーに登録
      for (const job of jobs) {
        try {
          // 動的インポートでスケジューラーを呼ぶ（存在する場合のみ）
          const sched = await import("./scheduler-v2").catch(() => null);
          if (sched?.schedulerV2) {
            sched.schedulerV2.addJob({
              id: job.id ?? `migrated-${Date.now()}`,
              schedule: job.schedule ?? "0 9 * * *",
              prompt: job.prompt ?? "",
              deliver: job.deliver ?? "local",
              skills: job.skills ?? [],
              enabled: true,
            });
            imported++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    } else {
      imported = total;
    }

    logger.info(`[Migration] Cron: ${imported} imported, ${total} total`);
  } catch (err) {
    logger.warn(`[Migration] Cron error: ${err}`);
  }

  return { total, imported, skipped };
}

// ==================== 一括移行 ====================

/**
 * ソースフレームワークからAikataへの完全移行を実行。
 * スキル・メモリ・設定の3つを一括でインポート。
 * 
 * @param source - 移行元フレームワーク
 * @param sourcePath - 移行元のルートディレクトリ（デフォルトは自動検出）
 */
export async function migrateAll(
  source: MigrationSource,
  sourcePath?: string,
  options?: { dryRun?: boolean; overwrite?: boolean },
): Promise<MigrationReport> {
  const t0 = Date.now();

  // ソースパスの自動検出
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const defaultPaths: Record<MigrationSource, string> = {
    "openclaw": join(home, ".openclaw"),
    "hermes-agent": join(home, ".hermes"),
    "openhuman": join(home, ".openhuman"),
    "auto": "", // 順に試行
  };

  let srcPath = sourcePath ?? defaultPaths[source];
  if (!srcPath || !existsSync(srcPath)) {
    // auto-detect: 存在する最初のパスを使用
    for (const [src, path] of Object.entries(defaultPaths)) {
      if (src === "auto") continue;
      if (existsSync(path)) {
        srcPath = path;
        source = src as MigrationSource;
        break;
      }
    }
  }

  if (!srcPath || !existsSync(srcPath)) {
    throw new Error(`No migration source found. Checked: ${Object.values(defaultPaths).join(", ")}`);
  }

  logger.info(`[Migration] Source: ${source} at ${srcPath}`);

  const report: MigrationReport = {
    source,
    skills: { total: 0, imported: 0, skipped: 0, errors: [] },
    memory: { imported: false, warnings: [] },
    config: { sections: [], warnings: [] },
    cron: { total: 0, imported: 0, skipped: 0 },
    durationMs: 0,
  };

  // 1. スキル移行
  const skillSourceDirs = [
    join(srcPath, "skills"),
    join(srcPath, ".agents", "skills"),
    join(srcPath, "agent-skills", "skills"),
  ];
  for (const skillDir of skillSourceDirs) {
    if (existsSync(skillDir)) {
      report.skills = migrateSkills(skillDir, "./skills", {
        overwrite: options?.overwrite,
        dryRun: options?.dryRun,
      });
      break;
    }
  }

  // 2. メモリ移行
  const memorySourceDirs = [
    join(srcPath, "memory"),
    srcPath, // openclaw: MEMORY.md はルート直下
    join(srcPath, "data", "memory"),
  ];
  for (const memDir of memorySourceDirs) {
    if (existsSync(memDir)) {
      report.memory = migrateMemory(memDir, "./data/memory", { dryRun: options?.dryRun });
      if (report.memory.imported) break;
    }
  }

  // 3. 設定移行（フレームワーク別）
  if (source === "hermes-agent") {
    const configPath = join(srcPath, "config.yaml");
    report.config = migrateHermesConfig(configPath, options?.dryRun);
  } else if (source === "openclaw") {
    const configPaths = [
      join(srcPath, "openclaw.json"),
      join(srcPath, "config.json"),
    ];
    for (const cp of configPaths) {
      if (existsSync(cp)) {
        report.config = migrateOpenclawConfig(cp, options?.dryRun);
        break;
      }
    }
  }

  // 4. Cron移行（hermes-agentのみ）
  if (source === "hermes-agent") {
    const jobsPath = join(srcPath, "cron", "jobs.json");
    report.cron = await migrateHermesCron(jobsPath, options?.dryRun);
  }

  report.durationMs = Date.now() - t0;
  logger.info(`[Migration] 完了: ${report.durationMs}ms`);

  return report;
}

/**
 * 移行レポートを人間可読形式でフォーマット。
 */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [
    `🔄 **Aikata 移行レポート**`,
    `移行元: **${report.source}**`,
    `所要時間: ${(report.durationMs / 1000).toFixed(1)}秒`,
    "",
    `📋 **スキル**: ${report.skills.imported}個インポート / ${report.skills.total}個中 (${report.skills.skipped}スキップ)`,
    `🧠 **メモリ**: ${report.memory.imported ? "✅ インポート成功" : "⚠️ スキップ（ファイルなし）"}`,
    `⚙️ **設定**: ${report.config.sections.length}項目抽出`,
    `⏰ **Cron**: ${report.cron.imported}個インポート / ${report.cron.total}個中`,
  ];

  if (report.skills.errors.length > 0) {
    lines.push("", "⚠️ スキルエラー:");
    report.skills.errors.forEach(e => lines.push(`  - ${e}`));
  }
  if (report.config.warnings.length > 0) {
    lines.push("", "⚠️ 設定警告:");
    report.config.warnings.forEach(w => lines.push(`  - ${w}`));
  }
  if (report.memory.warnings.length > 0) {
    lines.push("", "⚠️ メモリ警告:");
    report.memory.warnings.forEach(w => lines.push(`  - ${w}`));
  }

  return lines.join("\n");
}

// ==================== CLI ====================

/**
 * CLIから使う場合のエントリポイント。
 * 
 * 使用例:
 *   npx tsx src/migrate.ts --from openclaw
 *   npx tsx src/migrate.ts --from hermes-agent --dry-run
 *   npx tsx src/migrate.ts --from auto
 */
export async function runMigrationCLI(args: string[]): Promise<string> {
  const fromIdx = args.indexOf("--from");
  const source = (fromIdx >= 0 ? args[fromIdx + 1] : "auto") as MigrationSource;
  const dryRun = args.includes("--dry-run");
  const overwrite = args.includes("--overwrite");
  const pathIdx = args.indexOf("--path");
  const sourcePath = pathIdx >= 0 ? args[pathIdx + 1] : undefined;

  try {
    const report = await migrateAll(source, sourcePath, { dryRun, overwrite });
    return formatMigrationReport(report);
  } catch (err) {
    return `❌ 移行失敗: ${err instanceof Error ? err.message : String(err)}`;
  }
}
