// ==========================================
// Aikata - 統合エントリポイント (Discord + Telegram + Scheduler)
// ==========================================

import "dotenv/config";
import { registerAllTools } from "./tools/index";
import { logger } from "./utils/logger";
// DB初期化
import "./db";

registerAllTools();

const enabledPlatforms = (process.env.ENABLED_PLATFORMS || "discord,telegram")
  .split(",").map(s => s.trim()).filter(Boolean);

const platformClients: Record<string, any> = {};

// ==================== 配信ヘルパー ====================

async function deliverMessage(platform: string, chatId: string, message: string): Promise<void> {
  try {
    if (platform === "discord" && platformClients.discord) {
      const client = platformClients.discord;
      const channel = await client.channels.fetch(chatId).catch(() => null);
      if (channel && "send" in channel) {
        for (const chunk of splitMessage(message, 1900)) {
          await (channel as any).send(chunk);
        }
      }
    } else if (platform === "telegram" && platformClients.telegram) {
      for (const chunk of splitMessage(message, 4000)) {
        await platformClients.telegram.api.sendMessage(chatId, chunk);
      }
    } else {
      console.log(`\n[Cron] ${message}\n`);
    }
  } catch (e: any) {
    logger.error(`配信失敗 (${platform}): ${e.message}`);
  }
}

// ==================== 起動 ====================

async function main() {
  logger.info("═══════════════════════════════════");
  logger.info(" Aikata v1.1 起動中…");
  logger.info(` プラットフォーム: ${enabledPlatforms.join(", ")}`);
  logger.info("═══════════════════════════════════");

  if (enabledPlatforms.includes("discord")) {
    const token = process.env.DISCORD_TOKEN;
    if (token && token !== "your-discord-bot-token-here") {
      const { startDiscord } = await import("./discord");
      const client = await startDiscord(token);
      platformClients.discord = client;
    } else {
      logger.warn("DISCORD_TOKEN 未設定。Discordスキップ。");
    }
  }

  if (enabledPlatforms.includes("telegram")) {
    const token = process.env.TELEGRAM_TOKEN;
    if (token && token !== "your-telegram-bot-token-here") {
      const { startTelegramBot } = await import("./telegram");
      const bot = await startTelegramBot(token);
      platformClients.telegram = bot;
    } else {
      logger.warn("TELEGRAM_TOKEN 未設定。Telegramスキップ。");
    }
  }

  // スケジューラー
  if (process.env.ENABLE_SCHEDULER !== "false") {
    const { createActiveProvider } = await import("./providers/base");
    const { startScheduler } = await import("./scheduler");
    startScheduler({ provider: createActiveProvider(), deliver: deliverMessage });
  }

  logger.info("Aikata 起動完了 🎉");
  logger.info(" /provider /model /maxiter /models /providers /addprovider /delprovider /info");
  logger.info(" /reset /jobs");

  process.on("SIGINT", () => {
    logger.info("シャットダウン…");
    if (platformClients.discord) platformClients.discord.destroy();
    if (platformClients.telegram) platformClients.telegram.stop();
    process.exit(0);
  });
}

main().catch(e => { logger.error(`起動失敗: ${e.message}`); process.exit(1); });

function splitMessage(text: string, maxLen: number): string[] {
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
