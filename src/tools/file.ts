// ==========================================
// Hikamer - ファイル操作ツール
// ==========================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { readdirSync } from "fs";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";

/** 指定ディレクトリ配下のみ許可（簡単なパストラバーサル対策） */
const ALLOWED_BASE = resolve(process.cwd());

function safePath(inputPath: string): string {
  const resolved = resolve(inputPath);
  // .. を含む場合は許可ベース内かチェック
  if (!resolved.startsWith(ALLOWED_BASE)) {
    // 明示的に許可されたパスならOK
    // 簡易版: ユーザーホームとデスクトップは許可
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    const desktop = join(home, "Desktop");
    if (resolved.startsWith(home) || resolved.startsWith(desktop)) {
      return resolved;
    }
    throw new Error(`アクセス拒否: ${inputPath}（許可されていないパスです）`);
  }
  return resolved;
}

const fileTool: ToolDescriptor = {
  emoji: "📄",
  owner: "core",
  name: "file",
  description: "ファイルの読み書き・検索・一覧表示を行います。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write", "list", "exists", "mkdir"],
        description: "操作: read=読み取り, write=書き込み, list=一覧, exists=存在確認, mkdir=ディレクトリ作成",
      },
      path: {
        type: "string",
        description: "対象ファイル/ディレクトリのパス",
      },
      content: {
        type: "string",
        description: "write時の書き込み内容",
      },
      offset: {
        type: "number",
        description: "read時の開始行（1-indexed、省略時は1）",
        default: 1,
      },
      limit: {
        type: "number",
        description: "read時の最大行数（省略時は500）",
        default: 500,
      },
    },
    required: ["action", "path"],
  },
  async execute(args) {
    const action = args.action as string;
    const inputPath = args.path as string;
    const resolved = safePath(inputPath);

    switch (action) {
      case "read": {
        if (!existsSync(resolved)) return `[エラー] ファイルが存在しません: ${inputPath}`;
        const stat = statSync(resolved);
        if (stat.isDirectory()) return `[エラー] ディレクトリです: ${inputPath}`;
        if (stat.size > 10 * 1024 * 1024) return `[エラー] ファイルが大きすぎます (${(stat.size / 1024 / 1024).toFixed(1)}MB)`;

        const content = readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const offset = Math.max(1, (args.offset as number) || 1);
        const limit = Math.min((args.limit as number) || 500, 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit);

        let result = slice.map((line, i) => `${offset + i}|${line}`).join("\n");
        if (lines.length > offset - 1 + limit) {
          result += `\n…（残り ${lines.length - (offset - 1 + limit)} 行）`;
        }
        return `${inputPath} (${lines.length}行, ${(stat.size / 1024).toFixed(1)}KB)\n${result || "(空ファイル)"}`;
      }

      case "write": {
        const content = args.content as string;
        if (content === undefined) return "[エラー] content パラメータが必要です";
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, "utf-8");
        return `書き込み完了: ${inputPath} (${content.length}文字)`;
      }

      case "list": {
        if (!existsSync(resolved)) return `[エラー] パスが存在しません: ${inputPath}`;
        const stat = statSync(resolved);
        if (!stat.isDirectory()) {
          return `ファイル: ${inputPath} (${(stat.size / 1024).toFixed(1)}KB, ${stat.mtime.toISOString()})`;
        }
        const entries = readdirSync(resolved, { withFileTypes: true });
        const items = entries.slice(0, 200).map(e => {
          const prefix = e.isDirectory() ? "📁" : "📄";
          return `${prefix} ${e.name}`;
        });
        const suffix = entries.length > 200 ? `\n…（残り ${entries.length - 200} 件）` : "";
        return `${inputPath}/ (${entries.length}件)\n${items.join("\n")}${suffix}`;
      }

      case "exists": {
        const exists = existsSync(resolved);
        if (exists) {
          const stat = statSync(resolved);
          return `存在: ${inputPath} (${stat.isDirectory() ? "ディレクトリ" : "ファイル"}, ${(stat.size / 1024).toFixed(1)}KB)`;
        }
        return `不存在: ${inputPath}`;
      }

      case "mkdir": {
        mkdirSync(resolved, { recursive: true });
        return `ディレクトリ作成: ${inputPath}`;
      }

      default:
        return `[エラー] 不明なアクション: ${action}`;
    }
  },
};

toolRegistry.register(fileTool);
export { fileTool };
