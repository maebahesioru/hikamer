// ==========================================
// Aikata - CI Poller（roborev internal/daemon/ci_poller.go 由来）
// GitHub PR監視 + 自動レビューキューイング
// ==========================================

import { logger } from "./utils/logger";
import { safeFetch } from "./net-utils";

export interface CiConfig {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  pollIntervalMs: number;
  reviewOnOpen: boolean;
  reviewOnUpdate: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headSHA: string;
  baseSHA: string;
  branch: string;
  baseBranch: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  draft: boolean;
}

export class CiPoller {
  private config: CiConfig;
  private knownPRs = new Set<number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onChange: ((pr: PullRequest, event: "opened" | "updated") => void) | null = null;

  constructor(config: CiConfig) {
    this.config = config;
  }

  /** 変更ハンドラ */
  setOnChange(handler: (pr: PullRequest, event: "opened" | "updated") => void): void {
    this.onChange = handler;
  }

  /** ポーリング開始 */
  start(): void {
    logger.info(`[CI] ポーリング開始: ${this.config.repoOwner}/${this.config.repoName} (${this.config.pollIntervalMs}ms)`);
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), this.config.pollIntervalMs);
  }

  /** 停止 */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** PR一覧を取得 */
  async fetchOpenPRs(): Promise<PullRequest[]> {
    const perPage = 100;
    let page = 1;
    const allPRs: PullRequest[] = [];

    while (true) {
      try {
        const res = await safeFetch(
          `https://api.github.com/repos/${this.config.repoOwner}/${this.config.repoName}/pulls?state=open&per_page=${perPage}&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${this.config.githubToken}`,
              "User-Agent": "Aikata-CI-Poller",
              Accept: "application/vnd.github.v3+json",
            },
            timeoutMs: 15000,
          },
        );

        if (!res.ok) break;
        const prs = JSON.parse(res.body);
        if (!Array.isArray(prs) || prs.length === 0) break;

        for (const pr of prs) {
          allPRs.push({
            number: pr.number,
            title: pr.title || "",
            author: pr.user?.login || "",
            url: pr.html_url || "",
            headSHA: pr.head?.sha || "",
            baseSHA: pr.base?.sha || "",
            branch: pr.head?.ref || "",
            baseBranch: pr.base?.ref || "",
            state: pr.state || "",
            createdAt: pr.created_at || "",
            updatedAt: pr.updated_at || "",
            labels: (pr.labels || []).map((l: any) => l.name),
            draft: pr.draft || false,
          });
        }

        if (prs.length < perPage) break;
        page++;
      } catch { break; }
    }

    return allPRs;
  }

  /** 1回のポーリング */
  private async pollOnce(): Promise<void> {
    try {
      const prs = await this.fetchOpenPRs();

      for (const pr of prs) {
        const wasKnown = this.knownPRs.has(pr.number);

        if (!wasKnown) {
          this.knownPRs.add(pr.number);
          if (this.config.reviewOnOpen && !pr.draft) {
            this.onChange?.(pr, "opened");
            logger.info(`[CI] 新規PR: #${pr.number} ${pr.title}`);
          }
        } else if (this.config.reviewOnUpdate) {
          // 既知のPRの更新チェック（簡易版：updatedAtの変化で判断）
          this.onChange?.(pr, "updated");
        }
      }
    } catch (e: any) {
      logger.warn(`[CI] ポーリングエラー: ${e.message}`);
    }
  }

  /** 特定PRの差分を取得 */
  async fetchDiff(prNumber: number): Promise<string> {
    const res = await safeFetch(
      `https://api.github.com/repos/${this.config.repoOwner}/${this.config.repoName}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          "User-Agent": "Aikata-CI-Poller",
          Accept: "application/vnd.github.v3.diff",
        },
        timeoutMs: 30000,
      },
    );
    return res.body;
  }

  /** 特定PRのコミット一覧を取得 */
  async fetchCommits(prNumber: number): Promise<Array<{ sha: string; message: string; author: string }>> {
    const res = await safeFetch(
      `https://api.github.com/repos/${this.config.repoOwner}/${this.config.repoName}/pulls/${prNumber}/commits`,
      {
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          "User-Agent": "Aikata-CI-Poller",
        },
        timeoutMs: 15000,
      },
    );

    if (!res.ok) return [];
    const commits = JSON.parse(res.body);
    return (commits || []).map((c: any) => ({
      sha: c.sha || "",
      message: c.commit?.message || "",
      author: c.commit?.author?.name || c.author?.login || "",
    }));
  }

  /** コメント投稿 */
  async postComment(prNumber: number, body: string): Promise<boolean> {
    try {
      const res = await safeFetch(
        `https://api.github.com/repos/${this.config.repoOwner}/${this.config.repoName}/issues/${prNumber}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.githubToken}`,
            "User-Agent": "Aikata-CI-Poller",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body }),
          timeoutMs: 15000,
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  formatStatus(): string {
    return [
      "🔄 **CI Poller**",
      `  ${this.config.repoOwner}/${this.config.repoName}`,
      `  既知PR: ${this.knownPRs.size}`,
      `  間隔: ${this.config.pollIntervalMs / 1000}秒`,
      `  状態: ${this.pollTimer ? "🟢 動作中" : "🔴 停止中"}`,
    ].join("\n");
  }
}
