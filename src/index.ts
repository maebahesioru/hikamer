// ==========================================
// Aikata - 統合エントリポイント (Discord + Telegram + Scheduler)
// v1.18: Threads + Hooks + Doctor + Connectivity + SituationReport
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
import { startMcpServer } from "./mcp-server";
import { subconscious } from "./subconscious";
import { approvalManager } from "./approval-workflow";
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

registerCommand("approve", async (id, userId) => {
  if (!id) return "承認するリクエストIDを指定してください。\n`/approve <id> [メモ]`";
  const parts = id.split(" ");
  const reqId = parts[0];
  const note = parts.slice(1).join(" ");
  const ok = approvalManager.approve(reqId, userId, note || undefined);
  return ok ? `✅ 承認しました: \`${reqId}\`` : `❌ リクエスト \`${reqId}\` は見つからないか、すでに処理済みです。`;
});

registerCommand("reject", async (id, userId) => {
  if (!id) return "拒否するリクエストIDを指定してください。\n`/reject <id> [理由]`";
  const parts = id.split(" ");
  const reqId = parts[0];
  const reason = parts.slice(1).join(" ");
  const ok = approvalManager.reject(reqId, userId, reason || undefined);
  return ok ? `❌ 拒否しました: \`${reqId}\`${reason ? ` (理由: ${reason})` : ""}` : `❌ リクエスト \`${reqId}\` は見つからないか、すでに処理済みです。`;
});

registerCommand("pending", async () => {
  return approvalManager.formatPending();
});

registerCommand("creds", async () => {
  const { formatCredentials } = await import("./credentials");
  return formatCredentials();
});

registerCommand("notif", async (args) => {
  const { notificationManager } = await import("./notifications");
  if (!args) return notificationManager.formatHistory();
  return notificationManager.formatHistory(args as any);
});

registerCommand("routes", async () => {
  const { modelRouter } = await import("./model-router");
  return modelRouter.formatRoutes();
});

registerCommand("context", async (args) => {
  const { contextManager } = await import("./context-manager");
  if (args === "compress") {
    const result = contextManager.compress();
    return `✅ 圧縮完了: ${result.removedMessages}メッセージ削除, ${result.savedTokens}トークン節約`;
  }
  return contextManager.formatStats();
});

registerCommand("kanban", async (args) => {
  const { kanban } = await import("./kanban");
  if (!args) return kanban.renderBoard();
  const parts = args.split(" ");
  const cmd = parts[0];
  const rest = parts.slice(1).join(" ");
  if (cmd === "add" && rest) {
    const card = kanban.addCard("default", rest);
    return card ? `✅ カード追加: "${rest}" (${card.id})` : "❌ カード追加失敗（WIP制限？）";
  }
  if (cmd === "move" && parts.length >= 3) {
    const ok = kanban.moveCard("default", parts[1]!, parts[2]!);
    return ok ? `✅ カード移動: ${parts[1]} → ${parts[2]}` : "❌ 移動失敗";
  }
  return kanban.renderBoard();
});

registerCommand("update", async (args) => {
  const { autoUpdater } = await import("./auto-update");
  if (args === "apply") {
    const result = autoUpdater.applyUpdate();
    if (result.success && result.restartRequired) {
      setTimeout(() => autoUpdater.restart(), 2000);
      return `${result.message}\n\n2秒後に再起動します…`;
    }
    return result.message;
  }
  return autoUpdater.formatInfo();
});

registerCommand("plugins", async () => {
  const { pluginManager } = await import("./plugin-system");
  return pluginManager.formatPlugins();
});

