// ==========================================
// Hikamer - Retry & Async Utilities（OH util.rs + OC lazy-runtime + HA retry_utils由来）
// 指数バックオフ・ジッター・遅延ロード・並列実行制御
// ==========================================

import { logger } from "./utils/logger";

// ==================== リトライ ====================

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/** 指数バックオフ＋ジッター付きリトライ */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxDelay = options.maxDelayMs ?? 30000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt >= options.maxAttempts) break;

      // 指数バックオフ
      let delay = Math.min(options.baseDelayMs * Math.pow(2, attempt - 1), maxDelay);

      // ジッター（±50%）
      if (options.jitter !== false) {
        delay = delay * (0.5 + Math.random());
      }

      options.onRetry?.(attempt, lastError, delay);
      logger.warn(`[Retry] attempt ${attempt}/${options.maxAttempts} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`);

      await sleep(delay);
    }
  }

  throw lastError || new Error("Retry failed");
}

// ==================== 遅延 ====================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 遅延ローダー ====================

/** 遅延ローダー（キャッシュ付き） */
export function createLazyLoader<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: T | null = null;
  let loading: Promise<T> | null = null;

  return async () => {
    if (cached !== null) return cached;
    if (loading) return loading;

    loading = factory().then((result) => {
      cached = result;
      loading = null;
      return result;
    }).catch((e) => {
      loading = null;
      throw e;
    });

    return loading;
  };
}

/** 動的インポートの遅延ローダー */
export function createLazyImport<T>(importFn: () => Promise<T>): () => Promise<T> {
  return createLazyLoader(importFn);
}

// ==================== タイムアウト ====================

/** タイムアウト付きPromise */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ==================== セーフタイマー ====================

const MAX_TIMEOUT_VALUE = 2_147_483_647; // setTimeoutの最大値

/** setTimeoutの整数オーバーフロー対策 */
export function setSafeTimeout(fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, Math.min(delayMs, MAX_TIMEOUT_VALUE));
}

// ==================== グローバルシングルトン ====================

const GLOBAL_SINGLETONS = new Map<string, unknown>();

/** プロセスレベルシングルトン */
export function resolveGlobalSingleton<T>(key: string, factory: () => T): T {
  if (!GLOBAL_SINGLETONS.has(key)) {
    GLOBAL_SINGLETONS.set(key, factory());
  }
  return GLOBAL_SINGLETONS.get(key) as T;
}

/** スコープ付きキャッシュ */
export function createScopedCache<V>(ttlMs = 60000): {
  get: (scope: string, key: string) => V | undefined;
  set: (scope: string, key: string, value: V) => void;
  clear: () => void;
} {
  const store = new Map<string, { value: V; expiresAt: number }>();

  return {
    get(scope, key) {
      const entry = store.get(`${scope}:${key}`);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(`${scope}:${key}`);
        return undefined;
      }
      return entry.value;
    },
    set(scope, key, value) {
      store.set(`${scope}:${key}`, { value, expiresAt: Date.now() + ttlMs });
    },
    clear() {
      store.clear();
    },
  };
}
