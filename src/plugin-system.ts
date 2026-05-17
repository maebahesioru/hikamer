// ==========================================
// Aikata - プラグインシステム（OpenClaw plugin由来）
// 動的ロード/アンロード/ホットリロード/ライフサイクル管理
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from "fs";
import { resolve, dirname, basename } from "path";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type PluginPhase = "init" | "load" | "activate" | "ready" | "deactivate" | "unload" | "error";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  requires?: string[]; // 依存プラグイン
  configSchema?: Record<string, unknown>;
}

export interface Plugin {
  manifest: PluginManifest;
  phase: PluginPhase;
  /** プラグインのコアAPI */
  api: PluginAPI;
  config: Record<string, unknown>;
  loadedAt: number;
  error?: string;
}

export interface PluginAPI {
  /** プラグインのフック関数 */
  hooks: {
    onInit?: () => void | Promise<void>;
    onActivate?: () => void | Promise<void>;
    onDeactivate?: () => void | Promise<void>;
    onConfigChange?: (config: Record<string, unknown>) => void | Promise<void>;
    onMessage?: (message: string) => string | Promise<string>;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
    onShutdown?: () => void | Promise<void>;
  };
  /** プラグイン関数 */
  methods: Record<string, (...args: any[]) => any>;
}

// ==================== プラグインマネージャー ====================

class PluginManager {
  private plugins = new Map<string, Plugin>();
  private pluginDir: string;

  constructor(pluginDir?: string) {
    this.pluginDir = pluginDir || resolve(process.cwd(), "plugins");
    if (!existsSync(this.pluginDir)) {
      mkdirSync(this.pluginDir, { recursive: true });
      // サンプルプラグイン作成
      this.createSamplePlugin();
    }
  }

