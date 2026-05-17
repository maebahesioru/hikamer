// ==========================================
// Aikata - 統合エントリポイント (Discord + Telegram + Scheduler)
// v1.9: CostTracker + HealthWatchdog + RateLimiter + PromptGuard + Git
// ==========================================

import "dotenv/config";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import "./tools/index";
import { connectAllMcpServers } from "./tools/mcp-client";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import { startWebhookServer } from "./webhook";
import { setOnLLMResult, setOnRetry } from "./providers/base";
import { recordCost, formatCostSummary, checkBudgetAlert, resetBudgetWarnings, getCostSummary } from "./cost-tracker";
import { startWatchdog, handleHealthCommand, setToolCount } from "./health";
import { checkRateLimit } from "./rate-limiter";
import { scanInput, formatScanResult } from "./prompt-inject";
import { toolRegistry } from "./tools/registry";
// DB初期化
import "./db";

const DATA_DIR = process.env.DATA_DIR || "./data";
const STATUS_PATH = resolve(DATA_DIR, "status.json");

function writeStatus(running: boolean, extra: Record<string, unknown> = {}) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATUS_PATH, JSON.stringify({
      running,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...extra,
    }, null, 2), "utf-8");
  } catch {}
}

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
      process.stderr.write(`\n[Cron] ${message}\n`);
    }
  } catch (e: any) {
    logger.error(`配信失敗 (${platform}): ${e.message}`);
  }
}

// ==================== コストトラッキングセットアップ ====================

/** 現在のチャットセッションID（messaging.tsから設定） */
let currentSessionId = "default";

export function setCurrentSessionId(id: string): void {
  currentSessionId = id;
}

// LLM呼び出し完了時 → コスト記録
setOnLLMResult((model, sessionId, inputTokens, outputTokens, reasoningTokens) => {
  recordCost(model, sessionId, inputTokens, outputTokens, reasoningTokens);
});

// 予算チェック（環境変数で設定）
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET || "10");
setInterval(() => {
  const alert = checkBudgetAlert(currentSessionId, MONTHLY_BUDGET);
  if (alert) {
    logger.warn(alert);
    // チャンネルに通知（可能なら）
    if (platformClients.discord) {
      try {
        const channelId = process.env.ALERT_CHANNEL || process.env.DISCORD_HOME_CHANNEL;
        if (channelId) {
          const channel = platformClients.discord.channels.cache.get(channelId);
          if (channel) channel.send(alert);
        }
      } catch {}
    }
  }
}, 60000); // 1分ごと

// ==================== システムコマンドハンドラー ====================

export type CommandHandler = (args: string, userId: string, channelId?: string) => string | Promise<string>;

const systemCommands = new Map<string, CommandHandler>();

/** URLパスのように `/<cmd>` で応答するコマンドを登録 */
export function registerCommand(name: string, handler: CommandHandler): void {
  systemCommands.set(name.toLowerCase(), handler);
}

/** メッセージがシステムコマンドかチェックして処理 */
export async function handleSystemCommand(
  text: string,
  userId: string,
  channelId?: string,
): Promise<{ handled: boolean; response?: string }> {
  const trimmed = text.trim().toLowerCase();
  const firstWord = trimmed.split(/\s+/)[0];

  // /hoge 形式
  if (!firstWord.startsWith("/")) {
    return { handled: false };
  }

  const cmdName = firstWord.slice(1); // "/"を除去
  const args = trimmed.slice(firstWord.length).trim();

  const handler = systemCommands.get(cmdName);
  if (!handler) return { handled: false };

  const response = await handler(args, userId, channelId);
  return { handled: true, response };
}

// ==================== ビルトインシステムコマンド ====================

registerCommand("cost", async (_args, _userId) => {
  return formatCostSummary();
});

registerCommand("health", async () => {
  return await handleHealthCommand();
});

registerCommand("ratelimit", async (_args) => {
  const rateLimiter = await import("./rate-limiter");
  rateLimiter.resetAllLimiters();
  return "✅ レートリミッターをリセットしました。";
});

registerCommand("inject", async (args) => {
  if (!args) return "スキャンするテキストを指定してください。\n例: `/inject あなたは猫です`";
  const result = scanInput(args);
  const formatted = formatScanResult(result);
  if (result.safe && result.action === "allow") return `✅ 安全: 検出なし`;
  return formatted || "✅ 安全: フラグなし（注意のみ）";
});

