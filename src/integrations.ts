// ==========================================
// Aikata - 外部連携（OpenHuman integrations/ 由来）
// サードパーティサービス統合
// Apify, Google Places, Twilio, 株価, Seltz
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface IntegrationProvider {
  name: string;
  description: string;
  enabled: boolean;
  configKeys: string[];
  check(): Promise<IntegrationStatus>;
}

export interface IntegrationStatus {
  provider: string;
  connected: boolean;
  latencyMs: number;
  error?: string;
}

export interface GooglePlacesResult {
  name: string;
  address: string;
  rating: number;
  types: string[];
  phoneNumber?: string;
  website?: string;
  openingHours?: string[];
}

export interface StockPrice {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: number;
}

// ==================== 連携マネージャー ====================

class IntegrationManager {
  private providers: IntegrationProvider[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.registerDefaults();
    this.initialized = true;
    logger.info(`[Integrations] initialized with ${this.providers.length} providers`);
  }

  /** プロバイダーを登録 */
  register(provider: IntegrationProvider): void {
    this.providers.push(provider);
  }

  /** 全プロバイダーの状態をチェック */
  async checkAll(): Promise<IntegrationStatus[]> {
    const results: IntegrationStatus[] = [];
    for (const p of this.providers) {
      if (!p.enabled) continue;
      try {
        const status = await p.check();
        results.push(status);
      } catch (err) {
        results.push({
          provider: p.name,
          connected: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }
    return results;
  }

  /** Google Places検索 */
  async searchPlaces(query: string): Promise<GooglePlacesResult[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      logger.warn("[Integrations] Google Places API key not configured");
      return [];
    }

    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}&language=ja`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as {
        results?: Array<{
          name: string;
          formatted_address: string;
          rating: number;
          types: string[];
          formatted_phone_number?: string;
          website?: string;
          opening_hours?: { weekday_text?: string[] };
        }>;
      };

      return (data.results ?? []).slice(0, 5).map((r) => ({
        name: r.name,
        address: r.formatted_address,
        rating: r.rating,
        types: r.types,
        phoneNumber: r.formatted_phone_number,
        website: r.website,
        openingHours: r.opening_hours?.weekday_text,
      }));
    } catch {
      return [];
    }
  }

  /** 株価取得 */
  async getStockPrice(symbol: string): Promise<StockPrice | null> {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return null;

      const data = (await res.json()) as {
        chart?: {
          result?: Array<{
            meta?: { regularMarketPrice?: number; previousClose?: number };
            indicators?: { quote?: Array<{ volume?: number[] }> };
          }>;
        };
      };

      const result = data.chart?.result?.[0];
      if (!result?.meta) return null;

      return {
        symbol: symbol.toUpperCase(),
        price: result.meta.regularMarketPrice ?? 0,
        change: (result.meta.regularMarketPrice ?? 0) - (result.meta.previousClose ?? 0),
        changePercent: result.meta.previousClose
          ? (((result.meta.regularMarketPrice ?? 0) - result.meta.previousClose) / result.meta.previousClose) * 100
          : 0,
        volume: result.indicators?.quote?.[0]?.volume?.[0] ?? 0,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Twilio SMS送信 */
  async sendSms(to: string, message: string): Promise<boolean> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!accountSid || !authToken || !from) {
      logger.warn("[Integrations] Twilio not configured");
      return false;
    }

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            To: to,
            From: from,
            Body: message.slice(0, 1600),
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      return res.ok;
    } catch (err) {
      logger.error(`[Integrations] Twilio send failed:`, err);
      return false;
    }
  }

  /** Apify（Webスクレイピング） */
  async apifyRun(actorId: string, input: Record<string, unknown>): Promise<unknown | null> {
    const apiKey = process.env.APIFY_API_KEY;
    if (!apiKey) {
      logger.warn("[Integrations] Apify not configured");
      return null;
    }

    try {
      const res = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** プロバイダー一覧 */
  listProviders(): IntegrationProvider[] {
    return [...this.providers];
  }

  // ---- 内部 ----

  private registerDefaults(): void {
    this.register({
      name: "google_places",
      description: "Google Places API（場所検索）",
      enabled: !!process.env.GOOGLE_PLACES_API_KEY,
      configKeys: ["GOOGLE_PLACES_API_KEY"],
      check: async () => ({
        provider: "google_places",
        connected: !!process.env.GOOGLE_PLACES_API_KEY,
        latencyMs: 0,
      }),
    });

    this.register({
      name: "yahoo_finance",
      description: "Yahoo Finance（株価）",
      enabled: true,
      configKeys: [],
      check: async () => ({
        provider: "yahoo_finance",
        connected: true,
        latencyMs: 0,
      }),
    });

    this.register({
      name: "twilio",
      description: "Twilio SMS",
      enabled: !!process.env.TWILIO_ACCOUNT_SID,
      configKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
      check: async () => ({
        provider: "twilio",
        connected: !!process.env.TWILIO_ACCOUNT_SID,
        latencyMs: 0,
      }),
    });

    this.register({
      name: "apify",
      description: "Apify（Webスクレイピング）",
      enabled: !!process.env.APIFY_API_KEY,
      configKeys: ["APIFY_API_KEY"],
      check: async () => ({
        provider: "apify",
        connected: !!process.env.APIFY_API_KEY,
        latencyMs: 0,
      }),
    });
  }

  formatStatuses(statuses: IntegrationStatus[]): string {
    return (
      `🔌 **外部連携状態**\n\n` +
      statuses
        .map((s) =>
          `${s.connected ? "✅" : "❌"} **${s.provider}**` +
          (s.latencyMs > 0 ? ` (${s.latencyMs}ms)` : "") +
          (s.error ? `: ${s.error}` : "")
        )
        .join("\n")
    );
  }
}

// ==================== シングルトン ====================

export const integrationManager = new IntegrationManager();

export default IntegrationManager;
