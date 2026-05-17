// ==========================================
// Aikata - レートリミッター（OpenHuman scheduler_gate由来）
// ユーザー単位のリクエスト制限
// ==========================================

import { logger } from "./utils/logger";

// ==================== 設定 ====================

interface RateLimitConfig {
  /** 時間枠（ミリ秒） */
  windowMs: number;
  /** 時間枠内の最大リクエスト数 */
  maxRequests: number;
  /** 超過時のエラーメッセージ */
  message?: string;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 10000,   // 10秒
  maxRequests: 5,    // 最大5回
  message: "レート制限です。しばらく待ってからもう一度試してください。",
};

// ==================== スライディングウィンドウ ====================

interface WindowEntry {
  timestamps: number[];
  blocked: boolean;
  blockedUntil: number;
}

class SlidingWindowLimiter {
  private windows = new Map<string, WindowEntry>();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * リクエストをチェック
   * @returns true=許可, false=制限
   */
  check(key: string): boolean {
    const now = Date.now();
    let entry = this.windows.get(key);

    if (!entry) {
      entry = { timestamps: [], blocked: false, blockedUntil: 0 };
      this.windows.set(key, entry);
    }

    // ブロック解除チェック
    if (entry.blocked && now > entry.blockedUntil) {
      entry.blocked = false;
      entry.timestamps = [];
    }

    if (entry.blocked) {
      return false;
    }

    // 期限切れタイムスタンプを除去
    const windowStart = now - this.config.windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    // 現在のリクエスト数をチェック
    if (entry.timestamps.length >= this.config.maxRequests) {
      entry.blocked = true;
      entry.blockedUntil = now + this.config.windowMs;
      logger.warn(`[RateLimit] ブロック: ${key} (${entry.timestamps.length}回/${this.config.windowMs}ms)`);
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** 残りリクエスト数 */
  remaining(key: string): number {
    const entry = this.windows.get(key);
    if (!entry) return this.config.maxRequests;

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const active = entry.timestamps.filter(t => t > windowStart).length;
    return Math.max(0, this.config.maxRequests - active);
  }

  /** リセット時間（ミリ秒） */
  resetTime(key: string): number {
    const entry = this.windows.get(key);
    if (!entry || entry.timestamps.length === 0) return 0;

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const active = entry.timestamps.filter(t => t > windowStart);
    if (active.length === 0) return 0;

    // 最も古いアクティブタイムスタンプ + ウィンドウ
    return Math.max(0, this.config.windowMs - (now - active[0]));
  }

  /** キーのキャッシュクリア */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** 全キャッシュクリア */
  resetAll(): void {
    this.windows.clear();
  }

  /** 設定更新 */
  updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RateLimitConfig {
    return { ...this.config };
  }
}

// ==================== 階層型レートリミッター ====================

interface TieredLimiter {
  name: string;
  perUser: SlidingWindowLimiter;
  perChannel: SlidingWindowLimiter;
  global: SlidingWindowLimiter;
}

const limiters = new Map<string, TieredLimiter>();

/**
 * 階層型リミッターを取得
 * - ユーザー単位: 5回/10秒
 * - チャンネル単位: 20回/10秒
 * - グローバル: 50回/10秒
 */
export function getLimiter(name = "default"): TieredLimiter {
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = {
      name,
      perUser: new SlidingWindowLimiter({ maxRequests: 5, windowMs: 10000 }),
      perChannel: new SlidingWindowLimiter({ maxRequests: 20, windowMs: 10000 }),
      global: new SlidingWindowLimiter({ maxRequests: 50, windowMs: 10000 }),
    };
    limiters.set(name, limiter);
  }
  return limiter;
}

/** 全リミッターリセット */
export function resetAllLimiters(): void {
  for (const limiter of Array.from(limiters.values())) {
    limiter.perUser.resetAll();
    limiter.perChannel.resetAll();
    limiter.global.resetAll();
  }
}

// ==================== チェック関数 ====================

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  remaining: {
    user: number;
    channel: number;
    global: number;
  };
}

/**
 * 階層レート制限チェック
 * @returns 許可 or 拒否
 */
export function checkRateLimit(
  userId: string,
  channelId?: string,
  limiterName = "default",
): RateLimitCheckResult {
  const limiter = getLimiter(limiterName);

  // グローバルチェック
  if (!limiter.global.check(`global`)) {
    return {
      allowed: false,
      reason: "サーバーのレート制限に達しました。しばらく待ってください。",
      remaining: {
        user: limiter.perUser.remaining(userId),
        channel: channelId ? limiter.perChannel.remaining(channelId) : 20,
        global: limiter.global.remaining("global"),
      },
    };
  }

  // チャンネルチェック（任意）
  if (channelId) {
    if (!limiter.perChannel.check(channelId)) {
      return {
        allowed: false,
        reason: "このチャンネルのレート制限に達しました。",
        remaining: {
          user: limiter.perUser.remaining(userId),
          channel: limiter.perChannel.remaining(channelId),
          global: limiter.global.remaining("global"),
        },
      };
    }
  }

  // ユーザーチェック
  if (!limiter.perUser.check(userId)) {
    return {
      allowed: false,
      reason: "レート制限です。少し待ってからもう一度試してください。",
      remaining: {
        user: limiter.perUser.remaining(userId),
        channel: channelId ? limiter.perChannel.remaining(channelId) : 20,
        global: limiter.global.remaining("global"),
      },
    };
  }

  return {
    allowed: true,
    remaining: {
      user: limiter.perUser.remaining(userId),
      channel: channelId ? limiter.perChannel.remaining(channelId) : 20,
      global: limiter.global.remaining("global"),
    },
  };
}

// ==================== フォーマット ====================

export function formatRateLimit(result: RateLimitCheckResult): string {
  if (result.allowed) {
    return `✅ 残り: ユーザー${result.remaining.user} / チャンネル${result.remaining.channel} / 全体${result.remaining.global}`;
  }
  return `⏳ ${result.reason}\n残り: ユーザー${result.remaining.user} / チャンネル${result.remaining.channel} / 全体${result.remaining.global}`;
}
