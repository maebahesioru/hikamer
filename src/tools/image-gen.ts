// ==========================================
// Aikata - 画像生成ツール（OpenClaw image-generation由来）
// テキストから画像を生成
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";

// ==================== プロバイダーマップ ====================

interface ImageProvider {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  /** リクエスト形式変換 */
  buildBody: (prompt: string, opts: ImageOptions) => any;
  /** レスポンスから画像URLを抽出 */
  extractUrl: (json: any) => string | null;
}

interface ImageOptions {
  size?: string;
  negativePrompt?: string;
  n?: number;
}

// ==================== プロバイダー ====================

const PROVIDERS: Record<string, ImageProvider> = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "dall-e-3",
    apiKeyEnv: "OPENAI_API_KEY",
    buildBody(prompt, opts) {
      return {
        model: this.model,
        prompt,
        n: opts.n || 1,
        size: opts.size || "1024x1024",
      };
    },
    extractUrl(json: any) {
      return json.data?.[0]?.url || null;
    },
  },
};

// ==================== デフォルトプロバイダー検出 ====================

function detectProvider(): ImageProvider | null {
  // 設定済みのプロバイダーを検出
  for (const [, provider] of Object.entries(PROVIDERS)) {
    if (process.env[provider.apiKeyEnv]) return provider;
  }
  return null;
}

// ==================== ツール ====================

const genTool: ToolDescriptor = {
  name: "generate_image",
  emoji: "🎨",
  owner: "core",
  description: "テキストプロンプトから画像を生成します。DALL-E 3対応。APIキーが必要。",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "生成する画像の説明（英語推奨、詳細に）",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1792x1024", "1024x1792"],
        description: "画像サイズ（デフォルト1024x1024）",
        default: "1024x1024",
      },
      provider: {
        type: "string",
        description: "使用するプロバイダー（省略時は自動検出）",
        default: "openai",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "").trim();
    const size = (args.size as string) || "1024x1024";
    const providerName = (args.provider as string) || "openai";

    if (!prompt) return "[エラー] prompt が必要です";

    const provider = PROVIDERS[providerName] || detectProvider();
    if (!provider) {
      return "[エラー] 利用可能な画像生成プロバイダーがありません\n" +
        "環境変数 OPENAI_API_KEY を設定するか、有効なプロバイダーを指定してください。";
    }

    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) {
      return `[エラー] ${provider.name}のAPIキーが設定されていません\n環境変数 ${provider.apiKeyEnv} を設定してください。`;
    }

    logger.info(`画像生成: ${provider.name} "${prompt.slice(0, 60)}"`);

    try {
      const body = provider.buildBody(prompt, { size });
      const response = await fetch(`${provider.baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "unknown");
        return `[エラー] ${provider.name} APIエラー (${response.status}): ${err.slice(0, 300)}`;
      }

      const json = await response.json();
      const imageUrl = provider.extractUrl(json);

      if (!imageUrl) {
        return `[エラー] 画像URLの取得に失敗しました\nレスポンス: ${JSON.stringify(json).slice(0, 500)}`;
      }

      return `🎨 **画像生成完了** (${provider.name})\nプロンプト: ${prompt}\nサイズ: ${size}\n\n![生成画像](${imageUrl})`;
    } catch (e: any) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        return `[エラー] 画像生成がタイムアウトしました（60秒）`;
      }
      return `[エラー] 画像生成失敗: ${e.message?.slice(0, 200) || String(e)}`;
    }
  },
};

toolRegistry.register(genTool);
export { genTool };
