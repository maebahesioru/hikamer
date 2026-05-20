// ==========================================
// Hikamer - ツールレジストリ v2（自己登録 + ToolDescriptor）
// 各tools/*.tsがimport時に自動登録。index.tsはimportするだけ。
// ==========================================

import type { Tool, ToolDescriptor } from "../types";
import { logger } from "../utils/logger";
import { trimToolResult } from "../budget-config";

/** 各行の最大長（超えるとトリム） */
const MAX_LINE_LENGTH = 5000;
/** 最大行数（超えると中央を省略） */
const MAX_LINES = 2000;

/**
 * 出力を行レベルでもトリム
 * 超長行のトリム + 行数制限（中央省略）
 */
function applyLineLimits(result: string): string {
  const lines = result.split("\n");

  // 各行の長さ制限
  const trimmedLines = lines.map(line => {
    if (line.length > MAX_LINE_LENGTH) {
      return line.slice(0, MAX_LINE_LENGTH) + `…[${line.length - MAX_LINE_LENGTH}文字省略]`;
    }
    return line;
  });

  // 行数制限（中央省略）
  if (trimmedLines.length > MAX_LINES) {
    const head = trimmedLines.slice(0, Math.floor(MAX_LINES * 0.4));
    const tail = trimmedLines.slice(-Math.floor(MAX_LINES * 0.6));
    const skipped = trimmedLines.length - head.length - tail.length;
    return [
      ...head,
      `…[${skipped}行省略 / 全${trimmedLines.length}行中${MAX_LINES}行表示]`,
      ...tail,
    ].join("\n");
  }

  return trimmedLines.join("\n");
}

class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();
  private beforeHooks: Array<(name: string, args: Record<string, unknown>) => void> = [];
  private afterHooks: Array<(name: string, args: Record<string, unknown>, result: string, durationMs: number) => void> = [];

  /** ツール実行前フック登録 */
  onBeforeToolCall(fn: (name: string, args: Record<string, unknown>) => void): void {
    this.beforeHooks.push(fn);
  }

  /** ツール実行後フック登録 */
  onAfterToolCall(fn: (name: string, args: Record<string, unknown>, result: string, durationMs: number) => void): void {
    this.afterHooks.push(fn);
  }

  /** ツールの自己登録（各ツールファイルがimport時に呼ぶ） */
  register(descriptor: ToolDescriptor): void {
    if (this.tools.has(descriptor.name)) {
      logger.warn(`ツール重複登録: ${descriptor.name}（上書き）`);
    }
    this.tools.set(descriptor.name, descriptor);
    logger.debug(`ツール登録: ${descriptor.name} (${descriptor.owner})`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** フルDescriptorを取得（formatTool等のメタデータ用） */
  getDescriptor(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** OpenAI互換のツール定義配列（利用可能なもののみ） */
  getOpenAISchema(): Tool[] {
    return this.listAvailable();
  }

  /** 利用可能なツールのみ返す */
  listAvailable(): Tool[] {
    return Array.from(this.tools.values()).filter(t => this.isAvailable(t));
  }

  /** ツールの可用性チェック */
  isAvailable(descriptor: ToolDescriptor): boolean {
    const av = descriptor.availability;
    if (!av) return true;
    // 環境変数チェック
    if (av.requiresEnv?.length) {
      for (const key of av.requiresEnv) {
        if (!process.env[key]) return false;
      }
    }
    // カスタムチェック関数
    if (av.checkFn && !av.checkFn()) return false;
    return true;
  }

  /** ツールの表示絵文字を取得 */
  getEmoji(name: string): string {
    return this.tools.get(name)?.emoji || "🔧";
  }

  /** ツール実行 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[エラー] ツール '${name}' は登録されていません。`;
    }
    logger.tool(name, args);
    this.beforeHooks.forEach(fn => { try { fn(name, args); } catch {} });
    const start = Date.now();
    try {
      const result = await tool.execute(args);
      const duration = Date.now() - start;
      this.afterHooks.forEach(fn => { try { fn(name, args, result, duration); } catch {} });
      const trimmed = trimToolResult(name, result);
      const lineLimited = applyLineLimits(trimmed);
      if (lineLimited !== result) {
        logger.debug(`結果トリム: ${name} ${result.length}→${lineLimited.length}`);
      }
      return lineLimited;
    } catch (e: any) {
      const duration = Date.now() - start;
      const err = `[エラー] ${e.message || String(e)}`;
      this.afterHooks.forEach(fn => { try { fn(name, args, err, duration); } catch {} });
      return err;
    }
  }
}

export const toolRegistry = new ToolRegistry();

// ==========================================
// ツール自動検出（hermes-agent AST-based discovery パターン）
// tools/ ディレクトリ内の全.tsファイルを動的インポートし
// register()済みツールを自動検出
// ==========================================

/**
 * 指定ディレクトリから全ツールモジュールを動的インポート。
 * hermes-agentの `tools/__init__.py` の全import戦略に相当。
 * 
 * 使用例:
 *   await discoverTools("./tools");
 */
export async function discoverTools(dir: string): Promise<string[]> {
  const { readdirSync } = await import("fs");
  const { resolve, extname } = await import("path");
  const discovered: string[] = [];

  try {
    const files = readdirSync(dir).filter(f =>
      extname(f) === ".ts" && !f.startsWith(".") && f !== "registry.ts"
    );

    for (const file of files) {
      try {
        const modulePath = resolve(dir, file);
        await import(modulePath);
        discovered.push(file);
      } catch (err) {
        logger.warn(`[ToolDiscovery] インポート失敗 ${file}: ${err}`);
      }
    }

    logger.info(`[ToolDiscovery] ${discovered.length}モジュール読込完了: ${discovered.join(", ").slice(0, 120)}`);
  } catch (err) {
    logger.error(`[ToolDiscovery] ディレクトリ読込失敗: ${err}`);
  }

  return discovered;
}
