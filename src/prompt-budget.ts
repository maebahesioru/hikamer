// ==========================================
// Aikata - Budgeted Prompt Builder（roborev internal/prompt/ + internal/worktree/由来）
// サイズ制約付きプロンプト構築 + Git Worktree分離
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

// ==================== プロンプトビルダー ====================

export type PromptSection = "system" | "guidelines" | "context" | "diff" | "instructions" | "history";

export interface PromptPlan {
  sections: Array<{ key: PromptSection; content: string; optional: boolean; priority: number }>;
  maxTokens: number;
  currentTokens: number;
}

/** 制約付きプロンプトビルダー */
export class PromptBuilder {
  private sections: Map<PromptSection, { content: string; optional: boolean; priority: number }> = new Map();
  private maxTokens: number;
  private readonly TOKEN_RATIO = 4; // 文字→トークン換算

  constructor(maxTokens = 128000) {
    this.maxTokens = maxTokens;
  }

  /** セクションを追加 */
  addSection(key: PromptSection, content: string, options?: { optional?: boolean; priority?: number }): void {
    this.sections.set(key, {
      content,
      optional: options?.optional ?? false,
      priority: options?.priority ?? 5,
    });
  }

  /** プロンプトを構築（予算内に収める） */
  build(): PromptPlan {
    const sorted = Array.from(this.sections.entries())
      .sort(([, a], [, b]) => a.priority - b.priority);

    let currentTokens = 0;
    const included: Array<{ key: PromptSection; content: string }> = [];
    const budget = this.maxTokens;

    for (const [key, { content, optional }] of sorted) {
      const sectionTokens = Math.ceil(content.length / this.TOKEN_RATIO);

      // 必須セクションは常に含める（オーバーフロー時は切り詰め）
      if (!optional) {
        const available = budget - currentTokens;
        if (sectionTokens > available) {
          // 切り詰めて追加
          const truncatedTokens = Math.max(available - 10, 50);
          const truncatedChars = truncatedTokens * this.TOKEN_RATIO;
          included.push({
            key,
            content: content.slice(0, truncatedChars) + "\n[...truncated...]",
          });
          currentTokens += truncatedTokens + 1;
        } else {
          included.push({ key, content });
          currentTokens += sectionTokens;
        }
        continue;
      }

      // オプショナルセクションは予算が許せば追加
      if (currentTokens + sectionTokens <= budget) {
        included.push({ key, content });
        currentTokens += sectionTokens;
      }
    }

    return {
      sections: included.map((s) => ({
        key: s.key,
        content: s.content,
        optional: this.sections.get(s.key)?.optional ?? false,
        priority: this.sections.get(s.key)?.priority ?? 5,
      })),
      maxTokens: this.maxTokens,
      currentTokens,
    };
  }

  /** 構築したプロンプトをテキストとして取得 */
  render(): string {
    const plan = this.build();
    return plan.sections.map((s) => s.content).join("\n\n");
  }

  /** 予算超過時にdiffをファイルに退避して参照させる */
  buildWithSnapshot(diff: string): { prompt: string; snapshotPath?: string } {
    this.addSection("diff", diff, { optional: true, priority: 3 });

    const plan = this.build();
    const diffSection = plan.sections.find((s) => s.key === "diff");

    if (!diffSection) {
      // diffが予算超過で削除された→ファイルに保存
      const snapshotDir = resolve(tmpdir(), "aikata-prompt-snapshots");
      mkdirSync(snapshotDir, { recursive: true });
      const snapshotPath = join(snapshotDir, `diff-${Date.now()}.patch`);
      writeFileSync(snapshotPath, diff, "utf-8");
      logger.info(`[PromptBuilder] Diff退避: ${snapshotPath} (${diff.length} chars)`);

      // ファイル参照に置き換え
      const remaining = plan.sections.filter((s) => s.key !== "diff");
      return {
        prompt: remaining.map((s) => s.content).join("\n\n") +
          `\n\n[Diff saved to: ${snapshotPath} — ${diff.length} chars]`,
        snapshotPath,
      };
    }

    return { prompt: this.render() };
  }

  /** 状態表示 */
  formatStatus(): string {
    const stats = Array.from(this.sections.entries()).map(([key, { content, optional }]) => ({
      key,
      chars: content.length,
      tokens: Math.ceil(content.length / this.TOKEN_RATIO),
      optional,
    }));

    return [
      "📝 **Prompt Builder**",
      `  最大トークン: ${this.maxTokens.toLocaleString()}`,
      `  セクション数: ${this.sections.size}`,
      ...stats.map(
        (s) => `  • ${s.key}: ${s.chars.toLocaleString()}文字 (~${s.tokens}トークン)${s.optional ? " [optional]" : ""}`,
      ),
    ].join("\n");
  }
}

// ==================== Git Worktree分離 ====================

export interface Worktree {
  dir: string;
  repoPath: string;
  baseSHA: string;
}

/** Gitの一時ワークツリーを作成（安全な分離実行用） */
export function createWorktree(repoPath: string, ref = "HEAD"): Worktree {
  const dir = resolve(tmpdir(), `aikata-worktree-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  execSync(`git -C "${repoPath}" worktree add --detach "${dir}" "${ref}" 2>/dev/null`, {
    timeout: 30000,
    stdio: "pipe",
  });

  const baseSHA = execSync(`git -C "${repoPath}" rev-parse "${ref}"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).toString().trim();

  logger.info(`[Worktree] 作成: ${dir} (base: ${baseSHA.slice(0, 8)})`);
  return { dir, repoPath, baseSHA };
}

/** ワークツリーの変更をパッチとして取得 */
export function capturePatch(wt: Worktree): string {
  execSync(`git -C "${wt.dir}" add -A 2>/dev/null`, { timeout: 10000 });
  const patch = execSync(
    `git -C "${wt.repoPath}" diff "${wt.baseSHA}" -- "${wt.dir}"`,
    { encoding: "utf-8", timeout: 10000 },
  ).toString();
  return patch;
}

/** パッチが適用可能かドライラン */
export function checkPatch(repoPath: string, patch: string): boolean {
  try {
    execSync(`echo "${patch.replace(/"/g, '\\"')}" | git -C "${repoPath}" apply --check -`, {
      timeout: 10000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** パッチを適用 */
export function applyPatch(repoPath: string, patch: string): void {
  execSync(`echo "${patch.replace(/"/g, '\\"')}" | git -C "${repoPath}" apply -`, {
    timeout: 10000,
    stdio: "pipe",
  });
}

/** ワークツリーを削除 */
export function removeWorktree(wt: Worktree): void {
  try {
    execSync(`git -C "${wt.repoPath}" worktree remove "${wt.dir}" 2>/dev/null`, {
      timeout: 10000,
      stdio: "pipe",
    });
  } catch {
    // 強制削除
    execSync(`rm -rf "${wt.dir}"`, { timeout: 10000 });
  }
  logger.info(`[Worktree] 削除: ${wt.dir}`);
}
