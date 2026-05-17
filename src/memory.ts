// ==========================================
// Aikata - メモリ管理（Frozen Snapshot方式）
// Hermes AgentのMEMORY.md + USER.md パターン
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const MEMORY_DIR = resolve(process.env.DATA_DIR || "./data", "memory");
const MEMORY_FILE = resolve(MEMORY_DIR, "MEMORY.md");
const USER_FILE = resolve(MEMORY_DIR, "USER.md");

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/** メモリ内容を読み込む（存在しなければ空文字） */
function readFileSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** メモリ内容を書き込む */
function writeFileSafe(path: string, content: string): void {
  ensureDir();
  writeFileSync(path, content, "utf-8");
}

// ==================== 公開API ====================

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
