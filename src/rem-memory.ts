// ==========================================
// Aikata - REM Memory Lifecycle（OpenClaw Active Memory由来）
// 短期→長期記憶の自動昇格・圧縮・統合
// 会話履歴から重要な情報を抽出して長期記憶に昇格
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { createHash, randomBytes } from "crypto";

// ==================== 型定義 ====================

export type MemoryTier = "working" | "short_term" | "long_term" | "archived";

export type MemoryCategory =
  | "user_preference"     // ユーザー設定・好み
  | "project_fact"        // プロジェクトに関する事実
  | "decision_log"        // 決定・判断
  | "technical_detail"    // 技術的詳細
  | "social_relation"     // 人間関係
  | "task_state"          // タスク状態
  | "learning"            // 学習したこと
  | "error_pattern"       // エラーパターン
  | "workflow_pattern"    // ワークフローパターン
  | "raw_transcript";     // 未処理のトランスクリプト

export interface MemoryRecord {
  id: string;
  tier: MemoryTier;
  category: MemoryCategory;
  content: string;
  summary: string;
  keywords: string[];
  source: string;          // sessionKey or context
  confidence: number;      // 0-1
  importance: number;      // 0-1
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  relatedIds: string[];
  embedding?: number[];    // optional embedding vector
}

export interface RemConfig {
  /** 短期記憶の最大数 */
  shortTermMax: number;
  /** 長期記憶の最大数 */
  longTermMax: number;
  /** 昇格の確信度閾値 */
  promotionThreshold: number;
  /** REM（急速眼球運動相当）圧縮間隔（ms） */
  remIntervalMs: number;
  /** アーカイブまでの非アクセス日数 */
  archiveAfterDays: number;
  /** キーワードベース昇格（MLシグナル不使用時） */
  keywordPromotion: boolean;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: RemConfig = {
  shortTermMax: 200,
  longTermMax: 1000,
  promotionThreshold: 0.65,
  remIntervalMs: 3600_000, // 1時間
  archiveAfterDays: 30,
  keywordPromotion: true,
};

// ==================== 昇格シグナルパターン ====================

/** 昇格をトリガーする重要パターン（MLシグナル代替） */
const PROMOTION_PATTERNS: Array<{ pattern: RegExp; category: MemoryCategory; importance: number }> = [
  { pattern: /(好み|好き|嫌い|苦手|得意)/, category: "user_preference", importance: 0.7 },
  { pattern: /(パスワード|APIキー|トークン|シークレット)/, category: "technical_detail", importance: 0.9 },
  { pattern: /(決めた|決定|結論|選択)/, category: "decision_log", importance: 0.8 },
  { pattern: /(バグ|エラー|問題|エラーコード|例外)/, category: "error_pattern", importance: 0.7 },
  { pattern: /(ワークフロー|手順|流れ|プロセス)/, category: "workflow_pattern", importance: 0.6 },
  { pattern: /(プロジェクト|repo|repository|ブランチ|PR|マージ)/, category: "project_fact", importance: 0.7 },
  { pattern: /(友達|家族|彼|彼女|先生|上司)/, category: "social_relation", importance: 0.6 },
  { pattern: /(学んだ|理解|気づき|発見)/, category: "learning", importance: 0.8 },
  { pattern: /(設定|config|configure|環境変数)/, category: "technical_detail", importance: 0.6 },
  { pattern: /(毎回|いつも|よく|頻繁|必ず)/, category: "user_preference", importance: 0.6 },
];

// ==================== 内部状態 ====================

let config: RemConfig = { ...DEFAULT_CONFIG };
let records: MemoryRecord[] = [];
let loaded = false;
let remTimer: ReturnType<typeof setInterval> | null = null;

// ==================== ストア ====================

function storePath(): string {
  return resolve(process.env.DATA_DIR || "./data", "memory", "rem-memory.json");
}

function loadStore(): void {
  if (loaded) return;
  const path = storePath();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      records = raw.records || [];
    }
  } catch (e) {
    logger.warn(`[REM] ストア読み込みエラー: ${e}`);
  }
  loaded = true;
}

function saveStore(): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ records, version: 1 }), "utf-8");
}

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

// ==================== コア処理 ====================

