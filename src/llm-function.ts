// ==========================================
// Aikata - LLM-as-Function + Intent Routing（ViMax agents/ 由来）
// Pydantic I/Oパターンの軽量実装 + インテントルーティング
// ==========================================

import { logger } from "./utils/logger";
import { retryWithBackoff } from "./retry-utils";

// ==================== LLM-as-Function ====================

export interface LLMFunctionConfig {
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  retryAttempts?: number;
  timeoutMs?: number;
}

export interface LLMFunctionResult<T> {
  data: T;
  raw: string;
  model: string;
  provider: string;
  durationMs: number;
  tokensUsed?: number;
}

/** LLM関数テンプレート（Pydantic I/Oに相当） */
export async function llmFunction<T>(
  systemPrompt: string,
  userMessage: string,
  outputSchema: { parse: (raw: string) => T },
  config: LLMFunctionConfig = {},
): Promise<LLMFunctionResult<T>> {
  const start = Date.now();

  const result = await retryWithBackoff(
    async () => {
      // LLM呼び出し（実際の実装ではproviders/base.tsを使用）
      const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

      // 実際のLLM呼び出しに置き換え
      const response = await callLLM(fullPrompt, config);

      // スキーマパース
      const parsed = outputSchema.parse(response);
      return { text: response, parsed };
    },
    {
      maxAttempts: config.retryAttempts ?? 3,
      baseDelayMs: 1000,
      onRetry: (attempt, err) => logger.warn(`[LLMFn] リトライ ${attempt}: ${err.message}`),
    },
  );

  return {
    data: result.parsed,
    raw: result.text,
    model: config.model || "default",
    provider: config.provider || "openrouter",
    durationMs: Date.now() - start,
  };
}

/** LLM呼び出し（プレースホルダー、実際はAikataのプロバイダを使う） */
async function callLLM(prompt: string, config: LLMFunctionConfig): Promise<string> {
  // 実際のAikataプロバイダ呼び出しに置き換え
  // const { complete } = await import("./providers/base");
  // return complete(prompt, config);
  return `LLM response for: ${prompt.slice(0, 50)}...`; // placeholder
}

// ==================== スキーマ定義ヘルパー ====================

/** JSONスキーマベースのパーサーを作成 */
export function jsonSchema<T>(fields: Record<string, { type: string; optional?: boolean }>): {
  parse: (raw: string) => T;
  prompt: string;
} {
  const fieldDefs = Object.entries(fields)
    .map(([key, def]) => `  "${key}": "${def.type}${def.optional ? " (optional)" : ""}"`)
    .join(",\n");

  return {
    parse: (raw: string) => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        // JSON抽出のフォールバック
        const jsonMatch = raw.match(/\{[^]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]) as T;
        throw new Error(`Failed to parse LLM output as JSON: ${raw.slice(0, 100)}`);
      }
    },
    prompt: [
      "You must respond with valid JSON only, no markdown, no explanation:",
      "{",
      fieldDefs,
      "}",
    ].join("\n"),
  };
}

/** リスト出力スキーマ */
export function listSchema<T>(itemSchema: string): {
  parse: (raw: string) => T[];
  prompt: string;
} {
  return {
    parse: (raw: string) => {
      try {
        return JSON.parse(raw) as T[];
      } catch {
        const arrayMatch = raw.match(/\[[^]*\]/);
        if (arrayMatch) return JSON.parse(arrayMatch[0]) as T[];
        throw new Error(`Failed to parse list output: ${raw.slice(0, 100)}`);
      }
    },
    prompt: `Output only a JSON array of ${itemSchema} objects, no markdown.`,
  };
}

// ==================== インテントルーティング ====================

export type IntentCategory = string;

export interface IntentRoute {
  category: IntentCategory;
  handler: string;
  prompt: string;
  priority: number;
}

const intentRoutes = new Map<IntentCategory, IntentRoute>();

/** インテントルートを登録 */
export function registerIntent(category: IntentCategory, route: IntentRoute): void {
  intentRoutes.set(category, route);
  logger.info(`[Intent] 登録: ${category} → ${route.handler}`);
}

/** テキストからインテントを分類 */
export async function classifyIntent(
  text: string,
  categories: IntentCategory[],
): Promise<{ category: IntentCategory; confidence: number }> {
  const schema = jsonSchema<{ category: string; confidence: number }>({
    category: { type: "string" },
    confidence: { type: "number" },
  });

  const systemPrompt = [
    "Classify the following user input into exactly one of these categories:",
    categories.map((c) => `- ${c}`).join("\n"),
    "Respond with JSON: { category, confidence }",
  ].join("\n");

  const result = await llmFunction(systemPrompt, text, schema);
  return { category: result.data.category, confidence: result.data.confidence };
}

/** 分類済みテキストをルーティング */
export async function routeByIntent(
  text: string,
  categories: IntentCategory[],
): Promise<{ route: IntentRoute; category: IntentCategory } | null> {
  const { category } = await classifyIntent(text, categories);
  const route = intentRoutes.get(category);
  if (!route) return null;
  return { route, category };
}

/** インテントルート一覧 */
export function formatIntents(): string {
  const lines: string[] = ["🧭 **Intent Routes**"];
  for (const [category, route] of intentRoutes) {
    lines.push(`  • **${category}**: ${route.handler} (優先度: ${route.priority})`);
  }
  return lines.join("\n");
}
