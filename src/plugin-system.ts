// ==========================================
// Aikata - Plugin System (v1.69)
// 出典: paperclip adapter-plugin pattern + superpowers plugin loading
// 外部拡張の動的読み込み・ホットリロード
// ==========================================

import { logger } from "./utils/logger";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, join } from "path";

// ==================== 型定義 ====================

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** エントリポイント（相対パス） */
  main: string;
  /** プラグインが提供するコマンド */
  commands?: Record<string, {
    description: string;
    handler: string; // export名
  }>;
  /** プラグインが提供するツール */
  tools?: string[];
  /** プラグインが提供するスキル */
  skills?: string[];
  /** 依存プラグイン */
  dependencies?: Record<string, string>;
  /** フック */
  hooks?: {
    onLoad?: string;
    onUnload?: string;
    preToolUse?: string;
    postToolUse?: string;
  };
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  module: any;
  loadedAt: number;
  status: "active" | "error" | "disabled";
  error?: string;
}

// ==================== プラグインマネージャー ====================

const PLUGINS_DIR = resolve(process.env.DATA_DIR || "./data", "plugins");
const PLUGINS_JSON = resolve(PLUGINS_DIR, "plugins.json");

class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.ensureDir();
    this.loadFromDisk();
    logger.info(`[PluginManager] ${this.plugins.size}個のプラグインを読み込み`);
  }

  /**
   * プラグインを登録（ディレクトリから plugin.json を読み込み）
   */
  async register(pluginPath: string): Promise<LoadedPlugin | null> {
    const manifestPath = join(pluginPath, "plugin.json");
    if (!existsSync(manifestPath)) {
      logger.error(`[PluginManager] plugin.jsonが見つかりません: ${pluginPath}`);
      return null;
    }

    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

      // 依存チェック
      if (manifest.dependencies) {
        for (const [dep, version] of Object.entries(manifest.dependencies)) {
          if (!this.plugins.has(dep)) {
            logger.warn(`[PluginManager] ${manifest.name}: 依存 ${dep}@${version} が未インストール`);
          }
        }
      }

      // 動的読み込み
      let mod: any = {};
      try {
        const mainPath = join(pluginPath, manifest.main);
        if (existsSync(mainPath)) {
          mod = await import(mainPath);
        }
      } catch (e: any) {
        logger.warn(`[PluginManager] ${manifest.name}: モジュール読み込み失敗: ${e.message}`);
      }

      const loaded: LoadedPlugin = {
        manifest,
        path: pluginPath,
        module: mod,
        loadedAt: Date.now(),
        status: "active",
      };

      this.plugins.set(manifest.name, loaded);
      this.saveToDisk();

      // onLoadフック
      if (manifest.hooks?.onLoad && mod[manifest.hooks.onLoad]) {
        try { mod[manifest.hooks.onLoad](); } catch {}
      }

      logger.info(`[PluginManager] 登録: ${manifest.name} v${manifest.version}`);
      return loaded;
    } catch (e: any) {
      logger.error(`[PluginManager] 登録失敗: ${e.message}`);
      return null;
    }
  }

  /** プラグインを削除 */
  unregister(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // onUnloadフック
    if (plugin.manifest.hooks?.onUnload && plugin.module[plugin.manifest.hooks.onUnload]) {
      try { plugin.module[plugin.manifest.hooks.onUnload](); } catch {}
    }

    this.plugins.delete(name);
    this.saveToDisk();
    logger.info(`[PluginManager] 削除: ${name}`);
    return true;
  }

  /** 全プラグインのコマンドを取得 */
  getAllCommands(): Map<string, { plugin: string; description: string; handler: string }> {
    const commands = new Map<string, { plugin: string; description: string; handler: string }>();
    for (const [name, plugin] of this.plugins) {
      if (plugin.status !== "active") continue;
      if (plugin.manifest.commands) {
        for (const [cmdName, cmd] of Object.entries(plugin.manifest.commands)) {
          commands.set(cmdName, { plugin: name, description: cmd.description, handler: cmd.handler });
        }
      }
    }
    return commands;
  }

  /** プラグインのコマンドを実行 */
  async executeCommand(pluginName: string, command: string, args: string): Promise<string | null> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin || plugin.status !== "active") return null;
    if (!plugin.manifest.commands?.[command]) return null;

    const handlerName = plugin.manifest.commands[command]!.handler;
    const handler = plugin.module[handlerName];
    if (typeof handler !== "function") return null;

    try {
      return await handler(args);
    } catch (e: any) {
      return `[Plugin Error] ${pluginName}/${command}: ${e.message}`;
    }
  }

  /** インストール可能なプラグインを探す */
  discoverPlugins(searchPath?: string): PluginManifest[] {
    const dirs = searchPath ? [searchPath] : [PLUGINS_DIR];
    const manifests: PluginManifest[] = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(dir, entry.name, "plugin.json");
          if (existsSync(manifestPath)) {
            try {
              manifests.push(JSON.parse(readFileSync(manifestPath, "utf-8")));
            } catch {}
          }
        }
      } catch {}
    }

    return manifests;
  }

  formatPlugins(): string {
    const lines: string[] = ["🔌 **プラグイン**", ""];
    if (this.plugins.size === 0) {
      lines.push("インストール済みプラグインはありません。");
      lines.push("`/plugin scan` で利用可能なプラグインを探せます。");
      return lines.join("\n");
    }

    for (const [name, plugin] of this.plugins) {
      const icon = plugin.status === "active" ? "✅" : "❌";
      lines.push(`${icon} **${name}** v${plugin.manifest.version}`);
      lines.push(`  ${plugin.manifest.description.slice(0, 80)}`);
      if (plugin.manifest.commands) {
        lines.push(`  コマンド: ${Object.keys(plugin.manifest.commands).join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  private ensureDir(): void {
    if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  private saveToDisk(): void {
    try {
      const data = [...this.plugins.entries()].map(([name, p]) => ({
        name,
        manifest: p.manifest,
        path: p.path,
        status: p.status,
      }));
      writeFileSync(PLUGINS_JSON, JSON.stringify(data, null, 2), "utf-8");
    } catch {}
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(PLUGINS_JSON)) {
        const data = JSON.parse(readFileSync(PLUGINS_JSON, "utf-8"));
        for (const item of data) {
          this.plugins.set(item.name, {
            manifest: item.manifest,
            path: item.path,
            module: {},
            loadedAt: Date.now(),
            status: item.status || "active",
          });
        }
      }
    } catch {}
  }
}

// ==================== シングルトン ====================

export const pluginManager = new PluginManager();
export default PluginManager;
