// ==========================================
// Hikamer - 設定管理（OpenHuman config + OpenClaw config由来）
// スキーマ検証・環境変数管理・ホットリロード
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface ConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  label: string;
  description: string;
  default?: any;
  required?: boolean;
  envVar?: string;     // 環境変数からのフォールバック
  validate?: (value: any) => string | null; // バリデーション関数（エラー時はエラーメッセージ）
  secret?: boolean;    // trueの場合、ログに値を表示しない
}

export interface ConfigSchema {
  name: string;
  version: string;
  description: string;
  fields: ConfigField[];
}

export interface ConfigSnapshot {
  key: string;
  value: any;
  source: "env" | "file" | "default";
  updatedAt: number;
}

// ==================== 設定マネージャー ====================

class ConfigManager {
  private schemas = new Map<string, ConfigSchema>();
  private values = new Map<string, any>();
  private snapshots = new Map<string, ConfigSnapshot>();
  private configPath: string;
  private watcher: any = null;

  constructor() {
    this.configPath = resolve(process.env.DATA_DIR || "./data", "config", "runtime.json");
    this.load();
    this.loadEnv();
  }

  /** スキーマ登録 */
  registerSchema(schema: ConfigSchema): void {
    this.schemas.set(schema.name, schema);

    // デフォルト値の設定
    for (const field of schema.fields) {
      const key = `${schema.name}.${field.key}`;
      if (!this.values.has(key)) {
        // 環境変数チェック
        if (field.envVar && process.env[field.envVar] !== undefined) {
          this.values.set(key, this.coerceValue(field.type, process.env[field.envVar]!));
          this.snapshots.set(key, { key, value: this.values.get(key), source: "env", updatedAt: Date.now() });
        } else if (field.default !== undefined) {
          this.values.set(key, field.default);
          this.snapshots.set(key, { key, value: field.default, source: "default", updatedAt: Date.now() });
        }
      }
    }

    logger.info(`[Config] スキーマ登録: ${schema.name} (${schema.fields.length}項目)`);
  }

  /** 設定値を取得 */
  get<T = any>(key: string): T | undefined {
    return this.values.get(key) as T;
  }

  /** 設定値を設定 */
  set(key: string, value: any, source: "file" | "env" = "file"): boolean {
    const [schemaName, fieldKey] = key.split(".");
    const schema = this.schemas.get(schemaName! || "");

    // バリデーション
    if (schema) {
      const field = schema.fields.find(f => f.key === fieldKey);
      if (field) {
        const coerced = this.coerceValue(field.type, value);
        if (field.validate) {
          const error = field.validate(coerced);
          if (error) {
            logger.warn(`[Config] バリデーションエラー: ${key} = ${field.secret ? "***" : value} → ${error}`);
            return false;
          }
        }
        this.values.set(key, coerced);
        this.snapshots.set(key, { key, value: coerced, source, updatedAt: Date.now() });
        this.save();
        logger.info(`[Config] 設定変更: ${key} = ${field.secret ? "***" : String(value)}`);

        // ホットリロード用イベント
        eventBus.publish(createEvent("system", "configChanged", { key, value: coerced }));
        return true;
      }
    }

    // スキーマなしでも保存可能
    this.values.set(key, value);
    this.snapshots.set(key, { key, value, source, updatedAt: Date.now() });
    this.save();
    return true;
  }

  /** 設定値の型変換 */
  private coerceValue(type: string, value: any): any {
    if (value === null || value === undefined) return value;
    switch (type) {
      case "number": return Number(value);
      case "boolean": return typeof value === "string" ? value === "true" || value === "1" : Boolean(value);
      case "array": return Array.isArray(value) ? value : String(value).split(",").map(s => s.trim()).filter(Boolean);
      case "object": return typeof value === "object" ? value : {};
      default: return String(value);
    }
  }

  /** 環境変数から読み込み */
  private loadEnv(): void {
    for (const schema of Array.from(this.schemas.values())) {
      for (const field of schema.fields) {
        if (field.envVar && process.env[field.envVar] !== undefined) {
          const key = `${schema.name}.${field.key}`;
          this.values.set(key, this.coerceValue(field.type, process.env[field.envVar]!));
          this.snapshots.set(key, {
            key, value: this.values.get(key), source: "env", updatedAt: Date.now(),
          });
        }
      }
    }
  }

