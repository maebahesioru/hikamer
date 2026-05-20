// ==========================================
// Hikamer - 認証情報マネージャー（OpenHuman credentials + encryption由来）
// API鍵・OAuthトークンの暗号化保存・自動更新
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "crypto";
import { logger } from "./utils/logger";

// ==================== 暗号化 ====================

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** マスターキーを環境変数から生成 */
function getMasterKey(): Buffer {
  const envKey = process.env.CREDENTIALS_KEY;
  if (envKey && envKey.length >= 16) {
    // 任意の長さのキーをSHA-256で固定長に
    return createHash("sha256").update(envKey).digest();
  }
  // フォールバック: プロセス固有のキー（再起動で無効）
  return createHash("sha256")
    .update(`hikamer-${process.pid}-${new Date().toISOString().slice(0, 10)}`)
    .digest();
}

function encrypt(text: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  // iv:tag:encrypted の形式
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

function decrypt(encoded: string): string {
  const key = getMasterKey();
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("暗号化形式が不正です");

  const iv = Buffer.from(parts[0]!, "hex");
  const tag = Buffer.from(parts[1]!, "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ==================== ストレージ ====================

interface CredentialEntry {
  id: string;
  service: string;
  label: string;
  type: "api_key" | "oauth_token" | "oauth_refresh" | "password" | "custom";
  encrypted: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  metadata?: Record<string, string>;
}

interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

const CRED_PATH = resolve(process.env.DATA_DIR || "./data", "credentials.json");
let _store: CredentialEntry[] = [];

function loadStore(): CredentialEntry[] {
  if (_store.length > 0) return _store;
  try {
    if (existsSync(CRED_PATH)) {
      _store = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
    }
  } catch (e) {
    logger.warn(`[Credentials] 読込失敗: ${e}`);
  }
  return _store;
}

function saveStore(): void {
  try {
    const dir = dirname(CRED_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CRED_PATH, JSON.stringify(_store, null, 2), "utf-8");
  } catch (e) {
    logger.error(`[Credentials] 保存失敗: ${e}`);
  }
}

// ==================== 公開API ====================

/** API鍵を保存 */
export function saveApiKey(
  service: string,
  apiKey: string,
  label?: string,
  metadata?: Record<string, string>,
): string {
  const id = `cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry: CredentialEntry = {
    id,
    service,
    label: label || `${service} API Key`,
    type: "api_key",
    encrypted: encrypt(apiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata,
  };

  loadStore();
  _store.push(entry);
  saveStore();
  logger.info(`[Credentials] API鍵保存: ${service} (${id})`);
  return id;
}

/** OAuthトークンを保存 */
export function saveOAuthToken(
  service: string,
  token: OAuthToken,
  label?: string,
): string {
  const id = `oauth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry: CredentialEntry = {
    id,
    service,
    label: label || `${service} OAuth`,
    type: "oauth_token",
    encrypted: encrypt(JSON.stringify(token)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: token.expiresAt ? new Date(token.expiresAt).toISOString() : undefined,
  };

  loadStore();
  _store.push(entry);
  saveStore();
  logger.info(`[Credentials] OAuth保存: ${service} (${id})`);
  return id;
}

/** 認証情報を取得（復号化） */
export function getCredential(id: string): { entry: CredentialEntry; decrypted: string } | null {
  loadStore();
  const entry = _store.find(e => e.id === id);
  if (!entry) return null;

  try {
    const decrypted = decrypt(entry.encrypted);
    return { entry, decrypted };
  } catch (e) {
    logger.error(`[Credentials] 復号失敗: ${id}`);
    return null;
  }
}

/** サービス名で検索してAPI鍵を取得 */
export function getApiKeyByService(service: string): string | null {
  loadStore();
  const entries = _store.filter(e => e.service === service && e.type === "api_key");
  if (entries.length === 0) return null;

  // 最新を返す
  const latest = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  try {
    return decrypt(latest.encrypted);
  } catch {
    return null;
  }
}

/** サービス名でOAuthトークンを取得 */
export function getOAuthTokenByService(service: string): OAuthToken | null {
  loadStore();
  const entries = _store.filter(e => e.service === service && e.type === "oauth_token");
  if (entries.length === 0) return null;

  const latest = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  try {
    return JSON.parse(decrypt(latest.encrypted));
  } catch {
    return null;
  }
}

/** 認証情報を削除 */
export function deleteCredential(id: string): boolean {
  loadStore();
  const idx = _store.findIndex(e => e.id === id);
  if (idx === -1) return false;
  _store.splice(idx, 1);
  saveStore();
  logger.info(`[Credentials] 削除: ${id}`);
  return true;
}

/** 全認証情報一覧（復号化なし） */
export function listCredentials(): Array<{
  id: string;
  service: string;
  label: string;
  type: string;
  createdAt: string;
  expiresAt?: string;
}> {
  loadStore();
  return _store.map(e => ({
    id: e.id,
    service: e.service,
    label: e.label,
    type: e.type,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
  }));
}

/** OAuthトークンの自動リフレッシュ（トークン期限切れを検出） */
export function checkExpiredTokens(): Array<{ id: string; service: string; label: string }> {
  loadStore();
  const now = Date.now();
  return _store
    .filter(e => e.type === "oauth_token" && e.expiresAt && new Date(e.expiresAt).getTime() < now)
    .map(e => ({ id: e.id, service: e.service, label: e.label }));
}

/** 認証情報をクリア */
export function clearAllCredentials(): void {
  _store = [];
  saveStore();
  logger.info("[Credentials] 全削除");
}

// ==================== フォーマット ====================

export function formatCredentials(): string {
  const list = listCredentials();
  if (list.length === 0) return "🔑 保存された認証情報はありません。";

  const now = Date.now();
  return [
    "🔑 **認証情報一覧**",
    "",
    ...list.map(c => {
      const expired = c.expiresAt && new Date(c.expiresAt).getTime() < now;
      const typeIcon = c.type === "api_key" ? "🔐" : c.type === "oauth_token" ? "🔑" : "📝";
      return `${typeIcon} **${c.label}** (${c.service})\n` +
        `   ID: \`${c.id}\` | 種類: ${c.type}\n` +
        `   作成: ${c.createdAt.slice(0, 10)}` +
        (c.expiresAt ? ` | 期限: ${expired ? "⚠️ 切れ" : c.expiresAt.slice(0, 10)}` : "");
    }),
  ].join("\n");
}
