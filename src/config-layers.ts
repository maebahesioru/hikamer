// ==========================================
// Hikamer - Multi-Layer Config Resolution（roborev internal/config/ 由来）
// CLI→Repo→Global→Defaultの5層設定解決 + ホットリロード
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, writeFileSync, watch, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ==================== 型定義 ====================

export type ConfigLayer = "cli" | "local" | "global" | "defaults";
export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };

export interface ConfigSource {
  layer: ConfigLayer;
  path?: string;
  data: Record<string, ConfigValue>;
}

/** ワークフロー別モデル設定 */
export interface WorkflowModelConfig {
  review?: string;
  reviewFast?: string;
  reviewThorough?: string;
  refine?: string;
  fix?: string;
  security?: string;
  design?: string;
  default?: string;
  [key: string]: string | undefined;
}

// ==================== 5層設定リゾルバ ====================

const LAYER_PRIORITY: ConfigLayer[] = ["cli", "local", "global", "defaults"];

class ConfigResolver {
  private sources: ConfigSource[] = [];
  private watchCallbacks: Array<() => void> = [];

  /** 設定ファイルを読み込み */
  loadFile(path: string, layer: ConfigLayer): ConfigSource {
    let data: Record<string, ConfigValue> = {};
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        // TOML風簡略パーサー（本格TOMLは外部ライブラリ推奨）
        data = this.parseConfig(raw);
        logger.info(`[Config] 読み込み: ${path} (${layer})`);
      }
    } catch (e: any) {
      logger.warn(`[Config] 読込エラー: ${path}: ${e.message}`);
    }

    const source: ConfigSource = { layer, path, data };
    this.sources.push(source);
    return source;
  }

  /** 値を解決（高優先度層が勝つ） */
  get<T extends ConfigValue>(key: string, defaultValue?: T): T | undefined {
    for (const layer of LAYER_PRIORITY) {
      const source = this.sources.find((s) => s.layer === layer);
      if (source && key in source.data) {
        return source.data[key] as T;
      }
    }
    return defaultValue;
  }

  /** ワークフロー別モデル解決 */
  getWorkflowModel(workflow: string, reasoning?: string): string | undefined {
    const key = reasoning ? `${workflow}_${reasoning}` : workflow;
    const models = this.get<Record<string, string>>("models");
    if (!models) return this.get<string>("model");

    // 完全一致
    if (models[key]) return models[key];
    // デフォルト
    if (models.default) return models.default;
    return this.get<string>("model");
  }

  /** 設定ファイル監視開始 */
  startWatching(callback: () => void): void {
    this.watchCallbacks.push(callback);

    for (const source of this.sources) {
      if (!source.path) continue;
      try {
        watch(source.path, () => {
          logger.info(`[Config] 変更検出: ${source.path}`);
          this.loadFile(source.path!, source.layer);
          callback();
        });
      } catch { /* ignore */ }
    }
  }

  /** 設定値設定（CLI層に） */
  set(key: string, value: ConfigValue): void {
    let cliSource = this.sources.find((s) => s.layer === "cli");
    if (!cliSource) {
      cliSource = { layer: "cli", data: {} };
      this.sources.push(cliSource);
    }
    cliSource.data[key] = value;
  }

  /** 全設定をダンプ */
  dump(): Record<string, ConfigValue> {
    const result: Record<string, ConfigValue> = {};
    // 優先度逆順でマージ（低→高）
    for (const layer of [...LAYER_PRIORITY].reverse()) {
      const source = this.sources.find((s) => s.layer === layer);
      if (source) {
        Object.assign(result, source.data);
      }
    }
    return result;
  }

  /** 設定を保存 */
  save(path: string): void {
    const data = this.dump();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    logger.info(`[Config] 保存: ${path}`);
  }

  /** TOML風簡略パーサー */
  private parseConfig(raw: string): Record<string, ConfigValue> {
    const result: Record<string, ConfigValue> = {};
    const lines = raw.split("\n");
    let currentSection = result;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      // セクション [section]
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        const sectionPath = sectionMatch[1]!.split(".");
        currentSection = result;
        for (const part of sectionPath) {
          if (!currentSection[part]) currentSection[part] = {};
          currentSection = currentSection[part] as Record<string, ConfigValue>;
        }
        continue;
      }

      // キー = 値
      const kvMatch = trimmed.match(/^"?([^"=\s]+)"?\s*[=:]\s*(.+)$/);
      if (kvMatch) {
        currentSection[kvMatch[1]!] = this.parseValue(kvMatch[2]!.trim());
      }
    }

    return result;
  }

  private parseValue(value: string): ConfigValue {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }

  formatStatus(): string {
    const lines: string[] = ["⚙️ **Config Resolver (5層)**"];
    for (const layer of LAYER_PRIORITY) {
      const source = this.sources.find((s) => s.layer === layer);
      if (source) {
        const keys = Object.keys(source.data);
        lines.push(`  • **${layer.padEnd(8)}**: ${source.path || "(inline)"} (${keys.length}項目)`);
      } else {
        lines.push(`  • **${layer.padEnd(8)}**: 未設定`);
      }
    }
    return lines.join("\n");
  }
}

export const configResolver = new ConfigResolver();