registerCommand("mail", async (args) => {
  const { mailEngine } = await import("./email");
  if (!args) return "メールコマンド: `/mail send <to> <subject> <body>`, `/mail inbox`";
  const parts = args.split(" ");
  if (parts[0] === "send" && parts.length >= 3) {
    const to = parts[1]!;
    const subject = parts[2]!;
    const body = parts.slice(3).join(" ") || "(本文なし)";
    const ok = await mailEngine.sendMail(to, subject, body);
    return ok ? `✅ メール送信: ${subject} → ${to}` : `❌ 送信失敗`;
  }
  if (parts[0] === "inbox") {
    const emails = await mailEngine.fetchInbox(5);
    if (emails.length === 0) return "📬 新着メールはありません。";
    return `📬 **受信箱**\n${emails.map(e => `• ${e.subject} from ${e.from}`).join("\n")}`;
  }
  return "不明なサブコマンド";
});

registerCommand("sessions", async (args) => {
  const { sessionManager } = await import("./session-manager");
  if (!args) {
    return sessionManager.formatSessions(sessionManager.listActive(), "アクティブセッション");
  }
  const parts = args.split(" ");
  const cmd = parts[0];
  const id = parts[1] || "";
  const rest = parts.slice(2).join(" ");
  if (cmd === "pin" && id) return sessionManager.togglePin(id) ? "📌 ピン留め切替" : "❌ セッションなし";
  if (cmd === "archive" && id) return sessionManager.toggleArchive(id) ? "🗄️ アーカイブ切替" : "❌ セッションなし";
  if (cmd === "star" && id) return sessionManager.toggleStar(id) ? "⭐ スター切替" : "❌ セッションなし";
  if (cmd === "title" && id && rest) return sessionManager.setTitle(id, rest) ? `✅ タイトル変更: ${rest}` : "❌ 失敗";
  if (cmd === "pinned") return sessionManager.formatSessions(sessionManager.listPinned(), "ピン留め");
  if (cmd === "archived") return sessionManager.formatSessions(sessionManager.listArchived(), "アーカイブ");
  return sessionManager.formatSessions(sessionManager.search(args), `検索: ${args}`);
});

registerCommand("ocr", async (args) => {
  const { ocrEngine } = await import("./screen");
  if (args === "check") {
    const caps = ocrEngine.checkCapabilities();
    return `🖥️ **OCR能力**\n利用可能: ${caps.length > 0 ? caps.join(", ") : "なし"}`;
  }
  return "OCR: `/ocr check` で能力確認。画像認識はメッセージ内の画像に対して自動実行。";
});

registerCommand("heal", async () => {
  const { selfHealer } = await import("./self-healer");
  return selfHealer.formatStatus();
});

registerCommand("contacts", async (args) => {
  const { contactManager } = await import("./contacts");
  if (!args) return contactManager.formatContacts(contactManager.listContacts());
  if (args.startsWith("search ")) return contactManager.formatContacts(contactManager.search(args.slice(7)));
  if (args === "stats") {
    const s = contactManager.getStats();
    return `👤 **連絡先統計**\n合計: ${s.total} | お気に入り: ${s.favorite} | ブロック: ${s.blocked} | グループ: ${s.groups}`;
  }
  return contactManager.formatContacts(contactManager.search(args));
});

registerCommand("sandbox", async () => {
  const { getSandboxCapabilities } = await import("./sandbox");
  const caps = getSandboxCapabilities();
  return `🛡️ **サンドボックス能力**\n利用可能: ${caps.length > 0 ? caps.join(", ") : "なし (直接実行)"}\n環境変数 SANDBOX_TYPE で指定: bubblewrap/firejail/docker/tempdir`;
});

registerCommand("usage", async () => {
  const { billingManager } = await import("./billing");
  return billingManager.formatUsage("default");
});

registerCommand("learn", async (args) => {
  const { learningEngine } = await import("./learning");
  if (!args) return learningEngine.formatStats();
  return "学習: `/learn` で状態表示。";
});

registerCommand("config", async (args) => {
  const { configManager } = await import("./config-manager");
  if (!args) return configManager.formatConfig();
  const eqIdx = args.indexOf("=");
  if (eqIdx > 0) {
    const key = args.slice(0, eqIdx).trim();
    const value = args.slice(eqIdx + 1).trim();
    return configManager.set(key, value) ? `✅ 設定: ${key} = ${value}` : "❌ 設定失敗";
  }
  return configManager.formatConfig();
});

