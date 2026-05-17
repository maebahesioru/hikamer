// ==========================================
// Aikata - ツールレジストリ v2（自己登録 + ToolDescriptor）
// 各tools/*.tsがimport時に自動登録。index.tsはimportするだけ。
// ==========================================

import type { Tool, ToolDescriptor } from "../types";
import { logger } from "../utils/logger";
import { trimToolResult } from "../budget-config";

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
      if (trimmed !== result) {
        logger.debug(`結果トリム: ${name} ${result.length}→${trimmed.length}`);
      }
      return trimmed;
    } catch (e: any) {
      const duration = Date.now() - start;
      const err = `[エラー] ${e.message || String(e)}`;
      this.afterHooks.forEach(fn => { try { fn(name, args, err, duration); } catch {} });
      return err;
    }
  }
}

export const toolRegistry = new ToolRegistry();
