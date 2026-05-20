// ==========================================
// Hikamer - 認証情報プール（Hermes Agent credential_pool.py 由来）
// 複数APIキーの管理・自動ローテーション・レート制限対応
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface Credential {
  id: string;
  provider: string;
  apiKey: string;
  label: string;
  isActive: boolean;
  usageCount: number;
  lastUsed: number | null;
  errorCount: number;
  rateLimitedUntil: number | null;
  createdAt: number;
}

export interface PoolStats {
  totalCredentials: number;
  activeCredentials: number;
  rateLimited: number;
  totalRequests: number;
  errors: number;
  rotationCount: number;
}

// ==================== 認証情報プール ====================

class CredentialPool {
  private credentials: Credential[] = [];
  private currentIndex = 0;
  private stats: PoolStats = {
    totalCredentials: 0, activeCredentials: 0,
    rateLimited: 0, totalRequests: 0,
    errors: 0, rotationCount: 0,
  };
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.loadFromEnv();
    this.initialized = true;
    logger.info(`[CredentialPool] initialized: ${this.credentials.length} keys`);
  }

  /** 環境変数から読み込み */
  private loadFromEnv(): void {
    // OpenRouter
    if (process.env.OPENROUTER_API_KEY) {
      this.addCredential("openrouter", process.env.OPENROUTER_API_KEY, "primary");
    }
    // 複数キー (OPENROUTER_API_KEY_1, OPENROUTER_API_KEY_2, ...)
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`OPENROUTER_API_KEY_${i}`];
      if (key) this.addCredential("openrouter", key, `key-${i}`);
    }
    // OpenAI
    if (process.env.OPENAI_API_KEY) {
      this.addCredential("openai", process.env.OPENAI_API_KEY, "primary");
    }
    // Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      this.addCredential("anthropic", process.env.ANTHROPIC_API_KEY, "primary");
    }
  }

  /** 認証情報を追加 */
  addCredential(provider: string, apiKey: string, label?: string): Credential {
    const cred: Credential = {
      id: `cred-${provider}-${this.credentials.length}`,
      provider,
      apiKey,
      label: label ?? `key-${this.credentials.length + 1}`,
      isActive: true,
      usageCount: 0,
      lastUsed: null,
      errorCount: 0,
      rateLimitedUntil: null,
      createdAt: Date.now(),
    };
    this.credentials.push(cred);
    this.stats.totalCredentials++;
    this.stats.activeCredentials++;
    return cred;
  }

  /** 利用可能な認証情報を取得（ラウンドロビン） */
  acquire(provider?: string): Credential | null {
    this.cleanupRateLimits();
    this.stats.totalRequests++;

    const pool = provider
      ? this.credentials.filter((c) => c.provider === provider && c.isActive)
      : this.credentials.filter((c) => c.isActive);

    if (pool.length === 0) return null;

    // ラウンドロビン + レート制限回避
    for (let i = 0; i < pool.length; i++) {
      const idx = (this.currentIndex + i) % pool.length;
      const cred = pool[idx]!;

      if (cred.rateLimitedUntil && Date.now() < cred.rateLimitedUntil) continue;

      this.currentIndex = (idx + 1) % pool.length;
      cred.usageCount++;
      cred.lastUsed = Date.now();
      return cred;
    }

    // 全てレート制限中 → 最も制限が解除されるのが早いものを返す
    const sorted = [...pool].sort(
      (a, b) => (a.rateLimitedUntil ?? 0) - (b.rateLimitedUntil ?? 0)
    );
    return sorted[0] ?? null;
  }

  /** エラーを報告（自動ローテーション） */
  reportError(credentialId: string): Credential | null {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (!cred) return null;

    cred.errorCount++;
    this.stats.errors++;

    // 429（レート制限）の可能性
    if (cred.errorCount >= 3) {
      cred.rateLimitedUntil = Date.now() + 60000; // 1分
      this.stats.rateLimited++;
      logger.warn(`[CredentialPool] ${cred.label} rate limited for 60s`);
    }

    // ローテーション
    this.stats.rotationCount++;
    return this.acquire(cred.provider);
  }

  /** レート制限を手動で設定 */
  markRateLimited(credentialId: string, durationMs?: number): void {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (!cred) return;

    cred.rateLimitedUntil = Date.now() + (durationMs ?? 30000);
    this.stats.rateLimited++;
    this.stats.rotationCount++;
  }

  /** 期限切れのレート制限を解除 */
  private cleanupRateLimits(): void {
    const now = Date.now();
    for (const cred of this.credentials) {
      if (cred.rateLimitedUntil && now >= cred.rateLimitedUntil) {
        cred.rateLimitedUntil = null;
      }
    }
  }

  /** プールの状態 */
  getStats(): PoolStats {
    this.cleanupRateLimits();
    this.stats.activeCredentials = this.credentials.filter(
      (c) => c.isActive && (!c.rateLimitedUntil || Date.now() < c.rateLimitedUntil!)
    ).length;
    return { ...this.stats };
  }

  /** 認証情報一覧（キーはマスク） */
  listCredentials(): Array<Omit<Credential, "apiKey"> & { apiKeyMasked: string }> {
    return this.credentials.map((c) => ({
      id: c.id,
      provider: c.provider,
      apiKeyMasked: c.apiKey.slice(0, 8) + "..." + c.apiKey.slice(-4),
      label: c.label,
      isActive: c.isActive,
      usageCount: c.usageCount,
      lastUsed: c.lastUsed,
      errorCount: c.errorCount,
      rateLimitedUntil: c.rateLimitedUntil,
      createdAt: c.createdAt,
    }));
  }

  formatStats(): string {
    const s = this.getStats();
    const creds = this.listCredentials();
    const now = Date.now();

    return (
      `🔑 **認証情報プール**\n` +
      `総キー: ${s.totalCredentials}\n` +
      `アクティブ: ${s.activeCredentials}\n` +
      `レート制限中: ${s.rateLimited}\n` +
      `総リクエスト: ${s.totalRequests}\n` +
      `エラー: ${s.errors}\n` +
      `ローテーション: ${s.rotationCount}\n\n` +
      (creds.length > 0
        ? `**キー一覧**\n` +
          creds
            .map(
              (c) =>
                `${c.isActive ? "✅" : "⛔"} **${c.provider}** (${c.label})\n` +
                `   キー: \`${c.apiKeyMasked}\` | 使用: ${c.usageCount}回 | エラー: ${c.errorCount}` +
                (c.rateLimitedUntil && now < c.rateLimitedUntil
                  ? ` | ⏳ 制限中 (${Math.ceil((c.rateLimitedUntil - now) / 1000)}秒)`
                  : "")
            )
            .join("\n\n")
        : "登録済みキーはありません")
    );
  }
}

// ==================== シングルトン ====================

export const credentialPool = new CredentialPool();

export default CredentialPool;