registerCommand("flags", async (args) => {
  const { featureFlags } = await import("./feature-flags");
  if (!args) return featureFlags.formatFlags();
  const parts = args.split(" ");
  if (parts[0] === "enable" && parts[1]) {
    featureFlags.setOverride(parts[1]!, true);
    return `✅ フラグ有効化: ${parts[1]}`;
  }
  if (parts[0] === "disable" && parts[1]) {
    featureFlags.setOverride(parts[1]!, false);
    return `✅ フラグ無効化: ${parts[1]}`;
  }
  return featureFlags.formatFlags();
});

registerCommand("obsidian", async (args) => {
  const { obsidianVault } = await import("./obsidian");
  if (!args) return obsidianVault.getInfo().available
    ? `📓 Vault: ${obsidianVault.getInfo().path} (${obsidianVault.getInfo().noteCount}ノート)`
    : "📓 Obsidian Vaultが設定されていません。OBSIDIAN_VAULT を設定してください。";
  const parts = args.split(" ");
  if (parts[0] === "search" && parts[1]) {
    const notes = obsidianVault.searchNotes(parts.slice(1).join(" "));
    return obsidianVault.formatNotes(notes);
  }
  if (parts[0] === "tag" && parts[1]) {
    const notes = obsidianVault.findByTag(parts[1]!);
    return obsidianVault.formatNotes(notes);
  }
  return obsidianVault.getInfo().available
    ? `📓 Vault OK: ${obsidianVault.getInfo().noteCount}ノート`
    : "📓 Vault未設定";
});

registerCommand("supervisor", async (args) => {
  const { supervisor } = await import("./supervisor");
  if (!args) return supervisor.formatStatus();
  const parts = args.split(" ");
  if (parts[0] === "start" && parts[1]) return supervisor.start(parts[1]!) ? `✅ 開始: ${parts[1]}` : "❌ 開始失敗";
  if (parts[0] === "stop" && parts[1]) return supervisor.stop(parts[1]!) ? `⏹️ 停止: ${parts[1]}` : "❌ 停止失敗";
  if (parts[0] === "restart" && parts[1]) return supervisor.restart(parts[1]!) ? `🔄 再起動: ${parts[1]}` : "❌ 再起動失敗";
  return supervisor.formatStatus();
});

registerCommand("url", async (args) => {
  const { urlManager } = await import("./url-manager");
  if (!args) return urlManager.formatLinks(Array.from(urlManager["shortLinks"].values()));
  const parts = args.split(" ");
  if (parts[0] === "shorten" && parts[1]) {
    const link = urlManager.shorten(parts[1]!, "user", { title: parts.slice(2).join(" ") || undefined });
    return `🔗 短縮: \`${link.code}\` → ${parts[1]}`;
  }
  if (parts[0] === "resolve" && parts[1]) {
    const link = urlManager.resolve(parts[1]!);
    return link ? `🔗 \`${link.code}\` → ${link.url} (${link.clickCount}クリック)` : "❌ コード無効";
  }
  return urlManager.formatLinks(urlManager.searchByTag(args));
});

registerCommand("suggest", async (args) => {
  const { autocomplete } = await import("./autocomplete");
  if (!args) return `💡 **人気コマンド**: ${autocomplete.getPopularCommands().join(", ")}`;
  return autocomplete.formatSuggestions(args);
});

registerCommand("invite", async (args) => {
  const { referralManager } = await import("./referral");
  if (!args) {
    const invite = referralManager.createInvite("user");
    return `📨 招待コード: \`${invite.code}\`\n有効期限: ${invite.maxUses}回`;
  }
  if (args.startsWith("use ")) {
    const result = referralManager.useInvite(args.slice(4), "user");
    return result.valid ? "✅ 招待コード使用成功" : `❌ ${result.reason}`;
  }
  return referralManager.formatInvites(referralManager.getMyInvites("user"));
});