/** トランスクリプトから記憶を作成（ワーキングメモリとして保存） */
export function ingestTranscript(
  content: string,
  source: string,
  category: MemoryCategory = "raw_transcript",
  confidence = 0.5,
): MemoryRecord {
  loadStore();

  const importance = scoreImportance(content);
  const keywords = extractKeywords(content);

  const record: MemoryRecord = {
    id: generateId(),
    tier: "working",
    category,
    content,
    summary: generateSummary(content),
    keywords,
    source,
    confidence,
    importance,
    accessCount: 1,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7日
    relatedIds: [],
  };

  records.push(record);
  saveStore();

  // 短期記憶過多なら圧縮
  const workingCount = records.filter((r) => r.tier === "working").length;
  if (workingCount > config.shortTermMax * 0.5) {
    consolidateWorkingMemory();
  }

  return record;
}

/** 記憶を検索（全階層） */
export function searchMemory(
  query: string,
  options?: {
    tier?: MemoryTier;
    category?: MemoryCategory;
    limit?: number;
    minConfidence?: number;
  },
): MemoryRecord[] {
  loadStore();

  const q = query.toLowerCase();
  const queryWords = q.split(/\s+/).filter(Boolean);

  let results = records.filter((r) => {
    if (options?.tier && r.tier !== options.tier) return false;
    if (options?.category && r.category !== options.category) return false;
    if (options?.minConfidence && r.confidence < options.minConfidence) return false;

    // キーワードマッチング
    const searchContent = `${r.content} ${r.summary} ${r.keywords.join(" ")}`.toLowerCase();
    return queryWords.every((w) => searchContent.includes(w));
  });

  // 関連度順にソート（アクセス回数＋最終アクセス＋重要度の複合スコア）
  results.sort((a, b) => {
    const aScore = a.importance * 0.4 + Math.min(a.accessCount / 10, 1) * 0.3 + (Date.now() - a.lastAccessedAt) / 86400000 * 0.3;
    const bScore = b.importance * 0.4 + Math.min(b.accessCount / 10, 1) * 0.3 + (Date.now() - b.lastAccessedAt) / 86400000 * 0.3;
    return bScore - aScore;
  });

  return results.slice(0, options?.limit ?? 10);
}

/** 記憶をアクセス（アクセスカウント更新） */
export function accessMemory(id: string): MemoryRecord | undefined {
  loadStore();
  const record = records.find((r) => r.id === id);
  if (record) {
    record.accessCount++;
    record.lastAccessedAt = Date.now();
    saveStore();

    // アクセス頻度が高いものは自動昇格
    if (record.tier === "short_term" && record.accessCount > 5 && record.importance > 0.6) {
      promoteToLongTerm(record);
    }
  }
  return record;
}

/** 重要度をスコアリング */
function scoreImportance(content: string): number {
  let score = 0.3; // ベースライン

  for (const { pattern, importance } of PROMOTION_PATTERNS) {
    if (pattern.test(content)) {
      score = Math.max(score, importance);
    }
  }

  // 長さによるブースト
  if (content.length > 200) score += 0.1;
  if (content.length > 500) score += 0.1;

  // キーワード密度によるブースト
  const keywordCount = PROMOTION_PATTERNS.reduce(
    (sum, { pattern }) => sum + (content.match(pattern)?.length ?? 0),
    0,
  );
  score += Math.min(keywordCount * 0.05, 0.2);

  return Math.min(score, 1);
}

