// ==========================================
// Hikamer - TokenJuice Terminal Output Compaction（OpenHuman tokenjuice/ 完全移植）
// LLMコンテキスト節約のためのターミナル出力圧縮エンジン
// 3層ルール・ANSI除去・重複行削減・インライン要約
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface CompactRule {
  toolName?: string;
  argv0?: string;
  argvIncludes?: string[];
  commandIncludes?: string[];
  skipPatterns?: string[];
  keepPatterns?: string[];
  stripAnsi?: boolean;
  trimEmptyEdges?: boolean;
  dedupeAdjacent?: boolean;
  prettyPrintJson?: boolean;
  headLines?: number;
  tailLines?: number;
  counters?: Array<{ pattern: string; label: string }>;
}

export interface CompactResult {
  text: string;
  tokenSavings: number;
  matchedRules: string[];
  originalLength: number;
  compressedLength: number;
}

interface ClassifiedRule {
  rule: CompactRule;
  specificity: number;
  name: string;
}

// ==================== ビルトインルール ====================

const BUILTIN_RULES: Record<string, CompactRule> = {
  "generic/fallback": {
    stripAnsi: true,
    trimEmptyEdges: true,
    dedupeAdjacent: true,
  },
  "git/status": {
    toolName: "terminal",
    argvIncludes: ["git", "status"],
    stripAnsi: true,
    trimEmptyEdges: true,
    headLines: 5,
    tailLines: 10,
  },
  "git/branch": {
    toolName: "terminal",
    argvIncludes: ["git", "branch"],
    stripAnsi: true,
    headLines: 20,
    tailLines: 5,
  },
  "git/diff": {
    toolName: "terminal",
    argvIncludes: ["git", "diff"],
    stripAnsi: true,
    headLines: 30,
    tailLines: 30,
    counters: [
      { pattern: "^@@", label: "hunks" },
      { pattern: "^\\+", label: "added" },
      { pattern: "^\\-", label: "removed" },
    ],
  },
  "npm/install": {
    toolName: "terminal",
    argvIncludes: ["npm", "install"],
    stripAnsi: true,
    headLines: 10,
    tailLines: 5,
    keepPatterns: ["error", "warn", "added", "removed"],
  },
  "generic/help": {
    toolName: "terminal",
    argvIncludes: ["--help", "-h"],
    stripAnsi: true,
    headLines: 15,
    tailLines: 10,
  },
  "ls": {
    toolName: "terminal",
    argv0: "ls",
    stripAnsi: true,
    headLines: 20,
    tailLines: 5,
  },
  "cargo/build": {
    toolName: "terminal",
    argvIncludes: ["cargo", "build"],
    headLines: 5,
    tailLines: 5,
    counters: [
      { pattern: "Compiling", label: "compiled" },
      { pattern: "error", label: "errors" },
      { pattern: "warning", label: "warnings" },
    ],
  },
  "docker/build": {
    toolName: "terminal",
    argvIncludes: ["docker", "build"],
    headLines: 10,
    tailLines: 5,
    keepPatterns: ["error", "successfully", "exported"],
  },
};

/** ユーザールールのストア */
const userRules: CompactRule[] = [];
const projectRules: CompactRule[] = [];

// ==================== テキスト処理 ====================

/** ANSIエスケープシーケンスを除去（ECMA-48完全版） */
function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-nq-uy=><~]))/g, "");
}

/** 空行のトリミング（先頭・末尾） */
function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length - 1;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  while (end > start && lines[end]!.trim() === "") end--;
  return lines.slice(start, end + 1);
}

/** 隣接重複行の削除 */
function dedupeAdjacent(lines: string[]): string[] {
  return lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
}

