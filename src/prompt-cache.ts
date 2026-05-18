// ==========================================
// Aikata - プロンプトキャッシュ（Hermes Agent prompt_caching.py 由来）
// APIコスト削減のためのプロンプトキャッシュ戦略
// ==========================================

import { logger } from "./utils/logger";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface CacheEntry {
  key: string;
  model: string;
  systemPrompt: string;
  messages: string;
  response: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  createdAt: number;
  hitCount: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  totalEntries: number;
  oldestEntry: number | null;
  newestEntry: number | null;
  totalTokensSaved: number;
  cacheRatio: number;
  byModel: Record<string, { hits: number; misses: number }>;
}

// ==================== キャッシュマネージャー ====================

class PromptCache {
  private cache: Map<string, CacheEntry> = new Map();
  private hits = 0;
  private misses = 0;
  private totalTokensSaved = 0;
  private byModel: Record<string, { hits: number; misses: number }> = {};
  private maxEntries = 500;
  private defaultTtlMs = 30 * 60 * 1000; // 30分
  private compressionEnabled = true;

  /** キャッシュから検索 */
  get(
    systemPrompt: string,
    messages: string,
    model: string
  ): { entry: CacheEntry; isHit: boolean } | null {
    const key = this.generateKey(systemPrompt, messages, model);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      this.trackModel(model, false);
      return null;
    }

    // TTLチェック
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      this.trackModel(model, false);
      return null;
    }

    // ヒット
    entry.hitCount++;
    this.hits++;
    this.totalTokensSaved += entry.usage.inputTokens;
    this.trackModel(model, true);

    return { entry, isHit: true };
  }

  /** キャッシュに保存 */
  set(entry: Omit<CacheEntry, "key" | "createdAt" | "hitCount">): CacheEntry {
    const key = this.generateKey(entry.systemPrompt, entry.messages, entry.model);

    const cacheEntry: CacheEntry = {
      ...entry,
      key,
      createdAt: Date.now(),
      hitCount: 0,
    };

    this.cache.set(key, cacheEntry);

    // 上限超過時は最も古いエントリを削除
    if (this.cache.size > this.maxEntries) {
      this.evictOldest();
    }

    return cacheEntry;
  }

  /** プロンプトの類似性チェックでキャッシュヒット */
  findSimilar(
    systemPrompt: string,
    messages: string,
    model: string,
    similarityThreshold = 0.8
  ): CacheEntry | null {
    const systemHash = this.hashString(systemPrompt);
    const msgHash = this.hashString(messages);

    for (const entry of this.cache.values()) {
      if (entry.model !== model) continue;
      if (Date.now() - entry.createdAt > entry.ttlMs) continue;

      const existingSystemHash = this.hashString(entry.systemPrompt);
      const existingMsgHash = this.hashString(entry.messages);

      // 簡易類似度: システムプロンプトが一致+メッセージの前方一致
      if (
        existingSystemHash === systemHash &&
        this.computeSimilarity(entry.messages, messages) >= similarityThreshold
      ) {
        return entry;
      }
    }

    return null;
  }

  /** プロンプトをキャッシュするか判断 */
  shouldCache(systemPrompt: string, messages: string): boolean {
    if (!this.compressionEnabled) return false;
    // 短すぎるプロンプトはキャッシュしない
    const totalLen = systemPrompt.length + messages.length;
    if (totalLen < 500) return false;
    return true;
  }

  /** キャッシュをクリア */
  clear(): void {
    const before = this.cache.size;
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalTokensSaved = 0;
    this.byModel = {};
    logger.info(`[PromptCache] cleared (${before} entries)`);
  }

  /** 古いエントリを削除 */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`[PromptCache] cleaned up ${removed} expired entries`);
    }
    return removed;
  }

  /** モデル別のキャッシュをクリア */
  clearModel(model: string): number {
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (entry.model === model) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** TTLを設定 */
  setTtl(ttlMs: number): void {
    this.defaultTtlMs = ttlMs;
  }

  /** 最大エントリ数を設定 */
  setMaxEntries(max: number): void {
    this.maxEntries = max;
  }

  /** 圧縮を有効/無効 */
  setCompressionEnabled(enabled: boolean): void {
    this.compressionEnabled = enabled;
  }

  /** 統計を取得 */
  getStats(): CacheStats {
    const entries = [...this.cache.values()];
    const timestamps = entries.map((e) => e.createdAt);

    return {
      hits: this.hits,
      misses: this.misses,
      totalEntries: this.cache.size,
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
      totalTokensSaved: this.totalTokensSaved,
      cacheRatio: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
      byModel: { ...this.byModel },
    };
  }

  /** キャッシュの一覧を取得 */
  listEntries(limit = 20): { key: string; model: string; hitCount: number; createdAt: number; tokens: number }[] {
    return [...this.cache.values()]
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, limit)
      .map((e) => ({
        key: e.key.slice(0, 16),
        model: e.model,
        hitCount: e.hitCount,
        createdAt: e.createdAt,
        tokens: e.usage.inputTokens,
      }));
  }

  // ---- 内部実装 ----

  private generateKey(systemPrompt: string, messages: string, model: string): string {
    const hash = crypto
      .createHash("md5")
      .update(`${model}:${this.hashString(systemPrompt)}:${this.hashString(messages)}`)
      .digest("hex");
    return `prompt:${hash}`;
  }

  private hashString(text: string): string {
    return crypto.createHash("md5").update(text).digest("hex");
  }

  private computeSimilarity(a: string, b: string): number {
    // 簡易Jaccard類似度（単語ベース）
    const wordsA = new Set(a.split(/\s+/).slice(0, 100));
    const wordsB = new Set(b.split(/\s+/).slice(0, 100));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  private trackModel(model: string, isHit: boolean): void {
    if (!this.byModel[model]) {
      this.byModel[model] = { hits: 0, misses: 0 };
    }
    if (isHit) {
      this.byModel[model]!.hits++;
    } else {
      this.byModel[model]!.misses++;
    }
  }

  formatStats(): string {
    const stats = this.getStats();
    const ratio = (stats.cacheRatio * 100).toFixed(1);
    const tokensK = (stats.totalTokensSaved / 1000).toFixed(1);

    return (
      `📦 **プロンプトキャッシュ統計**\n` +
      `エントリ数: ${stats.totalEntries}\n` +
      `ヒット率: ${ratio}% (${stats.hits}H / ${stats.misses}M)\n` +
      `トークン節約: ${tokensK}K\n\n` +
      `**モデル別**\n` +
      Object.entries(stats.byModel)
        .map(
          ([model, m]) =>
            `- ${model}: ${m.hits}H / ${m.misses}M (${(m.hits / Math.max(m.hits + m.misses, 1) * 100).toFixed(0)}%)`
        )
        .join("\n")
    );
  }
}

