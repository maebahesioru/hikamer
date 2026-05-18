// ==========================================
// Aikata - メモリブリッジ（拡張版memory.ts）
// 既存のFrozen Snapshot方式 + agentmemoryのハイブリッド検索 + 4-Tierパイプライン
// 後方互換性を維持しつつ強化
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getDefaultPipeline, MemoryPipeline, MemoryTier } from "./memory-pipeline";
import { getDefaultSearch, HybridSearch } from "./hybrid-search";
import { logger } from "./utils/logger";

// ==================== パス設定（既存互換） ====================

const MEMORY_DIR = resolve(process.env.DATA_DIR || "./data", "memory");
const MEMORY_FILE = resolve(MEMORY_DIR, "MEMORY.md");
const USER_FILE = resolve(MEMORY_DIR, "USER.md");
const PIPELINE_FILE = resolve(MEMORY_DIR, "pipeline.json");

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readFileSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeFileSafe(path: string, content: string): void {
  ensureDir();
  writeFileSync(path, content, "utf-8");
}

// ==================== 既存API（後方互換） ====================

/** エージェントメモリを取得（Frozen Snapshot） */
export function getAgentMemory(): string {
  return readFileSafe(MEMORY_FILE);
}

/** ユーザープロファイルを取得 */
export function getUserProfile(): string {
  return readFileSafe(USER_FILE);
}

/** エージェントメモリを更新 */
export function writeAgentMemory(content: string): void {
  writeFileSafe(MEMORY_FILE, content);
}

/** ユーザープロファイルを更新 */
export function writeUserProfile(content: string): void {
  writeFileSafe(USER_FILE, content);
}

/** メモリをシステムプロンプトに追加するブロックを生成 */
export function buildMemoryBlock(): string {
  const memory = getAgentMemory();
  const user = getUserProfile();
  const parts: string[] = [];

  if (memory) {
    parts.push(`<agent_memory>\n${memory}\n</agent_memory>`);
  }
  if (user) {
    parts.push(`<user_profile>\n${user}\n</user_profile>`);
  }
  if (parts.length === 0) return "";

  return `\n\n## 永続メモリ\n以下の情報はセッション間で保持されます。\n${parts.join("\n")}\n`;
}

/** メモリファイルが存在するか */
export function hasMemory(): boolean {
  return existsSync(MEMORY_FILE) && readFileSync(MEMORY_FILE, "utf-8").trim().length > 0;
}

// ==================== 拡張API（agentmemory由来の新機能） ====================

let pipeline: MemoryPipeline | null = null;

/** パイプラインインスタンスを取得 */
function getPipeline(): MemoryPipeline {
  if (!pipeline) {
    pipeline = getDefaultPipeline();
    loadPipelineFromDisk();
  }
  return pipeline;
}

/**
 * 観察を記録（自動メモリ）
 * Aikata起動中にエージェントが学習した内容を自動保存
 */
export async function observeMemory(
  text: string,
  options?: {
    sessionId?: string;
    entities?: string[];
    importance?: number;
    tier?: MemoryTier;
  }
): Promise<void> {
  const p = getPipeline();
  if (options?.tier === "semantic" || options?.tier === "procedural") {
    await p.remember(text, {
      entities: options.entities,
      importance: options.importance,
    });
  } else {
    await p.observe(text, {
      sessionId: options?.sessionId,
      entities: options?.entities,
      importance: options?.importance,
    });
  }
  savePipelineToDisk();
}

/**
 * ハイブリッド検索でメモリを検索
 * 新機能！BM25 + ベクトル + グラフのRRF融合検索
 */
export async function searchMemory(
  query: string,
  limit: number = 5,
  minTier?: MemoryTier
): Promise<string[]> {
  const p = getPipeline();
  const results = await p.search(query, limit * 2);

  let filtered = results;
  if (minTier) {
    const tierRank = { working: 1, episodic: 2, semantic: 3, procedural: 4 };
    const minRank = tierRank[minTier] || 1;
    filtered = results.filter(r => (tierRank[r.tier] || 0) >= minRank);
  }

  return filtered.slice(0, limit).map(r => {
    const tier = r.tier.toUpperCase();
    return `[${tier}][${(r.confidence * 100).toFixed(0)}%] ${r.summary || r.text}`;
  });
}

/**
 * コンテキストブロックを生成（トークン予算あり）
 * システムプロンプトに注入するための関連メモリブロック
 */
export async function buildEnhancedMemoryBlock(
  contextQuery: string,
  tokenBudget: number = 1500
): Promise<string> {
  const p = getPipeline();
  const contextBlock = await p.getContextBlock(contextQuery, tokenBudget);

  const traditional = buildMemoryBlock();

  if (!contextBlock) return traditional;

  return `${traditional}\n\n## 関連メモリ（ハイブリッド検索）\n${contextBlock}`;
}

/**
 * 明示的に覚えさせる（セマンティックメモリに直接追加）
 */
export async function rememberExplicitly(
  text: string,
  importance: number = 0.7
): Promise<void> {
  const p = getPipeline();
  await p.remember(text, { importance });
  savePipelineToDisk();
  logger.info(`[MemoryBridge] 明示的記憶: ${text.slice(0, 80)}...`);
}

/**
 * パイプラインの状態をディスクに保存
 */
export function savePipelineToDisk(): void {
  try {
    ensureDir();
    const p = getPipeline();
    const data = JSON.stringify({
      entries: p.exportData(),
      savedAt: Date.now(),
    });
    writeFileSafe(PIPELINE_FILE, data);
  } catch (e) {
    logger.error(`[MemoryBridge] 保存エラー: ${e}`);
  }
}

/**
 * パイプラインの状態をディスクから復元
 */
export function loadPipelineFromDisk(): void {
  try {
    const data = readFileSafe(PIPELINE_FILE);
    if (!data) return;

    const parsed = JSON.parse(data);
    if (parsed.entries && Array.isArray(parsed.entries)) {
      const p = getPipeline();
      p.importData(parsed.entries);
      logger.info(`[MemoryBridge] ${parsed.entries.length}件のメモリを復元`);
    }
  } catch (e) {
    logger.warn(`[MemoryBridge] 復元エラー（無視）: ${e}`);
  }
}

/**
 * 統合を手動実行
 */
export async function consolidateNow(): Promise<void> {
  const p = getPipeline();
  await p.consolidate();
  savePipelineToDisk();
  logger.info("[MemoryBridge] 手動統合完了");
}

/**
 * メモリ統計情報
 */
export function getMemoryStats(): Record<string, number> {
  const p = getPipeline();
  return {
    total: p.getAllEntries().length,
    working: p.getTierCount("working"),
    episodic: p.getTierCount("episodic"),
    semantic: p.getTierCount("semantic"),
    procedural: p.getTierCount("procedural"),
  };
}
