// ==========================================
// Hikamer - Git Utils（roborev internal/git/git.go 由来）
// 高機能Git操作ラッパー + ワークフロー管理
// ==========================================

import { logger } from "./utils/logger";
import { execSync, spawn } from "child_process";

export interface GitDiff {
  files: string[];
  insertions: number;
  deletions: number;
  patch?: string;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  sha: string;
  upstream?: string;
}

export class GitUtils {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /** gitコマンド実行 */
  private git(args: string[], options?: { timeout?: number }): string {
    try {
      return execSync(`git -C "${this.repoPath}" ${args.join(" ")}`, {
        timeout: options?.timeout ?? 30000,
        encoding: "utf-8",
        stdio: "pipe",
      }).toString().trim();
    } catch (e: any) {
      throw new Error(`Git error: ${e.stderr?.toString() || e.message}`);
    }
  }

  /** 現在のブランチ */
  currentBranch(): string {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** 全ブランチ */
  branches(): GitBranch[] {
    const out = this.git(["branch", "--format=%(refname:short)|%(objectname)|%(upstream:short)"]);
    return out.split("\n").filter(Boolean).map((line) => {
      const [name, sha, upstream] = line.split("|");
      return {
        name: name!.replace(/^\*?\s*/, ""),
        current: name!.startsWith("*"),
        sha: sha || "",
        upstream: upstream || undefined,
      };
    });
  }

  /** 差分取得 */
  diff(ref1: string, ref2?: string): GitDiff {
    const target = ref2 ? `${ref1}..${ref2}` : ref1;
    const stat = this.git(["diff", "--stat", target]);
    const lines = stat.split("\n");
    const lastLine = lines[lines.length - 2] || "";
    const match = lastLine.match(/(\d+) insertions?, (\d+) deletions?/);

    return {
      files: lines.slice(0, -1).map((l) => l.split("|")[0]?.trim() || "").filter(Boolean),
      insertions: match ? parseInt(match[1]!) : 0,
      deletions: match ? parseInt(match[2]!) : 0,
    };
  }

  /** パッチ取得 */
  getPatch(ref: string): string {
    return this.git(["diff", ref]);
  }

  /** コミットログ */
  log(maxCount = 10): GitCommit[] {
    const format = "%H|%s|%an|%ai";
    const out = this.git(["log", `--max-count=${maxCount}`, `--format=${format}`, "--name-only"]);
    const blocks = out.split("\n\n");
    return blocks.filter(Boolean).map((block) => {
      const lines = block.split("\n");
      const [sha, message, author, date] = lines[0]!.split("|");
      return {
        sha: sha || "",
        message: message || "",
        author: author || "",
        date: date || "",
        files: lines.slice(1).filter((l) => l.trim() && !l.startsWith("%")),
      };
    });
  }

  /** ファイル変更履歴 */
  fileHistory(filePath: string, maxCount = 20): GitCommit[] {
    const format = "%H|%s|%an|%ai";
    const out = this.git(["log", `--max-count=${maxCount}`, `--format=${format}`, "--", filePath]);
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, message, author, date] = line.split("|");
      return { sha: sha || "", message: message || "", author: author || "", date: date || "", files: [filePath] };
    });
  }

  /** ワークツリーの状態 */
  status(): { modified: string[]; staged: string[]; untracked: string[] } {
    const out = this.git(["status", "--porcelain"]);
    const modified: string[] = [];
    const staged: string[] = [];
    const untracked: string[] = [];

    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (status === "??") untracked.push(file);
      else if (status.includes("M") || status.includes("A") || status.includes("D")) {
        if (status[0] !== " ") staged.push(file);
        if (status[1] !== " " && status[0] !== "?" && status[0] !== "!") modified.push(file);
      }
    }

    return { modified, staged, untracked };
  }

  /** ブランチ作成 */
  createBranch(name: string, baseRef = "HEAD"): void {
    this.git(["checkout", "-b", name, baseRef]);
    logger.info(`[Git] ブランチ作成: ${name} (base: ${baseRef})`);
  }

  /** コミット */
  commit(message: string, files?: string[]): string {
    if (files && files.length > 0) {
      this.git(["add", ...files]);
    } else {
      this.git(["add", "-A"]);
    }
    const sha = this.git(["commit", "-m", `"${message.replace(/"/g, '\\"')}"`]);
    const shaMatch = sha.match(/\[[\w-]+ ([a-f0-9]+)\]/);
    const result = shaMatch?.[1] || "unknown";
    logger.info(`[Git] コミット: ${result}`);
    return result;
  }

  /** プッシュ */
  push(remote = "origin", branch?: string): void {
    const ref = branch || this.currentBranch();
    this.git(["push", remote, ref]);
    logger.info(`[Git] プッシュ: ${remote}/${ref}`);
  }

  /** プル */
  pull(remote = "origin", branch?: string): void {
    const ref = branch || this.currentBranch();
    this.git(["pull", "--rebase", remote, ref]);
    logger.info(`[Git] プル: ${remote}/${ref}`);
  }

  /** クリーンチェック */
  isClean(): boolean {
    return this.git(["status", "--porcelain"]) === "";
  }

  /** 特定ファイルの内容（特定コミット時点） */
  showFile(sha: string, filePath: string): string {
    return this.git(["show", `${sha}:${filePath}`]);
  }

  formatStatus(): string {
    const branch = this.currentBranch();
    const s = this.status();
    const clean = s.modified.length === 0 && s.staged.length === 0 && s.untracked.length === 0;

    return [
      "📂 **Git Utils**",
      `  リポジトリ: ${this.repoPath}`,
      `  ブランチ: ${branch}`,
      `  状態: ${clean ? "✅ クリーン" : "⚠️ 変更あり"}`,
      clean ? "" : `  modified: ${s.modified.length}, staged: ${s.staged.length}, untracked: ${s.untracked.length}`,
    ].filter(Boolean).join("\n");
  }
}
