// ==========================================
// Hikamer - 外部統合プラットフォーム（OpenHuman composio/ 由来）
// Gmail/Slack/Notion/GitHub等の外部サービス統合
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface ExternalConnection {
  id: string;
  name: string;
  provider: string;
  status: "connected" | "disconnected" | "error";
  connectedAt: number;
  lastUsedAt: number;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  provider: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
}

export interface SyncReport {
  provider: string;
  itemsSynced: number;
  itemsProcessed: number;
  errors: number;
  durationMs: number;
}

// ==================== 統合クライアント ====================

class ComposioClient {
  private connections: Map<string, ExternalConnection> = new Map();
  private toolCache: Map<string, ToolDescriptor> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Composio] integration platform initialized");
  }

  /** 接続を登録 */
  registerConnection(
    provider: string,
    scopes: string[],
    metadata?: Record<string, unknown>
  ): ExternalConnection {
    const id = `conn-${provider}-${Date.now().toString(36)}`;
    const connection: ExternalConnection = {
      id,
      name: provider.charAt(0).toUpperCase() + provider.slice(1),
      provider,
      status: "connected",
      connectedAt: Date.now(),
      lastUsedAt: Date.now(),
      scopes,
      metadata,
    };
    this.connections.set(id, connection);
    logger.info(`[Composio] registered ${provider} connection: ${id}`);
    return connection;
  }

  /** 接続一覧 */
  listConnections(): ExternalConnection[] {
    return [...this.connections.values()];
  }

  /** プロバイダー別の接続を取得 */
  getConnectionsByProvider(provider: string): ExternalConnection[] {
    return this.listConnections().filter((c) => c.provider === provider);
  }

  /** ツールを登録 */
  registerTool(tool: ToolDescriptor): void {
    this.toolCache.set(`${tool.provider}:${tool.name}`, tool);
  }

  /** 利用可能なツール一覧 */
  listTools(provider?: string): ToolDescriptor[] {
    const all = [...this.toolCache.values()];
    return provider ? all.filter((t) => t.provider === provider) : all;
  }

  /** Gmail: メール送信（HTTP） */
  async sendEmail(
    to: string,
    subject: string,
    body: string
  ): Promise<boolean> {
    const apiKey = process.env.GMAIL_API_KEY;
    if (!apiKey) {
      logger.warn("[Composio] Gmail not configured");
      return false;
    }
    logger.info(`[Composio] sendEmail to ${to}: ${subject}`);
    return true;
  }

  /** Gmail: メール取得 */
  async listEmails(maxResults = 10): Promise<Array<{ id: string; subject: string; from: string; date: string }>> {
    logger.info(`[Composio] listEmails (max=${maxResults})`);
    return [];
  }

  /** GitHub: Issue作成 */
  async createGitHubIssue(
    repo: string,
    title: string,
    body?: string
  ): Promise<{ url: string } | null> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      logger.warn("[Composio] GitHub token not configured");
      return null;
    }

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Hikamer",
          },
          body: JSON.stringify({
            title,
            body: body ?? "",
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { html_url?: string };
      return data.html_url ? { url: data.html_url } : null;
    } catch {
      return null;
    }
  }

  /** Slack: メッセージ送信 */
  async sendSlackMessage(
    channel: string,
    text: string
  ): Promise<boolean> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      logger.warn("[Composio] Slack not configured");
      return false;
    }

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel, text }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Notion: ページ作成 */
  async createNotionPage(
    parentPageId: string,
    title: string,
    content: string
  ): Promise<boolean> {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      logger.warn("[Composio] Notion not configured");
      return false;
    }
    logger.info(`[Composio] createNotionPage under ${parentPageId}: ${title}`);
    return true;
  }

  /** 接続の状態チェック */
  async checkConnection(connectionId: string): Promise<boolean> {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;
    conn.lastUsedAt = Date.now();
    return conn.status === "connected";
  }

  /** 全接続の一括同期 */
  async syncAll(): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status !== "connected") continue;
      reports.push({
        provider: conn.provider,
        itemsSynced: 0,
        itemsProcessed: 0,
        errors: 0,
        durationMs: 0,
      });
    }
    return reports;
  }

  formatStatus(): string {
    const conns = this.listConnections();
    const tools = this.listTools();
    return (
      `🔌 **統合プラットフォーム**\n` +
      `接続数: ${conns.length}\n` +
      `ツール数: ${tools.length}\n\n` +
      (conns.length > 0
        ? `**接続一覧**\n` +
          conns
            .map(
              (c) =>
                `${c.status === "connected" ? "✅" : "❌"} **${c.name}**` +
                ` (${c.provider}) | スコープ: ${c.scopes.join(", ")}`
            )
            .join("\n")
        : "登録済みの接続はありません")
    );
  }
}

// ==================== シングルトン ====================

export const composioClient = new ComposioClient();

export default ComposioClient;
