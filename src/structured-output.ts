// ==========================================
// Aikata - Structured Output Enforcer (v1.72)
// 出典: nadeesha/structlm + guidance-ai/llguidance パターン
// JSON SchemaによるLLM出力の検証・再試行・修復
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface SchemaValidationResult<T = any> {
  valid: boolean;
  data?: T;
  errors: string[];
  rawOutput: string;
  retriesUsed: number;
}

export interface SchemaDefinition {
  type: string;
  properties?: Record<string, SchemaDefinition>;
  required?: string[];
  enum?: string[];
  items?: SchemaDefinition;
  description?: string;
  /** 追加のバリデーション（自然言語） */
  validation_rules?: string[];
}

// ==================== JSON Schema バリデーター ====================

class SchemaValidator {
  /**
   * JSON文字列をパースし、スキーマに対して検証
   */
  validate<T = any>(raw: string, schema: SchemaDefinition): SchemaValidationResult<T> {
    const errors: string[] = [];

    // 1. JSONパース試行
    let data: any;
    try {
      // コードブロック内のJSONを抽出
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : raw.trim();
      data = JSON.parse(jsonStr);
    } catch (e: any) {
      return { valid: false, errors: [`JSONパース失敗: ${e.message}`], rawOutput: raw, retriesUsed: 0 };
    }

    // 2. 型チェック
    if (schema.type === "object" && typeof data !== "object") {
      errors.push(`型不一致: object 期待、${typeof data} 受信`);
      return { valid: false, errors, rawOutput: raw, retriesUsed: 0, data };
    }

    if (schema.type === "array" && !Array.isArray(data)) {
      errors.push(`型不一致: array 期待、${typeof data} 受信`);
      return { valid: false, errors, rawOutput: raw, retriesUsed: 0, data };
    }

    // 3. プロパティ検証
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (data[key] === undefined) {
          if (schema.required?.includes(key)) {
            errors.push(`必須プロパティ欠落: ${key}`);
          }
          continue;
        }

        // 型チェック
        const value = data[key];
        if (propSchema.type === "string" && typeof value !== "string") {
          errors.push(`${key}: string 期待、${typeof value} 受信`);
        } else if (propSchema.type === "number" && typeof value !== "number") {
          errors.push(`${key}: number 期待、${typeof value} 受信`);
        } else if (propSchema.type === "boolean" && typeof value !== "boolean") {
          errors.push(`${key}: boolean 期待、${typeof value} 受信`);
        } else if (propSchema.type === "array" && !Array.isArray(value)) {
          errors.push(`${key}: array 期待、${typeof value} 受信`);
        }

        // Enum検証
        if (propSchema.enum && !propSchema.enum.includes(value)) {
          errors.push(`${key}: "${value}" は enum [${propSchema.enum.join(", ")}] に含まれない`);
        }
      }

      // 未知のプロパティ警告
      for (const key of Object.keys(data)) {
        if (!(key in schema.properties)) {
          logger.debug(`[SchemaValidator] 未知のプロパティ: ${key}（許容）`);
        }
      }
    }

    // 4. 配列要素の検証
    if (schema.type === "array" && schema.items && Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        if (schema.items.type === "string" && typeof data[i] !== "string") {
          errors.push(`items[${i}]: string 期待`);
        } else if (schema.items.type === "number" && typeof data[i] !== "number") {
          errors.push(`items[${i}]: number 期待`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      data: data as T,
      errors,
      rawOutput: raw,
      retriesUsed: 0,
    };
  }

  /**
   * スキーマをLLM向けのプロンプト指示に変換
   */
  buildSchemaPrompt(schema: SchemaDefinition): string {
    const parts: string[] = [];

    parts.push(`以下のJSON Schemaに厳密に従って出力してください:`);
    parts.push("```json");
    parts.push(JSON.stringify(this.simplifySchema(schema), null, 2));
    parts.push("```");

    if (schema.required && schema.required.length > 0) {
      parts.push(`\n必須フィールド: ${schema.required.join(", ")}`);
    }

    if (schema.validation_rules && schema.validation_rules.length > 0) {
      parts.push(`\n追加ルール:`);
      for (const rule of schema.validation_rules) {
        parts.push(`- ${rule}`);
      }
    }

    parts.push(`\nJSONオブジェクトのみを出力し、説明文は含めないでください。`);

    return parts.join("\n");
  }

  /**
   * スキーマ違反時のリトライプロンプトを生成
   */
  buildRetryPrompt(prevResult: SchemaValidationResult, schema: SchemaDefinition): string {
    const parts: string[] = [];

    parts.push(`前回の出力がJSON Schemaに違反していました。修正してください。`);
    parts.push(``);
    parts.push(`**違反内容**:`);
    for (const err of prevResult.errors) {
      parts.push(`- ❌ ${err}`);
    }
    parts.push(``);
    parts.push(`**前回の出力**:`);
    parts.push("```json");
    parts.push(prevResult.rawOutput.slice(0, 2000));
    parts.push("```");
    parts.push(``);
    parts.push(this.buildSchemaPrompt(schema));

    return parts.join("\n");
  }

  /**
   * TypeScriptのinterfaceからJSON Schemaを生成
   */
  static fromTypeScript(schemaObj: Record<string, string>): SchemaDefinition {
    const properties: Record<string, SchemaDefinition> = {};
    const required: string[] = [];

    for (const [key, type] of Object.entries(schemaObj)) {
      const isRequired = !key.endsWith("?");
      const cleanKey = isRequired ? key : key.slice(0, -1);

      properties[cleanKey] = { type, description: "" };
      if (isRequired) required.push(cleanKey);
    }

    return { type: "object", properties, required };
  }

  private simplifySchema(schema: SchemaDefinition): any {
    const result: any = { type: schema.type };
    if (schema.properties) {
      result.properties = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        result.properties[key] = { type: prop.type };
        if (prop.enum) result.properties[key].enum = prop.enum;
        if (prop.description) result.properties[key].description = prop.description;
      }
    }
    if (schema.required) result.required = schema.required;
    if (schema.items) result.items = { type: schema.items.type };
    return result;
  }
}

