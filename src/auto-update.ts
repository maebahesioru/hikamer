// ==========================================
// Aikata - 自動更新（OpenHuman update由来）
// Git pull + 依存更新 + 再起動
// ==========================================

import { execSync, spawn } from "child_process";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 更新管理 ====================

interface UpdateInfo {
  currentCommit: string;
  currentTag: string;
  remoteCommit: string;
  remoteTag: string;
  hasUpdate: boolean;
  commitsBehind: number;
  changelog: string[];
}

interface UpdateResult {
  success: boolean;
  pulled: boolean;
  depsInstalled: boolean;
  restartRequired: boolean;
  message: string;
  changelog?: string[];
}

class AutoUpdater {
  private repoPath: string;
  private checking = false;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
  }

  /** 更新があるかチェック */
  checkForUpdates(): UpdateInfo {
    try {
      const currentCommit = execSync("git rev-parse HEAD", {
        cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
      }).toString().trim();

      const currentTag = this.getCurrentTag();

      // remote fetch
      execSync("git fetch --tags", {
        cwd: this.repoPath, timeout: 15000, encoding: "utf-8",
      });

      const remoteCommit = execSync("git rev-parse origin/main", {
        cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
      }).toString().trim();

      // タグ取得
      let remoteTag = "";
      try {
        remoteTag = execSync("git describe --tags origin/main 2>/dev/null || echo ''", {
          cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
        }).toString().trim();
      } catch {}

      // ビハインド数
      let commitsBehind = 0;
      try {
        const behind = execSync(`git rev-list --count HEAD..origin/main 2>/dev/null || echo "0"`, {
          cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
        }).toString().trim();
        commitsBehind = parseInt(behind, 10) || 0;
      } catch {}

      // 変更履歴
      let changelog: string[] = [];
      if (commitsBehind > 0) {
        try {
          const log = execSync("git log HEAD..origin/main --oneline --no-decorate 2>/dev/null || true", {
            cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
          }).toString().trim();
          changelog = log.split("\n").filter(Boolean).slice(0, 20);
        } catch {}
      }

      const result: UpdateInfo = {
        currentCommit: currentCommit.slice(0, 12),
        currentTag,
        remoteCommit: remoteCommit.slice(0, 12),
        remoteTag,
        hasUpdate: currentCommit !== remoteCommit,
        commitsBehind,
        changelog,
      };

      logger.info(`[Updater] 更新チェック: ${result.commitsBehind}件遅れ (${result.hasUpdate ? "更新あり" : "最新"})`);
      return result;
    } catch (e: any) {
      logger.warn(`[Updater] チェック失敗: ${e.message}`);
      return {
        currentCommit: "unknown", currentTag: "", remoteCommit: "",
        remoteTag: "", hasUpdate: false, commitsBehind: 0, changelog: [],
      };
    }
  }

  /** 更新を適用（git pull + npm install） */
  applyUpdate(): UpdateResult {
    try {
      const info = this.checkForUpdates();
      if (!info.hasUpdate) {
        return {
          success: true,
          pulled: false,
          depsInstalled: false,
          restartRequired: false,
          message: "既に最新です。",
        };
      }

      // git pull
      logger.info(`[Updater] Pull開始: ${info.commitsBehind}コミット`);
      const pullOutput = execSync("git pull origin main --ff-only 2>&1 || git pull origin main 2>&1", {
        cwd: this.repoPath, timeout: 30000, encoding: "utf-8",
      }).toString().trim();
      logger.info(`[Updater] Pull完了: ${pullOutput.slice(0, 200)}`);

      // 依存関係更新
      let depsInstalled = false;
      try {
        // package.jsonの変更を検出
        const pkgChanged = execSync("git diff HEAD@{1}..HEAD --name-only 2>/dev/null || echo ''", {
          cwd: this.repoPath, timeout: 5000, encoding: "utf-8",
        }).toString().trim();

        if (pkgChanged.includes("package.json") || pkgChanged.includes("package-lock.json")) {
          logger.info("[Updater] 依存関係更新…");
          execSync("npm install 2>&1 || true", {
            cwd: this.repoPath, timeout: 60000,
          });
          depsInstalled = true;
          logger.info("[Updater] 依存関係更新完了");
        }
      } catch (e: any) {
        logger.warn(`[Updater] 依存更新スキップ: ${e.message}`);
      }

      eventBus.publish(createEvent("system", "updateApplied", {
        commits: info.commitsBehind,
        changelog: info.changelog,
      }));

      return {
        success: true,
        pulled: true,
        depsInstalled,
        restartRequired: true,
        message: `更新完了: ${info.commitsBehind}コミット反映`,
        changelog: info.changelog,
      };
    } catch (e: any) {
      logger.error(`[Updater] 更新失敗: ${e.message}`);
      return {
        success: false,
        pulled: false,
        depsInstalled: false,
        restartRequired: false,
        message: `更新失敗: ${e.message}`,
      };
    }
  }

  /** プロセス再起動 */
  restart(): void {
    logger.info("[Updater] 再起動…");
    eventBus.publish(createEvent("system", "restarting", {
      reason: "update",
    }));

    // 現在のプロセスを置き換え
    const args = process.argv.slice(1);
    const cmd = process.execPath;

    // 子プロセスとして新しいインスタンス起動
    const child = spawn(cmd, args, {
      stdio: "inherit",
      detached: true,
      env: { ...process.env, AIKATA_RESTART: "1" },
    });
    child.unref();

    // 現在のプロセス終了
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }

  /** 自動更新ループを開始 */
  startAutoUpdate(intervalMs: number = 3600000): void {
    // チェック→更新→再起動のループ
    setInterval(async () => {
      if (this.checking) return;
      this.checking = true;

      try {
        const info = this.checkForUpdates();
        if (info.hasUpdate) {
          logger.info(`[Updater] 自動更新検出: ${info.commitsBehind}コミット`);
          const result = this.applyUpdate();
          if (result.success && result.restartRequired) {
            logger.info("[Updater] 更新適用完了。再起動します…");
            setTimeout(() => this.restart(), 5000);
          }
        }
      } catch (e: any) {
        logger.error(`[Updater] 自動更新エラー: ${e.message}`);
      } finally {
        this.checking = false;
      }
    }, intervalMs);

    logger.info(`[Updater] 自動更新ループ開始: ${intervalMs / 60000}分間隔`);
  }

  /** 情報表示 */
  formatInfo(): string {
    const info = this.checkForUpdates();

    const lines = [
      "🔄 **アップデート状態**",
      `現在: \`${info.currentCommit}\``,
    ];

    if (info.currentTag) lines.push(`タグ: ${info.currentTag}`);

    if (info.hasUpdate) {
      lines.push(`リモート: \`${info.remoteCommit}\``);
      if (info.remoteTag) lines.push(`リモートタグ: ${info.remoteTag}`);
      lines.push(`**${info.commitsBehind}コミット遅れ**`);
      if (info.changelog.length > 0) {
        lines.push("", "**変更履歴:**");
        for (const log of info.changelog.slice(0, 10)) {
          lines.push(`  ${log}`);
        }
      }
      lines.push("", "`/update apply` で更新を適用");
    } else {
      lines.push("✅ **最新です**");
    }

    return lines.join("\n");
  }

  private getCurrentTag(): string {
    try {
      return execSync("git describe --tags --exact-match HEAD 2>/dev/null || echo ''", {
        cwd: this.repoPath, timeout: 3000, encoding: "utf-8",
      }).toString().trim();
    } catch {
      return "";
    }
  }
}

// ==================== シングルトン ====================

export const autoUpdater = new AutoUpdater();
