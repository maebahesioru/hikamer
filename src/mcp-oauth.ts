// ==========================================
// Aikata - MCP OAuth認証（Hermes Agent由来）
// MCPサーバー接続時のOAuth認証フロー
// ==========================================

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri?: string;
  scopes: string[];
}

// ==================== トークンストレージ ====================

const TOKEN_DIR = resolve(process.env.DATA_DIR || "./data", "mcp-oauth");

function ensureTokenDir(): void {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
}

function safeFilename(name: string): string {
  return name.replace(/[^\w\-]/g, "_").slice(0, 128);
}

export class TokenStorage {
  /** トークンを保存 */
  save(serverName: string, configId: string, token: TokenData): void {
    ensureTokenDir();
    const filename = resolve(TOKEN_DIR, `${safeFilename(serverName)}_${safeFilename(configId)}.json`);
    writeFileSync(filename, JSON.stringify(token, null, 2), { encoding: "utf-8", mode: 0o600 });
    logger.info(`OAuthトークン保存: ${serverName}/${configId}`);
  }

  /** トークンを読み込む */
  load(serverName: string, configId: string): TokenData | null {
    const filename = resolve(TOKEN_DIR, `${safeFilename(serverName)}_${safeFilename(configId)}.json`);
    if (!existsSync(filename)) return null;
    try {
      const data = JSON.parse(readFileSync(filename, "utf-8")) as TokenData;
      // 有効期限チェック
      if (data.expiresAt && Date.now() > data.expiresAt * 1000) {
        logger.warn(`OAuthトークン期限切れ: ${serverName}/${configId}`);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /** トークンを削除 */
  delete(serverName: string, configId: string): void {
    const filename = resolve(TOKEN_DIR, `${safeFilename(serverName)}_${safeFilename(configId)}.json`);
    try { readFileSync(filename); } catch { return; }
    try { writeFileSync(filename, ""); } catch {}
    logger.info(`OAuthトークン削除: ${serverName}/${configId}`);
  }
}

export const tokenStorage = new TokenStorage();

// ==================== OAuth認証フロー ====================

/** 空きポートを検索 */
function findFreePort(): Promise<number> {
  return new Promise((resolve_, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      server.close(() => resolve_(port));
    });
    server.on("error", reject);
  });
}

/**
 * OAuth認証URLを表示して、コールバックを受信
 * CLI, サーバーレス等、対話的な環境を前提
 */
export async function runOAuthFlow(
  serverName: string,
  config: OAuthConfig,
): Promise<TokenData> {
  const redirectPort = await findFreePort();
  const redirectUri = config.redirectUri || `http://127.0.0.1:${redirectPort}/callback`;

  // 認証URL構築
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state: Math.random().toString(36).slice(2, 10),
  });

  const authUrl = `${config.authorizationUrl}?${params}`;

  logger.info(`OAuth認証が必要です: ${serverName}`);
  logger.info(`以下のURLをブラウザで開いて認証してください:\n${authUrl}`);

  // コールバックサーバー起動
  return new Promise((resolve_, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`OAuth認証エラー: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>✅ 認証完了</h1><p>このウィンドウは閉じてください。</p></body></html>");

        try {
          // 認証コードをトークンと交換
          const tokenResponse = await fetch(config.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: config.clientId,
              ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
            }),
          });

          if (!tokenResponse.ok) {
            throw new Error(`トークン交換失敗: ${tokenResponse.status}`);
          }

          const tokenData = await tokenResponse.json();

          const token: TokenData = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
            scope: tokenData.scope,
            clientId: config.clientId,
            metadata: { tokenType: tokenData.token_type },
          };

          tokenStorage.save(serverName, config.clientId, token);
          server.close();
          resolve_(token);
        } catch (e: any) {
          server.close();
          reject(e);
        }
      }
    });

    server.listen(redirectPort, "127.0.0.1", () => {
      logger.info(`OAuthコールバック待機中: http://127.0.0.1:${redirectPort}`);
    });

    // タイムアウト（5分）
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth認証がタイムアウトしました（5分）"));
    }, 300_000);
  });
}