/** キーワード抽出 */
function extractKeywords(content: string): string[] {
  const words = content.toLowerCase().split(/[\s,.!?;:()\[\]{}"']+/).filter(Boolean);
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "about", "up", "and", "but", "or", "if", "while", "that",
    "this", "it", "its", "i", "me", "my", "we", "our", "you", "your",
    "he", "him", "his", "she", "her", "they", "them", "their",
    "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "あそこ",
    "は", "が", "の", "を", "に", "へ", "と", "から", "より", "で",
    "です", "ます", "した", "いる", "ある", "なる", "できる",
  ]);

  const freq = new Map<string, number>();
  for (const word of words) {
    if (word.length < 3 || stopWords.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/** サマリー生成（先頭から抽出） */
function generateSummary(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 150) return cleaned;
  return cleaned.slice(0, 147) + "...";
}

// ==================== 昇格処理 ====================

/** ワーキングメモリを短期記憶に統合 */
function consolidateWorkingMemory(): void {
  const working = records.filter((r) => r.tier === "working");
  if (working.length === 0) return;

  // カテゴリごとにグループ化
  const grouped = new Map<MemoryCategory, MemoryRecord[]>();
  for (const r of working) {
    if (!grouped.has(r.category)) grouped.set(r.category, []);
    grouped.get(r.category)!.push(r);
  }

  const created: MemoryRecord[] = [];
  for (const [, group] of grouped) {
    // 同じカテゴリの内容を統合
    const merged = group
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5);

    const combinedContent = merged.map((r) => r.content).join("\n");
    const combinedKeywords = [...new Set(merged.flatMap((r) => r.keywords))];
    const avgImportance = merged.reduce((s, r) => s + r.importance, 0) / merged.length;
    const avgConfidence = merged.reduce((s, r) => s + r.confidence, 0) / merged.length;

    const shortTerm: MemoryRecord = {
      id: generateId(),
      tier: "short_term",
      category: group[0]!.category,
      content: combinedContent,
      summary: generateSummary(combinedContent),
      keywords: combinedKeywords,
      source: merged.map((r) => r.source).join(","),
      confidence: avgConfidence,
      importance: avgImportance,
      accessCount: 1,
      lastAccessedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30日
      relatedIds: merged.map((r) => r.id),
    };

    created.push(shortTerm);
  }

  // ワーキングメモリを削除して統合版に置き換え
  records = records.filter((r) => r.tier !== "working");
  records.push(...created);
  saveStore();

  logger.info(`[REM] ワーキングメモリ統合: ${working.length}→${created.length}件`);
}

/** 短期→長期への昇格 */
function promoteToLongTerm(record: MemoryRecord): void {
  if (record.tier !== "short_term") return;

  // 関連する短期記憶を探す
  const related = records.filter(
    (r) =>
      r.id !== record.id &&
      r.tier === "short_term" &&
      r.category === record.category &&
      r.keywords.some((k) => record.keywords.includes(k)),
  );

  const mergedKeywords = [...new Set([...record.keywords, ...related.flatMap((r) => r.keywords)])];
  const mergedContent = [record.content, ...related.map((r) => r.content)].join("\n\n---\n\n");

  const longTerm: MemoryRecord = {
    id: generateId(),
    tier: "long_term",
    category: record.category,
    content: mergedContent,
    summary: record.summary,
    keywords: mergedKeywords,
    source: record.source,
    confidence: Math.min(record.confidence + 0.1, 1),
    importance: record.importance,
    accessCount: record.accessCount,
    lastAccessedAt: Date.now(),
    createdAt: Math.min(...related.map((r) => r.createdAt), record.createdAt),
    updatedAt: Date.now(),
    expiresAt: null, // 長期記憶は期限切れなし
    relatedIds: [record.id, ...related.map((r) => r.id)],
  };

  // 昇格元を削除
  records = records.filter(
    (r) => r.id !== record.id && !related.some((rel) => rel.id === r.id),
  );
  records.push(longTerm);

  // 長期記憶数制限
  enforceLongTermLimit();

  saveStore();
  logger.info(`[REM] 昇格: ${record.id} → long_term (${record.category}, imp=${record.importance.toFixed(2)})`);
}

/** 長期記憶の上限を強制 */
function enforceLongTermLimit(): void {
  const longTerm = records.filter((r) => r.tier === "long_term");
  if (longTerm.length <= config.longTermMax) return;

  // アクセス頻度の低いものからアーカイブ
  const toArchive = longTerm
    .sort((a, b) => a.accessCount - b.accessCount || a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, longTerm.length - config.longTermMax);

  for (const r of toArchive) {
    r.tier = "archived";
    r.updatedAt = Date.now();
  }

  saveStore();
  logger.info(`[REM] ${toArchive.length}件をアーカイブ`);
}

// ==================== REMサイクル（定期的な圧縮・昇格） ====================

/** REMサイクルを実行 */
export function runRemCycle(): { promoted: number; archived: number; consolidated: number } {
  loadStore();
  const now = Date.now();
  let promoted = 0;
  let archived = 0;
  let consolidated = 0;

  // 1. ワーキングメモリの統合
  const workingCount = records.filter((r) => r.tier === "working").length;
  if (workingCount > 10) {
    consolidateWorkingMemory();
    consolidated = workingCount - records.filter((r) => r.tier === "working").length;
  }

  // 2. 短期→長期昇格（キーワードベース）
  const shortTerm = records.filter(
    (r) => r.tier === "short_term" && r.importance >= config.promotionThreshold,
  );

  for (const r of shortTerm) {
    if (r.accessCount >= 3 || r.importance >= 0.75) {
      promoteToLongTerm(r);
      promoted++;
    }
  }

  // 3. 長期→アーカイブ（非アクセス期間）
  const archiveCutoff = now - config.archiveAfterDays * 24 * 60 * 60 * 1000;
  const toArchive = records.filter(
    (r) => r.tier === "long_term" && r.lastAccessedAt < archiveCutoff,
  );

  for (const r of toArchive) {
    r.tier = "archived";
    r.updatedAt = now;
    archived++;
  }

  if (promoted > 0 || archived > 0 || consolidated > 0) {
    saveStore();
    logger.info(`[REM] サイクル完了: ${promoted}昇格, ${archived}アーカイブ, ${consolidated}統合`);
  }

  return { promoted, archived, consolidated };
}

/** REMサイクルを定期実行 */
export function startRemCycle(customConfig?: Partial<RemConfig>): void {
  if (remTimer) return;

  if (customConfig) {
    config = { ...config, ...customConfig };
  }

  remTimer = setInterval(() => {
    runRemCycle().catch((e) => logger.error(`[REM] サイクルエラー: ${e}`));
  }, config.remIntervalMs);

  // 初回実行
  runRemCycle().catch((e) => logger.error(`[REM] 初回サイクルエラー: ${e}`));

  logger.info(`[REM] サイクル開始 (interval=${config.remIntervalMs / 60000}分)`);
}

export function stopRemCycle(): void {
  if (remTimer) {
    clearInterval(remTimer);
    remTimer = null;
  }
}

// ==================== クエリ ====================

export function getMemoryStats(): Record<string, number> {
  loadStore();
  return {
    working: records.filter((r) => r.tier === "working").length,
    short_term: records.filter((r) => r.tier === "short_term").length,
    long_term: records.filter((r) => r.tier === "long_term").length,
    archived: records.filter((r) => r.tier === "archived").length,
    total: records.length,
  };
}

export function getMemoriesByTier(tier: MemoryTier, limit = 50): MemoryRecord[] {
  loadStore();
  return records
    .filter((r) => r.tier === tier)
    .sort((a, b) => b.importance - b.importance)
    .slice(0, limit);
}

export function formatMemoryRecord(r: MemoryRecord): string {
  const tierIcon: Record<MemoryTier, string> = {
    working: "💭",
    short_term: "🧠",
    long_term: "💎",
    archived: "📦",
  };

  return [
    `${tierIcon[r.tier] ?? "📝"} **${r.summary}**`,
    `  カテゴリ: ${r.category} | 重要度: ${(r.importance * 100).toFixed(0)}%`,
    `  キーワード: ${r.keywords.slice(0, 5).join(", ")}`,
    `  アクセス: ${r.accessCount}回 | 作成: ${new Date(r.createdAt).toLocaleDateString()}`,
  ].join("\n");
}

export function formatMemoryStats(): string {
  const stats = getMemoryStats();
  return [
    "🧠 **REM Memory System**",
    "",
    `💭 ワーキング: ${stats.working}`,
    `🧠 短期記憶: ${stats.short_term}`,
    `💎 長期記憶: ${stats.long_term}`,
    `📦 アーカイブ: ${stats.archived}`,
    `📊 合計: ${stats.total}`,
    "",
    `⚙️ 昇格閾値: ${(config.promotionThreshold * 100).toFixed(0)}%`,
    `🔄 REM間隔: ${config.remIntervalMs / 60000}分`,
  ].join("\n");
}

export function resetMemory(): void {
  records = [];
  saveStore();
  logger.info("[REM] メモリ全リセット");
}
