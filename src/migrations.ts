// ==========================================
// Hikamer - スキーママイグレーション（OpenHuman migrations/由来）
// データベーススキーマの自動バージョン管理・移行
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";
import { db } from "./db";

// ==================== 型定義 ====================

export interface Migration {
  id: number;
  name: string;
  description: string;
  up: string;        // SQL
  down?: string;     // ロールバックSQL
  createdAt: string;
  runAt?: string;
  durationMs?: number;
  checksum?: string;
}

// ==================== マイグレーション管理 ====================

class MigrationManager {
  private migrations: Migration[] = [];
  private persistPath: string;
  private tableName = "_migrations";

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "migrations.json");
    this.ensureMetaTable();
    this.registerBuiltin();
  }

  /** メタテーブル作成 */
  private ensureMetaTable(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT (datetime('now')),
        duration_ms INTEGER DEFAULT 0,
        checksum TEXT
      )
    `);
  }

  /** 組み込みマイグレーション登録 */
  private registerBuiltin(): void {
    this.register({
      id: 1,
      name: "initial_schema",
      description: "初回スキーマ作成",
      up: `
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          messages TEXT,
          title TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT,
          role TEXT,
          content TEXT,
          tool_calls TEXT,
          tool_call_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `,
      createdAt: "2026-04-01",
    });

    this.register({
      id: 2,
      name: "add_memory_tree",
      description: "メモリツリーカラム追加",
      up: `
        CREATE TABLE IF NOT EXISTS memory_tree (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          type TEXT,
          label TEXT,
          content TEXT,
          tags TEXT,
          created_at INTEGER,
          updated_at INTEGER
        );
      `,
      createdAt: "2026-05-01",
    });

    this.register({
      id: 3,
      name: "add_cron_table",
      description: "cronジョブ管理テーブル",
      up: `
        CREATE TABLE IF NOT EXISTS cron_jobs (
          id TEXT PRIMARY KEY,
          name TEXT,
          schedule TEXT,
          prompt TEXT,
          last_run TEXT,
          next_run TEXT,
          enabled INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `,
      createdAt: "2026-05-10",
    });
  }

  /** マイグレーション登録 */
  register(migration: Migration): void {
    if (!this.migrations.find(m => m.id === migration.id)) {
      this.migrations.push(migration);
    }
  }

  /** 未実行のマイグレーションを全て実行 */
  runPending(): { executed: number; total: number; errors: string[] } {
    const executed: number[] = [];
    const errors: string[] = [];
    const alreadyRun = this.getRunIds();

    const pending = this.migrations
      .filter(m => !alreadyRun.has(m.id))
      .sort((a, b) => a.id - b.id);

    for (const migration of pending) {
      try {
        const start = Date.now();
        db.exec(migration.up);
        const duration = Date.now() - start;

        // 記録
        const checksum = this.calcChecksum(migration.up);
        db.prepare(`INSERT INTO ${this.tableName} (id, name, duration_ms, checksum) VALUES (?, ?, ?, ?)`)
          .run(migration.id, migration.name, duration, checksum);

        executed.push(migration.id);
        logger.info(`[Migration] 実行: ${migration.name} (id=${migration.id}, ${duration}ms)`);
      } catch (e: any) {
        errors.push(`Migration ${migration.id} (${migration.name}): ${e.message}`);
        logger.error(`[Migration] 失敗: ${migration.name} — ${e.message}`);
      }
    }

    return { executed: executed.length, total: this.migrations.length, errors };
  }

  /** ロールバック（最新1件） */
  rollback(): boolean {
    const lastRun = db.prepare(`SELECT id, name FROM ${this.tableName} ORDER BY id DESC LIMIT 1`).get() as any;
    if (!lastRun) return false;

    const migration = this.migrations.find(m => m.id === lastRun.id);
    if (!migration || !migration.down) return false;

    try {
      db.exec(migration.down);
      db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(migration.id);
      logger.info(`[Migration] ロールバック: ${migration.name}`);
      return true;
    } catch (e: any) {
      logger.error(`[Migration] ロールバック失敗: ${e.message}`);
      return false;
    }
  }

  /** 実行済みID一覧 */
  private getRunIds(): Set<number> {
    try {
      const rows = db.prepare(`SELECT id FROM ${this.tableName}`).all() as any[];
      return new Set(rows.map(r => r.id));
    } catch {
      return new Set();
    }
  }

  /** 状態 */
  getStatus(): { total: number; pending: number; executed: number; lastRun?: string } {
    const executed = this.getRunIds();
    let lastRun: string | undefined;

    try {
      const last = db.prepare(`SELECT run_at FROM ${this.tableName} ORDER BY id DESC LIMIT 1`).get() as any;
      if (last) lastRun = last.run_at;
    } catch {}

    return {
      total: this.migrations.length,
      pending: this.migrations.length - executed.size,
      executed: executed.size,
      lastRun,
    };
  }

  private calcChecksum(sql: string): string {
    let hash = 0;
    for (let i = 0; i < sql.length; i++) {
      hash = ((hash << 5) - hash) + sql.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  formatStatus(): string {
    const status = this.getStatus();
    const lines = [
      "🗄️ **マイグレーション状態**",
      `全マイグレーション: ${status.total}`,
      `実行済み: ${status.executed}`,
      `未実行: ${status.pending}`,
      status.lastRun ? `最終実行: ${status.lastRun}` : "",
    ];

    if (status.pending > 0) {
      const pending = this.migrations
        .filter(m => !this.getRunIds().has(m.id))
        .map(m => `• #${m.id} ${m.name}: ${m.description}`);
      lines.push("", "**保留中:**", ...pending);
    }

    return lines.join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const migrationManager = new MigrationManager(DATA_DIR);
