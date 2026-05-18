// ==========================================
// Aikata - アカウント使用量（Hermes Agent account_usage.py 由来）
// APIアカウントごとの使用量追跡・制限管理
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface AccountUsage {
  provider: string;
  model: string;
  requestsToday: number;
  tokensToday: number;
  costToday: number;
  requestsLimit: number;
  tokensLimit: number;
  costLimit: number;
  resetAt: number;
}

export interface UsageAlert {
  type: "requests" | "tokens" | "cost";
  provider: string;
  threshold: number;
  current: number;
  message: string;
  timestamp: number;
}

// ==================== アカウント使用量管理 ====================

class AccountUsageManager {
  private usages: Map<string, AccountUsage> = new Map();
  private alerts: UsageAlert[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initDefaults();
    this.initialized = true;
    logger.info("[AccountUsage] initialized");
  }

  /** 使用量を記録 */
  record(provider: string, model: string, tokens: number, cost: number): void {
    const key = `${provider}:${model}`;
    let usage = this.usages.get(key);

    if (!usage) {
      usage = {
        provider,
        model,
        requestsToday: 0,
        tokensToday: 0,
        costToday: 0,
        requestsLimit: 10000,
        tokensLimit: 10000000,
        costLimit: 10,
        resetAt: this.getNextReset(),
      };
      this.usages.set(key, usage);
    }

    // 日付が変わっていたらリセット
    if (Date.now() > usage.resetAt) {
      usage.requestsToday = 0;
      usage.tokensToday = 0;
      usage.costToday = 0;
      usage.resetAt = this.getNextReset();
    }

    usage.requestsToday++;
    usage.tokensToday += tokens;
    usage.costToday += cost;

    // アラートチェック
    this.checkAlerts(usage);
  }

  /** 使用量を取得 */
  getUsage(provider: string, model: string): AccountUsage | null {
    return this.usages.get(`${provider}:${model}`) ?? null;
  }

  /** 全プロバイダーの使用量 */
  getAllUsage(): AccountUsage[] {
    return Array.from(this.usages.values());
  }

  /** 制限値を設定 */
  setLimits(provider: string, model: string, limits: {
    requestsLimit?: number;
    tokensLimit?: number;
    costLimit?: number;
  }): void {
    const usage = this.usages.get(`${provider}:${model}`);
    if (!usage) return;
    if (limits.requestsLimit) usage.requestsLimit = limits.requestsLimit;
    if (limits.tokensLimit) usage.tokensLimit = limits.tokensLimit;
    if (limits.costLimit) usage.costLimit = limits.costLimit;
  }

  /** リソースが利用可能か */
  canUse(provider: string, model: string): { allowed: boolean; reason?: string } {
    const usage = this.usages.get(`${provider}:${model}`);
    if (!usage) return { allowed: true };

    if (usage.requestsToday >= usage.requestsLimit) {
      return { allowed: false, reason: "Request limit reached" };
    }
    if (usage.tokensToday >= usage.tokensLimit) {
      return { allowed: false, reason: "Token limit reached" };
    }
    if (usage.costToday >= usage.costLimit) {
      return { allowed: false, reason: "Cost limit reached" };
    }
    return { allowed: true };
  }

  /** アラート一覧 */
  getAlerts(): UsageAlert[] {
    return [...this.alerts].reverse();
  }

  // ---- 内部 ----

  private initDefaults(): void {
    // デフォルトでOpenRouterを登録
    if (process.env.OPENROUTER_API_KEY) {
      this.usages.set("openrouter:deepseek/deepseek-v4-flash", {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        requestsToday: 0,
        tokensToday: 0,
        costToday: 0,
        requestsLimit: 5000,
        tokensLimit: 5000000,
        costLimit: 5,
        resetAt: this.getNextReset(),
      });
    }
  }

  private checkAlerts(usage: AccountUsage): void {
    const thresholds = [
      { type: "requests" as const, current: usage.requestsToday, limit: usage.requestsLimit, threshold: 0.8 },
      { type: "tokens" as const, current: usage.tokensToday, limit: usage.tokensLimit, threshold: 0.8 },
      { type: "cost" as const, current: usage.costToday, limit: usage.costLimit, threshold: 0.8 },
    ];

    for (const t of thresholds) {
      if (t.limit > 0 && t.current >= t.limit * t.threshold) {
        const pct = ((t.current / t.limit) * 100).toFixed(0);
        this.alerts.push({
          type: t.type,
          provider: usage.provider,
          threshold: t.threshold,
          current: t.current,
          message: `${usage.provider}/${usage.model}: ${t.type} ${pct}% used (${t.current}/${t.limit})`,
          timestamp: Date.now(),
        });
      }
    }

    // アラートは最新50件まで
    if (this.alerts.length > 50) this.alerts = this.alerts.slice(-50);
  }

  private getNextReset(): number {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return tomorrow.getTime();
  }

  formatUsage(usage: AccountUsage): string {
    const reqPct = ((usage.requestsToday / usage.requestsLimit) * 100).toFixed(0);
    const tokPct = ((usage.tokensToday / usage.tokensLimit) * 100).toFixed(0);
    const costPct = ((usage.costToday / usage.costLimit) * 100).toFixed(0);

    return (
      `📊 **${usage.provider}/${usage.model}**\n` +
      `リクエスト: ${usage.requestsToday}/${usage.requestsLimit} (${reqPct}%)\n` +
      `トークン: ${(usage.tokensToday / 1000).toFixed(0)}K/${(usage.tokensLimit / 1000).toFixed(0)}K (${tokPct}%)\n` +
      `コスト: $${usage.costToday.toFixed(4)}/$${usage.costLimit.toFixed(2)} (${costPct}%)` +
      `\nリセット: ${new Date(usage.resetAt).toLocaleString("ja-JP")}`
    );
  }

  formatStatus(): string {
    const usages = this.getAllUsage();
    const alerts = this.getAlerts();
    if (usages.length === 0) return "📭 使用量データはありません";
    return (
      usages.map((u) => this.formatUsage(u)).join("\n\n") +
      (alerts.length > 0
        ? `\n\n**アラート (${alerts.length})**\n` +
          alerts
            .slice(-3)
            .map((a) => `⚠️ ${a.message}`)
            .join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const accountUsage = new AccountUsageManager();

export default AccountUsageManager;
