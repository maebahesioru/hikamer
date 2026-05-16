// ==========================================
// Aikata - 動的設定管理 (v1.2 - .envフォールバック削除)
// ==========================================

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

export type ProviderType = "openai" | "anthropic" | "gemini";

export interface ProviderEntry {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderEntry>;
}

export interface ActiveConfig {
  provider: string;
  model: string;
}

export interface AgentRuntimeConfig {
  maxIterations: number;
}

const PROVIDERS_PATH = resolve(process.cwd(), "providers.json");
const ACTIVE_PATH = resolve(process.cwd(), "active.json");

let providersCache: ProvidersConfig | null = null;
let activeCache: ActiveConfig | null = null;
let runtimeConfig: AgentRuntimeConfig = {
  maxIterations: parseInt(process.env.MAX_ITERATIONS || "") || 200,
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

function loadActive(): ActiveConfig {
  if (!activeCache) {
    if (existsSync(ACTIVE_PATH)) {
      activeCache = JSON.parse(readFileSync(ACTIVE_PATH, "utf-8"));
    } else {
      const providers = loadProviders();
      const first = Object.keys(providers.providers)[0] || "opencode";
      activeCache = { provider: first, model: "deepseek/deepseek-v4-pro" };
    }
  }
  return activeCache;
}

function saveActive(): void {
  writeFileSync(ACTIVE_PATH, JSON.stringify(activeCache, null, 2), "utf-8");
}

// ==================== API ====================

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
  // 削除したのがアクティブなら先頭に切替
  const active = loadActive();
  if (active.provider === key) {
    const first = Object.keys(config.providers)[0];
    if (first) {
      activeCache = { provider: first, model: active.model };
      saveActive();
    }
  }
  return true;
}

export function getActiveConfig(): ActiveConfig {
  return loadActive();
}

export function setActiveProvider(provider: string): void {
  const config = loadProviders();
  if (!config.providers[provider]) {
    throw new Error(`プロバイダー '${provider}' は登録されていません。/providers で一覧を確認してください。`);
  }
  activeCache = { ...loadActive(), provider };
  saveActive();
}

export function setActiveModel(model: string): void {
  activeCache = { ...loadActive(), model };
  saveActive();
}

export function getActiveProviderEntry(): ProviderEntry {
  const active = loadActive();
  const providers = loadProviders();
  const entry = providers.providers[active.provider];
  if (!entry) {
    throw new Error(`アクティブプロバイダー '${active.provider}' が providers.json にありません。`);
  }
  return entry;
}

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
