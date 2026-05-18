// ==========================================
// Aikata - Backend Factory + Rate Limiter（ViMax tools/ + utils/ 由来）
// 設定駆動型プラグ可能プロバイダファクトリ + 非同期レート制限
// ==========================================

import { logger } from "./utils/logger";
import { createHash } from "crypto";

// ==================== プロトコル型 ====================

export interface ImageGenerator {
  generateSingleImage(prompt: string, references?: string[]): Promise<{ url: string; b64?: string }>;
  generateBatchImages(prompts: string[], references?: string[]): Promise<Array<{ url: string; b64?: string }>>;
}

export interface VideoGenerator {
  generateSingleVideo(prompt: string, references?: string[]): Promise<{ url: string; duration?: number }>;
}

// ==================== バックエンド設定 ====================

export interface BackendConfig {
  /** 実装クラスのパス */
  classPath: string;
  /** プロバイダ名 */
  provider: string;
  /** APIキー（環境変数名か値） */
  apiKey?: string;
  /** APIベースURL */
  baseUrl?: string;
  /** レート制限 */
  rateLimit?: { requestsPerMinute?: number; requestsPerDay?: number };
  /** 追加オプション */
  options?: Record<string, unknown>;
}

export interface ProviderPreset {
  name: string;
  envVars: Record<string, string>;
  baseUrl?: string;
  temperature?: number;
}

// ==================== プロバイダプリセット ====================

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    name: "OpenAI",
    envVars: { apiKey: "OPENAI_API_KEY" },
    baseUrl: "https://api.openai.com/v1",
  },
  openrouter: {
    name: "OpenRouter",
    envVars: { apiKey: "OPENROUTER_API_KEY" },
    baseUrl: "https://openrouter.ai/api/v1",
  },
  anthropic: {
    name: "Anthropic",
    envVars: { apiKey: "ANTHROPIC_API_KEY" },
    baseUrl: "https://api.anthropic.com/v1",
  },
  google: {
    name: "Google AI",
    envVars: { apiKey: "GOOGLE_API_KEY" },
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
};

// ==================== レートリミッター ====================

interface RateLimitState {
  minuteTokens: number;
  minuteResetAt: number;
  dailyTokens: number;
  dailyResetAt: number;
}

export class RateLimiter {
  private state: RateLimitState;
  private requestsPerMinute: number;
  private requestsPerDay: number;
  private queue: Array<{ resolve: () => void }> = [];

  constructor(requestsPerMinute = 60, requestsPerDay = 10000) {
    this.requestsPerMinute = requestsPerMinute;
    this.requestsPerDay = requestsPerDay;
    this.state = {
      minuteTokens: requestsPerMinute,
      minuteResetAt: Date.now() + 60000,
      dailyTokens: requestsPerDay,
      dailyResetAt: Date.now() + 86400000,
    };
    this.startRefill();
  }

  /** 1回のリクエストを待機 */
  async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();

      // リセット
      if (now >= this.state.minuteResetAt) {
        this.state.minuteTokens = this.requestsPerMinute;
        this.state.minuteResetAt = now + 60000;
      }
      if (now >= this.state.dailyResetAt) {
        this.state.dailyTokens = this.requestsPerDay;
        this.state.dailyResetAt = now + 86400000;
      }

      if (this.state.minuteTokens > 0 && this.state.dailyTokens > 0) {
        this.state.minuteTokens--;
        this.state.dailyTokens--;
        return;
      }

      // 待機
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** 現在の状態 */
  getStatus(): string {
    return [
      `  分間: ${this.state.minuteTokens}/${this.requestsPerMinute} 残り`,
      `  日次: ${this.state.dailyTokens}/${this.requestsPerDay} 残り`,
    ].join("\n");
  }

  private startRefill(): void {
    setInterval(() => {
      const now = Date.now();
      if (now >= this.state.minuteResetAt) {
        this.state.minuteTokens = this.requestsPerMinute;
        this.state.minuteResetAt = now + 60000;
      }
      if (now >= this.state.dailyResetAt) {
        this.state.dailyTokens = this.requestsPerDay;
        this.state.dailyResetAt = now + 86400000;
      }
    }, 10000);
  }
}

// ==================== バックエンドファクトリ ====================

const backends = new Map<string, { instance: unknown; provider: string; createdAt: number }>();
const rateLimiters = new Map<string, RateLimiter>();

