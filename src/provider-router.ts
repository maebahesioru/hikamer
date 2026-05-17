// ==========================================
// Aikata - AIプロバイダールーター（OpenHuman providers/factory/retry由来）
// 高機能プロバイダー抽象化：リトライ＋フォールバック＋負荷分散
// ==========================================

import { createActiveProvider } from "./providers/base";
import { getProvider, getApiKey, getActiveModel } from "./utils/config";
import type { LLMProvider, LLMResponse, LLMChunk, Message, Tool } from "./types";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type RouterStrategy = "primary_only" | "fallback" | "load_balance" | "fastest";

export interface ProviderRoute {
  name: string;
  provider: string;
  model: string;
  weight: number;      // 負荷分散用
  timeout: number;
  maxRetries: number;
  tags: string[];       // ワークロードタグ
}

// ==================== プロバイダールーター ====================

class ProviderRouter {
  private routes: ProviderRoute[] = [];
  private strategy: RouterStrategy = "fallback";
  private failoverCounts = new Map<string, number>();

  constructor() {
    this.loadDefaultRoutes();
  }

  /** デフォルトルート */
  private loadDefaultRoutes(): void {
    const active = getActiveModel();
    this.routes = [
      {
        name: "primary",
        provider: active.provider,
        model: active.model,
        weight: 10,
        timeout: 120000,
        maxRetries: 3,
        tags: ["all"],
      },
    ];
  }

  /** ルート追加 */
  addRoute(route: ProviderRoute): void {
    this.routes.push(route);
    logger.info(`[ProviderRouter] ルート追加: ${route.name} (${route.provider}/${route.model})`);
  }

  /** 戦略設定 */
  setStrategy(strategy: RouterStrategy): void {
    this.strategy = strategy;
    logger.info(`[ProviderRouter] 戦略: ${strategy}`);
  }

  /** 最適なプロバイダーを選択 */
  selectProvider(workload?: string): { route: ProviderRoute; provider: LLMProvider } {
    const candidates = workload
      ? this.routes.filter(r => r.tags.includes("all") || r.tags.includes(workload))
      : this.routes;

    if (candidates.length === 0) {
      return { route: this.routes[0]!, provider: createActiveProvider() };
    }

    switch (this.strategy) {
      case "primary_only":
        return this.selectPrimary(candidates);
      case "fallback":
        return this.selectWithFallback(candidates);
      case "load_balance":
        return this.selectWeighted(candidates);
      case "fastest":
        return this.selectPrimary(candidates);
      default:
        return this.selectPrimary(candidates);
    }
  }

  /** プライマリ選択 */
  private selectPrimary(candidates: ProviderRoute[]): { route: ProviderRoute; provider: LLMProvider } {
    const route = candidates.sort((a, b) => a.weight - b.weight)[0]!;
    return { route, provider: this.createProvider(route) };
  }

  /** フォールバック付き */
  private selectWithFallback(candidates: ProviderRoute[]): { route: ProviderRoute; provider: LLMProvider } {
    const sorted = candidates.sort((a, b) => {
      const aFails = this.failoverCounts.get(`${a.provider}:${a.model}`) || 0;
      const bFails = this.failoverCounts.get(`${b.provider}:${b.model}`) || 0;
      return aFails - bFails;
    });
    const route = sorted[0]!;
    return { route, provider: this.createProvider(route) };
  }

  /** 重みづけ負荷分散 */
  private selectWeighted(candidates: ProviderRoute[]): { route: ProviderRoute; provider: LLMProvider } {
    const totalWeight = candidates.reduce((s, r) => s + r.weight, 0);
    let random = Math.random() * totalWeight;
    for (const route of candidates) {
      random -= route.weight;
      if (random <= 0) return { route, provider: this.createProvider(route) };
    }
    return { route: candidates[candidates.length - 1]!, provider: this.createProvider(candidates[candidates.length - 1]!) };
  }

  /** プロバイダー作成 */
  private createProvider(route: ProviderRoute): LLMProvider {
    try {
      const entry = getProvider(route.provider);
      if (entry) {
        const apiKey = getApiKey(route.provider);
        const { createProvider } = require("./providers/base") as any;
        if (createProvider) return createProvider(entry, route.model, apiKey);
      }
    } catch {}
    return createActiveProvider();
  }

  /** 呼び出し失敗を記録（フォールバック用） */
  recordFailure(route: ProviderRoute): void {
    const key = `${route.provider}:${route.model}`;
    this.failoverCounts.set(key, (this.failoverCounts.get(key) || 0) + 1);
    logger.warn(`[ProviderRouter] 失敗記録: ${key} (${this.failoverCounts.get(key)}回)`);
  }

  /** 呼び出し成功を記録（カウンタ減衰） */
  recordSuccess(route: ProviderRoute): void {
    const key = `${route.provider}:${route.model}`;
    const current = this.failoverCounts.get(key) || 0;
    if (current > 0) this.failoverCounts.set(key, current - 1);
  }

  /** フォールバック付きチャット */
  async chatWithFallback(
    messages: Message[],
    tools: Tool[],
    workload?: string,
  ): Promise<LLMResponse> {
    const { route, provider } = this.selectProvider(workload);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= route.maxRetries; attempt++) {
      try {
        const result = await provider.chat(messages, tools);
        this.recordSuccess(route);
        return result;
      } catch (e: any) {
        lastError = e;
        this.recordFailure(route);
        logger.warn(`[ProviderRouter] リトライ ${attempt + 1}/${route.maxRetries}: ${e.message}`);

        if (attempt < route.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error("全リトライ失敗");
  }

  /** フォーマット */
  formatRoutes(): string {
    return [
      "🔄 **プロバイダールーター**",
      `戦略: ${this.strategy}`,
      "",
      ...this.routes.map(r => {
        const fails = this.failoverCounts.get(`${r.provider}:${r.model}`) || 0;
        const failStr = fails > 0 ? ` ⚠️${fails}回失敗` : "";
        return `• **${r.name}**: ${r.provider}/${r.model} (weight=${r.weight}, timeout=${r.timeout}ms)${failStr}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const providerRouter = new ProviderRouter();
