// ==========================================
// Hikamer - Webhookトンネルルーター（OpenHuman webhooks/ 完全移植）
// トンネル登録・ルーティング・デバッグログ
// ==========================================

import { logger } from "./utils/logger";
import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ==================== 型定義 ====================

export type TunnelTargetKind = "echo" | "agent" | "skill";

export interface TunnelRegistration {
  id: string;
  path: string;
  kind: TunnelTargetKind;
  skillId?: string;
  agentId?: string;
  createdAt: number;
  generation: number;
}

export interface WebhookDebugLogEntry {
  timestamp: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

export type WebhookRequestStatus = "received" | "routed" | "completed" | "failed";

// ==================== ルーター ====================

class WebhookRouter {
  private tunnels = new Map<string, TunnelRegistration>();
  private debugLogs: WebhookDebugLogEntry[] = [];
  private maxDebugLogs = 250;
  private generation = 0;
  private persistencePath: string;

  constructor() {
    this.persistencePath = resolve(process.env.DATA_DIR || "./data", "webhook-tunnels.json");
    this.load();
  }

  /** トンネル登録 */
  register(path: string, kind: TunnelTargetKind, owner?: { skillId?: string; agentId?: string }): TunnelRegistration {
    // 既存のトンネルがあれば上書き
    for (const [, t] of this.tunnels) {
      if (t.path === path) {
        if (owner?.skillId && t.skillId && t.skillId !== owner.skillId) {
          throw new Error(`Path "${path}" is already owned by skill "${t.skillId}"`);
        }
        this.unregister(t.id);
        break;
      }
    }

    this.generation++;
    const tunnel: TunnelRegistration = {
      id: `tun_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      path,
      kind,
      skillId: owner?.skillId,
      agentId: owner?.agentId,
      createdAt: Date.now(),
      generation: this.generation,
    };

    this.tunnels.set(tunnel.id, tunnel);
    this.save();
    logger.info(`[Webhook] トンネル登録: ${path} → ${kind} (id=${tunnel.id})`);
    return tunnel;
  }

  /** エコートンネル登録（テスト用） */
  registerEcho(path: string): TunnelRegistration {
    return this.register(path, "echo");
  }

  /** スキルトンネル登録 */
  registerSkill(path: string, skillId: string): TunnelRegistration {
    return this.register(path, "skill", { skillId });
  }

  /** エージェントトンネル登録 */
  registerAgent(path: string, agentId: string): TunnelRegistration {
    return this.register(path, "agent", { agentId });
  }

  /** トンネル解除 */
  unregister(id: string): boolean {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;

    this.tunnels.delete(id);
    this.save();
    logger.info(`[Webhook] トンネル解除: ${id} (${tunnel.path})`);
    return true;
  }

  /** スキルの全トンネルを解除 */
  unregisterSkill(skillId: string): number {
    let count = 0;
    for (const [id, t] of this.tunnels) {
      if (t.skillId === skillId) {
        this.tunnels.delete(id);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /** ルーティング */
  route(path: string): { tunnel: TunnelRegistration; params: Record<string, string> } | null {
    // 完全一致
    for (const t of this.tunnels.values()) {
      if (t.path === path) {
        return { tunnel: t, params: {} };
      }
    }

    // パラメータ付きパス: /webhook/{id}/action
    for (const t of this.tunnels.values()) {
      const tParts = t.path.split("/");
      const pParts = path.split("/");
      if (tParts.length !== pParts.length) continue;

      const params: Record<string, string> = {};
      let match = true;
      for (let i = 0; i < tParts.length; i++) {
        if (tParts[i]!.startsWith("{") && tParts[i]!.endsWith("}")) {
          params[tParts[i]!.slice(1, -1)] = pParts[i]!;
        } else if (tParts[i] !== pParts[i]) {
          match = false;
          break;
        }
      }
      if (match) return { tunnel: t, params };
    }

    return null;
  }

  /** トンネル情報取得 */
  get(id: string): TunnelRegistration | undefined {
    return this.tunnels.get(id);
  }

  /** スキルの全トンネル */
  listForSkill(skillId: string): TunnelRegistration[] {
    return Array.from(this.tunnels.values()).filter((t) => t.skillId === skillId);
  }

  /** 全トンネル */
  listAll(): TunnelRegistration[] {
    return Array.from(this.tunnels.values());
  }

  // ==================== デバッグログ ====================

  /** リクエストを記録 */
  recordRequest(method: string, path: string, status: number, durationMs: number, error?: string): void {
    const entry: WebhookDebugLogEntry = { timestamp: Date.now(), method, path, status, durationMs, error };
    this.debugLogs.push(entry);
    if (this.debugLogs.length > this.maxDebugLogs) this.debugLogs.shift();
  }

  /** ログ取得 */
  getLogs(limit = 50): WebhookDebugLogEntry[] {
    return this.debugLogs.slice(-limit).reverse();
  }

  /** ログクリア */
  clearLogs(): void {
    this.debugLogs = [];
  }

  // ==================== 永続化 ====================

  private save(): void {
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      writeFileSync(this.persistencePath, JSON.stringify({
        generation: this.generation,
        tunnels: Array.from(this.tunnels.values()),
      }), "utf-8");
    } catch (e) {
      logger.warn(`[Webhook] 永続化エラー: ${e}`);
    }
  }

  private load(): void {
    try {
      if (existsSync(this.persistencePath)) {
        const data = JSON.parse(readFileSync(this.persistencePath, "utf-8"));
        this.generation = data.generation || 0;
        for (const t of data.tunnels || []) {
          this.tunnels.set(t.id, t);
        }
      }
    } catch { /* ignore */ }
  }

  // ==================== フォーマット ====================

  formatStatus(): string {
    const tunnels = this.listAll();
    const logs = this.getLogs(5);

    const lines: string[] = ["🌐 **Webhook Tunnel Router**"];
    lines.push(`  トンネル数: ${tunnels.length}`);
    lines.push(`  世代: ${this.generation}`);
    lines.push(`  デバッグログ: ${this.debugLogs.length}/${this.maxDebugLogs}`);
    lines.push("");

    if (tunnels.length > 0) {
      lines.push("**登録トンネル:**");
      for (const t of tunnels) {
        const kindIcon = t.kind === "echo" ? "🔁" : t.kind === "agent" ? "🤖" : "🔧";
        lines.push(`  ${kindIcon} \`${t.path}\` → ${t.kind}${t.skillId ? ` (skill: ${t.skillId})` : ""}${t.agentId ? ` (agent: ${t.agentId})` : ""}`);
      }
    }

    if (logs.length > 0) {
      lines.push("");
      lines.push("**最近のリクエスト:**");
      for (const log of logs) {
        const icon = log.status < 300 ? "✅" : log.status < 500 ? "⚠️" : "❌";
        lines.push(`  ${icon} ${log.method} ${log.path} → ${log.status} (${log.durationMs}ms)`);
      }
    }

    return lines.join("\n");
  }
}

export const webhookRouter = new WebhookRouter();

/** Webhook HTTPサーバーを起動 */
export function startWebhookServer(port?: number): void {
  const { createServer } = require("http");
  const listenPort = port || parseInt(process.env.WEBHOOK_PORT || "9733", 10);
  const server = createServer(async (req: any, res: any) => {
    try {
      const match = webhookRouter.route(req.url || "/");
      if (match) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tunnel: match.tunnel.path, kind: match.tunnel.kind, params: match.params }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no matching tunnel" }));
      }
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(listenPort, () => {
    process.stderr.write(`[Webhook] サーバー起動: http://localhost:${listenPort}\n`);
  });
}