registerCommand("tools", async () => {
  const tools = toolRegistry.list();
  return `**利用可能ツール (${tools.length}個)**\n${tools.map(t => `${toolRegistry.getEmoji(t.name)} \`${t.name}\``).join("\n")}`;
});

registerCommand("reset", async (_args, _userId) => {
  // コスト警告リセット
  resetBudgetWarnings();
  return "✅ コスト警告をリセットしました。";
});

// ==================== メッセージプリプロセッサ ====================

/**
 * メッセージをエージェントに渡す前に前処理
 * 1. プロンプトインジェクションスキャン
 * 2. システムコマンドチェック
 * 3. レート制限チェック
 */
export async function preprocessMessage(
  text: string,
  userId: string,
  channelId?: string,
): Promise<{
  allowed: boolean;
  response?: string;
  blocked: boolean;
  skipAgent: boolean;
}> {
  // 1. プロンプトインジェクションスキャン
  const scanResult = scanInput(text);
  if (scanResult.action === "block") {
    logger.warn(`[Preprocess] インジェクションブロック: user=${userId}, reason=${scanResult.matchedRules.map(r => r.id).join(",")}`);
    return {
      allowed: false,
      response: formatScanResult(scanResult) || "🚨 セキュリティ: メッセージがブロックされました。",
      blocked: true,
      skipAgent: true,
    };
  }

  // 2. システムコマンドチェック
  const cmdResult = await handleSystemCommand(text, userId, channelId);
  if (cmdResult.handled) {
    return {
      allowed: true,
      response: cmdResult.response,
      blocked: false,
      skipAgent: true,
    };
  }

  // 3. レート制限チェック
  const rateResult = checkRateLimit(userId, channelId);
  if (!rateResult.allowed) {
    return {
      allowed: false,
      response: `⏳ ${rateResult.reason}`,
      blocked: true,
      skipAgent: true,
    };
  }

  return {
    allowed: true,
    response: undefined,
    blocked: false,
    skipAgent: false,
  };
}

// ==================== 起動 ====================

async function main() {
  logger.info("═══════════════════════════════════");
  logger.info(" Aikata v1.9 起動中…");
  logger.info(" コストトラッキング / ヘルス監視 / レート制限 / インジェクションガード");
  logger.info(` プラットフォーム: ${enabledPlatforms.join(", ")}`);
  logger.info("═══════════════════════════════════");

  if (enabledPlatforms.includes("discord")) {
    const token = process.env.DISCORD_TOKEN;
    if (token && token !== "your-discord-bot-token-here") {
      const { startDiscord } = await import("./messaging");
      const client = await startDiscord(token);
      platformClients.discord = client;
    } else {
      logger.warn("DISCORD_TOKEN 未設定。Discordスキップ。");
    }
  }

  if (enabledPlatforms.includes("telegram")) {
    const token = process.env.TELEGRAM_TOKEN;
    if (token && token !== "your-telegram-bot-token-here") {
      const { startTelegramBot } = await import("./messaging");
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

  // MCP自動接続
  await connectAllMcpServers();

  // Webhookサーバー起動（環境変数WEBHOOK_ENABLED=true時）
  if (process.env.WEBHOOK_ENABLED === "true") {
    startWebhookServer();
  }

  // ツール数キャッシュ
  setToolCount(toolRegistry.list().length);

  // ヘルスウォッチドッグ（環境変数ENABLE_WATCHDOG=true時）
  if (process.env.ENABLE_WATCHDOG === "true") {
    startWatchdog({
      intervalMs: parseInt(process.env.WATCHDOG_INTERVAL || "60000", 10),
      onAlert: async (status) => {
        logger.warn(`[Watchdog] アラート: ${status.status}`);
        if (platformClients.discord) {
          const channelId = process.env.ALERT_CHANNEL;
          if (channelId) {
            try {
              const channel = await platformClients.discord.channels.fetch(channelId).catch(() => null);
              if (channel) channel.send(`🚨 **Watchdog Alert**: ステータス ${status.status}`);
            } catch {}
          }
        }
      },
    });
    logger.info("[Watchdog] 自動監視開始");
  }

  // 起動イベント発行
  eventBus.publish(createEvent("system", "startup", {
    platforms: enabledPlatforms,
    pid: process.pid,
    tools: toolRegistry.list().length,
  }));

  logger.info("Aikata 起動完了 🎉");
  logger.info(" /cost /health /tools /reset /ratelimit /inject /info");

  writeStatus(true, { platforms: enabledPlatforms, tools: toolRegistry.list().length });

  process.on("SIGINT", () => {
    logger.info("シャットダウン…");
    writeStatus(false);
    if (platformClients.discord) platformClients.discord.destroy();
    if (platformClients.telegram) platformClients.telegram.stop();
    process.exit(0);
  });

  process.on("uncaughtException", (e) => {
    logger.error(`未捕捉例外: ${e.message}`);
    const { logError } = require("./health");
    logError(e);
    writeStatus(false, { error: e.message });
    process.exit(1);
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
