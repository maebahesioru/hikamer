// ==========================================
// Aikata - 全ツール登録
// ==========================================

import { toolRegistry } from "./registry";
import { terminalTool } from "./terminal";
import { fileTool } from "./file";
import { webTool } from "./web";
import { browserTool } from "./browser";
import { codeTool } from "./code";
import { scheduleTool } from "./schedule";
import { sqliteTool } from "./sqlite";

export function registerAllTools(): void {
  toolRegistry.register(terminalTool);
  toolRegistry.register(fileTool);
  toolRegistry.register(webTool);
  toolRegistry.register(browserTool);
  toolRegistry.register(codeTool);
  toolRegistry.register(scheduleTool);
  toolRegistry.register(sqliteTool);
}

export { toolRegistry };
