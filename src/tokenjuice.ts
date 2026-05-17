// ==========================================
// Aikata - Token Juice（OpenHuman tokenjuice由来）
// 定形ツール出力（git/npm/docker/cargo等）を自動圧縮
// トークン消費を直接削減
// ==========================================

import { logger } from "./utils/logger";
import { stripAnsi } from "./ansi-strip";

// ==================== ルール定義 ====================

interface JuiceRule {
  id: string;
  family: string;
  toolNames?: string[];
  argv0?: string[];
  argvIncludes?: string[];
  commandIncludes?: string[];
  skipPatterns?: RegExp[];
  keepPatterns?: RegExp[];
  transforms?: {
    stripAnsi?: boolean;
    dedupeAdjacent?: boolean;
    trimEmptyEdges?: boolean;
    prettyPrintJson?: boolean;
  };
  headLines?: number;
  tailLines?: number;
  failureOverride?: { maxLines?: number };
  counters?: Array<{ name: string; pattern: RegExp }>;
  /** 定型メッセージ完全一致で短絡 */
  matchOutput?: RegExp;
}

// ==================== 組み込みルール ====================

const BUILTIN_RULES: JuiceRule[] = [
  // === git ===
  {
    id: "git__status",
    family: "git",
    commandIncludes: ["git status"],
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    headLines: 10, tailLines: 5,
    counters: [
      { name: "modified", pattern: /modified:\s+/g },
      { name: "untracked", pattern: /\?\?/g },
      { name: "deleted", pattern: /deleted:\s+/g },
    ],
  },
  {
    id: "git__log-oneline",
    family: "git",
    commandIncludes: ["git log --oneline", "git log --pretty=oneline"],
    transforms: { stripAnsi: true },
    headLines: 20, tailLines: 5,
    counters: [{ name: "commits", pattern: /^[a-f0-9]+/gm }],
  },
  {
    id: "git__diff-stat",
    family: "git",
    commandIncludes: ["git diff --stat", "git diffstat"],
    transforms: { stripAnsi: true },
    headLines: 15, tailLines: 0,
  },
  {
    id: "git__branch",
    family: "git",
    commandIncludes: ["git branch"],
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    headLines: 20, tailLines: 0,
  },
  {
    id: "git__show",
    family: "git",
    commandIncludes: ["git show"],
    transforms: { stripAnsi: true },
    headLines: 30, tailLines: 10,
  },
  {
    id: "git__diff-name-only",
    family: "git",
    commandIncludes: ["git diff --name-only"],
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    headLines: 30, tailLines: 0,
    counters: [{ name: "files", pattern: /^.+$/gm }],
  },

  // === npm/pnpm/yarn ===
  {
    id: "install__npm-install",
    family: "install",
    commandIncludes: ["npm install", "npm i "],
    transforms: { stripAnsi: true },
    headLines: 5, tailLines: 3,
    matchOutput: /up to date|added \d+|removed \d+/,
  },
  {
    id: "install__pnpm-install",
    family: "install",
    commandIncludes: ["pnpm install", "pnpm i "],
    transforms: { stripAnsi: true },
    headLines: 5, tailLines: 3,
    matchOutput: /up to date|Already up to date/,
  },

  // === cargo ===
  {
    id: "build__cargo",
    family: "build",
    commandIncludes: ["cargo build", "cargo check", "cargo test"],
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    headLines: 10, tailLines: 5,
    matchOutput: /Compiling|Finished|error|warning/,
  },

  // === docker ===
  {
    id: "devops__docker-ps",
    family: "devops",
    commandIncludes: ["docker ps"],
    transforms: { stripAnsi: true, prettyPrintJson: true },
    headLines: 20, tailLines: 0,
    counters: [{ name: "containers", pattern: /^[a-f0-9]{12}\s/gm }],
  },
  {
    id: "devops__docker-images",
    family: "devops",
    commandIncludes: ["docker images"],
    transforms: { stripAnsi: true },
    headLines: 20, tailLines: 0,
    counters: [{ name: "images", pattern: /^[a-z0-9]+\s/gm }],
  },
  {
    id: "devops__docker-compose",
    family: "devops",
    commandIncludes: ["docker compose", "docker-compose"],
    transforms: { stripAnsi: true },
    headLines: 10, tailLines: 5,
  },

  // === system ===
  {
    id: "system__ls",
    family: "filesystem",
    commandIncludes: ["ls ", "ls -la"],
    transforms: { stripAnsi: true },
    headLines: 40, tailLines: 0,
    counters: [{ name: "entries", pattern: /^[-dl]/gm }],
  },
  {
    id: "system__ps",
    family: "system",
    commandIncludes: ["ps aux", "ps -ef"],
    transforms: { stripAnsi: true },
    headLines: 25, tailLines: 0,
    counters: [{ name: "processes", pattern: /^[\w]/gm }],
  },
  {
    id: "system__df",
    family: "system",
    commandIncludes: ["df -h", "df "],
    transforms: { stripAnsi: true },
    headLines: 15, tailLines: 0,
  },
  {
    id: "system__du",
    family: "system",
    commandIncludes: ["du -sh", "du -h"],
    transforms: { stripAnsi: true },
    headLines: 25, tailLines: 0,
  },
  {
    id: "system__find",
    family: "filesystem",
    commandIncludes: ["find "],
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    headLines: 25, tailLines: 5,
    counters: [{ name: "results", pattern: /^/gm }],
  },

  // === search ===
  {
    id: "search__grep",
    family: "search",
    commandIncludes: ["grep ", "rg ", "ag "],
    transforms: { stripAnsi: true },
    headLines: 30, tailLines: 10,
    counters: [{ name: "matches", pattern: /^[\w/]/gm }],
  },

  // === network ===
  {
    id: "network__curl",
    family: "network",
    commandIncludes: ["curl "],
    transforms: { stripAnsi: true },
    headLines: 30, tailLines: 10,
  },

  // === tests ===
  {
    id: "tests__vitest",
    family: "tests",
    commandIncludes: ["vitest", "npx vitest"],
    transforms: { stripAnsi: true },
    headLines: 15, tailLines: 10,
    matchOutput: /PASS|FAIL|Tests\s+\d+/,
  },
  {
    id: "tests__jest",
    family: "tests",
    commandIncludes: ["jest", "npx jest"],
    transforms: { stripAnsi: true },
    headLines: 15, tailLines: 10,
    matchOutput: /PASS|FAIL|Tests:/,
  },

  // === generic fallback ===
  {
    id: "generic__fallback",
    family: "generic",
    transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
    headLines: 40, tailLines: 20,
    failureOverride: { maxLines: 5 },
  },
];

