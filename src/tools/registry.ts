// ==========================================
// Aikata - ツールレジストリ
// ==========================================

import type { Tool } from "../types";
import { logger } from "../utils/logger";

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`ツール重複登録: ${tool.name}（上書き）`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`ツール登録: ${tool.name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** OpenAI互換のツール定義配列 */
  getOpenAISchema(): Tool[] {
    return this.list();
  }

  /** ツール実行 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[エラー] ツール '${name}' は登録されていません。`;
    }
    logger.tool(name, args);
    try {
      const result = await tool.execute(args);
      // 結果が長すぎる場合は切り詰める
      if (result.length > 50_000) {
        return result.slice(0, 50_000) + `\n\n…（${result.length - 50_000}文字省略）`;
      }
      return result;
    } catch (e: any) {
      return `[エラー] ${e.message || String(e)}`;
    }
  }
}

export const toolRegistry = new ToolRegistry();