// ==================== シングルトン ====================

export const promptCache = new PromptCache();

// ==================== システムコマンド ====================

export function getCacheCommands(): Record<string, (args: string[]) => string> {
  return {
    "/cache": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "stats":
          return promptCache.formatStats();

        case "entries":
        case "list": {
          const entries = promptCache.listEntries();
          if (entries.length === 0) return "📭 キャッシュエントリがありません";
          return (
            `📋 **キャッシュエントリ (${entries.length})**\n\n` +
            entries
              .map(
                (e, i) =>
                  `${i + 1}. \`${e.key}...\` ${e.model} x${e.hitCount}回ヒット` +
                  ` | ${(e.tokens / 1000).toFixed(0)}Kトークン`
              )
              .join("\n")
          );
        }

        case "clear": {
          const before = promptCache["cache"].size;
          promptCache.clear();
          return `🧹 ${before}エントリをクリアしました`;
        }

        case "cleanup": {
          const removed = promptCache.cleanup();
          return removed > 0 ? `🧹 ${removed}エントリを削除しました` : "✅ 期限切れエントリはありません";
        }

        case "ttl": {
          const ttl = parseInt(args[1] ?? "30", 10);
          promptCache.setTtl(ttl * 60 * 1000);
          return `⏱️ TTLを${ttl}分に設定しました`;
        }

        default:
          return (
            `📦 **キャッシュコマンド**\n` +
            `/cache stats — 統計\n` +
            `/cache list — エントリ一覧\n` +
            `/cache clear — 全削除\n` +
            `/cache cleanup — 期限切れ削除\n` +
            `/cache ttl <分> — TTL設定`
          );
      }
    },
  };
}

export default PromptCache;
