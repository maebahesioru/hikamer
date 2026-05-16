// ==========================================
// Aikata - ターミナル実行ツール
// ==========================================

import { exec } from "child_process";
import { promisify } from "util";
import { platform } from "os";
import type { Tool } from "../types";

const execAsync = promisify(exec);

const isWindows = platform() === "win32";

export const terminalTool: Tool = {
  name: "terminal",
  description: `シェルコマンドを実行します。${isWindows ? "Windows (cmd.exe)" : "Linux (bash)"} 環境です。`,
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

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        cwd: workdir,
        shell: isWindows ? "cmd.exe" : "/bin/bash",
        windowsHide: true,
      });

      if (!stdout && !stderr) return "(出力なし)";
      if (!stdout) return `(stderr)\n${stderr}`;
      if (!stderr) return stdout;
      return `${stdout}\n(stderr)\n${stderr}`;
    } catch (e: any) {
      const exitCode = e.code ?? "?";
      const msg = e.stderr || e.stdout || e.message || String(e);
      return `[終了コード: ${exitCode}]\n${msg}`;
    }
  },
};
