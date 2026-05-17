// ==========================================
// Aikata - セッションキャッシュ（LRU + Idle TTL）
// 会話セッションの状態をキャッシュして効率化
// ==========================================

import { logger } from "./utils/logger";

interface CacheEntry<T> {
  data: T;
  lastAccess: number;
  createdAt: number;
}

/** LRU+TTLキャッシュ */
export class SessionCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private _hits = 0;
  private _misses = 0;

  constructor(
    private maxSize: number = 128,
    private ttlMs: number = 60 * 60 * 1000, // 1時間
  ) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    const now = Date.now();
    if (now - entry.lastAccess > this.ttlMs || now - entry.createdAt > this.ttlMs) {
      // TTL切れ
      this.cache.delete(key);
      this._misses++;
      return undefined;
    }

    // LRU: アクセス時に最後尾に移動
    this.cache.delete(key);
    this.cache.set(key, entry);
    entry.lastAccess = now;
    this._hits++;
    return entry.data;
  }

  set(key: string, data: T): void {
    // サイズ制限：最も古いエントリを削除
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      data,
      lastAccess: Date.now(),
      createdAt: Date.now(),
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this._hits + this._misses;
    return {
      size: this.cache.size,
      hits: this._hits,
      misses: this._misses,
      hitRate: total === 0 ? "0%" : `${((this._hits / total) * 100).toFixed(1)}%`,
    };
  }
}

// グローバルインスタンス
export const agentSessionCache = new SessionCache<any>(64, 30 * 60 * 1000); // 64セッション, 30分TTL
