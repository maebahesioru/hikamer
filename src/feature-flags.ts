// ==========================================
// Hikamer - フィーチャーフラグ（Hermes Agent feature flags由来）
// 機能の動的ON/OFF、A/Bテスト、段階的ロールアウト
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type FlagState = "enabled" | "disabled" | "experimental" | "deprecated";

export interface FeatureFlag {
  key: string;
  name: string;
  description: string;
  state: FlagState;
  owner: string;
  defaultState: FlagState;
  createdAt: number;
  updatedAt: number;
  enabledForUsers?: string[];     // 特定ユーザーのみ有効
  enabledForPercent?: number;     // 0-100 ランダムロールアウト
  dependsOn?: string[];           // 依存フラグ
}

// ==================== フラグ管理 ====================

class FeatureFlags {
  private flags = new Map<string, FeatureFlag>();
  private persistPath: string;
  private overrides = new Map<string, boolean>(); // ランタイムオーバーライド

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "feature-flags.json");
    this.load();
    this.registerDefaults();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data: FeatureFlag[] = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        for (const f of data) this.flags.set(f.key, f);
      }
    } catch (e) {
      logger.warn(`[FeatureFlag] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(Array.from(this.flags.values()), null, 2), "utf-8");
    } catch (e) {
      logger.error(`[FeatureFlag] 保存失敗: ${e}`);
    }
  }

  /** デフォルトフラグ登録 */
  private registerDefaults(): void {
    const defaults: FeatureFlag[] = [
      { key: "streaming", name: "ストリーミング応答", description: "LLM応答をストリーミング表示", state: "enabled", owner: "core", defaultState: "enabled", createdAt: 0, updatedAt: 0 },
      { key: "tools.terminal", name: "ターミナル実行", description: "シェルコマンド実行機能", state: "enabled", owner: "core", defaultState: "enabled", createdAt: 0, updatedAt: 0 },
      { key: "tools.browser", name: "ブラウザ操作", description: "ブラウザ自動操作", state: "enabled", owner: "core", defaultState: "enabled", createdAt: 0, updatedAt: 0 },
      { key: "tools.code", name: "コード実行", description: "コード実行機能", state: "enabled", owner: "core", defaultState: "enabled", createdAt: 0, updatedAt: 0 },
      { key: "memory.persistence", name: "メモリ永続化", description: "長期メモリのファイル保存", state: "enabled", owner: "core", defaultState: "enabled", createdAt: 0, updatedAt: 0 },
      { key: "experimental.voice", name: "音声出力", description: "TTS音声生成（実験的）", state: "experimental", owner: "core", defaultState: "experimental", createdAt: 0, updatedAt: 0 },
      { key: "experimental.sandbox", name: "サンドボックス実行", description: "隔離環境コマンド実行", state: "experimental", owner: "core", defaultState: "experimental", createdAt: 0, updatedAt: 0 },
      { key: "deprecated.webhook", name: "Webhook旧サーバー", description: "旧Webhookシステム", state: "deprecated", owner: "core", defaultState: "deprecated", createdAt: 0, updatedAt: 0 },
    ];

    for (const flag of defaults) {
      if (!this.flags.has(flag.key)) {
        flag.createdAt = Date.now();
        flag.updatedAt = Date.now();
        this.flags.set(flag.key, flag);
      }
    }
  }

  /** フラグが有効かチェック */
  isEnabled(key: string, userId?: string): boolean {
    // ランタイムオーバーライド優先
    if (this.overrides.has(key)) return this.overrides.get(key)!;

    const flag = this.flags.get(key);
    if (!flag) return false;

    if (flag.state === "disabled") return false;

    // 特定ユーザー許可
    if (flag.enabledForUsers && userId && flag.enabledForUsers.includes(userId)) return true;

    // パーセントロールアウト
    if (flag.enabledForPercent !== undefined && userId) {
      const userHash = this.hashString(userId) % 100;
      if (userHash >= flag.enabledForPercent) return false;
    }

    // 依存フラグチェック
    if (flag.dependsOn) {
      for (const dep of flag.dependsOn) {
        if (!this.isEnabled(dep, userId)) return false;
      }
    }

    return flag.state === "enabled";
  }

  /** ユーザーハッシュ（パーセントロールアウト用） */
  private hashString(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /** ランタイムオーバーライド */
  setOverride(key: string, enabled: boolean): void {
    this.overrides.set(key, enabled);
    logger.info(`[FeatureFlag] オーバーライド: ${key} = ${enabled}`);
    eventBus.publish(createEvent("system", "featureFlagChanged", { key, enabled }));
  }

  clearOverride(key: string): void {
    this.overrides.delete(key);
  }

  clearAllOverrides(): void {
    this.overrides.clear();
  }

  /** フラグの状態を変更 */
  setState(key: string, state: FlagState): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;
    flag.state = state;
    flag.updatedAt = Date.now();
    this.save();
    logger.info(`[FeatureFlag] 状態変更: ${key} → ${state}`);
    eventBus.publish(createEvent("system", "featureFlagStateChanged", { key, state }));
    return true;
  }

  /** フラグ登録 */
  register(flag: Omit<FeatureFlag, "createdAt" | "updatedAt">): void {
    const existing = this.flags.get(flag.key);
    if (!existing) {
      this.flags.set(flag.key, { ...flag, createdAt: Date.now(), updatedAt: Date.now() });
      this.save();
    }
  }

  /** フラグ一覧 */
  listFlags(): FeatureFlag[] {
    return Array.from(this.flags.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  /** フォーマット */
  formatFlags(filter?: FlagState): string {
    let flags = this.listFlags();
    if (filter) flags = flags.filter(f => f.state === filter);

    if (flags.length === 0) return "該当するフラグはありません。";

    const stateIcons: Record<FlagState, string> = { enabled: "✅", disabled: "❌", experimental: "🧪", deprecated: "⚠️" };

    return [
      "🏳️ **フィーチャーフラグ一覧**",
      "",
      ...flags.map(f => {
        const icon = stateIcons[f.state] || "❓";
        const override = this.overrides.has(f.key) ? ` (オーバーライド: ${this.overrides.get(f.key)})` : "";
        return `${icon} **${f.key}**: ${f.name} — ${f.description}${override}`;
      }),
      `\n${this.listFlags().length}フラグ中 ${flags.length}件表示`,
    ].join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const featureFlags = new FeatureFlags(DATA_DIR);