registerCommand("profile", async (args) => {
  const { peopleManager } = await import("./people");
  const profile = peopleManager.getOrCreate("user", "discord", args || "User");
  return peopleManager.formatProfile(profile);
});

registerCommand("sched", async (args) => {
  const { schedulerV2 } = await import("./scheduler-v2");
  if (!args) return schedulerV2.formatTasks();
  return schedulerV2.formatTasks();
});

registerCommand("state", async () => {
  const { appState } = await import("./app-state");
  return appState.formatState();
});

registerCommand("migrate", async (args) => {
  const { migrationManager } = await import("./migrations");
  if (args === "run") {
    const result = migrationManager.runPending();
    return `🗄️ マイグレーション: ${result.executed}実行, ${result.errors.length}エラー${result.errors.length > 0 ? "\n" + result.errors.join("\n") : ""}`;
  }
  return migrationManager.formatStatus();
});

registerCommand("caps", async () => {
  const { capabilityRegistry } = await import("./capabilities");
  return capabilityRegistry.formatCapabilities();
});

registerCommand("service", async () => {
  const { serviceManager } = await import("./service");
  return serviceManager.formatStatus();
});

registerCommand("reset", async (_args, _userId) => {
  // コスト警告リセット
  resetBudgetWarnings();
  return "✅ コスト警告をリセットしました。";
});

// ==================== v1.18: 新モジュールコマンド ====================

registerCommand("threads", async (args) => {
  const { threadManager, getThreadsCommands } = await import("./threads");
  const cmds = getThreadsCommands();
  return cmds["/threads"] ? cmds["/threads"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("hooks", async (args) => {
  const { hookManager, getHooksCommands } = await import("./hooks");
  const cmds = getHooksCommands();
  return cmds["/hooks"] ? cmds["/hooks"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("doctor", async (args) => {
  const { getDoctorCommands } = await import("./doctor");
  const cmds = getDoctorCommands();
  return cmds["/doctor"] ? await cmds["/doctor"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("connectivity", async (args) => {
  const { connectivityManager, getConnectivityCommands } = await import("./connectivity");
  const cmds = getConnectivityCommands();
  return cmds["/connectivity"] ? await cmds["/connectivity"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("situation", async (args) => {
  const { situationReport, getSituationCommands } = await import("./situation-report");
  const cmds = getSituationCommands();
  return cmds["/situation"] ? await cmds["/situation"](args ? args.split(" ") : []) : "❌ コマンドエラー";
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
  logger.info(" Aikata v1.18 起動中…");
  logger.info(" Threads / Hooks / Doctor / Connectivity / SituationReport");
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

  // MCPサーバー（環境変数MCP_TRANSPORT=stdio|tcp時）
  if (process.env.MCP_TRANSPORT) {
    startMcpServer();
  }

  // v1.18: 新モジュール初期化
  try {
    const { threadManager: tm } = await import("./threads");
    tm.init();
    logger.info("[Threads] スレッド管理初期化完了");

    const { hookManager: hm } = await import("./hooks");
    hm.init();
    logger.info("[Hooks] エージェントフック初期化完了");

    const { connectivityManager: cm } = await import("./connectivity");
    cm.init();
    logger.info("[Connectivity] 接続監視開始");

    // 中断ターンをマーク
    const interrupted = tm.markInterruptedTurns();
    if (interrupted > 0) {
      logger.warn(`[Threads] ${interrupted}個のターンを中断としてマーク（前回のクラッシュの可能性）`);
    }
  } catch (err) {
    logger.warn("[Startup] 一部v1.18モジュールの初期化に失敗:", err);
  }

  logger.info(" /threads /hooks /doctor /connectivity /situation");
  logger.info(` ツール数: ${toolRegistry.list().length} | モジュール数: 99+`);

  // サブコンシャス（環境変数ENABLE_SUBCONSCIOUS=true時）
  if (process.env.ENABLE_SUBCONSCIOUS === "true") {
    subconscious.start();
    logger.info("[Subconscious] バックグラウンド思考開始");
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
