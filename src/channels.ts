// ==========================================
// Aikata - Multi-Channel Framework（OpenHuman channels/由来）
// 抽象Channel trait + マルチプロバイダ統合（Telegram/Slack/WhatsApp）
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import https from "https";
import http from "http";
import { URL } from "url";

// ==================== 型定義 ====================

export interface ChannelMessage {
  id: string;
  sender: string;
  replyTarget: string;
  content: string;
  channel: string;
  timestamp: number;
  threadTs?: string;
}

export interface SendMessage {
  content: string;
  recipient: string;
  subject?: string;
  threadTs?: string;
}

export type ChannelCapability = "send_text" | "send_rich" | "receive" | "typing" | "drafts" | "threads" | "files" | "reactions";

/** チャンネル抽象インターフェース */
export interface IChannel {
  readonly name: string;
  send(msg: SendMessage): Promise<void>;
  setOnMessage(handler: (msg: ChannelMessage) => void): void;
  healthCheck(): Promise<boolean>;
  startTyping(recipient: string): Promise<void>;
  stopTyping(recipient: string): Promise<void>;
  supports(cap: ChannelCapability): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ==================== Telegram チャンネル ====================

export interface TelegramConfig {
  botToken: string;
  allowedUsers?: string[];
  mentionOnly?: boolean;
}

export class TelegramChannel implements IChannel {
  readonly name = "telegram";
  private config: TelegramConfig;
  private onMessage: ((msg: ChannelMessage) => void) | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  setOnMessage(handler: (msg: ChannelMessage) => void) { this.onMessage = handler; }

  async send(msg: SendMessage): Promise<void> {
    const chatId = msg.recipient;
    const text = msg.content;

    // メッセージ分割（Telegram 4096文字制限）
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      const body = JSON.stringify({
        chat_id: chatId,
        text: chunk,
        reply_to_message_id: msg.threadTs ? parseInt(msg.threadTs) : undefined,
        parse_mode: "Markdown",
      });
      await this.apiCall("sendMessage", body);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.apiCall("getMe", "");
      return true;
    } catch { return false; }
  }

  async startTyping(recipient: string): Promise<void> {
    if (this.typingTimers.has(recipient)) return;
    this.typingTimers.set(recipient, setInterval(() => {
      this.apiCall("sendChatAction", JSON.stringify({ chat_id: recipient, action: "typing" })).catch(() => {});
    }, 4000));
  }

  async stopTyping(recipient: string): Promise<void> {
    const timer = this.typingTimers.get(recipient);
    if (timer) { clearInterval(timer); this.typingTimers.delete(recipient); }
  }

