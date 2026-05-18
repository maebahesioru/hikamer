// ==========================================
// Aikata - Gmail/Slackプロバイダー（OpenHuman composio/providers/ 由来）
// メール・メッセージのCRUD操作
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  body: string;
  snippet: string;
  labels: string[];
  isRead: boolean;
  hasAttachments: boolean;
}

export interface SlackMessage {
  ts: string;
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
  reactions?: Array<{ name: string; count: number }>;
  timestamp: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  isPrivate: boolean;
}

// ==================== プロバイダーマネージャー ====================

class ProviderManager {
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Providers] Gmail/Slack initialized");
  }

  // ==================== GMAIL ====================

  /** Gmailからメール一覧を取得 */
  async listEmails(
    maxResults = 10,
    query?: string
  ): Promise<EmailMessage[]> {
    const token = process.env.GMAIL_ACCESS_TOKEN;
    if (!token) {
      logger.warn("[Providers] Gmail not configured");
      return [];
    }

    try {
      const q = query ? `&q=${encodeURIComponent(query)}` : "";
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}${q}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as {
        messages?: Array<{ id: string; threadId: string }>;
      };
      if (!data.messages) return [];

      const emails: EmailMessage[] = [];
      for (const msg of data.messages.slice(0, maxResults)) {
        const detail = await this.getEmailDetail(msg.id!);
        if (detail) emails.push(detail);
      }
      return emails;
    } catch (err) {
      logger.error("[Providers] Gmail list failed:", err);
      return [];
    }
  }

  /** Gmailからメール詳細を取得 */
  async getEmailDetail(messageId: string): Promise<EmailMessage | null> {
    const token = process.env.GMAIL_ACCESS_TOKEN;
    if (!token) return null;

    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return null;

      const data = (await res.json()) as {
        id?: string;
        threadId?: string;
        labelIds?: string[];
        payload?: {
          headers?: Array<{ name: string; value: string }>;
        };
        snippet?: string;
      };

      const headers = data.payload?.headers ?? [];
      return {
        id: data.id ?? "",
        threadId: data.threadId ?? "",
        subject: headers.find((h) => h.name === "Subject")?.value ?? "",
        from: headers.find((h) => h.name === "From")?.value ?? "",
        to: (headers.find((h) => h.name === "To")?.value ?? "").split(",").map((s) => s.trim()),
        date: headers.find((h) => h.name === "Date")?.value ?? "",
        body: data.snippet ?? "",
        snippet: data.snippet ?? "",
        labels: data.labelIds ?? [],
        isRead: !data.labelIds?.includes("UNREAD"),
        hasAttachments: false,
      };
    } catch {
      return null;
    }
  }

  /** Gmailでメールを送信 */
  async sendEmail(
    to: string,
    subject: string,
    body: string
  ): Promise<boolean> {
    const token = process.env.GMAIL_ACCESS_TOKEN;
    if (!token) return false;

    try {
      const email = [
        `From: me`,
        `To: ${to}`,
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\r\n");

      const encoded = Buffer.from(email).toString("base64url");

      const res = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: encoded }),
          signal: AbortSignal.timeout(10000),
        }
      );
      return res.ok;
    } catch (err) {
      logger.error("[Providers] Gmail send failed:", err);
      return false;
    }
  }

  // ==================== SLACK ====================

  /** Slackチャンネル一覧 */
  async listChannels(): Promise<SlackChannel[]> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return [];

    try {
      const res = await fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as {
        channels?: Array<{
          id: string;
          name: string;
          topic?: { value?: string };
          num_members?: number;
          is_private?: boolean;
        }>;
      };
      return (data.channels ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        topic: c.topic?.value ?? "",
        memberCount: c.num_members ?? 0,
        isPrivate: c.is_private ?? false,
      }));
    } catch {
      return [];
    }
  }

  /** Slackメッセージ送信 */
  async sendSlackMessage(
    channel: string,
    text: string
  ): Promise<{ ts: string } | null> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return null;

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel, text }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { ts?: string; ok?: boolean };
      return data.ok && data.ts ? { ts: data.ts } : null;
    } catch {
      return null;
    }
  }

  /** Slackメッセージ履歴 */
  async getChannelHistory(
    channel: string,
    limit = 20
  ): Promise<SlackMessage[]> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return [];

    try {
      const res = await fetch(
        `https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return [];

      const data = (await res.json()) as {
        messages?: Array<{
          ts: string;
          user: string;
          text: string;
          thread_ts?: string;
          reactions?: Array<{ name: string; count: number }>;
        }>;
      };
      return (data.messages ?? []).map((m) => ({
        ts: m.ts,
        channel,
        user: m.user,
        text: m.text,
        threadTs: m.thread_ts,
        reactions: m.reactions,
        timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  formatStatus(): string {
    return (
      `📧 **プロバイダー状態**\n` +
      `Gmail: ${process.env.GMAIL_ACCESS_TOKEN ? "✅ 設定済み" : "❌ 未設定"}\n` +
      `Slack: ${process.env.SLACK_BOT_TOKEN ? "✅ 設定済み" : "❌ 未設定"}`
    );
  }
}

// ==================== シングルトン ====================

export const providerManager = new ProviderManager();

export default ProviderManager;