// ==================== Juiceエンジン ====================

interface JuiceResult {
  text: string;
  originalLines: number;
  finalLines: number;
  counters: Record<string, number>;
  ruleId: string;
}

/**
 * ツール出力を自動圧縮
 * パススルー条件:
 * - 512バイト未満 → そのまま（圧縮するほど小さくない）
 * - 圧縮後のサイズが元の95%以上 → そのまま（圧縮効果なし）
 */
export function juiceOutput(commandHint: string, output: string): JuiceResult {
  const originalLines = output.split("\n").length;
  const originalBytes = output.length;

  // 小さすぎる出力はパススルー
  if (originalBytes < 512) {
    return { text: output, originalLines, finalLines: originalLines, counters: {}, ruleId: "passthrough" };
  }

  // ルールマッチング
  const rule = matchRule(commandHint, output);

  if (!rule) {
    // マッチなし → シンプルなtrimのみ
    const trimmed = trimOutput(output, 40, 20);
    const finalLines = trimmed.split("\n").length;
    return { text: trimmed, originalLines, finalLines, counters: {}, ruleId: "none" };
  }

  // トランスフォーム適用
  let text = output;

  if (rule.transforms?.stripAnsi) {
    text = stripAnsi(text);
  }

  // 定型出力マッチ → 短絡
  if (rule.matchOutput && !rule.matchOutput.test(text)) {
    // マッチするパターンがない場合も処理続行
  }

  // skipPatterns の行を除去
  if (rule.skipPatterns) {
    const lines = text.split("\n");
    text = lines.filter(line => !rule.skipPatterns!.some(p => p.test(line))).join("\n");
  }

  if (rule.transforms?.trimEmptyEdges) {
    text = text.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
  }

  if (rule.transforms?.dedupeAdjacent) {
    text = dedupeAdjacent(text);
  }

  // カウンター
  const counters: Record<string, number> = {};
  if (rule.counters) {
    for (const c of rule.counters) {
      const matches = text.match(c.pattern);
      counters[c.name] = matches ? matches.length : 0;
    }
  }

  // ヘッド/テール抽出
  const failureMode = rule.failureOverride && /error|fail|abort/i.test(text);
  const maxHead = failureMode && rule.failureOverride?.maxLines
    ? rule.failureOverride.maxLines : rule.headLines || 20;
  const maxTail = failureMode ? 0 : rule.tailLines || 10;

  text = trimOutput(text, maxHead, maxTail);

  // カウンターサマリを先頭に追加
  const counterSummary = Object.keys(counters).length > 0
    ? `[${Object.entries(counters).map(([k, v]) => `${k}: ${v}`).join(", ")}] `
    : "";

  if (counterSummary) {
    text = counterSummary + "\n" + text;
  }

  // 圧縮効果チェック
  const finalLines = text.split("\n").length;
  const finalBytes = text.length;

  if (finalBytes > originalBytes * 0.95) {
    // 圧縮効果がない → 元のまま
    return { text: output, originalLines, finalLines: originalLines, counters, ruleId: rule.id };
  }

  logger.debug(`TokenJuice: ${rule.id} ${originalLines}→${finalLines}行 (${originalBytes}→${finalBytes}B)`);

  return { text, originalLines, finalLines, counters, ruleId: rule.id };
}

// ==================== ルールマッチング ====================

function matchRule(command: string, output: string): JuiceRule | undefined {
  // まずspecificなルールから
  for (const rule of BUILTIN_RULES) {
    if (rule.id === "generic__fallback") continue; // fallbackは最後

    if (rule.commandIncludes) {
      for (const inc of rule.commandIncludes) {
        if (command.includes(inc)) {
          return rule;
        }
      }
    }
    if (rule.toolNames && rule.toolNames.some(t => command.startsWith(t))) {
      return rule;
    }
  }

  // fallback（出力が3行以上ある場合のみ）
  return BUILTIN_RULES.find(r => r.id === "generic__fallback");
}

// ==================== ユーティリティ ====================

function dedupeAdjacent(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let prev = "";
  for (const line of lines) {
    if (line !== prev) result.push(line);
    prev = line;
  }
  return result.join("\n");
}

function trimOutput(text: string, headLines: number, tailLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 3) return text;

  const head = lines.slice(0, headLines);
  const tail = tailLines > 0 ? lines.slice(-tailLines) : [];
  const skipped = lines.length - head.length - tail.length;

  const parts = [head.join("\n")];
  if (skipped > 0) parts.push(`…[${skipped}行省略]`);
  if (tail.length > 0) parts.push(tail.join("\n"));

  return parts.join("\n");
}

// ==================== 公開API ====================

export function setCustomRule(rule: JuiceRule): void {
  BUILTIN_RULES.unshift(rule);
}

export { JuiceRule };