  supports(cap: ChannelCapability): boolean {
    return ["send_text", "receive", "typing", "reactions"].includes(cap);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("[Telegram] 起動");
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        const body = JSON.stringify({
          offset: this.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        const data = await this.apiCall("getUpdates", body);
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          for (const update of json.result) {
            if (update.update_id > this.lastUpdateId) this.lastUpdateId = update.update_id;
            const msg = this.parseUpdate(update);
            if (msg && this.onMessage) this.onMessage(msg);
          }
        }
      } catch (e: any) {
        logger.warn(`[Telegram] ポーリングエラー: ${e.message}`);
      }
      this.pollTimer = setTimeout(poll, 1000);
    };
    this.pollTimer = setTimeout(poll, 0);
  }

  private parseUpdate(update: Record<string, any>): ChannelMessage | null {
    const msg = (update.message || update.callback_query?.message) as Record<string, any> | undefined;
    if (!msg || !msg.text) return null;
    const chat = msg.chat as Record<string, unknown> | undefined;
    if (!chat) return null;
    const from = msg.from as Record<string, unknown> | undefined;
    return {
      id: `tg_${update.update_id}`,
      sender: from?.username as string || from?.id as string || "unknown",
      replyTarget: String(chat.id),
      content: String(msg.text),
      channel: "telegram",
      timestamp: (msg.date as number || 0) * 1000,
    };
  }

  private async apiCall(method: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/bot${this.config.botToken}/${method}`);
      const req = https.request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: string) => data += chunk);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    while (text.length > maxLen) {
      let cut = text.lastIndexOf("\n", maxLen);
      if (cut === -1 || cut < maxLen / 2) cut = text.lastIndexOf(" ", maxLen);
      if (cut === -1 || cut < maxLen / 2) cut = maxLen;
      chunks.push(text.slice(0, cut));
      text = text.slice(cut).trim();
    }
    if (text) chunks.push(text);
    return chunks;
  }
}

// ==================== Slack チャンネル ====================

export interface SlackConfig {
  botToken: string;
  channelId?: string;
  allowedUsers?: string[];
}

export class SlackChannel implements IChannel {
  readonly name = "slack";
  private config: SlackConfig;
  private onMessage: ((msg: ChannelMessage) => void) | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SlackConfig) { this.config = config; }
  setOnMessage(handler: (msg: ChannelMessage) => void) { this.onMessage = handler; }
  supports(cap: ChannelCapability): boolean { return ["send_text", "receive", "threads"].includes(cap); }

  async startTyping(_recipient: string): Promise<void> {}
  async stopTyping(_recipient: string): Promise<void> {}

  async send(msg: SendMessage): Promise<void> {
    const body = JSON.stringify({
      channel: msg.recipient,
      text: msg.content,
      thread_ts: msg.threadTs || undefined,
    });
    await this.apiCall("chat.postMessage", body);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.apiCall("auth.test", JSON.stringify({})); return true; }
    catch { return false; }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("[Slack] 起動");
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        const data = await this.apiCall("conversations.history", JSON.stringify({
          channel: this.config.channelId,
          limit: 10,
        }));
        const json = JSON.parse(data);
        // 実際のSlackではcursorを使ってページング
      } catch (e: any) {
        logger.warn(`[Slack] ポーリングエラー: ${e.message}`);
      }
      this.pollTimer = setTimeout(poll, 3000);
    };
    this.pollTimer = setTimeout(poll, 1000);
  }

  private async apiCall(method: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://slack.com/api/${method}`);
      const req = https.request(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.config.botToken}`,
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: string) => data += chunk);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// ==================== チャンネルマネージャー ====================

export class ChannelManager {
  private channels = new Map<string, IChannel>();
  private onMessage: ((msg: ChannelMessage) => void) | null = null;

  register(channel: IChannel): void {
    this.channels.set(channel.name, channel);
    channel.setOnMessage((msg) => {
      eventBus.publish(createEvent("channel", "inbound", {
        id: msg.id,
        sender: msg.sender,
        channel: msg.channel,
        content: msg.content.slice(0, 200),
      }));
      this.onMessage?.(msg);
    });
    logger.info(`[Channels] 登録: ${channel.name}`);
  }

  setOnMessage(handler: (msg: ChannelMessage) => void): void {
    this.onMessage = handler;
  }

  async send(channel: string, msg: SendMessage): Promise<void> {
    const ch = this.channels.get(channel);
    if (!ch) throw new Error(`Unknown channel: ${channel}`);
    await ch.send(msg);
  }

  async broadcast(msg: Omit<SendMessage, "recipient">): Promise<void> {
    for (const ch of this.channels.values()) {
      // broadcast to all registered channels
      eventBus.publish(createEvent("channel", "outbound", { channel: ch.name, content: msg.content.slice(0, 100) }));
    }
  }

  async startAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.stop();
    }
  }

  getChannel(name: string): IChannel | undefined {
    return this.channels.get(name);
  }

  listChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  async healthAll(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const [name, ch] of this.channels) {
      result[name] = await ch.healthCheck();
    }
    return result;
  }

  formatStatus(): string {
    const lines: string[] = ["🔌 **チャンネル一覧**"];
    for (const [name, ch] of this.channels) {
      lines.push(`  • **${name}**: ${ch.supports("send_text") ? "📤" : ""}${ch.supports("receive") ? "📥" : ""}${ch.supports("typing") ? "⌨️" : ""}${ch.supports("threads") ? "🧵" : ""}`);
    }
    return lines.join("\n");
  }
}

export const channelManager = new ChannelManager();
