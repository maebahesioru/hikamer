// ==========================================
// Aikata - コンテキストエンジン（OpenClaw Context Engine Plugin System 由来）
// プラグイン式コンテキストアセンブリ + 制御プレーンフィンガープリント
// ==========================================

import { logger } from "./utils/logger";
import { createHash } from "crypto";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type ContextSource = "load" | "control_plane" | "runtime" | "hook" | "fast";

export interface ContextFingerprint {
  discovery: string;
  policy: string;
  inventory: string;
  activation: string;
}

export interface RuntimeContext {
  channelId: string;
  accountId: string;
  capability: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ContextEngineConfig {
  maxRuntimeContexts: number;
  fingerprintEnabled: boolean;
  cacheTtlMs: number;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: ContextEngineConfig = {
  maxRuntimeContexts: 1000,
  fingerprintEnabled: true,
  cacheTtlMs: 300000, // 5分
};

// ==================== コンテキストエンジン ====================

class ContextEngine {
  private config: ContextEngineConfig = { ...DEFAULT_CONFIG };

  // ランタイムコンテキストレジストリ
  private runtimeContexts = new Map<string, RuntimeContext>();

  // フィンガープリント
  private fingerprint: ContextFingerprint | null = null;

  // キャッシュ
  private cache = new Map<string, { value: unknown; expiresAt: number }>();

  /** 設定更新 */
  configure(cfg: Partial<ContextEngineConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  // ==================== フィンガープリント ====================

  /** 制御プレーンフィンガープリントを計算 */
  computeFingerprint(params: {
    discoveryRoots?: string[];
    policy?: Record<string, unknown>;
    inventory?: string[];
    activation?: string[];
  }): ContextFingerprint {
    const fp: ContextFingerprint = {
      discovery: this.hashJson(params.discoveryRoots || []),
      policy: this.hashJson(params.policy || {}),
      inventory: this.hashJson((params.inventory || []).sort()),
      activation: this.hashJson((params.activation || []).sort()),
    };
    this.fingerprint = fp;
    return fp;
  }

  /** 現在のフィンガープリントを取得 */
  getFingerprint(): ContextFingerprint | null {
    return this.fingerprint;
  }

  /** フィンガープリントの完全ハッシュ */
  getFingerprintHash(): string {
    if (!this.fingerprint) return "none";
    return this.hashJson(this.fingerprint);
  }

  // ==================== ランタイムコンテキストレジストリ ====================

  /** ランタイムコンテキストを登録 */
  registerRuntimeContext(
    channelId: string,
    accountId: string,
    capability: string,
    data: Record<string, unknown>,
  ): void {
    const key = `${channelId}\x00${accountId}\x00${capability}`;
    const ctx: RuntimeContext = { channelId, accountId, capability, data, createdAt: Date.now() };

    this.runtimeContexts.set(key, ctx);

    // 上限超過時は古いものから削除
    if (this.runtimeContexts.size > this.config.maxRuntimeContexts) {
      const oldest = Array.from(this.runtimeContexts.entries())
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
      if (oldest) this.runtimeContexts.delete(oldest[0]);
    }

    eventBus.publish(createEvent("context", "registered", { key, channelId, capability }));
  }

  /** ランタイムコンテキストを取得 */
  getRuntimeContext(channelId: string, accountId: string, capability: string): RuntimeContext | undefined {
    return this.runtimeContexts.get(`${channelId}\x00${accountId}\x00${capability}`);
  }

  /** チャンネルの全コンテキストを取得 */
  getChannelContexts(channelId: string): RuntimeContext[] {
    return Array.from(this.runtimeContexts.values()).filter((c) => c.channelId === channelId);
  }

  /** コンテキストを解除 */
  unregisterRuntimeContext(channelId: string, accountId: string, capability: string): boolean {
    const key = `${channelId}\x00${accountId}\x00${capability}`;
    const existed = this.runtimeContexts.delete(key);
    if (existed) {
      eventBus.publish(createEvent("context", "unregistered", { key, channelId }));
    }
    return existed;
  }

  // ==================== キャッシュ ====================

  /** キャッシュに保存 */
  cacheSet<T>(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.config.cacheTtlMs });
  }

  /** キャッシュから取得 */
  cacheGet<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** キャッシュクリア */
  cacheClear(): void {
    this.cache.clear();
  }

  /** 期限切れキャッシュを削除 */
  cachePrune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  // ==================== クイックコンテキスト解決 ====================

  /** テキストからコンテキスト情報を抽出 */
  extractContextFromText(text: string, limit = 2000): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    return cleaned.length > limit ? cleaned.slice(0, limit - 3) + "..." : cleaned;
  }

  // ==================== 内部 ====================

  private hashJson(data: unknown): string {
    return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  }

  /** 統計 */
  getStats(): Record<string, number> {
    return {
      runtimeContexts: this.runtimeContexts.size,
      cacheEntries: this.cache.size,
      maxRuntimeContexts: this.config.maxRuntimeContexts,
      cacheTtlMs: this.config.cacheTtlMs,
    };
  }

  formatStatus(): string {
    const stats = this.getStats();
    const fp = this.getFingerprint();
    return [
      "🧩 **Context Engine**",
      `  ランタイムコンテキスト: ${stats.runtimeContexts}/${stats.maxRuntimeContexts}`,
      `  キャッシュ: ${stats.cacheEntries}エントリ (TTL: ${stats.cacheTtlMs / 1000}秒)`,
      fp ? `  フィンガープリント: ${this.getFingerprintHash()}` : "  フィンガープリント: 未計算",
      `  フィンガープリント有効: ${this.config.fingerprintEnabled ? "ON" : "OFF"}`,
    ].join("\n");
  }
}

export const contextEngine = new ContextEngine();
