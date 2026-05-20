// ==========================================
// Hikamer - 自動アップデート（OpenHuman update/ 由来）
// Gitベースの自動更新・バージョンチェック・再起動
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  lastCheckAt: number | null;
  updateAvailable: boolean;
  changelog: string[];
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string | null;
  durationMs: number;
  changes: string[];
  error?: string;
}

// ==================== アップデートマネージャー ====================

class UpdateManager {
  private repoPath: string;
  private currentVersion: string;
  private lastCheckAt: number | null = null;
  private cachedLatestVersion: string | null = null;
  private updating = false;

  constructor(repoPath?: string) {
    this.repoPath = repoPath ?? process.cwd();
    this.currentVersion = this.detectVersion();
  }

  init(): void {
    logger.info(`[Update] current version: ${this.currentVersion}`);
  }

  /** 更新をチェック */
  async checkForUpdate(): Promise<UpdateInfo> {
    if (this.updating) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: this.cachedLatestVersion,
        hasUpdate: false,
        lastCheckAt: this.lastCheckAt,
        updateAvailable: false,
        changelog: [],
      };
    }

    this.lastCheckAt = Date.now();
    const isGitRepo = this.checkIsGitRepo();

    if (!isGitRepo) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        hasUpdate: false,
        lastCheckAt: this.lastCheckAt,
        updateAvailable: false,
        changelog: [],
      };
    }

    try {
      // リモートの最新を取得
      execSync("git fetch origin 2>/dev/null", {
        cwd: this.repoPath,
        timeout: 15000,
      });

      // ローカルとリモートの差分をチェック
      const behind = execSync(
        "git rev-list --count HEAD..origin/main 2>/dev/null || git rev-list --count HEAD..origin/master 2>/dev/null",
        { cwd: this.repoPath, timeout: 5000 }
      )
        .toString()
        .trim();

      const behindCount = parseInt(behind, 10);
      const hasUpdate = !isNaN(behindCount) && behindCount > 0;

      // 最新バージョン
      let latestVersion: string | null = null;
      let changelog: string[] = [];

      if (hasUpdate) {
        // リモートの最新コミットメッセージを取得
        const log = execSync(
          `git log HEAD..origin/main --oneline --no-decorate 2>/dev/null || git log HEAD..origin/master --oneline --no-decorate 2>/dev/null`,
          { cwd: this.repoPath, timeout: 5000 }
        )
          .toString()
          .trim();

        changelog = log.split("\n").filter(Boolean).slice(0, 20);
        latestVersion = `origin/main (${behindCount}コミット先)`;
        this.cachedLatestVersion = latestVersion;
      }

      return {
        currentVersion: this.currentVersion,
        latestVersion,
        hasUpdate,
        lastCheckAt: this.lastCheckAt,
        updateAvailable: hasUpdate,
        changelog,
      };
    } catch {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        hasUpdate: false,
        lastCheckAt: this.lastCheckAt,
        updateAvailable: false,
        changelog: [],
      };
    }
  }

  /** 更新を実行 */
  async performUpdate(): Promise<UpdateResult> {
    const start = Date.now();
    const previousVersion = this.currentVersion;

    if (this.updating) {
      return { success: false, previousVersion, newVersion: null, durationMs: Date.now() - start, changes: [], error: "Already updating" };
    }

    this.updating = true;

    try {
      const info = await this.checkForUpdate();
      if (!info.hasUpdate) {
        this.updating = false;
        return { success: false, previousVersion, newVersion: null, durationMs: Date.now() - start, changes: [], error: "No update available" };
      }

      // プル
      execSync("git pull --ff-only origin main 2>/dev/null || git pull --ff-only origin master 2>/dev/null", {
        cwd: this.repoPath,
        timeout: 30000,
      });

      // npm install（依存関係更新）
      if (fs.existsSync(path.join(this.repoPath, "package.json"))) {
        execSync("npm install 2>/dev/null", {
          cwd: this.repoPath,
          timeout: 60000,
        });
      }

      const newVersion = this.detectVersion();
      this.currentVersion = newVersion;

      logger.info(`[Update] updated: ${previousVersion} → ${newVersion}`);

      return {
        success: true,
        previousVersion,
        newVersion,
        durationMs: Date.now() - start,
        changes: info.changelog,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[Update] failed: ${errMsg}`);
      return {
        success: false,
        previousVersion,
        newVersion: null,
        durationMs: Date.now() - start,
        changes: [],
        error: errMsg.slice(0, 200),
      };
    } finally {
      this.updating = false;
    }
  }

  /** バージョン情報を取得 */
  getVersion(): string {
    return this.currentVersion;
  }

  /** バージョンタグを設定 */
  setVersionTag(tag: string): void {
    this.currentVersion = tag;
  }

  // ---- 内部 ----

  private detectVersion(): string {
    try {
      if (this.checkIsGitRepo()) {
        const hash = execSync("git rev-parse --short HEAD 2>/dev/null", {
          cwd: this.repoPath,
          timeout: 3000,
        })
          .toString()
          .trim();
        if (hash) return hash;

        const tag = execSync("git describe --tags 2>/dev/null", {
          cwd: this.repoPath,
          timeout: 3000,
        })
          .toString()
          .trim();
        if (tag) return tag;
      }
    } catch {
      // ignore
    }

    // package.jsonから
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(this.repoPath, "package.json"), "utf-8")
      ) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private checkIsGitRepo(): boolean {
    try {
      return fs.existsSync(path.join(this.repoPath, ".git"));
    } catch {
      return false;
    }
  }

  formatInfo(info: UpdateInfo): string {
    return (
      `🔄 **アップデート情報**\n` +
      `現在: \`${info.currentVersion}\`\n` +
      `最新: ${info.latestVersion ? `\`${info.latestVersion}\`` : "確認できず"}\n` +
      `更新: ${info.hasUpdate ? "✅ あり" : "なし"}\n` +
      `最終確認: ${info.lastCheckAt ? new Date(info.lastCheckAt).toLocaleString("ja-JP") : "未確認"}\n\n` +
      (info.changelog.length > 0
        ? `**変更履歴（直近${info.changelog.length}件）**\n` +
          info.changelog.map((c) => `- ${c}`).join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const updateManager = new UpdateManager();

export default UpdateManager;
