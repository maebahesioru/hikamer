// ==========================================
// Aikata - モデルルーティング（OpenHuman inference + routing由来）
// タスク種別に応じて最適なモデルを自動選択
// ==========================================

import { createActiveProvider } from "./providers/base";
import { getActiveModel, getProvider, getApiKey } from "./utils/config";
import type { LLMProvider, LLMResponse, Message, Tool } from "./types";
import { logger } from "./utils/logger";

// ==================== ワークロード種別 ====================

export type WorkloadType = "reasoning" | "fast" | "vision" | "code" | "summarize" | "search" | "default";

interface WorkloadConfig {
  /** ワークロードに使うモデル（空ならデフォルトモデル） */
  model?: string;
  /** プロバイダー（空ならデフォルト） */
  provider?: string;
  maxTokens?: number;
  temperature?: number;
}

// ==================== デフォルトルーティング ====================

const DEFAULT_ROUTES: Record<WorkloadType, Partial<WorkloadConfig>> = {
  reasoning: {
    model: "deepseek/deepseek-v4-pro",
    maxTokens: 8192,
    temperature: 0.6,
  },
  fast: {
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 4096,
    temperature: 0.7,
  },
  vision: {
    model: "gpt-4o",
    maxTokens: 4096,
    temperature: 0.7,
  },
  code: {
    model: "deepseek/deepseek-v4-pro",
    maxTokens: 8192,
    temperature: 0.3,
  },
  summarize: {
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 2048,
    temperature: 0.3,
  },
  search: {
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 2048,
    temperature: 0.3,
  },
  default: {},
};

// ==================== ルーター ====================

class ModelRouter {
  private routes: Record<string, Partial<WorkloadConfig>> = {};
  private providerCache = new Map<string, LLMProvider>();

  constructor() {
    // デフォルトルートをコピー
    for (const [key, val] of Object.entries(DEFAULT_ROUTES)) {
      this.routes[key] = { ...val };
    }
  }

  /** ルート設定（マージ） */
  setRoute(workload: WorkloadType | string, config: Partial<WorkloadConfig>): void {
    this.routes[workload] = { ...(this.routes[workload] || {}), ...config };
    // プロバイダーキャッシュをクリア
    this.providerCache.clear();
    logger.info(`[Router] ルート設定: ${workload} → ${config.model || "(デフォルト)"}`);
  }

  /** ルート削除 */
  removeRoute(workload: string): void {
    delete this.routes[workload];
    logger.info(`[Router] ルート削除: ${workload}`);
  }

  /** ワークロードに合ったプロバイダーを作成 */
  getProvider(workload: WorkloadType = "default"): LLMProvider {
    const config = this.routes[workload] || this.routes["default"];

    if (config.provider && config.model) {
      const cacheKey = `${config.provider}:${config.model}`;
      const cached = this.providerCache.get(cacheKey);
      if (cached) return cached;
    }

    // デフォルトを使用
    return createActiveProvider();
  }

  /** ワークロード用のチャット関数（ルーティング付き） */
  async chat(
    messages: Message[],
    tools: Tool[],
    workload: WorkloadType = "default",
    options?: {
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<LLMResponse> {
    const config = this.routes[workload] || this.routes["default"];
    const provider = this.getProvider(workload);

    logger.debug(`[Router] ${workload}: ${(config as any).model || "default"}`);

    return provider.chat(messages, tools);
  }

  /** ルーティングテーブル表示 */
  formatRoutes(): string {
    const entries = Object.entries(this.routes).filter(([k]) => k !== "default");
    if (entries.length === 0) return "カスタムルートは設定されていません。";

    return [
      "**モデルルーティング一覧**",
      "",
      ...entries.map(([workload, cfg]) => {
        const model = cfg.model || "(デフォルト)";
        const prov = cfg.provider || "(デフォルト)";
        const tokens = cfg.maxTokens || "default";
        const temp = cfg.temperature !== undefined ? cfg.temperature : "default";
        return `• **${workload}**: ${prov}/${model} (max_tokens=${tokens}, temp=${temp})`;
      }),
      "",
      "**ワークロード種別:** reasoning / fast / vision / code / summarize / search",
    ].join("\n");
  }

  /** 入力からワークロードを推測 */
  detectWorkload(messages: Message[], tools: Tool[]): WorkloadType {
    const lastMsg = messages[messages.length - 1];
    const content = (lastMsg?.content || "").toLowerCase();

    // ツール呼び出しがある場合
    if (lastMsg?.tool_calls?.length) {
      const toolNames = lastMsg.tool_calls.map(tc => tc.function.name);

      if (toolNames.some(n => ["code_execute", "terminal"].includes(n))) return "code";
      if (toolNames.some(n => ["web_search", "search_conversations"].includes(n))) return "search";
      if (toolNames.some(n => ["browser", "image_gen"].includes(n))) return "vision";
    }

    // テキストヒューリスティック
    if (content.length > 2000) return "summarize";
    if (content.includes("コード") || content.includes("code") || content.includes("プログラミング")) return "code";
    if (content.includes("検索") || content.includes("調べて") || content.includes("調査")) return "search";
    if (content.includes("要約") || content.includes("まとめて")) return "summarize";

    // ツール数から判断
    if (tools.length > 5) return "reasoning";

    return "default";
  }
}

// ==================== シングルトン ====================

export const modelRouter = new ModelRouter();
