// ==========================================
// Hikamer - WebViewアカウント管理（OpenHuman webview_accounts/ 由来）
// ブラウザベースのアカウント連携・セッション管理
// ==========================================

import { logger } from "./utils/logger";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface WebViewAccount {
  id: string;
  provider: string;
  label: string;
  username: string;
  loggedIn: boolean;
  lastVerified: number | null;
  createdAt: number;
  cookies: number;
  metadata?: Record<string, unknown>;
}

export interface WebViewSession {
  id: string;
  accountId: string;
  userAgent: string;
  ipAddress: string;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  active: boolean;
}

// ==================== WebViewアカウントマネージャー ====================

class WebViewAccountManager {
  private accounts: Map<string, WebViewAccount> = new Map();
  private sessions: WebViewSession[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[WebView] account manager initialized");
  }

  /** アカウントを登録 */
  registerAccount(
    provider: string,
    username: string,
    label?: string
  ): WebViewAccount {
    const id = `wva-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const account: WebViewAccount = {
      id,
      provider,
      label: label ?? `${provider}:${username}`,
      username,
      loggedIn: false,
      lastVerified: null,
      createdAt: Date.now(),
      cookies: 0,
    };
    this.accounts.set(id, account);
    logger.info(`[WebView] registered ${provider} account: ${username}`);
    return account;
  }

  /** ログイン状態を更新 */
  setLoggedIn(accountId: string, loggedIn: boolean): boolean {
    const account = this.accounts.get(accountId);
    if (!account) return false;
    account.loggedIn = loggedIn;
    account.lastVerified = Date.now();
    return true;
  }

  /** セッションを作成 */
  createSession(accountId: string): WebViewSession {
    const session: WebViewSession = {
      id: `wvs-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      accountId,
      userAgent: "Hikamer/1.0",
      ipAddress: "127.0.0.1",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + 3600000, // 1時間
      active: true,
    };
    this.sessions.push(session);
    if (this.sessions.length > 100) this.sessions.shift();
    return session;
  }

  /** アカウント一覧 */
  listAccounts(provider?: string): WebViewAccount[] {
    const all = Array.from(this.accounts.values());
    return provider ? all.filter((a) => a.provider === provider) : all;
  }

  /** プロバイダー一覧 */
  listProviders(): string[] {
    return [...new Set(Array.from(this.accounts.values()).map((a) => a.provider))];
  }

  /** 期限切れセッションをクリーンアップ */
  cleanupSessions(): number {
    const now = Date.now();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.expiresAt > now);
    return before - this.sessions.length;
  }

  formatStatus(): string {
    const accounts = this.listAccounts();
    const providers = this.listProviders();
    return (
      `🌐 **WebViewアカウント**\n` +
      `アカウント数: ${accounts.length}\n` +
      `プロバイダー: ${providers.length}\n` +
      `アクティブセッション: ${this.sessions.filter((s) => s.active && s.expiresAt > Date.now()).length}\n\n` +
      (accounts.length > 0
        ? `**アカウント一覧**\n` +
          accounts
            .map(
              (a) =>
                `${a.loggedIn ? "✅" : "❌"} **${a.label}** (${a.provider})` +
                ` | cookies: ${a.cookies}`
            )
            .join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const webViewAccounts = new WebViewAccountManager();

export default WebViewAccountManager;
