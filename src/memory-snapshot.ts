// ==========================================
// Hikamer - Gitスナップショット（メモリバージョン管理）
// 出典: agentmemory (rohitg00/agentmemory) Git Snapshots
// ==========================================

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

const SNAPSHOT_DIR = resolve(process.env.DATA_DIR || "./data", "memory-snapshots");
const MEMORY_DIR = resolve(process.env.DATA_DIR || "./data", "memory");

interface SnapshotInfo {
  id: string;
  timestamp: number;
  message: string;
  fileCount: number;
}

class MemorySnapshot {
  private initialized = false;

  /**
   * Gitリポジトリを初期化
   */
  init(): void {
    if (this.initialized) return;

    if (!existsSync(SNAPSHOT_DIR)) {
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }

    try {
      if (!existsSync(resolve(SNAPSHOT_DIR, ".git"))) {
        execSync("git init", { cwd: SNAPSHOT_DIR, stdio: "pipe" });
        execSync('git config user.name "Hikamer Memory"', { cwd: SNAPSHOT_DIR, stdio: "pipe" });
        execSync('git config user.email "memory@hikamer.local"', { cwd: SNAPSHOT_DIR, stdio: "pipe" });

        // .gitignore
        writeFileSync(resolve(SNAPSHOT_DIR, ".gitignore"), "node_modules/\n");
        execSync("git add .gitignore", { cwd: SNAPSHOT_DIR, stdio: "pipe" });
        execSync('git commit -m "init"', { cwd: SNAPSHOT_DIR, stdio: "pipe" });
      }

      this.initialized = true;
      logger.info("[MemorySnapshot] Gitリポジトリ初期化完了");
    } catch (e: any) {
      logger.warn(`[MemorySnapshot] Git初期化失敗: ${e.message}`);
    }
  }

  /**
   * 現在のメモリ状態をスナップショットとして保存
   * agentmemory: memory_snapshot_create
   */
  snapshot(message: string = `snapshot ${Date.now()}`): SnapshotInfo | null {
    if (!this.initialized) this.init();
    if (!this.initialized) return null;

    try {
      // メモリファイルをスナップショットディレクトリにコピー
      this.syncMemoryFiles();

      execSync("git add -A", { cwd: SNAPSHOT_DIR, stdio: "pipe" });

      // 変更がない場合はスキップ
      const status = execSync("git status --porcelain", { cwd: SNAPSHOT_DIR, stdio: "pipe" }).toString().trim();
      if (!status) {
        logger.debug("[MemorySnapshot] 変更なし、スナップショットスキップ");
        return null;
      }

      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: SNAPSHOT_DIR, stdio: "pipe" });

      const id = execSync("git rev-parse --short HEAD", { cwd: SNAPSHOT_DIR, stdio: "pipe" }).toString().trim();
      const info: SnapshotInfo = {
        id,
        timestamp: Date.now(),
        message,
        fileCount: status.split("\n").length,
      };

      logger.info(`[MemorySnapshot] 保存: ${id} "${message}" (${info.fileCount}ファイル)`);
      return info;
    } catch (e: any) {
      logger.warn(`[MemorySnapshot] 保存失敗: ${e.message}`);
      return null;
    }
  }

  /**
   * スナップショット一覧
   */
  list(): SnapshotInfo[] {
    if (!existsSync(resolve(SNAPSHOT_DIR, ".git"))) return [];

    try {
      const log = execSync(
        'git log --oneline --format="%h|%ct|%s"',
        { cwd: SNAPSHOT_DIR, stdio: "pipe" }
      ).toString().trim();

      if (!log) return [];

      return log.split("\n").map(line => {
        const [id, ts, ...msgParts] = line.split("|");
        return {
          id: id || "unknown",
          timestamp: parseInt(ts || "0") * 1000,
          message: msgParts.join("|"),
          fileCount: 0,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * 特定のスナップショットにロールバック
   * agentmemory: git rollback
   */
  rollback(snapshotId: string): boolean {
    if (!this.initialized) this.init();
    if (!this.initialized) return false;

    try {
      execSync(`git checkout ${snapshotId} -- .`, { cwd: SNAPSHOT_DIR, stdio: "pipe" });
      logger.info(`[MemorySnapshot] ロールバック: ${snapshotId}`);

      // メモリファイルを元の場所にコピー
      this.syncBack();

      // masterに戻る
      execSync("git checkout master", { cwd: SNAPSHOT_DIR, stdio: "pipe" });
      return true;
    } catch (e: any) {
      logger.error(`[MemorySnapshot] ロールバック失敗: ${e.message}`);
      return false;
    }
  }

  /**
   * 差分を表示
   */
  diff(snapshotId: string): string {
    try {
      const diff = execSync(
        `git diff ${snapshotId}..HEAD -- *.md *.json 2>/dev/null || echo "差分なし"`,
        { cwd: SNAPSHOT_DIR, stdio: "pipe" }
      ).toString();
      return diff.slice(0, 2000);
    } catch {
      return "差分の取得に失敗";
    }
  }

  /**
   * メモリファイルをスナップショットディレクトリと同期
   */
  private syncMemoryFiles(): void {
    if (!existsSync(MEMORY_DIR)) return;

    const files = ["MEMORY.md", "USER.md", "pipeline.json"];
    for (const file of files) {
      const src = resolve(MEMORY_DIR, file);
      const dst = resolve(SNAPSHOT_DIR, file);
      if (existsSync(src)) {
        writeFileSync(dst, readFileSync(src));
      }
    }
  }

  /**
   * スナップショットからメモリファイルを復元
   */
  private syncBack(): void {
    const files = ["MEMORY.md", "USER.md", "pipeline.json"];
    for (const file of files) {
      const src = resolve(SNAPSHOT_DIR, file);
      const dst = resolve(MEMORY_DIR, file);
      if (existsSync(src)) {
        writeFileSync(dst, readFileSync(src));
      }
    }
  }

  /**
   * フォーマットされた一覧
   */
  formatList(): string {
    const snapshots = this.list();
    if (snapshots.length === 0) return "📭 スナップショットがありません";

    return `📸 **メモリスナップショット一覧 (${snapshots.length}件)**
${snapshots.slice(0, 20).map(s =>
  `• \`${s.id}\` ${new Date(s.timestamp).toLocaleString("ja-JP")} — ${s.message}`
).join("\n")}`;
  }
}

export const memorySnapshot = new MemorySnapshot();
