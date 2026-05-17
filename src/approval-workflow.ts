// ==========================================
// Aikata - 承認ワークフロー（OpenHuman approval/workflow由来）
// 危険操作に人間の承認が必要な本格システム
// ==========================================

import { logger } from "./utils/logger";
import { toolRegistry } from "./tools/registry";

// ==================== 型定義 ====================

export type ApprovalAction = "terminal" | "file_write" | "file_delete" | "browser" | "git_force" | "deploy" | "custom";

export interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  description: string;
  detail: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  requestedBy: string; // session/user ID
  requestedAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  respondedBy?: string;
  respondedAt?: number;
  note?: string;
  expiresAt: number;
  autoDenyAfter: number; // ms
}

export type ApprovalResult = "approved" | "rejected" | "timeout";

// ==================== 承認マネージャー ====================

class ApprovalManager {
  private pending = new Map<string, ApprovalRequest>();
  private history: ApprovalRequest[] = [];
  private maxHistory = 100;

  // 応答コールバック
  private onRequest: ((request: ApprovalRequest) => void) | null = null;
  private autoApprovePatterns: Array<{ pattern: RegExp; action: ApprovalAction }> = [];

  /** 承認リクエストを受信したときのコールバック */
  setOnRequest(fn: (request: ApprovalRequest) => void): void {
    this.onRequest = fn;
  }

  /** 自動承認パターンを追加 */
  addAutoApprove(pattern: RegExp, action: ApprovalAction): void {
    this.autoApprovePatterns.push({ pattern, action });
  }

