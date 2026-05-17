// ==========================================
// Aikata - Send Message ツール（Hermes Agent由来）
// エージェントから他チャンネルへクロスプラットフォーム送信
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";

// ==================== 配信 ====================

async function sendToDiscord(target: string, text: string): Promise<string> {
  try {
    const { getDiscordClient } = await import("../messaging");
    const client = getDiscordClient();
    if (!client) return "[エラー] Discordクライアントが利用できません";

    // target = "channel_id" or "channel_id:thread_id"
    const parts = target.split(":");
    const channelId = parts[0]!;
    const threadId = parts[1];

    let channel;
    if (threadId) {
      channel = await client.channels.fetch(threadId).catch(() => null);
      if (!channel) channel = await client.channels.fetch(channelId).catch(() => null);
    } else {
      channel = await client.channels.fetch(channelId).catch(() => null);
    }

    if (!channel || !("send" in channel)) {
      return `[エラー] チャンネル ${target} が見つからないか、メッセージ送信に対応していません`;
    }

    const chunks = splitMessage(text, 1950);
    for (const chunk of chunks) {
      await (channel as any).send(chunk);
    }

    return `✅ Discord ${target} に送信完了 (${text.length}文字, ${chunks}分割)`;
  } catch (e: any) {
    return `[エラー] Discord送信失敗: ${e.message?.slice(0, 200)}`;
  }
}

async function sendToTelegram(target: string, text: string): Promise<string> {
  try {
    const chatId = target; // "1234567890"
    const { Bot } = await import("grammy");
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) return "[エラー] TELEGRAM_TOKEN 未設定";

    const bot = new Bot(token);
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }

    return `✅ Telegram ${target} に送信完了 (${text.length}文字)`;
  } catch (e: any) {
    return `[エラー] Telegram送信失敗: ${e.message?.slice(0, 200)}`;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut === -1 || cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut === -1 || cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ==================== ツール ====================

const sendTool: ToolDescriptor = {
  name: "send_message",
  emoji: "📨",
  owner: "core",
  description: "指定したプラットフォームのチャンネル/ユーザーにメッセージを送信します。",
  parameters: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: ["discord", "telegram"],
        description: "送信先プラットフォーム",
      },
      target: {
        type: "string",
        description: "送信先ID。discord: 'channel_id' または 'channel_id:thread_id'。telegram: 'chat_id'",
      },
      text: {
        type: "string",
        description: "送信するメッセージ本文",
      },
    },
    required: ["platform", "target", "text"],
  },
  async execute(args) {
    const platform = args.platform as string;
    const target = args.target as string;
    const text = String(args.text || "").trim();

    if (!text) return "[エラー] text が必要です";
    if (!target) return "[エラー] target が必要です";

    logger.info(`send_message: ${platform}:${target} (${text.length}文字)`);

    switch (platform) {
      case "discord": return sendToDiscord(target, text);
      case "telegram": return sendToTelegram(target, text);
      default: return `[エラー] 未対応プラットフォーム: ${platform}`;
    }
  },
};

toolRegistry.register(sendTool);
export { sendTool };
