// ==========================================
// Hikamer - 動的設定管理 (v1.3 - apiKey分離 + AGENT_MODEL)
// ==========================================

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

export type ProviderType = "openai" | "anthropic" | "gemini";

export interface ProviderEntry {
  name: string;
  type: ProviderType;
  baseUrl: string;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderEntry>;
}

export interface AgentRuntimeConfig {
  maxIterations: number;
}

const PROVIDERS_PATH = resolve(process.cwd(), "providers.json");

let providersCache: ProvidersConfig | null = null;
let runtimeConfig: AgentRuntimeConfig = {
  maxIterations: parseInt(process.env.MAX_ITERATIONS || "") || 100,
};

function loadProviders(): ProvidersConfig {
  if (!providersCache) {
    if (existsSync(PROVIDERS_PATH)) {
      providersCache = JSON.parse(readFileSync(PROVIDERS_PATH, "utf-8"));
    } else {
      providersCache = { providers: {} };
    }
  }
  return providersCache;
}

function saveProviders(): void {
  writeFileSync(PROVIDERS_PATH, JSON.stringify(providersCache, null, 2), "utf-8");
}

// ==================== プロバイダー管理 ====================

export function getProviders(): ProvidersConfig {
  return loadProviders();
}

export function getProvider(name: string): ProviderEntry | undefined {
  return loadProviders().providers[name];
}

export function addProvider(key: string, entry: ProviderEntry): void {
  const config = loadProviders();
  config.providers[key] = entry;
  saveProviders();
  providersCache = config;
}

export function removeProvider(key: string): boolean {
  const config = loadProviders();
  if (!config.providers[key]) return false;
  delete config.providers[key];
  saveProviders();
  providersCache = config;
  return true;
}

/** providers.jsonのキーに対応するAPIキーを.envから取得 (例: opencode → OPENCODE_API_KEY) */
export function getApiKey(providerKey: string): string {
  const envKey = `${providerKey.toUpperCase()}_API_KEY`;
  return process.env[envKey] || "sk-dummy";
}

// ==================== アクティブモデル (AGENT_MODEL) ====================

/** AGENT_MODEL をパース: "opencode/deepseek/deepseek-v4-pro" → { provider, model } */
export function getActiveModel(): { provider: string; model: string } {
  const raw = process.env.AGENT_MODEL || "opencode/deepseek/deepseek-v4-pro";
  const slashIdx = raw.indexOf("/");
  if (slashIdx === -1) {
    // "/" がない場合、プロバイダーは最初の登録済みから、モデルは全体
    const first = Object.keys(loadProviders().providers)[0] || "opencode";
    return { provider: first, model: raw };
  }
  return {
    provider: raw.slice(0, slashIdx),
    model: raw.slice(slashIdx + 1),
  };
}

export function setActiveModel(providerModel: string): void {
  process.env.AGENT_MODEL = providerModel;
  writeEnv("AGENT_MODEL", providerModel);
}

/** モデル名だけ変更（プロバイダーは維持） */
export function setActiveModelOnly(modelName: string): void {
  const { provider } = getActiveModel();
  setActiveModel(`${provider}/${modelName}`);
}

/** プロバイダーだけ変更（モデルは維持） */
export function setActiveProvider(providerKey: string): void {
  const { model } = getActiveModel();
  setActiveModel(`${providerKey}/${model}`);
}

function writeEnv(key: string, value: string): void {
  try {
    const envPath = resolve(process.cwd(), ".env");
    if (existsSync(envPath)) {
      let content = readFileSync(envPath, "utf-8");
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}\n`;
      }
      writeFileSync(envPath, content, "utf-8");
    }
  } catch { /* ignore */ }
}

// ==================== ランタイム ====================

export function getRuntimeConfig(): AgentRuntimeConfig {
  return { ...runtimeConfig };
}

export function setMaxIterations(n: number): void {
  if (n < 1 || n > 1000) throw new Error("反復回数は1〜1000で指定してください。");
  runtimeConfig.maxIterations = n;
}

export function getSearxngUrl(): string {
  return process.env.SEARXNG_URL || "http://localhost:18080";
}

// ==========================================
// Stat-based config caching（hermes-agent config.py パターン）
// 設定ファイルのmtimeを監視し、変更があった場合のみ再読込。
// 無駄なfs.readFileSyncを防止し、パフォーマンス向上。
// ==========================================

import { statSync } from "fs";

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
  ttlMs: number;
  fetchedAt: number;
}

const configCache = new Map<string, CacheEntry<unknown>>();

/**
 * 設定値をキャッシュ付きで取得。
 * hermes-agentの stat-based caching 相当。
 *
 * @param key - キャッシュキー
 * @param filePath - 監視するファイルパス（mtimeで変更検知）
 * @param fetchFn - キャッシュミス時に実行する取得関数
 * @param ttlMs - キャッシュTTL（デフォルト60秒）
 */
export function getCachedConfig<T>(
  key: string,
  filePath: string,
  fetchFn: () => T,
  ttlMs: number = 60000,
): T {
  const cached = configCache.get(key);

  // ファイルのmtimeを取得
  let fileMtime = 0;
  try {
    if (existsSync(filePath)) {
      fileMtime = statSync(filePath).mtimeMs;
    }
  } catch {}

  const now = Date.now();

  // キャッシュヒット判定: mtimeが変わっておらず、TTL内
  if (cached && cached.mtimeMs === fileMtime && (now - cached.fetchedAt) < cached.ttlMs) {
    return cached.value as T;
  }

  // キャッシュミス: 再取得
  const value = fetchFn();
  configCache.set(key, {
    value,
    mtimeMs: fileMtime,
    ttlMs,
    fetchedAt: now,
  });

  return value;
}

/** キャッシュを強制無効化 */
export function invalidateConfigCache(key?: string): void {
  if (key) {
    configCache.delete(key);
  } else {
    configCache.clear();
  }
}

/** キャッシュ統計を取得 */
export function getConfigCacheStats(): { size: number; keys: string[] } {
  return {
    size: configCache.size,
    keys: Array.from(configCache.keys()),
  };
}
