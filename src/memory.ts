// ==========================================
// Aikata - メモリ管理
// 後方互換維持 + memory-bridge（agentmemory由来）への拡張リダイレクト
// v1.38: ハイブリッド検索 + 4-Tierパイプライン + 自動観察
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  getAgentMemory as bridgeGetAgentMemory,
  writeAgentMemory as bridgeWriteAgentMemory,
  getUserProfile as bridgeGetUserProfile,
  writeUserProfile as bridgeWriteUserProfile,
  buildEnhancedMemoryBlock,
  searchMemory,
  observeMemory,
  rememberExplicitly,
  getMemoryStats,
  consolidateNow,
  loadPipelineFromDisk,
} from "./memory-bridge";
import { logger } from "./utils/logger";

// ==================== 既存パス設定（互換性維持） ====================

const MEMORY_DIR = resolve(process.env.DATA_DIR || "./data", "memory");
const MEMORY_FILE = resolve(MEMORY_DIR, "MEMORY.md");
const USER_FILE = resolve(MEMORY_DIR, "USER.md");

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
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

// ==================== 既存API（完全後方互換） ====================

/** エージェントメモリを取得（Frozen Snapshot + 拡張パイプライン参照） */
export function getAgentMemory(): string {
  return bridgeGetAgentMemory() || readFileSafe(MEMORY_FILE);
}

/** ユーザープロファイルを取得 */
export function getUserProfile(): string {
  return bridgeGetUserProfile() || readFileSafe(USER_FILE);
}

/** エージェントメモリを更新 */
export function writeAgentMemory(content: string): void {
  writeFileSafe(MEMORY_FILE, content);
  bridgeWriteAgentMemory(content);
}

/** ユーザープロファイルを更新 */
export function writeUserProfile(content: string): void {
  writeFileSafe(USER_FILE, content);
  bridgeWriteUserProfile(content);
}

/**
 * メモリブロックを生成（拡張版：ハイブリッド検索結果も含む）
 * 従来のbuildMemoryBlockの完全上位互換
 */
export async function buildMemoryBlockAsync(contextQuery?: string): Promise<string> {
  if (contextQuery) {
    try {
      return await buildEnhancedMemoryBlock(contextQuery, 1500);
    } catch (e) {
      logger.warn(`[Memory] 拡張メモリブロック生成失敗、従来方式にフォールバック: ${e}`);
    }
  }
  return buildMemoryBlock();
}

/** メモリブロック（同期的。従来互換） */
export function buildMemoryBlock(): string {
  const memory = bridgeGetAgentMemory() || readFileSafe(MEMORY_FILE);
  const user = bridgeGetUserProfile() || readFileSafe(USER_FILE);
  const parts: string[] = [];

  if (memory) parts.push(`<agent_memory>\n${memory}\n</agent_memory>`);
  if (user) parts.push(`<user_profile>\n${user}\n</user_profile>`);
  if (parts.length === 0) return "";

  return `\n\n## 永続メモリ\n以下の情報はセッション間で保持されます。\n${parts.join("\n")}\n`;
}

/** メモリファイルが存在するか */
export function hasMemory(): boolean {
  return existsSync(MEMORY_FILE) && readFileSync(MEMORY_FILE, "utf-8").trim().length > 0;
}

// ==================== 拡張API（新機能。旧コードからは使われない） ====================

export {
  searchMemory,
  observeMemory,
  rememberExplicitly,
  getMemoryStats,
  consolidateNow,
};

/** 起動時にパイプラインを初期化（index.tsから呼ばれる） */
export function initMemoryPipeline(): void {
  try {
    loadPipelineFromDisk();
    logger.info("[Memory] メモリパイプライン初期化完了");
  } catch (e) {
    logger.warn(`[Memory] パイプライン初期化エラー: ${e}`);
  }
}
