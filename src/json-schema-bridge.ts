// ==========================================
// Hikamer - Zod → JSON Schema ブリッジ
// 出典: clawpatch (openclaw/clawpatch) src/provider-schema.ts
// ZodスキーマをLLMのJSONモードに対応したJSON Schemaに変換
// ==========================================

import { z } from "zod";

/**
 * LLMプロバイダがサポートしていないJSON Schemaキーワードを除去
 * clawpatch: stripProviderUnsupportedSchemaKeywords
 */
function stripUnsupportedKeywords(schema: Record<string, unknown>): Record<string, unknown> {
  const unsupported = new Set([
    "$schema",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maximum",
    "minimum",
    "multipleOf",
    "default",
    "examples",
    "definitions",
    "$defs",
    "$id",
    "$comment",
  ]);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (unsupported.has(key)) continue;

    // 再帰処理
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        result[key] = value.map(v =>
          v && typeof v === "object" ? stripUnsupportedKeywords(v as Record<string, unknown>) : v
        );
      } else {
        const objVal = value as Record<string, unknown>;

        // propertiesの中身を再帰
        if (key === "properties" || key === "items" || key === "additionalProperties") {
          result[key] = stripUnsupportedKeywords(objVal);
        } else if (objVal.type === "object" && objVal.properties) {
          result[key] = stripUnsupportedKeywords(objVal);
        } else {
          result[key] = stripUnsupportedKeywords(objVal);
        }
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * ZodスキーマをLLMプロバイダ互換なJSON Schemaに変換
 * clawpatch: providerJsonSchema
 *
 * 使い方:
 * ```typescript
 * const schema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 * const jsonSchema = zodToLLMSchema(schema);
 * // → LLMのtool/function callingのparametersとして使える
 * ```
 */
export function zodToLLMSchema<T extends z.ZodType>(schema: T): Record<string, unknown> {
  // ZodのJSON Schema変換（Zod 3.x / 4.x互換）
  let rawSchema: Record<string, unknown>;

  if (typeof (z as any).toJSONSchema === "function") {
    // Zod 4.x 以降
    rawSchema = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  } else if (typeof (schema as any).toJSONSchema === "function") {
    // 一部のZod 4.xビルド
    rawSchema = (schema as any).toJSONSchema() as Record<string, unknown>;
  } else {
    // Zod 3.x: 手動変換
    rawSchema = zod3ToJsonSchema(schema);
  }

  return stripUnsupportedKeywords(rawSchema);
}

/**
 * Zod 3.x用の手動JSON Schema変換
 */
function zod3ToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodNull || schema instanceof z.ZodUndefined) {
    return { type: "null" };
  }
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zod3ToJsonSchema(schema.element),
    };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zod3ToJsonSchema(value as z.ZodType);
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: schema._def.values as string[],
    };
  }
  if (schema instanceof z.ZodOptional) {
    return zod3ToJsonSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodNullable) {
    const inner = zod3ToJsonSchema(schema.unwrap());
    return { ...inner, nullable: true };
  }
  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: schema.options.map((o: z.ZodType) => zod3ToJsonSchema(o)),
    };
  }

  // フォールバック
  return { type: "string", description: `ZodType: ${schema.constructor?.name || "unknown"}` };
}

/**
 * LLMからのレスポンスをZodスキーマでバリデーション
 * clawpatch: JSON抽出＋Zod検証の組み合わせ
 */
export function parseAndValidate<T>(
  jsonStr: string,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; error: string } {
  try {
    // コードブロックや余分なテキストからJSONを抽出
    const cleaned = extractJSON(jsonStr);
    const parsed = JSON.parse(cleaned);
    const result = schema.safeParse(parsed);

    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error.message };
  } catch (e) {
    return { success: false, error: `JSONパースエラー: ${e}` };
  }
}

/**
 * LLM出力からJSONを抽出（マークダウンコードブロック対応）
 * clawpatch: provider-json.ts のパースロジック
 */
export function extractJSON(text: string): string {
  // ```json ... ``` ブロックを探す
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch) {
    const captured = jsonBlockMatch[1];
    if (captured) return captured.trim();
  }

  // { で始まり } で終わる部分を探す
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return braceMatch[0];
  }

  // [ で始まり ] で終わる部分を探す
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  // BOM文字除去などフォールバック
  return text.trim().replace(/^\uFEFF/, "");
}

/**
 * プロンプトマニフェスト（clawpatchのReviewPromptManifestに相当）
 * プロンプトに含めたファイル情報をトラッキング
 */
export interface PromptManifest {
  maxFiles: number;
  maxTokens: number;
  includedFiles: Array<{
    path: string;
    role: "owned" | "context" | "reference";
    bytes: number;
    truncated: boolean;
  }>;
  omittedFiles: Array<{
    path: string;
    role: string;
    reason: string;
  }>;
  totalBytes: number;
  estimatedTokens: number;
}

/**
 * プロンプトマニフェストを生成
 */
export function createPromptManifest(options: {
  maxTokens?: number;
  maxFiles?: number;
} = {}): PromptManifest {
  return {
    maxFiles: options.maxFiles ?? 20,
    maxTokens: options.maxTokens ?? 8000,
    includedFiles: [],
    omittedFiles: [],
    totalBytes: 0,
    estimatedTokens: 0,
  };
}

/**
 * ファイルをプロンプトに追加（マニフェスト付き）
 */
export function addFileToManifest(
  manifest: PromptManifest,
  path: string,
  content: string,
  role: "owned" | "context" | "reference"
): string | null {
  const maxBytesPerFile = 24_000;
  const estTokens = Math.ceil(content.length / 3);

  if (content.length > maxBytesPerFile) {
    manifest.includedFiles.push({
      path,
      role,
      bytes: maxBytesPerFile,
      truncated: true,
    });
    manifest.omittedFiles.push({
      path,
      role,
      reason: `truncated from ${content.length} to ${maxBytesPerFile} chars`,
    });
    return content.slice(0, maxBytesPerFile);
  }

  if (estTokens > manifest.maxTokens) {
    manifest.omittedFiles.push({
      path,
      role,
      reason: `exceeds remaining token budget (need ~${estTokens}, have ${manifest.maxTokens})`,
    });
    return null;
  }

  manifest.includedFiles.push({
    path,
    role,
    bytes: content.length,
    truncated: false,
  });
  manifest.totalBytes += content.length;
  manifest.estimatedTokens += estTokens;

  return content;
}
