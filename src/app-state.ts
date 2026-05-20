// ==========================================
// Hikamer - アプリ状態管理 + ワークスペース初期化（OpenHuman app_state + workspace由来）
// 永続化状態管理・初回セットアップ・ヘルススナップショット
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface AppState {
  version: string;
  schemaVersion: number;
  firstRun: boolean;
  firstRunAt: number;
  lastRunAt: number;
  runCount: number;
  onboardingCompleted: boolean;
  setupSteps: Record<string, boolean>;
  metrics: {
    totalMessages: number;
    totalCommands: number;
    totalErrors: number;
    uptimeSeconds: number;
  };
  features: Record<string, { enabled: boolean; firstUsed: number; lastUsed: number; useCount: number }>;
}

// ==================== アプリ状態管理 ====================

class AppStateManager {
  private state: AppState;
  private persistPath: string;
  private startTime: number;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "app-state.json");
    this.startTime = Date.now();
    this.state = this.load();
    this.state.lastRunAt = Date.now();
    this.state.runCount++;
    this.save();
  }

  private load(): AppState {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        logger.info(`[AppState] 復元: v${data.version}, ${data.runCount}回目の起動`);
        return data;
      }
    } catch (e) {
      logger.warn(`[AppState] 読込失敗: ${e}`);
    }

    // 初回起動
    const state: AppState = {
      version: "1.16.0",
      schemaVersion: 1,
      firstRun: true,
      firstRunAt: Date.now(),
      lastRunAt: Date.now(),
      runCount: 1,
      onboardingCompleted: false,
      setupSteps: {},
      metrics: { totalMessages: 0, totalCommands: 0, totalErrors: 0, uptimeSeconds: 0 },
      features: {},
    };

    logger.info("[AppState] 初回起動 — 初期状態作成");
    return state;
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[AppState] 保存失敗: ${e}`);
    }
  }

  // ==================== 状態更新 ====================

  incrementMessages(): void { this.state.metrics.totalMessages++; this.save(); }
  incrementCommands(): void { this.state.metrics.totalCommands++; this.save(); }
  incrementErrors(): void { this.state.metrics.totalErrors++; this.save(); }

  completeOnboarding(): void {
    this.state.onboardingCompleted = true;
    this.state.firstRun = false;
    this.save();
  }

  completeSetupStep(step: string): void {
    this.state.setupSteps[step] = true;
    this.save();
  }

  /** 機能の使用を記録 */
  useFeature(name: string): void {
    const now = Date.now();
    if (!this.state.features[name]) {
      this.state.features[name] = { enabled: true, firstUsed: now, lastUsed: now, useCount: 0 };
    }
    this.state.features[name].lastUsed = now;
    this.state.features[name].useCount++;
    this.save();
  }

  /** 起動時間更新（定期呼び出し用） */
  updateUptime(): void {
    this.state.metrics.uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    this.save();
  }

  // ==================== 取得 ====================

  get(): Readonly<AppState> { return this.state; }

  isFirstRun(): boolean { return this.state.firstRun; }

  getUptime(): number { return Math.floor((Date.now() - this.startTime) / 1000); }

  getFeatureStats(): Array<{ name: string; useCount: number; lastUsed: string }> {
    return Object.entries(this.state.features)
      .filter(([, v]) => v.useCount > 0)
      .sort((a, b) => b[1].useCount - a[1].useCount)
      .map(([name, info]) => ({ name, useCount: info.useCount, lastUsed: new Date(info.lastUsed).toLocaleDateString("ja-JP") }));
  }

  // ==================== ワークスペース ====================

  ensureDirectories(): void {
    const dirs = ["data/memory", "data/sessions", "data/cron", "data/tts", "data/ocr", "data/config"];
    for (const d of dirs) {
      const fullPath = resolve(process.env.DATA_DIR || "./data", "..", d);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        logger.debug(`[Workspace] 作成: ${d}`);
      }
    }
  }

  // ==================== フォーマット ====================

  formatState(): string {
    const s = this.state;
    const uptime = this.getUptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${days}d ${hours}h ${mins}m`;

    const topFeatures = this.getFeatureStats().slice(0, 5);
    const featuresStr = topFeatures.length > 0
      ? `\n\n**人気機能TOP5:**\n${topFeatures.map((f, i) => `${i + 1}. ${f.name} (${f.useCount}回)`).join("\n")}`
      : "";

    return [
      `📊 **Hikamer 状態** v${s.version}`,
      `起動: ${s.runCount}回目${s.firstRun ? " 🆕" : ""}`,
      `稼働時間: ${uptimeStr}`,
      `メッセージ: ${s.metrics.totalMessages} | コマンド: ${s.metrics.totalCommands} | エラー: ${s.metrics.totalErrors}`,
      `スキーマ: v${s.schemaVersion} | オンボーディング: ${s.onboardingCompleted ? "✅" : "❌"}`,
      featuresStr,
    ].join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const appState = new AppStateManager(DATA_DIR);
