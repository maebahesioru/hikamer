// ==========================================
// Hikamer - コード実行ツール
// ==========================================

import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";

const execAsync = promisify(exec);
const codeTool: ToolDescriptor = {
  emoji: "⚡",
  owner: "core",
  name: "code_execute",
  description: "Python または JavaScript コードを一時ファイルに保存して実行します。",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["python", "javascript", "typescript"],
        description: "プログラミング言語",
      },
      code: {
        type: "string",
        description: "実行するコード",
      },
      timeout: {
        type: "number",
        description: "タイムアウト（ミリ秒）。デフォルト30秒。最大120秒。",
        default: 30000,
      },
    },
    required: ["language", "code"],
  },
  async execute(args) {
    const language = args.language as string;
    const code = args.code as string;
    const timeout = Math.min((args.timeout as number) || 30000, 120_000);

    const dataDir = process.env.DATA_DIR || "./data";
    const tmpDir = join(dataDir, "code-tmp");
    mkdirSync(tmpDir, { recursive: true });

    let filePath: string;
    let command: string;

    switch (language) {
      case "python": {
        filePath = join(tmpDir, `tmp_${randomUUID().slice(0, 8)}.py`);
        writeFileSync(filePath, code, "utf-8");
        command = `python3 "${filePath}"`;
        break;
      }
      case "javascript": {
        filePath = join(tmpDir, `tmp_${randomUUID().slice(0, 8)}.js`);
        writeFileSync(filePath, code, "utf-8");
        command = `node "${filePath}"`;
        break;
      }
      case "typescript": {
        filePath = join(tmpDir, `tmp_${randomUUID().slice(0, 8)}.ts`);
        writeFileSync(filePath, code, "utf-8");
        command = `npx tsx "${filePath}"`;
        break;
      }
      default:
        return `[エラー] 未対応の言語: ${language}`;
    }

    try {
      const start = Date.now();
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 5 * 1024 * 1024, // 5MB
        cwd: tmpDir,
      });
      const elapsed = Date.now() - start;

      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += `\n[stderr]\n${stderr}`;
      if (!result) result = "(出力なし)";

      return `[${language}] ${elapsed}ms\n${result}`;
    } catch (e: any) {
      const exitCode = e.code ?? "?";
      const msg = e.stderr || e.stdout || e.message || String(e);
      return `[${language}] 終了コード: ${exitCode}\n${msg}`;
    } finally {
      // 一時ファイルを削除
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  },
};

toolRegistry.register(codeTool);
export { codeTool };