// ==================== 構造化出力エンフォーサー ====================

class StructuredOutputEnforcer {
  private validator = new SchemaValidator();
  private maxRetries = 2;

  /**
   * LLM出力を構造化。失敗時は自動リトライ
   * @param rawOutput LLMの生出力
   * @param schema JSON Schema定義
   * @param retryFn リトライ用のLLM呼び出し関数
   */
  async enforce<T = any>(
    rawOutput: string,
    schema: SchemaDefinition,
    retryFn?: (retryPrompt: string) => Promise<string>,
  ): Promise<SchemaValidationResult<T>> {
    let result = this.validator.validate<T>(rawOutput, schema);
    let retries = 0;

    while (!result.valid && retries < this.maxRetries && retryFn) {
      retries++;
      logger.warn(`[StructuredOutput] スキーマ違反 (${result.errors.length}件) → リトライ ${retries}/${this.maxRetries}`);

      try {
        const retryPrompt = this.validator.buildRetryPrompt(result, schema);
        const retryOutput = await retryFn(retryPrompt);
        result = this.validator.validate<T>(retryOutput, schema);
        result.retriesUsed = retries;
      } catch (e: any) {
        result.errors.push(`リトライ失敗: ${e.message}`);
        break;
      }
    }

    if (!result.valid) {
      logger.warn(`[StructuredOutput] 検証失敗（${retries}回リトライ後）: ${result.errors.join("; ")}`);
    }

    return result;
  }

  /**
   * ツールの引数スキーマを生成
   * toolRegistryのparametersからJSON Schemaを構築
   */
  buildToolSchema(parameters: any): SchemaDefinition {
    if (!parameters || !parameters.properties) {
      return { type: "object" };
    }

    const schema: SchemaDefinition = {
      type: "object",
      properties: {},
      required: parameters.required || [],
    };

    for (const [key, prop] of Object.entries(parameters.properties) as [string, any][]) {
      schema.properties![key] = {
        type: prop.type || "string",
        description: prop.description || "",
      };

      if (prop.enum) {
        schema.properties![key]!.enum = prop.enum;
      }
    }

    return schema;
  }

  /**
   * スキーマプロンプトをシステムプロンプトに注入
   */
  injectSchemaInstruction(systemPrompt: string, schema: SchemaDefinition): string {
    const schemaPrompt = this.validator.buildSchemaPrompt(schema);
    return `${systemPrompt}\n\n## 出力形式\n${schemaPrompt}`;
  }

  formatValidationResult(result: SchemaValidationResult): string {
    if (result.valid) {
      return `✅ スキーマ検証成功${result.retriesUsed > 0 ? ` (${result.retriesUsed}回リトライ)` : ""}`;
    }
    return `❌ スキーマ検証失敗 (${result.retriesUsed}回リトライ):\n${result.errors.map(e => `  • ${e}`).join("\n")}`;
  }
}

// ==================== シングルトン ====================

export const structuredOutput = new StructuredOutputEnforcer();
export { SchemaValidator };
export default StructuredOutputEnforcer;
