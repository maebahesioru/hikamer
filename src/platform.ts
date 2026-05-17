// ==========================================
// Aikata - プラットフォーム抽象化（OpenHuman channels由来）
// 統一メッセージングインターフェース
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type PlatformType = "discord" | "telegram" | "cli" | "slack" | "matrix" | "whatsapp" | "custom";

export interface PlatformMessage {
  id: string;
  platform: PlatformType;
  channelId: string;
  threadId?: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  attachments: PlatformAttachment[];
  isDM: boolean;
  isThread: boolean;
  raw: any;
}

export interface PlatformAttachment {
  type: "image" | "file" | "audio" | "video" | "link";
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
}

export interface PlatformAdapter {
  type: PlatformType;
  name: string;
  send(channelId: string, text: string, options?: SendOptions): Promise<string>;
  sendTyping(channelId: string): Promise<void>;
  createThread(channelId: string, title: string, firstMessage?: string): Promise<string>;
  getChannelName(channelId: string): Promise<string>;
  getUserName(userId: string): Promise<string>;
  isAvailable(): boolean;
}

export interface SendOptions {
  threadId?: string;
  replyTo?: string;
  mentions?: string[];
  embed?: { title?: string; description?: string; color?: number; fields?: Array<{ name: string; value: string }> };
  attachments?: Array<{ path: string; name?: string }>;
}

// ==================== アダプター管理 ====================

class PlatformManager {
  private adapters = new Map<PlatformType, PlatformAdapter>();
  private defaultPlatform: PlatformType = "discord";

  /** アダプター登録 */
  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.type, adapter);
    logger.info(`[Platform] 登録: ${adapter.name} (${adapter.type})`);
  }

  /** アダプター取得 */
  get(type: PlatformType): PlatformAdapter | undefined {
    return this.adapters.get(type);
  }

  /** 利用可能なプラットフォーム一覧 */
  listAvailable(): PlatformAdapter[] {
    return Array.from(this.adapters.values()).filter(a => a.isAvailable());
  }

  /** メッセージ送信（統一インターフェース） */
  async send(
    channelId: string,
    text: string,
    options?: SendOptions & { platform?: PlatformType },
  ): Promise<{ platform: PlatformType; messageId: string } | null> {
    const platform = options?.platform || this.defaultPlatform;
    const adapter = this.adapters.get(platform);

    if (!adapter || !adapter.isAvailable()) {
      logger.warn(`[Platform] 利用不可: ${platform}`);
      return null;
    }

    try {
      const targetChannel = options?.threadId || channelId;
      const messageId = await adapter.send(targetChannel, text, options);
      return { platform, messageId };
    } catch (e: any) {
      logger.error(`[Platform] 送信失敗 (${platform}): ${e.message}`);
      return null;
    }
  }

  /** 複数プラットフォームに一斉送信 */
  async broadcast(text: string, platforms?: PlatformType[]): Promise<Array<{ platform: PlatformType; messageId: string }>> {
    const targets = platforms || Array.from(this.adapters.keys());
    const results: Array<{ platform: PlatformType; messageId: string }> = [];

    for (const platform of targets) {
      const adapter = this.adapters.get(platform);
      if (!adapter || !adapter.isAvailable()) continue;

      try {
        // 各プラットフォームのホームチャンネルを想定
        const homeChannel = process.env[`${platform.toUpperCase()}_HOME_CHANNEL`];
        if (homeChannel) {
          const messageId = await adapter.send(homeChannel, text);
          results.push({ platform, messageId });
        }
      } catch {}
    }

    return results;
  }

  /** メッセージを正規化（プラットフォーム間差異を吸収） */
  normalizeText(text: string, fromPlatform: PlatformType): string {
    let normalized = text;

    switch (fromPlatform) {
      case "discord":
        // Discord: <@userId> → @username, <#channelId> → #channel
        normalized = normalized.replace(/<@!?(\d+)>/g, "@user");
        normalized = normalized.replace(/<#(\d+)>/g, "#channel");
        break;
      case "telegram":
        // Telegram: Markdown書式の差異
        normalized = normalized.replace(/__(.+?)__/g, "**$1**");
        break;
      case "slack":
        normalized = normalized.replace(/<@(\w+)>/g, "@$1");
        break;
    }

    return normalized;
  }

  /** メッセージをプラットフォーム向けにフォーマット */
  formatForPlatform(text: string, targetPlatform: PlatformType): string {
    switch (targetPlatform) {
      case "discord":
        return text; // Markdown互換
      case "telegram":
        // 一部のMarkdown書式を変換
        return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
      default:
        return text;
    }
  }

  /** スレッド作成 */
  async createThread(
    channelId: string,
    title: string,
    platform?: PlatformType,
    firstMessage?: string,
  ): Promise<string | null> {
    const p = platform || this.defaultPlatform;
    const adapter = this.adapters.get(p);
    if (!adapter) return null;

    try {
      return await adapter.createThread(channelId, title, firstMessage);
    } catch (e: any) {
      logger.error(`[Platform] スレッド作成失敗: ${e.message}`);
      return null;
    }
  }

  /** デフォルトプラットフォーム設定 */
  setDefault(platform: PlatformType): void {
    this.defaultPlatform = platform;
  }
}

// ==================== Discordアダプター ====================

export function createDiscordAdapter(client: any): PlatformAdapter {
  return {
    type: "discord",
    name: "Discord",
    isAvailable: () => client !== null && client.isReady(),
    async send(channelId, text, options) {
      const channel = await client.channels.fetch(channelId);
      const target = options?.threadId
        ? await client.channels.fetch(options.threadId).catch(() => channel)
        : channel;

      if (!target || !target.send) throw new Error("チャンネルが見つかりません");

      const msg = await target.send({ content: text.slice(0, 1950) });
      return msg.id;
    },
    async sendTyping(channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.sendTyping) await channel.sendTyping();
    },
    async createThread(channelId, title, firstMessage) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.startThread) throw new Error("スレッド作成不可");
      const thread = await channel.startThread({
        name: title.slice(0, 80),
        autoArchiveDuration: 60,
      });
      if (firstMessage) await thread.send(firstMessage);
      return thread.id;
    },
    async getChannelName(channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      return channel?.name || channelId;
    },
    async getUserName(userId) {
      try { const user = await client.users.fetch(userId); return user.displayName; } catch { return userId; }
    },
  };
}

// ==================== シングルトン ====================

export const platformManager = new PlatformManager();