  /** 承認リクエストを作成 */
  createRequest(
    action: ApprovalAction,
    description: string,
    detail: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    requestedBy: string,
    options?: {
      autoDenyAfterMs?: number;
    },
  ): ApprovalRequest {
    const id = `apr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const autoDenyAfter = options?.autoDenyAfterMs || 120_000; // デフォルト2分

    const request: ApprovalRequest = {
      id,
      action,
      description,
      detail,
      toolName,
      toolArgs,
      requestedBy,
      requestedAt: Date.now(),
      status: "pending",
      expiresAt: Date.now() + autoDenyAfter,
      autoDenyAfter,
    };

    // 自動承認チェック（危険度の低いパターン）
    for (const ap of this.autoApprovePatterns) {
      if (ap.action === action && ap.pattern.test(detail)) {
        request.status = "approved";
        request.respondedBy = "system-auto";
        request.respondedAt = Date.now();
        logger.info(`[Approval] 自動承認: ${id} (${description})`);
        this.history.push(request);
        if (this.history.length > this.maxHistory) this.history.shift();
        return request;
      }
    }

    this.pending.set(id, request);

    // タイムアウト処理
    setTimeout(() => {
      const r = this.pending.get(id);
      if (r && r.status === "pending") {
        r.status = "expired";
        this.pending.delete(id);
        this.history.push(r);
        if (this.history.length > this.maxHistory) this.history.shift();
        logger.warn(`[Approval] タイムアウト: ${id} (${description})`);
      }
    }, autoDenyAfter);

    logger.info(`[Approval] リクエスト作成: ${id} (${action}: ${description})`);
    this.onRequest?.(request);

    return request;
  }

  /** 承認 */
  approve(id: string, userId: string, note?: string): boolean {
    const request = this.pending.get(id);
    if (!request || request.status !== "pending") return false;

    request.status = "approved";
    request.respondedBy = userId;
    request.respondedAt = Date.now();
    request.note = note;
    this.pending.delete(id);
    this.history.push(request);
    if (this.history.length > this.maxHistory) this.history.shift();

    logger.info(`[Approval] 承認: ${id} by ${userId}`);
    return true;
  }

  /** 拒否 */
  reject(id: string, userId: string, reason?: string): boolean {
    const request = this.pending.get(id);
    if (!request || request.status !== "pending") return false;

    request.status = "rejected";
    request.respondedBy = userId;
    request.respondedAt = Date.now();
    request.note = reason;
    this.pending.delete(id);
    this.history.push(request);
    if (this.history.length > this.maxHistory) this.history.shift();

    logger.info(`[Approval] 拒否: ${id} by ${userId}`);
    return true;
  }

  /** リクエスト取得 */
  getRequest(id: string): ApprovalRequest | undefined {
    return this.pending.get(id) || this.history.find(r => r.id === id);
  }

  /** 保留中一覧 */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values());
  }

  /** 履歴 */
  getHistory(limit = 20): ApprovalRequest[] {
    return this.history.slice(-limit).reverse();
  }

  /** 実行を待つ */
  async waitForApproval(
    action: ApprovalAction,
    description: string,
    detail: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    requestedBy: string,
    options?: {
      autoDenyAfterMs?: number;
      pollIntervalMs?: number;
    },
  ): Promise<ApprovalResult> {
    const request = this.createRequest(
      action, description, detail, toolName, toolArgs, requestedBy, options,
    );

    // 自動承認された
    if (request.status === "approved") return "approved";

    const pollInterval = options?.pollIntervalMs || 500;

    // ポーリングで承認待ち
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const current = this.getRequest(request.id);
        if (!current) {
          clearInterval(check);
          resolve("timeout");
          return;
        }
        if (current.status === "approved") {
          clearInterval(check);
          resolve("approved");
        } else if (current.status === "rejected") {
          clearInterval(check);
          resolve("rejected");
        } else if (current.status === "expired") {
          clearInterval(check);
          resolve("timeout");
        }
      }, pollInterval);

      // 安全策：最大待機時間
      setTimeout(() => {
        clearInterval(check);
        resolve("timeout");
      }, (options?.autoDenyAfterMs || 120_000) + 5000);
    });
  }

  /** 指定されたツール実行前に承認が必要かチェック */
  async requireApproval(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
    sessionId: string,
  ): Promise<{ allowed: boolean; result?: string }> {
    // ツール別の承認条件
    const approvalCheck = this.getApprovalCheck(toolName, args);
    if (!approvalCheck) return { allowed: true };

    const result = await this.waitForApproval(
      approvalCheck.action,
      approvalCheck.description,
      approvalCheck.detail,
      toolName,
      args,
      sessionId,
    );

    if (result === "approved") return { allowed: true };
    if (result === "rejected") {
      return { allowed: false, result: `❌ 操作が拒否されました: ${approvalCheck.description}` };
    }
    return { allowed: false, result: `⏰ タイムアウト: 承認の期限が切れました (${approvalCheck.description})` };
  }

  /** ツール名＋引数から承認チェック条件を生成 */
  private getApprovalCheck(
    toolName: string,
    args: Record<string, unknown>,
  ): { action: ApprovalAction; description: string; detail: string } | null {
    switch (toolName) {
      case "terminal": {
        const cmd = (args.command as string) || "";
        if (cmd.includes("rm -rf") || cmd.includes("rm -rf --")) {
          return { action: "terminal", description: "ファイル削除", detail: `rm -rf: ${cmd.slice(0, 100)}` };
        }
        if (cmd.includes("git push -f") || cmd.includes("git push --force")) {
          return { action: "git_force", description: "Force Push", detail: cmd.slice(0, 100) };
        }
        if (cmd.includes("sudo ") || cmd.includes("doas ")) {
          return { action: "terminal", description: "Sudo権限実行", detail: cmd.slice(0, 100) };
        }
        if (cmd.includes("docker system prune") || cmd.includes("docker compose down")) {
          return { action: "deploy", description: "Docker操作", detail: cmd.slice(0, 100) };
        }
        // 長時間実行コマンド
        if (cmd.includes("npm publish") || cmd.includes("npm unpublish") || cmd.includes("yarn publish")) {
          return { action: "deploy", description: "パッケージ公開", detail: cmd.slice(0, 100) };
        }
        return null;
      }

      case "file": {
        const fileAction = (args.action as string) || "";
        const path = (args.path as string) || "";
        if (fileAction === "write" && (path.includes("/etc/") || path.includes("/usr/") || path.includes("/bin/"))) {
          return { action: "file_write", description: "システムファイル書き込み", detail: path };
        }
        if (fileAction === "write") {
          // 通常ファイル書き込みは大丈夫
          return null;
        }
        return null;
      }

      case "git": {
        const gitAction = (args.action as string) || "";
        if (gitAction === "push") {
          // force pushはブロック、通常pushはOK
          return null;
        }
        return null;
      }

      case "browser": {
        const bAction = (args.action as string) || "";
        if (bAction === "navigate") {
          const url = (args.url as string) || "";
          if (url.includes("login") || url.includes("auth") || url.includes("password") ||
              url.includes("bank") || url.includes("pay") || url.includes("card")) {
            return { action: "browser", description: "認証/金融ページ", detail: url.slice(0, 100) };
          }
        }
        return null;
      }

      default:
        return null;
    }
  }

  /** 保留中リクエストのフォーマット */
  formatPending(): string {
    const pending = this.getPending();
    if (pending.length === 0) return "✅ 保留中の承認リクエストはありません。";

    return [
      `⏳ **保留中の承認 (${pending.length}件)**`,
      "",
      ...pending.map((r, i) => {
        const elapsed = Math.floor((Date.now() - r.requestedAt) / 1000);
        const remaining = Math.max(0, Math.floor((r.expiresAt - Date.now()) / 1000));
        return `${i + 1}. **${r.description}** (${r.action})\n` +
          `   ID: \`${r.id}\`\n` +
          `   詳細: ${r.detail.slice(0, 80)}\n` +
          `   経過: ${elapsed}s | 残り: ${remaining}s\n` +
          `   ✅ \`approve ${r.id}\` または ❌ \`reject ${r.id} 理由\``;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const approvalManager = new ApprovalManager();
