// ==========================================
// Aikata - 利用量/課金管理（OpenHuman billing + cost由来）
// 使用割当・階層的アクセス制限・サブスクリプション
// ==========================================

import { logger } from "./utils/logger";
import { getCostSummary, estimateCost } from "./cost-tracker";

// ==================== 型定義 ====================

export type Tier = "free" | "basic" | "pro" | "enterprise";

export interface TierConfig {
  name: Tier;
  label: string;
  maxCallsPerDay: number;
  maxTokensPerDay: number;
  maxConcurrentSessions: number;
  features: string[];
  price: number; // $/月
}

export interface UsageQuota {
  userId: string;
  tier: Tier;
  dailyCalls: number;
  dailyTokens: number;
  resetDate: string; // 日付
  features: Set<string>;
  blocked: boolean;
  blockedUntil?: number;
}

// ==================== ティア設定 ====================

const TIERS: Record<Tier, TierConfig> = {
  free: {
    name: "free",
    label: "無料",
    maxCallsPerDay: 100,
    maxTokensPerDay: 100000,
    maxConcurrentSessions: 2,
    features: ["basic_chat", "web_search", "file_ops"],
    price: 0,
  },
  basic: {
    name: "basic",
    label: "ベーシック",
    maxCallsPerDay: 1000,
    maxTokensPerDay: 1000000,
    maxConcurrentSessions: 5,
    features: ["basic_chat", "web_search", "file_ops", "code_exec", "browser", "memory"],
    price: 5,
  },
  pro: {
    name: "pro",
    label: "プロ",
    maxCallsPerDay: 10000,
    maxTokensPerDay: 10000000,
    maxConcurrentSessions: 20,
    features: ["all"],
    price: 20,
  },
  enterprise: {
    name: "enterprise",
    label: "エンタープライズ",
    maxCallsPerDay: 100000,
    maxTokensPerDay: 100000000,
    maxConcurrentSessions: 100,
    features: ["all"],
    price: 100,
  },
};

// ==================== 利用量管理 ====================

class BillingManager {
  private quotas = new Map<string, UsageQuota>();
  private defaultTier: Tier = "pro"; // デフォルトはPro（個人利用）

  constructor() {
    // 環境変数でデフォルトティア変更
    if (process.env.DEFAULT_TIER && TIERS[process.env.DEFAULT_TIER as Tier]) {
      this.defaultTier = process.env.DEFAULT_TIER as Tier;
    }
  }

  /** ユーザーのクォータ取得 */
  getQuota(userId: string): UsageQuota {
    let quota = this.quotas.get(userId);
    const today = new Date().toISOString().slice(0, 10);

    if (!quota || quota.resetDate !== today) {
      quota = {
        userId,
        tier: this.defaultTier,
        dailyCalls: 0,
        dailyTokens: 0,
        resetDate: today,
        features: new Set(TIERS[this.defaultTier].features),
        blocked: false,
      };
      this.quotas.set(userId, quota);
    }

    return quota;
  }

  /** ユーザーのティア設定 */
  setTier(userId: string, tier: Tier): void {
    const config = TIERS[tier];
    if (!config) return;
    const quota = this.getQuota(userId);
    quota.tier = tier;
    quota.features = new Set(config.features);
    quota.blocked = false;
    logger.info(`[Billing] ティア変更: ${userId} → ${tier}`);
  }

  /** 機能へのアクセス権チェック */
  hasAccess(userId: string, feature: string): boolean {
    const quota = this.getQuota(userId);
    if (quota.blocked) return false;
    return quota.features.has("all") || quota.features.has(feature);
  }

  /** 呼び出しを記録し、制限をチェック */
  recordCall(userId: string, tokens: number): { allowed: boolean; reason?: string } {
    const quota = this.getQuota(userId);
    const config = TIERS[quota.tier];

    if (quota.blocked) {
      if (quota.blockedUntil && Date.now() > quota.blockedUntil) {
        quota.blocked = false;
        quota.blockedUntil = undefined;
      } else {
        return { allowed: false, reason: "アカウントが停止されています" };
      }
    }

    quota.dailyCalls++;
    quota.dailyTokens += tokens;

    // 制限チェック
    if (quota.dailyCalls > config.maxCallsPerDay) {
      quota.blocked = true;
      quota.blockedUntil = Date.now() + 3600000; // 1時間ブロック
      logger.warn(`[Billing] 呼出制限超過: ${userId} (${quota.dailyCalls}/${config.maxCallsPerDay})`);
      return { allowed: false, reason: `1日の呼び出し制限に達しました (${config.maxCallsPerDay}回/日)。1時間後にリセット。` };
    }

    if (quota.dailyTokens > config.maxTokensPerDay) {
      quota.blocked = true;
      quota.blockedUntil = Date.now() + 3600000;
      logger.warn(`[Billing] トークン制限超過: ${userId} (${quota.dailyTokens}/${config.maxTokensPerDay})`);
      return { allowed: false, reason: `1日のトークン制限に達しました。1時間後にリセット。` };
    }

    return { allowed: true };
  }

  /** 利用統計 */
  getUsage(userId: string): {
    tier: Tier;
    callsUsed: number;
    callsLimit: number;
    tokensUsed: number;
    tokensLimit: number;
    percentUsed: number;
    blocked: boolean;
  } {
    const quota = this.getQuota(userId);
    const config = TIERS[quota.tier];
    return {
      tier: quota.tier,
      callsUsed: quota.dailyCalls,
      callsLimit: config.maxCallsPerDay,
      tokensUsed: quota.dailyTokens,
      tokensLimit: config.maxTokensPerDay,
      percentUsed: Math.round((quota.dailyCalls / config.maxCallsPerDay) * 100),
      blocked: quota.blocked,
    };
  }

  /** すべてのクォータをリセット */
  resetAllQuotas(): void {
    const today = new Date().toISOString().slice(0, 10);
    for (const quota of Array.from(this.quotas.values())) {
      quota.dailyCalls = 0;
      quota.dailyTokens = 0;
      quota.resetDate = today;
      quota.blocked = false;
    }
    logger.info("[Billing] 全クォータリセット");
  }

  /** フォーマット */
  formatUsage(userId: string): string {
    const usage = this.getUsage(userId);
    const config = TIERS[usage.tier];

    const barLen = 20;
    const filled = Math.round((usage.percentUsed / 100) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

    return [
      `💳 **利用状況** (${config.label})`,
      `コール: ${usage.callsUsed}/${usage.callsLimit}`,
      `トークン: ${usage.tokensUsed.toLocaleString()}/${usage.tokensLimit.toLocaleString()}`,
      `使用率: ${bar} ${usage.percentUsed}%`,
      usage.blocked ? "🚫 **ブロック中**" : "",
      "",
      `**${config.label}機能:**`,
      config.features.includes("all") ? "• 全機能利用可能" : config.features.map(f => `• ${f}`).join("\n"),
      `価格: $${config.price}/月`,
    ].filter(Boolean).join("\n");
  }

  /** 全ユーザー統計 */
  getAllStats(): { totalUsers: number; activeToday: number; blockedUsers: number; totalCalls: number } {
    const all = Array.from(this.quotas.values());
    const today = new Date().toISOString().slice(0, 10);
    return {
      totalUsers: all.length,
      activeToday: all.filter(q => q.resetDate === today && q.dailyCalls > 0).length,
      blockedUsers: all.filter(q => q.blocked).length,
      totalCalls: all.reduce((s, q) => s + q.dailyCalls, 0),
    };
  }
}

// ==================== シングルトン ====================

export const billingManager = new BillingManager();