/** バックエンドを設定から生成 */
export function createBackend<T>(config: BackendConfig): T {
  const key = `${config.provider}:${config.classPath}`;

  // キャッシュ
  const cached = backends.get(key);
  if (cached) return cached.instance as T;

  // レートリミッター
  if (config.rateLimit) {
    const rlKey = `${config.provider}:${config.rateLimit.requestsPerMinute || 60}:${config.rateLimit.requestsPerDay || 10000}`;
    if (!rateLimiters.has(rlKey)) {
      rateLimiters.set(rlKey, new RateLimiter(
        config.rateLimit.requestsPerMinute || 60,
        config.rateLimit.requestsPerDay || 10000,
      ));
    }
  }

  // APIキー解決（環境変数名から値へ）
  const apiKey = config.apiKey
    ? (config.apiKey.startsWith("$")
      ? (process.env[config.apiKey.slice(1)] || "")
      : config.apiKey)
    : "";

  // プリセットの解決
  const preset = PROVIDER_PRESETS[config.provider.toLowerCase()];
  const baseUrl = config.baseUrl || preset?.baseUrl || "";
  const resolvedEnvVars: Record<string, string> = {};
  if (preset) {
    for (const [key, envVar] of Object.entries(preset.envVars)) {
      resolvedEnvVars[key] = process.env[envVar] || "";
    }
  }

  const instance = {
    provider: config.provider,
    apiKey,
    baseUrl,
    envVars: resolvedEnvVars,
    options: config.options || {},
    rateLimiter: rateLimiters.get(key) || null,
    generateSingleImage: async (prompt: string, references?: string[]) => {
      const limiter = rateLimiters.get(key);
      if (limiter) await limiter.waitForSlot();
      logger.info(`[Backend] ${config.provider}: 画像生成 "${prompt.slice(0, 50)}..."`);
      return { url: "" }; // 実際の実装はプロバイダ固有
    },
    generateBatchImages: async (prompts: string[], references?: string[]) => {
      const limiter = rateLimiters.get(key);
      const results: Array<{ url: string; b64?: string }> = [];
      for (const prompt of prompts) {
        if (limiter) await limiter.waitForSlot();
        results.push({ url: "" });
      }
      return results;
    },
    generateSingleVideo: async (prompt: string, references?: string[]) => {
      const limiter = rateLimiters.get(key);
      if (limiter) await limiter.waitForSlot();
      logger.info(`[Backend] ${config.provider}: 動画生成 "${prompt.slice(0, 50)}..."`);
      return { url: "" };
    },
  };

  backends.set(key, { instance, provider: config.provider, createdAt: Date.now() });
  logger.info(`[Backend] 作成: ${config.provider} (${config.classPath})`);
  return instance as T;
}

/** プロバイダプリセットを適用 */
export function applyProviderPreset(providerName: string, overrides?: Partial<BackendConfig>): BackendConfig {
  const preset = PROVIDER_PRESETS[providerName.toLowerCase()];
  if (!preset) {
    logger.warn(`[Backend] 未知のプロバイダ: ${providerName}`);
    return {
      classPath: "custom",
      provider: providerName,
      ...overrides,
    };
  }

  return {
    classPath: preset.name,
    provider: preset.name,
    baseUrl: preset.baseUrl,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 10000 },
    ...overrides,
  };
}

/** バックエンド状態 */
export function formatBackendStatus(): string {
  const lines: string[] = ["🔌 **Backend Factory**"];
  for (const [key, { provider, createdAt }] of backends) {
    const age = Math.round((Date.now() - createdAt) / 1000);
    lines.push(`  • ${provider}: ${key.split(":")[1]} (${age}秒前)`);
  }
  for (const [key, rl] of rateLimiters) {
    lines.push(`  ⏱️  ${key}: ${rl.getStatus()}`);
  }
  if (backends.size === 0) lines.push("  アクティブなバックエンドはありません");
  return lines.join("\n");
}

// ==================== 2段階コスト最適化 ====================

/** 2段階参照選択（テキストのみ→マルチモーダル） */
export async function twoStageSelect<T>(
  items: T[],
  textFilter: (items: T[]) => Promise<T[]>,
  multimodalSelector: (items: T[]) => Promise<T[]>,
  maxTextFilter = 20,
): Promise<T[]> {
  // ステージ1: テキストのみでフィルタ（安い）
  if (items.length > maxTextFilter) {
    items = await textFilter(items);
  }

  // ステージ2: マルチモーダルで最終選択（高価）
  if (items.length > 0) {
    items = await multimodalSelector(items);
  }

  return items;
}
