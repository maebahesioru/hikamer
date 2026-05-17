// ==========================================
// Aikata - ターミナル実行ツール
// ANSI除去 + 危険コマンド検出対応
// ==========================================

import { exec } from "child_process";
import { promisify } from "util";
import { platform } from "os";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { cleanTerminalOutput } from "../ansi-strip";
import { checkCommand } from "../approval";
import { juiceOutput } from "../tokenjuice";
import { logger } from "../utils/logger";

const execAsync = promisify(exec);

const isWindows = platform() === "win32";

const descriptor: ToolDescriptor = {
  name: "terminal",
  emoji: "💻",
  owner: "core",
  description: `シェルコマンドを実行します。${isWindows ? "Windows (cmd.exe)" : "Linux (bash)"} 環境です。危険コマンド自動検出対応。`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "実行するシェルコマンド",
      },
      timeout: {
        type: "number",
        description: "タイムアウト（ミリ秒）。デフォルト30秒。最大300秒。",
        default: 30000,
      },
      workdir: {
        type: "string",
        description: "作業ディレクトリ（省略時はプロセスと同じ）",
      },
    },
    required: ["command"],
  },
  async execute(args) {
    const command = args.command as string;
    const timeout = Math.min((args.timeout as number) || 30000, 300_000);
    const workdir = args.workdir as string | undefined;

    // 危険コマンドチェック
    const check = checkCommand(command);
    if (!check.safe) {
      return `[ブロック] ${check.message}` +
        (check.matchedPattern ? `\nマッチ: /${check.matchedPattern.slice(0, 100)}/` : "");
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        cwd: workdir,
        shell: isWindows ? "cmd.exe" : "/bin/bash",
        windowsHide: true,
      });

      let output: string;
      if (!stdout && !stderr) output = "(出力なし)";
      else if (!stdout) output = `(stderr)\n${stderr}`;
      else if (!stderr) output = stdout;
      else output = `${stdout}\n(stderr)\n${stderr}`;

      // Token Juiceでスマート圧縮（ANSI除去 + 定形出力圧縮）
      output = cleanTerminalOutput(output);
      const juiced = juiceOutput(command, output);
      if (juiced.ruleId !== "passthrough" && juiced.ruleId !== "none") {
        const saved = `${juiced.text}\n[TokenJuice: ${juiced.ruleId} ${juiced.originalLines}→${juiced.finalLines}行]`;
        logger.debug(`TokenJuice適用: ${juiced.ruleId} (${juiced.originalLines}→${juiced.finalLines})`);
        return saved;
      }
      return output;
    } catch (e: any) {
      const exitCode = e.code ?? "?";
      const msg = e.stderr || e.stdout || e.message || String(e);
      return `[終了コード: ${exitCode}]\n${msg}`;
    }
  },
};

toolRegistry.register(descriptor);
export { descriptor as terminalTool };
