// ==========================================
// Hikamer - ファイル状態追跡（Hermes Agent由来）
// ファイル変更検出（mtimeベース）
// ==========================================

import { statSync, readFileSync, existsSync } from "fs";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";

// ==================== ファイル状態管理 ====================

interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
  firstSeen: number;
  hash?: string; // 最初の200文字の簡易ハッシュ
}

class FileStateTracker {
  private files = new Map<string, FileEntry>();
  private maxEntries = 4096;

  /** ファイルをチェックして変更を検出 */
  check(path: string): { changed: boolean; status: "new" | "modified" | "unchanged"; detail?: string } {
    if (!existsSync(path)) {
      const existing = this.files.get(path);
      if (existing) {
        this.files.delete(path);
        return { changed: true, status: "modified", detail: "ファイルが削除されました" };
      }
      return { changed: false, status: "unchanged" };
    }

    const stat = statSync(path);
    const mtimeMs = stat.mtimeMs;
    const size = stat.size;

    const existing = this.files.get(path);

    if (!existing) {
      // 新規ファイル
      this.files.set(path, {
        path, mtimeMs, size,
        firstSeen: Date.now(),
        hash: getContentHash(path),
      });
      this.enforceLimit();
      return { changed: true, status: "new", detail: `新規ファイル (${formatSize(size)})` };
    }

    if (existing.mtimeMs !== mtimeMs || existing.size !== size) {
      // 変更あり
      const oldSize = existing.size;
      existing.mtimeMs = mtimeMs;
      existing.size = size;

      const diff = size - oldSize;
      const detail = `変更あり (${formatSize(oldSize)} → ${formatSize(size)}${diff > 0 ? `, +${formatSize(diff)}` : diff < 0 ? `, ${formatSize(diff)}` : ""})`;

      return { changed: true, status: "modified", detail };
    }

    return { changed: false, status: "unchanged" };
  }

  /** 複数ファイルを一括チェック */
  checkAll(paths: string[]): Array<{ path: string; changed: boolean; status: string; detail?: string }> {
    return paths.map(p => ({ path: p, ...this.check(p) }));
  }

  /** 監視している全ファイル一覧 */
  list(): FileEntry[] {
    return Array.from(this.files.values());
  }

  /** 特定パスの状態を忘れる */
  forget(path: string): void {
    this.files.delete(path);
  }

  /** 全状態リセット */
  reset(): void {
    this.files.clear();
  }

  private enforceLimit(): void {
    if (this.files.size > this.maxEntries) {
      const oldest = Array.from(this.files.entries())
        .sort(([, a], [, b]) => a.firstSeen - b.firstSeen)
        .slice(0, this.files.size - this.maxEntries);
      for (const [key] of oldest) this.files.delete(key);
    }
  }
}

function getContentHash(path: string): string {
  try {
    const content = readFileSync(path, "utf-8");
    return content.slice(0, 200);
  } catch {
    return "";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ==================== グローバルインスタンス ====================

export const fileState = new FileStateTracker();

// ==================== ツール ====================

const checkTool: ToolDescriptor = {
  name: "file_check",
  emoji: "👁️",
  owner: "core",
  description: "ファイルの変更状態をチェックします（mtimeベース）。前回のチェックから変更があったか検出。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "チェックするファイルパス",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "一括チェックするファイルパス配列（pathと併用不可）",
      },
    },
    required: [],
  },
  async execute(args) {
    const path = args.path as string | undefined;
    const paths = args.paths as string[] | undefined;

    if (path) {
      const result = fileState.check(path);
      return `👁️ **${path}**\n状態: ${result.status}${result.detail ? `\n${result.detail}` : ""}`;
    }

    if (paths && Array.isArray(paths) && paths.length > 0) {
      const results = fileState.checkAll(paths);
      const changed = results.filter(r => r.changed);
      const lines = results.map(r =>
        `${r.changed ? "🔴" : "🟢"} ${r.path} — ${r.status}${r.detail ? ` (${r.detail})` : ""}`
      );
      return `👁️ **ファイルチェック** (${results.length}件中${changed.length}件変更)\n\n${lines.join("\n")}`;
    }

    // 全監視ファイル一覧
    const all = fileState.list();
    if (all.length === 0) {
      return "👁️ 監視中のファイルはありません。\n`file_check path=<path>` でファイルをチェックすると自動的に監視を開始します。";
    }
    const lines = all.map(f => `• ${f.path} (${formatSize(f.size)})`);
    return `👁️ **監視中ファイル** (${all.length}件)\n\n${lines.join("\n")}`;
  },
};

toolRegistry.register(checkTool);
export { checkTool };