  /** 全プラグインのディレクトリをスキャンしてロード */
  async scanAndLoadAll(): Promise<void> {
    const { readdirSync } = require("fs") as typeof import("fs");
    try {
      const dirs = readdirSync(this.pluginDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          await this.loadPlugin(dir.name);
        }
      }
      logger.info(`[Plugin] スキャン完了: ${this.plugins.size}プラグイン`);
    } catch (e: any) {
      logger.error(`[Plugin] スキャン失敗: ${e.message}`);
    }
  }

  /** プラグインをロード */
  async loadPlugin(name: string): Promise<Plugin> {
    // 既存チェック
    if (this.plugins.has(name)) {
      await this.unloadPlugin(name);
    }

    const pluginPath = resolve(this.pluginDir, name);

    // manifest.json読み込み
    const manifestPath = resolve(pluginPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`manifest.json が見つかりません: ${name}`);
    }

    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (manifest.name !== name) manifest.name = name;

    // 設定ファイル読み込み
    const configPath = resolve(pluginPath, "config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    }

    // index.js/index.tsを探す
    let scriptPath = resolve(pluginPath, "index.js");
    let script: any = null;

    if (existsSync(scriptPath)) {
      delete require.cache[scriptPath]; // キャッシュクリア
      try {
        script = require(scriptPath);
      } catch (e: any) {
        logger.error(`[Plugin] スクリプトエラー: ${name} — ${e.message}`);
        script = {};
      }
    }

    // API構築
    const api: PluginAPI = {
      hooks: {
        onInit: script?.onInit,
        onActivate: script?.onActivate,
        onDeactivate: script?.onDeactivate,
        onConfigChange: script?.onConfigChange,
        onMessage: script?.onMessage,
        onToolCall: script?.onToolCall,
        onShutdown: script?.onShutdown,
      },
      methods: script?.methods || {},
    };

    const plugin: Plugin = {
      manifest,
      phase: "init",
      api,
      config,
      loadedAt: Date.now(),
    };

    this.plugins.set(name, plugin);

    // ライフサイクル: init
    try {
      if (api.hooks.onInit) await api.hooks.onInit();
      plugin.phase = "load";
      logger.info(`[Plugin] ロード: ${name} v${manifest.version}`);
      eventBus.publish(createEvent("system", "pluginLoaded", { name, version: manifest.version }));
    } catch (e: any) {
      plugin.phase = "error";
      plugin.error = e.message;
      logger.error(`[Plugin] init失敗: ${name} — ${e.message}`);
    }

    return plugin;
  }

  /** プラグインをアクティベート */
  async activatePlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    if (plugin.phase === "ready") return true;

    try {
      if (plugin.api.hooks.onActivate) await plugin.api.hooks.onActivate();
      plugin.phase = "ready";
      logger.info(`[Plugin] アクティベート: ${name}`);
      eventBus.publish(createEvent("system", "pluginActivated", { name }));
      return true;
    } catch (e: any) {
      plugin.phase = "error";
      plugin.error = e.message;
      logger.error(`[Plugin] activate失敗: ${name} — ${e.message}`);
      return false;
    }
  }

  /** プラグインを非アクティベート */
  async deactivatePlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    try {
      if (plugin.api.hooks.onDeactivate) await plugin.api.hooks.onDeactivate();
      plugin.phase = "load";
      logger.info(`[Plugin] 非アクティベート: ${name}`);
      eventBus.publish(createEvent("system", "pluginDeactivated", { name }));
      return true;
    } catch (e: any) {
      logger.warn(`[Plugin] deactivate警告: ${name} — ${e.message}`);
      plugin.phase = "load";
      return true;
    }
  }

  /** プラグインをアンロード */
  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    await this.deactivatePlugin(name);
    this.plugins.delete(name);
    logger.info(`[Plugin] アンロード: ${name}`);
    eventBus.publish(createEvent("system", "pluginUnloaded", { name }));
    return true;
  }

  /** ホットリロード */
  async reloadPlugin(name: string): Promise<boolean> {
    logger.info(`[Plugin] ホットリロード: ${name}`);
    await this.unloadPlugin(name);
    await this.loadPlugin(name);
    await this.activatePlugin(name);
    return this.plugins.has(name);
  }

  /** プラグイン取得 */
  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /** 全プラグイン一覧 */
  listPlugins(): Array<{
    name: string;
    version: string;
    description: string;
    phase: PluginPhase;
    loadedAt: number;
    uptime: number;
    error?: string;
  }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      phase: p.phase,
      loadedAt: p.loadedAt,
      uptime: Date.now() - p.loadedAt,
      error: p.error,
    }));
  }

  /** メッセージフック（全プラグインにメッセージを渡す） */
  async runMessageHooks(message: string): Promise<string> {
    let result = message;
    for (const plugin of Array.from(this.plugins.values())) {
      if (plugin.phase === "ready" && plugin.api.hooks.onMessage) {
        try {
          const r = await plugin.api.hooks.onMessage(result);
          if (r) result = r;
        } catch {}
      }
    }
    return result;
  }

  /** ツール呼び出しフック */
  async runToolCallHooks(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let result = { ...args };
    for (const plugin of Array.from(this.plugins.values())) {
      if (plugin.phase === "ready" && plugin.api.hooks.onToolCall) {
        try {
          const r = await plugin.api.hooks.onToolCall(toolName, result);
          if (r) result = r;
        } catch {}
      }
    }
    return result;
  }

  /** シャットダウン */
  async shutdownAll(): Promise<void> {
    for (const name of Array.from(this.plugins.keys())) {
      const plugin = this.plugins.get(name);
      if (plugin && plugin.api.hooks.onShutdown) {
        try { await plugin.api.hooks.onShutdown(); } catch {}
      }
    }
    this.plugins.clear();
    logger.info("[Plugin] 全プラグインシャットダウン");
  }

  /** プラグインフォルダの変更監視（ホットリロード） */
  startHotReload(): void {
    try {
      watch(this.pluginDir, { recursive: true }, async (event, filename) => {
        if (!filename) return;
        const name = basename(filename.toString()).split(".")[0]!;
        if (name && this.plugins.has(name)) {
          logger.info(`[Plugin] 変更検出: ${name} — ホットリロード`);
          await this.reloadPlugin(name);
        }
      });
      logger.info(`[Plugin] ホットリロード監視: ${this.pluginDir}`);
    } catch (e: any) {
      logger.warn(`[Plugin] ホットリロード監視失敗: ${e.message}`);
    }
  }

  /** フォーマット */
  formatPlugins(): string {
    const list = this.listPlugins();
    if (list.length === 0) return "🧩 プラグインはロードされていません。";

    return [
      "🧩 **プラグイン一覧**",
      "",
      ...list.map(p => {
        const phaseIcon = p.phase === "ready" ? "✅" : p.phase === "error" ? "❌" : "⏳";
        const uptime = Math.floor(p.uptime / 1000);
        return `${phaseIcon} **${p.name}** v${p.version}\n` +
          `   ${p.description}\n` +
          `   状態: ${p.phase}${p.error ? ` (${p.error})` : ""} | 稼働: ${uptime}s`;
      }),
      `\n合計: ${list.length}プラグイン`,
    ].join("\n");
  }

  /** サンプルプラグイン作成 */
  private createSamplePlugin(): void {
    const sampleDir = resolve(this.pluginDir, "echo");
    if (!existsSync(sampleDir)) mkdirSync(sampleDir, { recursive: true });

    const manifest: PluginManifest = {
      name: "echo",
      version: "1.0.0",
      description: "メッセージをエコーするサンプルプラグイン",
      author: "Aikata",
    };

    writeFileSync(resolve(sampleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    writeFileSync(resolve(sampleDir, "config.json"), JSON.stringify({ prefix: "[Echo] " }, null, 2), "utf-8");

    writeFileSync(resolve(sampleDir, "index.js"), `
// Aikata サンプルプラグイン: echo
module.exports = {
  onInit() {
    console.log("[Echo Plugin] 初期化完了");
  },
  onActivate() {
    console.log("[Echo Plugin] アクティベート");
  },
  onMessage(message) {
    const config = require(resolve(__dirname, "config.json"));
    return config.prefix + message;
  },
  methods: {
    repeat(text, count) {
      return Array(count).fill(text).join(" ");
    }
  }
};
`, "utf-8");
  }
}

// ==================== シングルトン ====================

export const pluginManager = new PluginManager();
