// ==========================================
// Aikata - Git操作ツール（OpenHuman tools/git由来）
// リポジトリ操作・変更履歴・ブランチ管理
// ==========================================

import { execSync } from "child_process";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";
import { stripAnsi } from "../ansi-strip";

// ==================== Git安全ラッパー ====================

const MAX_OUTPUT = 30000;
const TIMEOUT = 30000;
const ALLOWED_COMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "checkout",
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "merge",
  "rebase",
  "stash",
  "tag",
  "remote",
  "config",
  "reset",
  "clean",
  "restore",
  "switch",
];

const BLOCKED_FLAGS = [
  "--force",
  "-f",
  "--hard",
];

function runGit(args: string[], workdir?: string): string {
  const dir = workdir || process.cwd();
  try {
    const result = execSync(`git ${args.join(" ")}`, {
      cwd: dir,
      timeout: TIMEOUT,
      maxBuffer: MAX_OUTPUT * 2,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stripAnsi(result.toString().trim()).slice(0, MAX_OUTPUT);
  } catch (e: any) {
    const stderr = e.stderr?.toString() || e.message || "不明なエラー";
    return `[エラー] ${stripAnsi(stderr).slice(0, 1000)}`;
  }
}

// ==================== ツール ====================

const gitTool: ToolDescriptor = {
  emoji: "🔀",
  owner: "core",
  name: "git",
  description: "Gitリポジトリ操作を実行します。安全なコマンドのみ許可されます。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "log", "diff", "branch", "show", "commit", "add", "push", "pull", "fetch", "remote", "custom"],
        description: "Git操作: status=変更状態, log=コミット履歴, diff=差分, branch=ブランチ一覧, show=特定コミット, commit=コミット, add=ステージ, push=プッシュ, pull=プル, fetch=フェッチ, remote=リモート情報, custom=生コマンド",
      },
      args: {
        type: "string",
        description: "追加引数（例: '--oneline -5'、customの場合は 'log --oneline' のように先頭から指定）",
      },
      path: {
        type: "string",
        description: "リポジトリのパス（省略時はカレントディレクトリ）",
      },
      message: {
        type: "string",
        description: "commit時のコミットメッセージ",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;
    const extraArgs = (args.args as string) || "";
    const workdir = args.path as string | undefined;

    switch (action) {
      case "status": {
        const out = runGit(["status", ...(extraArgs ? extraArgs.split(" ") : [])], workdir);
        return `🔀 **Git Status**\n\`\`\`\n${out || "(clean)"}\n\`\`\``;
      }

      case "log": {
        const logArgs = extraArgs ? extraArgs.split(" ") : ["--oneline", "-10"];
        const out = runGit(["log", ...logArgs], workdir);
        return `🔀 **Git Log**\n\`\`\`\n${out || "(no commits)"}\n\`\`\``;
      }

      case "diff": {
        const diffArgs = extraArgs ? extraArgs.split(" ") : [];
        const out = runGit(["diff", ...diffArgs], workdir);
        if (!out || out.startsWith("[エラー]")) return `🔀 **Git Diff**\n\`\`\`\n${out || "(no changes)"}\n\`\`\``;
        // diffが長い時は要約表示
        const lines = out.split("\n");
        if (lines.length > 100) {
          const summary = runGit(["diff", "--stat", ...diffArgs], workdir);
          return `🔀 **Git Diff** (${lines.length}行、要約表示)\n\`\`\`\n${summary}\n\`\`\`\n先頭30行:\n\`\`\`\n${lines.slice(0, 30).join("\n")}\n…\n\`\`\``;
        }
        return `🔀 **Git Diff**\n\`\`\`\n${out}\n\`\`\``;
      }

      case "branch": {
        const branchArgs = extraArgs ? extraArgs.split(" ") : ["-a"];
        const out = runGit(["branch", ...branchArgs], workdir);
        const current = runGit(["rev-parse", "--abbrev-ref", "HEAD"], workdir);
        return `🔀 **Git Branches**\n現在のブランチ: \`${current}\`\n\`\`\`\n${out || "(no branches)"}\n\`\`\``;
      }

      case "show": {
        const showArgs = extraArgs ? extraArgs : "HEAD";
        const out = runGit(["show", "--stat", showArgs], workdir);
        const short = runGit(["log", "--oneline", "-1", showArgs], workdir);
        return `🔀 **Git Show**\n\`${short}\`\n\`\`\`\n${out}\n\`\`\``;
      }

      case "add": {
        const files = extraArgs || ".";
        const out = runGit(["add", ...files.split(" ")], workdir);
        return out.startsWith("[エラー]")
          ? `❌ **Add失敗**\n${out}`
          : `✅ **ステージング完了**: \`git add ${files}\``;
      }

      case "commit": {
        const msg = args.message as string;
        if (!msg) return "[エラー] commitには message パラメータが必要です";
        const out = runGit(["commit", "-m", msg], workdir);
        if (out.startsWith("[エラー]")) return `❌ **Commit失敗**\n${out}`;
        // 変更なしの場合もハンドリング
        if (out.includes("nothing to commit") || out.includes("no changes")) {
          return "ℹ️ コミットする変更がありません。";
        }
        return `✅ **Commit完了**\n\`\`\`\n${out}\n\`\`\``;
      }

      case "push": {
        const pushArgs = extraArgs ? extraArgs.split(" ") : [];
        // force push禁止
        if (pushArgs.includes("-f") || pushArgs.includes("--force")) {
          return "❌ **force pushは禁止されています**\n代わりに通常のpushを使用してください。";
        }
        const out = runGit(["push", ...pushArgs], workdir);
        return out.startsWith("[エラー]")
          ? `❌ **Push失敗**\n${out}`
          : `✅ **Push完了**\n\`\`\`\n${out}\n\`\`\``;
      }

      case "pull": {
        const pullArgs = extraArgs ? extraArgs.split(" ") : [];
        const out = runGit(["pull", ...pullArgs], workdir);
        if (out.startsWith("[エラー]")) return `❌ **Pull失敗**\n${out}`;
        // コンフリクト判定
        if (out.includes("CONFLICT") || out.includes("conflict")) {
          return `⚠️ **Pullにコンフリクトがあります**\n\`\`\`\n${out}\n\`\`\``;
        }
        return `✅ **Pull完了**\n\`\`\`\n${out}\n\`\`\``;
      }

      case "fetch": {
        const fetchArgs = extraArgs ? extraArgs.split(" ") : [];
        const out = runGit(["fetch", ...fetchArgs], workdir);
        return out.startsWith("[エラー]")
          ? `❌ **Fetch失敗**\n${out}`
          : `✅ **Fetch完了**\n\`\`\`\n${out}\n\`\`\``;
      }

      case "remote": {
        const remoteCmd = extraArgs ? extraArgs.split(" ") : ["-v"];
        const out = runGit(["remote", ...remoteCmd], workdir);
        return `🔀 **Git Remotes**\n\`\`\`\n${out || "(no remotes)"}\n\`\`\``;
      }

      case "custom": {
        // 生コマンド実行（安全チェックあり）
        const cmdParts = extraArgs.split(" ");
        const baseCmd = cmdParts[0];

        if (!ALLOWED_COMMANDS.includes(baseCmd)) {
          return `❌ **禁止されたコマンド**: \`${baseCmd}\`\n許可: ${ALLOWED_COMMANDS.join(", ")}`;
        }

        // 危険フラグチェック
        for (const flag of BLOCKED_FLAGS) {
          if (cmdParts.includes(flag)) {
            return `❌ **禁止フラグ**: \`${flag}\`\n安全なコマンドを使用してください。`;
          }
        }

        const out = runGit(cmdParts, workdir);
        return `🔀 **Git ${baseCmd}**\n\`\`\`\n${out || "(出力なし)"}\n\`\`\``;
      }

      default:
        return `[エラー] 不明なアクション: ${action}`;
    }
  },
};

const grepTool: ToolDescriptor = {
  emoji: "🔍",
  owner: "core",
  name: "grep",
  description: "ファイル内を高速検索します（ripgrep/grepのラッパー）。",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "検索パターン（正規表現）",
      },
      path: {
        type: "string",
        description: "検索対象パス（省略時はカレント）",
      },
      ext: {
        type: "string",
        description: "ファイル拡張子フィルタ（例: 'ts,js,py'）",
      },
      maxResults: {
        type: "number",
        description: "最大結果数（デフォルト50）",
        default: 50,
      },
      ignoreCase: {
        type: "boolean",
        description: "大文字小文字無視",
        default: true,
      },
      context: {
        type: "number",
        description: "前後のコンテキスト行数",
        default: 0,
      },
    },
    required: ["pattern"],
  },
  async execute(args) {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string) || process.cwd();
    const ext = args.ext as string | undefined;
    const maxResults = Math.min((args.maxResults as number) || 50, 200);
    const ignoreCase = args.ignoreCase !== false;
    const context = (args.context as number) || 0;

    if (!pattern) return "[エラー] pattern が必要です";

    try {
      // ripgrep優先、なければgrep
      let cmd: string;

      const useRg = execSync("which rg 2>/dev/null || true", { timeout: 2000 }).toString().trim();
      const safePattern = pattern.replace(/'/g, "'\\''");
      const safePath = searchPath.replace(/'/g, "'\\''");

      if (useRg) {
        const flags = [`--max-count ${maxResults}`];
        if (ignoreCase) flags.push("-i");
        if (context > 0) flags.push(`-C ${context}`);
        if (ext) {
          const exts = ext.split(",").map(e => `-g '*.${e.trim()}'`).join(" ");
          flags.push(exts);
        }
        flags.push(`--no-heading`);
        cmd = `rg ${flags.join(" ")} '${pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -${maxResults}`;
      } else {
        const flags = ["-rn"];
        if (ignoreCase) flags.push("-i");
        if (context > 0) flags.push(`-C ${context}`);
        if (ext) {
          const extGlob = ext.split(",").map(e => `--include='*.${e.trim()}'`).join(" ");
          flags.push(extGlob);
        }
        cmd = `grep ${flags.join(" ")} '${pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -${maxResults}`;
      }

      const result = execSync(cmd, { timeout: 10000, maxBuffer: MAX_OUTPUT, encoding: "utf-8" });
      const output = stripAnsi(result.toString().trim());

      if (!output) return `🔍 パターン \`${pattern}\` に一致するものは見つかりませんでした。`;

      const lines = output.split("\n");
      return `🔍 **Grep結果**: \`${pattern}\` (${lines.length}件)\n\`\`\`\n${lines.slice(0, maxResults).join("\n")}\n\`\`\``;
    } catch (e: any) {
      return `🔍 **Grepエラー**: ${e.message?.slice(0, 200) || "不明なエラー"}`;
    }
  },
};

toolRegistry.register(gitTool);
toolRegistry.register(grepTool);

export { gitTool, grepTool };