  /** ファイルから読み込み */
  private load(): void {
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, "utf-8"));
        for (const [key, value] of Object.entries(data)) {
          this.values.set(key, value);
          this.snapshots.set(key, { key, value, source: "file", updatedAt: Date.now() });
        }
        logger.info(`[Config] 復元: ${this.snapshots.size}設定`);
      }
    } catch (e) {
      logger.warn(`[Config] 読込失敗: ${e}`);
    }
  }

  /** ファイルに保存 */
  private save(): void {
    try {
      const data: Record<string, any> = {};
      for (const [key, snap] of Array.from(this.snapshots)) {
        if (snap.source === "file") data[key] = snap.value;
      }
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Config] 保存失敗: ${e}`);
    }
  }

  /** 設定ファイルの変更監視（ホットリロード） */
  startHotReload(): void {
    const configFile = resolve(process.cwd(), "config.yaml");
    if (!existsSync(configFile)) {
      // hikamer-config.json を試す
      const altPath = resolve(process.env.DATA_DIR || "./data", "config.json");
      if (existsSync(altPath)) {
        this.watchFile(altPath);
      }
      return;
    }
    this.watchFile(configFile);
  }

  private watchFile(path: string): void {
    try {
      watch(path, (event) => {
        if (event === "change") {
          logger.info(`[Config] 設定ファイル変更検出: ${path}`);
          try {
            this.load();
            eventBus.publish(createEvent("system", "configReloaded", { path }));
          } catch (e: any) {
            logger.error(`[Config] ホットリロード失敗: ${e.message}`);
          }
        }
      });
      logger.info(`[Config] ホットリロード監視: ${path}`);
    } catch (e: any) {
      logger.warn(`[Config] 監視失敗: ${e.message}`);
    }
  }

  /** 全設定一覧 */
  listConfig(): ConfigSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  /** スキーマ一覧 */
  listSchemas(): ConfigSchema[] {
    return Array.from(this.schemas.values());
  }

  /** 設定値のフォーマット */
  formatConfig(schemaName?: string): string {
    let snaps = this.listConfig();
    if (schemaName) snaps = snaps.filter(s => s.key.startsWith(schemaName + "."));

    if (snaps.length === 0) return "設定はありません。";

    return [
      "⚙️ **設定一覧**",
      "",
      ...snaps.map(s => {
        const schema = this.schemas.get(s.key.split(".")[0]!);
        const field = schema?.fields.find(f => f.key === s.key.split(".").slice(1).join("."));
        const isSecret = field?.secret;
        const valueStr = isSecret ? "••••••" : typeof s.value === "object" ? JSON.stringify(s.value) : String(s.value);
        const sourceIcon = s.source === "env" ? "🌐" : s.source === "file" ? "📄" : "⚪";
        return `${sourceIcon} **${s.key}** = \`${valueStr}\``;
      }),
    ].join("\n");
  }
}

// ==================== 組み込みスキーマ ====================

const BUILTIN_SCHEMA: ConfigSchema = {
  name: "hikamer",
  version: "1.0",
  description: "Hikamer 基本設定",
  fields: [
    { key: "maxIterations", type: "number", label: "最大反復数", description: "エージェントループの最大反復", default: 10, envVar: "AIKATA_MAX_ITERATIONS" },
    { key: "streamEnabled", type: "boolean", label: "ストリーミング", description: "ストリーミング応答の有効/無効", default: true, envVar: "AIKATA_STREAM" },
    { key: "monthlyBudget", type: "number", label: "月間予算($)", description: "月間LLM予算", default: 10, envVar: "MONTHLY_BUDGET" },
    { key: "logLevel", type: "string", label: "ログレベル", description: "ログ出力レベル", default: "info", envVar: "LOG_LEVEL",
      validate: (v) => ["debug", "info", "warn", "error"].includes(v) ? null : "debug/info/warn/error のいずれか" },
    { key: "dataDir", type: "string", label: "データディレクトリ", description: "データ保存先", default: "./data", envVar: "DATA_DIR" },
  ],
};

// ==================== シングルトン ====================

export const configManager = new ConfigManager();
configManager.registerSchema(BUILTIN_SCHEMA);