/** カウンター（行数集計） */
function countLines(lines: string[], patterns: Array<{ pattern: string; label: string }>): string {
  const counts: Record<string, number> = {};
  for (const { pattern, label } of patterns) {
    const re = new RegExp(pattern);
    counts[label] = lines.filter((l) => re.test(l)).length;
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`)
    .join(", ");
}

// ==================== コアエンジン ====================

/** ツール実行入力を分類 */
function classifyExecution(
  toolName: string,
  command?: string,
): ClassifiedRule[] {
  const argv0 = command?.split(/\s+/)[0];
  const argv = command?.split(/\s+/) || [];
  const scored: ClassifiedRule[] = [];

  for (const [name, rule] of Object.entries(BUILTIN_RULES)) {
    let specificity = 0;

    if (rule.toolName && rule.toolName === toolName) specificity += 10;
    if (rule.argv0 && rule.argv0 === argv0) specificity += 20;
    if (rule.argvIncludes) {
      const matchCount = rule.argvIncludes.filter((a) => argv.includes(a)).length;
      if (matchCount === rule.argvIncludes.length) specificity += 15 * matchCount;
    }
    if (rule.commandIncludes) {
      const matchCount = rule.commandIncludes.filter((c) => command?.includes(c)).length;
      if (matchCount > 0) specificity += 5 * matchCount;
    }

    if (specificity > 0) {
      scored.push({ rule, specificity, name });
    }
  }

  // ユーザールールも追加
  for (let i = 0; i < userRules.length; i++) {
    scored.push({ rule: userRules[i]!, specificity: 5, name: `user/${i}` });
  }

  // プロジェクトルールも追加
  for (let i = 0; i < projectRules.length; i++) {
    scored.push({ rule: projectRules[i]!, specificity: 8, name: `project/${i}` });
  }

  // 常にフォールバックルールを含める
  scored.push({ rule: BUILTIN_RULES["generic/fallback"]!, specificity: 0, name: "generic/fallback" });

  scored.sort((a, b) => b.specificity - a.specificity);
  return scored.slice(0, 3); // 上位3つまで
}

/** 出力を圧縮 */
export function compactOutput(
  output: string,
  toolName?: string,
  command?: string,
): CompactResult {
  const originalLength = output.length;
  const classified = toolName ? classifyExecution(toolName, command) : [];
  const matchedRules: string[] = [];

  let text = output;
  const lines = text.split("\n");

  for (const { rule, name } of classified) {
    matchedRules.push(name);
    let processedLines = [...lines];

    // ANSI除去
    if (rule.stripAnsi) {
      processedLines = processedLines.map((l) => stripAnsi(l));
    }

    // スキップパターン
    if (rule.skipPatterns) {
      processedLines = processedLines.filter(
        (l) => !rule.skipPatterns!.some((p) => new RegExp(p).test(l)),
      );
    }

    // 保持パターン
    if (rule.keepPatterns && rule.keepPatterns.length > 0) {
      const kept = processedLines.filter(
        (l) => rule.keepPatterns!.some((p) => new RegExp(p, "i").test(l)),
      );
      if (kept.length > 0) processedLines = kept;
    }

    // 空行トリミング
    if (rule.trimEmptyEdges) {
      processedLines = trimEmptyEdges(processedLines);
    }

    // 重複行削除
    if (rule.dedupeAdjacent) {
      processedLines = dedupeAdjacent(processedLines);
    }

    // カウンター集計
    let counterStr = "";
    if (rule.counters && rule.counters.length > 0) {
      counterStr = countLines(processedLines, rule.counters);
    }

    // ヘッド/テール切り詰め
    if (rule.headLines || rule.tailLines) {
      const head = rule.headLines ?? 0;
      const tail = rule.tailLines ?? 0;
      if (head + tail < processedLines.length) {
        const headLines = processedLines.slice(0, head);
        const tailLines = processedLines.slice(-tail);
        const hidden = processedLines.length - head - tail;
        processedLines = [
          ...headLines,
          `… ${hidden} lines suppressed …`,
          ...tailLines,
        ];
      }
    }

    // カウンターを先頭行に追加
    if (counterStr) {
      processedLines = [`[${counterStr}]`, ...processedLines];
    }

    text = processedLines.join("\n");
  }

  // パススルー最適化：512bytes未満または圧縮率5%未満なら変更しない
  if (originalLength < 512 || (originalLength - text.length) / originalLength < 0.05) {
    return {
      text: output,
      tokenSavings: 0,
      matchedRules,
      originalLength,
      compressedLength: originalLength,
    };
  }

  return {
    text,
    tokenSavings: Math.round((originalLength - text.length) / 4), // 大まかなトークン換算
    matchedRules,
    originalLength,
    compressedLength: text.length,
  };
}

// ==================== 公開API ====================

/** 出力をコンパクトにフォーマット */
export function formatCompactResult(result: CompactResult): string {
  if (result.tokenSavings === 0) {
    return `📄 出力: ${result.originalLength} chars (圧縮不要)`;
  }
  return [
    `📄 **出力圧縮:**`,
    `  元: ${result.originalLength} chars`,
    `  後: ${result.compressedLength} chars`,
    `  削減: ${result.tokenSavings} tokens (${((1 - result.compressedLength / result.originalLength) * 100).toFixed(1)}%)`,
    `  適用ルール: ${result.matchedRules.join(", ")}`,
  ].join("\n");
}

/** ユーザールール追加 */
export function addUserRule(name: string, rule: CompactRule): void {
  userRules.push(rule);
  logger.info(`[TokenJuice] ユーザールール追加: ${name}`);
}

/** ルール一覧 */
export function listRules(): string {
  const lines: string[] = ["📋 **TokenJuice Rules**"];
  for (const [name] of Object.entries(BUILTIN_RULES)) {
    lines.push(`  ✅ ${name}`);
  }
  if (userRules.length > 0) {
    lines.push(`  👤 ユーザー定義: ${userRules.length}`);
  }
  return lines.join("\n");
}

// ==================== LLMセマフォ（協調型スロットリング） ====================

interface SemaphoreSlot {
  runtimeId: string;
  acquiredAt: number;
}

let semaphoreSlots: SemaphoreSlot[] = [];
const MAX_SLOTS = 1;
let gateEnabled = true;

/** LLM呼び出し前にスロットを確保 */
export async function acquireLlmSlot(timeoutMs = 30000): Promise<boolean> {
  if (!gateEnabled) return true;
  const start = Date.now();

  while (semaphoreSlots.length >= MAX_SLOTS) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(100);
  }

  semaphoreSlots.push({
    runtimeId: `runtime_${Date.now()}`,
    acquiredAt: Date.now(),
  });

  return true;
}

/** LLM呼び出し後にスロットを解放 */
export function releaseLlmSlot(): void {
  semaphoreSlots.pop();
}

/** ゲート有効/無効 */
export function setGateEnabled(enabled: boolean): void {
  gateEnabled = enabled;
  if (!enabled) semaphoreSlots = [];
  logger.info(`[LLM Gate] ${enabled ? "有効" : "無効"}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 状態フォーマット */
export function formatTokenJuiceStatus(): string {
  return [
    "🧃 **TokenJuice Engine**",
    `  ビルトインルール: ${Object.keys(BUILTIN_RULES).length}`,
    `  ユーザールール: ${userRules.length}`,
    `  LLMセマフォ: ${semaphoreSlots.length}/${MAX_SLOTS}スロット使用中`,
    `  ゲート: ${gateEnabled ? "ON" : "OFF"}`,
  ].join("\n");
}
