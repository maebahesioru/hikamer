// ==========================================
// Aikata - 通知システム（OpenHuman notifications由来）
// マルチチャンネル通知（デスクトップ・Webhook・ログ）
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";

// ==================== 通知レベル ====================

export type NotificationLevel = "info" | "success" | "warning" | "error" | "critical";

interface Notification {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  source: string;
  timestamp: number;
  delivered: Set<string>;
}

// ==================== 通知チャンネル ====================

interface NotificationChannel {
  name: string;
  enabled: boolean;
  deliver: (notification: Notification) => Promise<void>;
}

type WebhookConfig = {
  url: string;
  method?: "POST" | "GET";
  headers?: Record<string, string>;
  template?: string; // JSONテンプレート: {{title}}, {{message}}, {{level}}
};

// ==================== 通知マネージャー ====================

class NotificationManager {
  private channels: NotificationChannel[] = [];
  private history: Notification[] = [];
  private maxHistory = 100;
  private rateLimitMap = new Map<string, number>(); // source: lastSent

  constructor() {
    // ログチャンネル（常時有効）
    this.addChannel({
      name: "log",
      enabled: true,
      deliver: async (n) => {
        const levelMap: Record<string, string> = {
          info: "info", success: "info", warning: "warn", error: "error", critical: "error",
        };
        const method = levelMap[n.level] || "info";
        (logger as any)[method](`[通知] ${n.title}: ${n.message.slice(0, 200)}`);
      },
    });
  }

  /** 通知チャンネル追加 */
  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel);
    logger.debug(`[通知] チャンネル追加: ${channel.name}`);
  }

  /** デスクトップ通知チャンネルを追加 */
  addDesktopChannel(): void {
    this.addChannel({
      name: "desktop",
      enabled: process.platform === "linux" || process.platform === "win32",
      deliver: async (n) => {
        try {
          if (process.platform === "linux") {
            const urgency = n.level === "critical" ? "critical" : n.level === "warning" ? "normal" : "low";
            execSync(`notify-send "${n.title}" "${n.message.slice(0, 200)}" -u ${urgency}`, {
              timeout: 3000, stdio: "ignore",
            });
          } else if (process.platform === "win32") {
            // Windows: msgコマンド（ローカル通知）
            try {
              execSync(`msg * "${n.title}: ${n.message.slice(0, 100)}"`, {
                timeout: 1000, stdio: "ignore",
              });
            } catch {}
          }
        } catch {}
      },
    });
  }

  /** Webhookチャンネルを追加 */
  addWebhookChannel(name: string, config: WebhookConfig): void {
    this.addChannel({
      name: `webhook-${name}`,
      enabled: true,
      deliver: async (n) => {
        try {
          const body = (config.template || '{"title":"{{title}}","message":"{{message}}","level":"{{level}}"}')
            .replace("{{title}}", n.title)
            .replace("{{message}}", n.message)
            .replace("{{level}}", n.level);

          const response = await fetch(config.url, {
            method: config.method || "POST",
            headers: {
              "Content-Type": "application/json",
              ...config.headers,
            },
            body,
            signal: AbortSignal.timeout(5000),
          });

          if (!response.ok) {
            logger.warn(`[通知] Webhook失敗: ${name} (${response.status})`);
          }
        } catch (e: any) {
          logger.warn(`[通知] Webhook接続失敗: ${name} — ${e.message}`);
        }
      },
    });
  }

  /** 通知を送信 */
  async notify(
    title: string,
    message: string,
    options?: {
      level?: NotificationLevel;
      source?: string;
      channels?: string[];
      dedupMs?: number; // 同一ソースからの重複防止時間
    },
  ): Promise<string> {
    const level = options?.level || "info";
    const source = options?.source || "system";
    const dedupMs = options?.dedupMs || 0;
    const targetChannels = options?.channels;

    // レート制限（同一ソースからの連続通知を抑制）
    if (dedupMs > 0) {
      const lastSent = this.rateLimitMap.get(source);
      if (lastSent && Date.now() - lastSent < dedupMs) {
        return ""; // スキップ（サイレント）
      }
      this.rateLimitMap.set(source, Date.now());
    }

    const id = `notif-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const notification: Notification = {
      id,
      title,
      message,
      level,
      source,
      timestamp: Date.now(),
      delivered: new Set(),
    };

    // 対象チャンネルに配信
    let deliverCount = 0;
    for (const channel of this.channels) {
      if (!channel.enabled) continue;
      if (targetChannels && !targetChannels.includes(channel.name)) continue;

      try {
        await channel.deliver(notification);
        notification.delivered.add(channel.name);
        deliverCount++;
      } catch (e: any) {
        logger.warn(`[通知] 配信失敗: ${channel.name} — ${e.message}`);
      }
    }

    // 履歴保存
    this.history.push(notification);
    if (this.history.length > this.maxHistory) this.history.shift();

    logger.debug(`[通知] 配信: "${title}" (${level}) → ${deliverCount}チャンネル`);
    return id;
  }

  /** クイック通知 */
  async info(title: string, message: string): Promise<string> {
    return this.notify(title, message, { level: "info" });
  }

  async warn(title: string, message: string): Promise<string> {
    return this.notify(title, message, { level: "warning" });
  }

  async error(title: string, message: string): Promise<string> {
    return this.notify(title, message, { level: "error" });
  }

  async critical(title: string, message: string): Promise<string> {
    return this.notify(title, message, { level: "critical" });
  }

  /** 履歴取得 */
  getHistory(level?: NotificationLevel, limit = 20): Notification[] {
    let results = this.history;
    if (level) results = results.filter(n => n.level === level);
    return results.slice(-limit).reverse();
  }

  /** チャンネル一覧 */
  getChannels(): Array<{ name: string; enabled: boolean }> {
    return this.channels.map(c => ({ name: c.name, enabled: c.enabled }));
  }

  /** チャンネル有効/無効 */
  setChannelEnabled(name: string, enabled: boolean): boolean {
    const channel = this.channels.find(c => c.name === name);
    if (!channel) return false;
    channel.enabled = enabled;
    return true;
  }

  /** 通知レベルに応じたプレフィックス */
  getPrefix(level: NotificationLevel): string {
    switch (level) {
      case "info": return "ℹ️";
      case "success": return "✅";
      case "warning": return "⚠️";
      case "error": return "❌";
      case "critical": return "🚨";
    }
  }

  /** フォーマット */
  formatHistory(level?: NotificationLevel, limit = 5): string {
    const history = this.getHistory(level, limit);
    if (history.length === 0) return "通知履歴はありません。";

    return [
      "**通知履歴**",
      "",
      ...history.map(n => {
        const prefix = this.getPrefix(n.level);
        const time = new Date(n.timestamp).toLocaleTimeString("ja-JP");
        return `${prefix} [${time}] **${n.title}**\n` +
          `   ${n.message.slice(0, 100)}${n.message.length > 100 ? "…" : ""}\n` +
          `   ソース: ${n.source} | 配信先: ${Array.from(n.delivered).join(", ")}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const notificationManager = new NotificationManager();
