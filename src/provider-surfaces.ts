// ==========================================
// Hikamer - プロバイダーサーフェス（OpenHuman provider_surfaces/ 由来）
// プロバイダー設定の管理・公開設定
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface ProviderSurface {
  id: string;
  provider: string;
  model: string;
  endpoint: string;
  capabilities: string[];
  surfaceType: "api" | "local" | "proxy";
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
}

// ==================== プロバイダーサーフェスマネージャー ====================

class ProviderSurfaceManager {
  private surfaces: Map<string, ProviderSurface> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.discoverSurfaces();
    this.initialized = true;
    logger.info(`[Surfaces] initialized: ${this.surfaces.size} surfaces`);
  }

  /** 利用可能なサーフェスを検出 */
  discoverSurfaces(): void {
    // 環境変数から検出
    const surfaces: Array<{ provider: string; endpoint: string; model: string }> = [];

    if (process.env.OPENROUTER_API_KEY) {
      surfaces.push({
        provider: "openrouter",
        endpoint: process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1",
        model: process.env.AIKATA_MODEL || "deepseek/deepseek-v4-flash",
      });
    }
    if (process.env.OPENAI_API_KEY) {
      surfaces.push({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
      });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      surfaces.push({
        provider: "anthropic",
        endpoint: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4",
      });
    }
    if (process.env.AIKATA_LOCAL_ENDPOINT) {
      surfaces.push({
        provider: "local",
        endpoint: process.env.AIKATA_LOCAL_ENDPOINT,
        model: "local-model",
      });
    }

    for (const s of surfaces) {
      this.registerSurface({
        provider: s.provider,
        model: s.model,
        endpoint: s.endpoint,
        capabilities: ["chat", "completion"],
        surfaceType: s.provider === "local" ? "local" : "api",
        priority: s.provider === "openrouter" ? 10 : 5,
      });
    }
  }

  /** サーフェスを登録 */
  registerSurface(config: Omit<ProviderSurface, "id" | "enabled" | "settings">): ProviderSurface {
    const id = `surf-${config.provider}-${Date.now().toString(36)}`;
    const surface: ProviderSurface = {
      ...config,
      id,
      enabled: true,
      settings: {},
    };
    this.surfaces.set(id, surface);
    return surface;
  }

  /** サーフェス一覧 */
  listSurfaces(): ProviderSurface[] {
    return Array.from(this.surfaces.values());
  }

  /** 有効なサーフェス */
  getEnabledSurfaces(): ProviderSurface[] {
    return this.listSurfaces().filter((s) => s.enabled);
  }

  /** プロバイダー別のサーフェス */
  getByProvider(provider: string): ProviderSurface[] {
    return this.listSurfaces().filter((s) => s.provider === provider);
  }

  /** 最適なサーフェスを選択 */
  selectBest(model?: string): ProviderSurface | null {
    const enabled = this.getEnabledSurfaces().sort((a, b) => b.priority - a.priority);
    if (model) {
      return enabled.find((s) => s.model === model) ?? enabled[0] ?? null;
    }
    return enabled[0] ?? null;
  }

  /** サーフェスの有効/無効 */
  setEnabled(id: string, enabled: boolean): boolean {
    const surface = this.surfaces.get(id);
    if (!surface) return false;
    surface.enabled = enabled;
    return true;
  }

  formatStatus(): string {
    const surfaces = this.listSurfaces();
    return (
      `🔌 **プロバイダーサーフェス (${surfaces.length})**\n\n` +
      surfaces
        .map(
          (s) =>
            `${s.enabled ? "✅" : "⛔"} **${s.provider}** (${s.surfaceType})\n` +
            `   モデル: ${s.model} | エンドポイント: ${s.endpoint.slice(0, 40)}...\n` +
            `   機能: ${s.capabilities.join(", ")} | 優先度: ${s.priority}`
        )
        .join("\n\n")
    );
  }
}

// ==================== シングルトン ====================

export const providerSurfaces = new ProviderSurfaceManager();

export default ProviderSurfaceManager;
