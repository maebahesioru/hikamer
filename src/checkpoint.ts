// ==========================================
// Aikata - チェックポイント永続化（Hermes Agent由来）
// エージェント状態をJSONに保存。再起動後も継続
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const CP_DIR = resolve(DATA_DIR, "checkpoints");

// ==================== 型 ====================

export interface Checkpoint {
  id: string;
  timestamp: number;
  conversationId: string;
  iteration: number;
  maxIterations: number;
  /** 会話の要約（復元時のシステムプロンプト用） */
  summary: string;
  /** 保存時の関連ファイルリスト */
  files: string[];
  /** メタデータ */
  metadata?: Record<string, unknown>;
}

// ==================== チェックポイント管理 ====================

class CheckpointManager {
  /** チェックポイントを保存 */
  save(cp: Omit<Checkpoint, "id" | "timestamp">): string {
    ensureDir(CP_DIR);

    const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const full: Checkpoint = { ...cp, id, timestamp: Date.now() };
    const path = resolve(CP_DIR, `${id}.json`);

    writeFileSync(path, JSON.stringify(full, null, 2), "utf-8");
    logger.info(`チェックポイント保存: ${id} (${cp.conversationId} #${cp.iteration})`);

    // 古いチェックポイントをクリーンアップ（同一conversationIdは最大5）
    this.cleanup(cp.conversationId, 5);

    return id;
  }

  /** チェックポイントを読み込む */
  load(id: string): Checkpoint | null {
    const path = resolve(CP_DIR, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint;
    } catch {
      return null;
    }
  }

  /** 最新のチェックポイントを取得 */
  latest(conversationId: string): Checkpoint | null {
    const all = this.list(conversationId);
    return all.length > 0 ? all[0]! : null;
  }

  /** 会話のチェックポイント一覧 */
  list(conversationId?: string): Checkpoint[] {
    ensureDir(CP_DIR);
    let files = readdirSync(CP_DIR).filter(f => f.endsWith(".json"));

    const all: Checkpoint[] = [];
    for (const f of files) {
      try {
        const cp = JSON.parse(readFileSync(resolve(CP_DIR, f), "utf-8")) as Checkpoint;
        if (!conversationId || cp.conversationId === conversationId) {
          all.push(cp);
        }
      } catch {}
    }

    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 削除 */
  delete(id: string): boolean {
    const path = resolve(CP_DIR, `${id}.json`);
    if (!existsSync(path)) return false;
    try { unlinkSync(path); return true; } catch { return false; }
  }

  /** 古いチェックポイントを削除（同一会話の最新N件のみ保持） */
  private cleanup(conversationId: string, maxKeep: number): void {
    const all = this.list(conversationId);
    if (all.length <= maxKeep) return;
    for (const cp of all.slice(maxKeep)) {
      this.delete(cp.id);
      logger.debug(`古いチェックポイント削除: ${cp.id}`);
    }
  }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export const checkpointManager = new CheckpointManager();
