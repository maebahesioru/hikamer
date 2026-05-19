// ==========================================
// Aikata - 統合エントリポイント (Discord + Telegram + Scheduler)
// v1.36: EXHAUSTIVE - cms-connector + dag-executor + ci-poller + git-utils + content-calendar
// toprank/ViMax/roborevの全残りパターンを抽出（最終バッチ）
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
  const { contextMonitor } = await import("./context-monitor");
  if (args === "compress") {
    const result = contextManager.compress();
    return `✅ 圧縮完了: ${result.removedMessages}メッセージ削除, ${result.savedTokens}トークン節約`;
  }
  if (args === "monitor" || args === "ctx") {
    return contextMonitor.formatStatus();
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
  const { updateManager } = await import("./auto-update");
  if (args === "apply") {
    const result = await updateManager.performUpdate();
    if (result.success) {
      return `✅ アップデート成功: ${result.previousVersion} → ${result.newVersion}`;
    }
    return result.error ? `❌ ${result.error}` : "❌ アップデート失敗";
  }
  if (args === "check") {
    const info = await updateManager.checkForUpdate();
    return updateManager.formatInfo(info);
  }
  return updateManager.formatInfo(await updateManager.checkForUpdate());
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

// ==================== v1.19: 第18弾コマンド ====================

registerCommand("triage", async (args) => {
  const { getTriageCommands } = await import("./triage");
  const cmds = getTriageCommands();
  return cmds["/triage"] ? cmds["/triage"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("vault", async (args) => {
  const { vaultManager, getVaultCommands } = await import("./vault");
  const cmds = getVaultCommands();
  return cmds["/vault"] ? await cmds["/vault"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("errors", async (args) => {
  const { errorClassifier, getErrorCommands } = await import("./error-classifier");
  const cmds = getErrorCommands();
  return cmds["/errors"] ? cmds["/errors"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("team", async (args) => {
  const { teamManager, getTeamCommands } = await import("./team");
  const cmds = getTeamCommands();
  return cmds["/team"] ? cmds["/team"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("gateway", async (args) => {
  const { gateway, getGatewayCommands } = await import("./gateway-platform");
  const cmds = getGatewayCommands();
  return cmds["/gateway"] ? await cmds["/gateway"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

// ==================== v1.20: 第19弾コマンド ====================

registerCommand("harness", async (args) => {
  const { sessionHarness, getHarnessCommands } = await import("./harness");
  const cmds = getHarnessCommands();
  return cmds["/harness"] ? cmds["/harness"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("audit", async (args) => {
  const { securityAudit, getSecurityCommands } = await import("./security-audit");
  const cmds = getSecurityCommands();
  return cmds["/audit"] ? cmds["/audit"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("review", async (args) => {
  const { reviewer, getReviewCommands } = await import("./background-review");
  const cmds = getReviewCommands();
  return cmds["/review"] ? cmds["/review"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("cache", async (args) => {
  const { promptCache, getCacheCommands } = await import("./prompt-cache");
  const cmds = getCacheCommands();
  return cmds["/cache"] ? cmds["/cache"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

registerCommand("safety", async (args) => {
  const { fileSafety, getFileSafetyCommands } = await import("./file-safety");
  const cmds = getFileSafetyCommands();
  return cmds["/safety"] ? cmds["/safety"](args ? args.split(" ") : []) : "❌ コマンドエラー";
});

// ==================== v1.21: 第20弾コマンド ====================

registerCommand("reflect", async (args) => {
  const { reflectionEngine } = await import("./reflection");
  if (!args) {
    const recent = reflectionEngine.getRecent(5);
    return recent.length === 0 ? "📭 リフレクションはありません" :
      "💭 **直近のリフレクション**\n\n" + recent.map(r => reflectionEngine.formatReflection(r)).join("\n\n");
  }
  return "💭 " + args;
});

registerCommand("gate", async () => {
  const { schedulerGate } = await import("./scheduler-gate");
  return schedulerGate.formatStats();
});

registerCommand("a11y", async (args) => {
  const { accessibilityManager } = await import("./accessibility");
  const sub = args?.toLowerCase();
  if (sub === "sr" || sub === "reader") {
    accessibilityManager.setMode("screen_reader");
    return "♿ スクリーンリーダーモードを有効化しました";
  }
  if (sub === "hc" || sub === "contrast") {
    accessibilityManager.setMode("high_contrast");
    return "👁️ ハイコントラストモードを有効化しました";
  }
  return accessibilityManager.formatConfig();
});

registerCommand("integrations", async (args) => {
  const { integrationManager } = await import("./integrations");
  const sub = args?.toLowerCase();
  if (sub === "check" || sub === "status") {
    const statuses = await integrationManager.checkAll();
    return integrationManager.formatStatuses(statuses);
  }
  return "🔌 **連携コマンド**\n/integrations status — 連携状態";
});

registerCommand("onboard", async (args) => {
  const { onboardingManager } = await import("./onboarding");
  const sub = args?.toLowerCase();

  if (sub === "start") {
    const state = onboardingManager.start("user");
    const msg = onboardingManager.getCurrentMessage("user")!;
    return onboardingManager.formatMessage(msg) + "\n\n`/onboard next` で次へ";
  }

  if (sub === "next") {
    const msg = onboardingManager.advance("user");
    if (!msg) return "✅ オンボーディングは完了しています";
    return onboardingManager.formatMessage(msg);
  }

  if (sub === "skip") {
    onboardingManager.skipAll("user");
    return "⏭️ オンボーディングをスキップしました";
  }

  if (sub === "status") {
    const state = onboardingManager.getState("user");
    if (!state) return "📭 オンボーディングは開始されていません";
    return onboardingManager.formatState(state);
  }

  return "📋 **オンボーディング**\n" +
    "/onboard start — 開始\n" +
    "/onboard next — 次のステップ\n" +
    "/onboard skip — スキップ\n" +
    "/onboard status — 状態確認";
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

// ==================== v1.22: 第21弾コマンド ====================

registerCommand("composio", async (args) => {
  const { composioClient } = await import("./composio");
  return composioClient.formatStatus();
});

registerCommand("voice", async (args) => {
  const { voiceManager } = await import("./voice");
  const sub = args?.toLowerCase();
  if (sub === "config" || !sub) return voiceManager.formatConfig();
  return voiceManager.formatConfig();
});

registerCommand("wallet", async (args) => {
  const { walletManager } = await import("./wallet");
  const sub = args?.toLowerCase();
  if (sub === "list" || sub === "ls") {
    const wallets = walletManager.listAddresses();
    if (wallets.length === 0) return "📭 登録済みウォレットはありません";
    return wallets.map(w => walletManager.formatAddress(w)).join("\n\n");
  }
  if (sub === "chains") {
    const chains = walletManager.listChains();
    return "⛓️ **対応チェーン**\n" + chains.map(c => `- ${c.name} (${c.nativeCurrency})`).join("\n");
  }
  return "💰 **ウォレット**\n/wallet list — アドレス一覧\n/wallet chains — 対応チェーン";
});

registerCommand("learn", async (args) => {
  const { learningManager } = await import("./learning-reflection");
  const sub = args?.toLowerCase();
  if (sub === "stats") return learningManager.formatStats();
  if (sub === "rules") {
    const rules = learningManager.listRules();
    if (rules.length === 0) return "📭 学習ルールはありません";
    return "🧠 **学習ルール一覧**\n\n" + rules.map(r => learningManager.formatRule(r)).join("\n\n");
  }
  if (sub === "high") {
    const rules = learningManager.getHighConfidenceRules();
    if (rules.length === 0) return "📭 高信頼度ルールはありません";
    return "✅ **高信頼度ルール**\n\n" + rules.map(r => learningManager.formatRule(r)).join("\n\n");
  }
  return "🧠 **学習コマンド**\n/learn stats — 統計\n/learn rules — 全ルール\n/learn high — 高信頼度ルール";
});

// ==================== v1.23: 第22弾コマンド ====================

registerCommand("orchestrate", async (args) => {
  const { orchestrator } = await import("./orchestrator");
  const sub = args?.toLowerCase();
  if (sub === "agents") return orchestrator.formatAgents();
  if (sub === "plans") {
    const plans = orchestrator.listPlans();
    if (plans.length === 0) return "📭 プランはありません";
    return plans.map(p => orchestrator.formatPlan(p)).join("\n\n---\n\n");
  }
  return "🤖 **オーケストレーター**\n/orchestrate agents — エージェント一覧\n/orchestrate plans — プラン一覧";
});

registerCommand("screen", async (args) => {
  const { screenIntelligence } = await import("./screen-intelligence");
  const sub = args?.toLowerCase();
  if (sub === "status" || !sub) return screenIntelligence.formatStatus();
  return screenIntelligence.formatStatus();
});

registerCommand("providers", async () => {
  const { providerManager } = await import("./providers-gmail-slack");
  return providerManager.formatStatus();
});

registerCommand("local", async (args) => {
  const { localInference } = await import("./local-inference");
  return localInference.formatStatus();
});

registerCommand("meet", async (args) => {
  const { meetManager } = await import("./meet");
  const sub = args?.toLowerCase();
  if (sub === "status" || !sub) return meetManager.formatStatus();
  return meetManager.formatStatus();
});

// ==================== v1.24: 第23弾コマンド ====================

registerCommand("sockets", async () => {
  const { socketManager } = await import("./socket");
  return socketManager.formatStatus();
});

registerCommand("audio", async () => {
  const { audioToolkit } = await import("./audio-toolkit");
  return audioToolkit.formatStatus();
});

registerCommand("summarize", async () => {
  const { treeSummarizer } = await import("./tree-summarizer");
  return "🌳 **ツリー要約**\n/summarize <text> — テキストを階層的要約";
});

registerCommand("timeout", async () => {
  const { toolTimeoutManager } = await import("./tool-timeout");
  return toolTimeoutManager.formatStats();
});

// ==================== v1.25: 第24弾コマンド ====================

registerCommand("redirect", async (args) => {
  const { redirectManager } = await import("./redirect-links");
  const sub = args?.toLowerCase();
  if (sub === "stats") return redirectManager.formatStats();
  return "🔗 **リダイレクト**\n/redirect stats — 統計";
});

registerCommand("meet-agent", async () => {
  const { meetAgent } = await import("./meet-agent");
  return meetAgent.formatStatus();
});

registerCommand("runtime", async () => {
  const { runtimeManager } = await import("./runtime");
  return runtimeManager.formatStatus();
});

registerCommand("whatsapp", async () => {
  const { whatsappManager } = await import("./whatsapp");
  return whatsappManager.formatStatus();
});

registerCommand("shell", async () => {
  const { shellManager } = await import("./shell-hooks");
  return shellManager.formatConfig();
});

// ==================== v1.26: 最終弾コマンド ====================

registerCommand("insights", async (args) => {
  const { insightsEngine } = await import("./insights");
  const sub = args?.toLowerCase();
  if (sub === "daily") return insightsEngine.formatDailyUsage();
  insightsEngine.generateInsights();
  return insightsEngine.formatStats(insightsEngine.computeStats(7));
});

registerCommand("trajectory", async () => {
  const { trajectoryCompressor } = await import("./trajectory-compressor");
  return "📦 **軌跡圧縮**\n圧縮率計算・重要情報抽出";
});

registerCommand("webview", async () => {
  const { webViewAccounts } = await import("./webview-accounts");
  return webViewAccounts.formatStatus();
});

registerCommand("surfaces", async () => {
  const { providerSurfaces } = await import("./provider-surfaces");
  return providerSurfaces.formatStatus();
});

registerCommand("utils", async () => {
  const { formatMiscStatus } = await import("./aikata-misc");
  return formatMiscStatus();
});

// ==================== v1.27 COMPLETE コマンド ====================

registerCommand("curator", async () => {
  const { curator } = await import("./curator");
  return curator.formatStats();
});

registerCommand("keys", async () => {
  const { credentialPool } = await import("./credential-pool");
  return credentialPool.formatStats();
});

registerCommand("usage", async () => {
  const { accountUsage } = await import("./account-usage");
  return accountUsage.formatStatus();
});

registerCommand("lsp", async () => {
  const { lspManager } = await import("./lsp");
  return lspManager.formatStatus();
});

registerCommand("skills", async (args) => {
  const { skillSystem } = await import("./skills-system");
  const category = args?.toLowerCase();
  return skillSystem.formatSkills(category);
});

// ==================== v1.28: 未統合ファイル修復 ====================

registerCommand("sandbox", async (args) => {
  const { codeSandbox } = await import("./code-sandbox");
  return "📦 **コードサンドボックス**\n安全なコード実行環境";
});

registerCommand("watch", async () => {
  const { listWatches } = await import("./file-watcher");
  const watches = listWatches();
  return watches.length > 0
    ? `👁️ **ファイル監視 (${watches.length})**\n` + watches.map(w => `- ${w.path}`).join("\n")
    : "👁️ アクティブな監視はありません";
});

registerCommand("locals", async () => {
  const { localAI } = await import("./local-ai");
  return `🖥️ **ローカルAI**\n利用可能なローカルAIモデルの管理`;
});

registerCommand("api", async () => {
  const { restServer } = await import("./rest-api");
  return `🌐 **REST API**\nポート: ${restServer["port"] ?? "未起動"}`;
});

registerCommand("text", async () => {
  const { textInputManager } = await import("./text-input");
  return textInputManager.formatStatus();
});

registerCommand("ws", async () => {
  const { wsServer } = await import("./websocket-server");
  return `🔌 **WebSocket**\nポート: ${wsServer["port"] ?? "未起動"}`;
});

// ==================== v1.29: NEW - Commitments + Crestodian + Heartbeat + REM + ThinkScrubber ====================

registerCommand("commits", async () => {
  const { listAllCommitments, formatCommitments } = await import("./commitments");
  const all = listAllCommitments({ status: "pending" });
  return formatCommitments(all);
});

registerCommand("crestodian", async (args) => {
  const { parseOperation, executeOperation, formatOverview, collectOverview } = await import("./crestodian");
  if (!args || args.trim() === "") {
    const overview = await collectOverview();
    return formatOverview(overview);
  }
  const op = parseOperation(args);
  const result = await executeOperation(op);
  return result.message;
});

registerCommand("heartbeat", async (args) => {
  const { getHeartbeatState, formatHeartbeatStatus, startHeartbeat, stopHeartbeat, tickNow } = await import("./heartbeat");
  const cmd = (args || "").trim().toLowerCase();
  if (cmd === "start") { startHeartbeat(); return "💓 Heartbeat started"; }
  if (cmd === "stop") { stopHeartbeat(); return "💓 Heartbeat stopped"; }
  if (cmd === "tick") { const s = await tickNow(); return `💓 Tick done: ${s.eventsDelivered}/${s.eventsProcessed} events`; }
  return formatHeartbeatStatus();
});

registerCommand("memory", async (args) => {
  const { formatMemoryStats, searchMemory, formatMemoryRecord, getMemoryStats } = await import("./rem-memory");
  const cmd = (args || "").trim().toLowerCase();
  if (cmd === "stats" || cmd === "") return formatMemoryStats();
  if (cmd.startsWith("search ")) {
    const query = cmd.slice(7);
    const results = searchMemory(query, { limit: 5 });
    if (results.length === 0) return "🔍 該当する記憶が見つかりませんでした。";
    return ["🔍 **検索結果**", "", ...results.map(r => formatMemoryRecord(r))].join("\n");
  }
  return formatMemoryStats();
});

registerCommand("scrub", async (args) => {
  const { stripThinkBlocks, StreamingThinkScrubber } = await import("./think-scrubber");
  if (!args) return "🧹 **Think Scrubber**\\nストリーミング思考タグ除去エンジン";
  return `🧹 スクラブ結果:\\n${stripThinkBlocks(args)}`;
});

// ==================== v1.31: ENHANCE - Capabilities + Autocomplete + Context + WebhookTunnel + PythonRuntime ====================

registerCommand("channels", async (args) => {
  const { channelManager } = await import("./channels");
  const cmd = (args || "").trim().toLowerCase();
  if (cmd === "health") {
    const results = await channelManager.healthAll();
    return ["🔌 **チャンネルヘルス**", ...Object.entries(results).map(([name, ok]) => `  ${ok ? "✅" : "❌"} ${name}`)].join("\n");
  }
  return channelManager.formatStatus();
});

registerCommand("secrets", async (args) => {
  const { formatSecretsStatus, auditSecrets, formatAuditReport } = await import("./secrets-manager");
  const cmd = (args || "").trim().toLowerCase();
  if (cmd === "audit") {
    const { collectOverview } = await import("./crestodian");
    const overview = await collectOverview();
    const findings = auditSecrets({ config: { valid: overview.config.valid } } as any);
    return formatAuditReport(findings);
  }
  return formatSecretsStatus();
});

registerCommand("flows", async () => {
  const { formatSetupGuide, getFlows } = await import("./flows");
  const allFlows = getFlows();
  const lines = [formatSetupGuide(), "", `📋 登録フロー: ${allFlows.length}件`];
  return lines.join("\n");
});

registerCommand("subagents", async (args) => {
  const { subagentRegistry, formatSubagentDetail } = await import("./subagents");
  const cmd = (args || "").trim().toLowerCase();
  if (cmd.startsWith("show ")) {
    return formatSubagentDetail(cmd.slice(5));
  }
  return subagentRegistry.formatStats();
});

registerCommand("sandbox", async () => {
  const { defaultPolicy, defaultSandbox } = await import("./sandbox");
  return [defaultPolicy.formatPolicy(), "", `🛡️ **サンドボックス**: ${defaultSandbox.name}`].join("\n");
});

// ==================== v1.60: 投資支援コマンド（株カード + ペーパーポートフォリオ） ====================

registerCommand("stock", async (args) => {
  const { analyzeStock, formatStockCard } = await import("./stock-card");
  const symbol = (args || "").trim().toUpperCase();
  if (!symbol) return "📊 **株カード分析**\n使い方: `/stock <銘柄コード>`\n例: `/stock 6758` (ソニー), `/stock AAPL` (Apple)";

  try {
    const card = await analyzeStock(symbol);
    return formatStockCard(card);
  } catch (e: any) {
    return `❌ 銘柄分析エラー: ${e.message}\nヒント: 日本株は4桁コード（例: 6758）、米国株はティッカー（例: AAPL）`;
  }
});

registerCommand("portfolio", async (args) => {
  const { paperPortfolio } = await import("./paper-portfolio");
  paperPortfolio.init();

  const sub = (args || "").trim().toLowerCase();

  if (sub === "buy" || sub.startsWith("buy ")) {
    const parts = sub.split(/\s+/);
    const symbol = parts[1];
    const qty = parseInt(parts[2] || "100", 10);
    if (!symbol) return "使い方: `/portfolio buy <銘柄> [数量]`\n例: `/portfolio buy 6758 100`";
    if (isNaN(qty) || qty <= 0) return "数量は正の整数で指定してください。";

    const trade = await paperPortfolio.buy(symbol.toUpperCase(), qty);
    if (!trade) return "❌ 買付失敗。資金不足か銘柄が見つかりません。";
    return `✅ **買付完了**\n${trade.symbol} ×${trade.quantity}株 @¥${trade.price.toLocaleString()}\n約定金額: ¥${trade.totalCost.toLocaleString()}\n手数料: ¥${trade.fee.toLocaleString()}`;
  }

  if (sub === "sell" || sub.startsWith("sell ")) {
    const parts = sub.split(/\s+/);
    const symbol = parts[1];
    const qty = parts[2] ? parseInt(parts[2], 10) : undefined;
    if (!symbol) return "使い方: `/portfolio sell <銘柄> [数量]`\n例: `/portfolio sell 6758` (全株売却)";

    const trade = await paperPortfolio.sell(symbol.toUpperCase(), qty);
    if (!trade) return "❌ 売却失敗。ポジションがないか数量不足です。";
    const pnlSign = (trade.pnl ?? 0) >= 0 ? "+" : "";
    return `✅ **売却完了**\n${trade.symbol} ×${trade.quantity}株 @¥${trade.price.toLocaleString()}\nP&L: ${pnlSign}¥${trade.pnl?.toLocaleString() || "0"} (${pnlSign}${trade.pnlPercent?.toFixed(2)}%)`;
  }

  if (sub === "history" || sub === "log") {
    return paperPortfolio.formatTradeHistory(10);
  }

  if (sub === "reset") {
    paperPortfolio.reset();
    return "🔄 ペーパーポートフォリオをリセットしました（初期資金: ¥1,000,000）";
  }

  // デフォルト: サマリー表示
  const summary = await paperPortfolio.getSummary();
  return paperPortfolio.formatSummary(summary) + "\n\n📋 **サブコマンド**\n" +
    "`/portfolio buy <銘柄> [数量]` — 買付\n" +
    "`/portfolio sell <銘柄> [数量]` — 売却\n" +
    "`/portfolio history` — 取引履歴\n" +
    "`/portfolio reset` — リセット";
});

registerCommand("invest", async (args) => {
  const sub = (args || "").trim().toLowerCase();

  if (!sub || sub === "help") {
    return "🎯 **投資学習メニュー** (高校生向け・ペーパー取引のみ)\n\n" +
      "📊 `/stock <銘柄>` — 株カード分析（テクニカル）\n" +
      "💼 `/portfolio` — ポートフォリオ管理\n" +
      "📚 `/invest learn` — 投資の基本を学ぶ\n\n" +
      "⚠️ *すべて仮想取引です。実金は一切動きません。*";
  }

  if (sub === "learn") {
    return "📚 **投資のキホン**\n\n" +
      "**1. 株って何？**\n会社の所有権を小分けにしたもの。株を買う＝会社の一部オーナーになる。\n\n" +
      "**2. どうやって儲かる？**\n• キャピタルゲイン: 安く買って高く売る\n• 配当: 会社の利益の一部をもらう\n\n" +
      "**3. リスク**\n• 株価は必ず変動する\n• 「絶対上がる」は存在しない\n• 失っても大丈夫な額だけ投資する\n\n" +
      "**4. 指標の見方**\n• トレンド: SMAで方向を見る\n• RSI: 70以上=買われすぎ、30以下=売られすぎ\n• 出来高: 多い=注目されてる\n\n" +
      "**5. 高校生ルール**\n• ✅ ペーパートレードで練習\n• ✅ 少額から始める（バイト代の一部）\n• ❌ 借金して投資しない\n• ❌ 「絶対儲かる」話は全部ウソ";
  }

  return "📋 不明なサブコマンド。`/invest help` で一覧表示。";
});

// ==================== v1.64: リサーチパイプライン（academic-research-skillsパターン） ====================

registerCommand("research", async (args) => {
  const { researchPipeline } = await import("./research-pipeline");
  const sub = (args || "").trim();

  if (!sub || sub === "help") {
    return "📝 **リサーチパイプライン** (5段階: 調査→執筆→レビュー→修正→最終化)\n\n" +
      "`/research start <トピック>` — 新しい研究を開始\n" +
      "`/research status` — 現在のタスク状態\n" +
      "`/research prompt` — 現在の段階のプロンプトを表示\n" +
      "例: `/research start AIエージェントの自律性について`";
  }

  if (sub.startsWith("start ")) {
    const topic = sub.slice(6);
    if (!topic) return "トピックを指定してください。\n例: `/research start AIエージェントの自律性について`";
    const task = researchPipeline.start(topic);
    const prompt = researchPipeline.getStagePrompt(task);
    return `✅ 研究を開始しました！\n\n**次の指示**:\n${prompt}`;
  }

  if (sub === "status" || sub === "list") {
    // シンプルに最新タスクの状態を返す
    return "📝 `/research start <トピック>` で研究を開始してください。";
  }

  return "📋 不明なサブコマンド。`/research help` で一覧表示。";
});

// ==================== v1.64: 一人企業メソッド（OPC methodologyパターン） ====================

registerCommand("biz", async (args) => {
  const sub = (args || "").trim().toLowerCase();

  if (!sub || sub === "help") {
    return "🚀 **一人企業メソッド** (OPC methodology + claude-code-best-practice)\n\n" +
      "`/biz principles` — 核心理論\n" +
      "`/biz checklist` — 副業開始チェックリスト\n" +
      "`/biz tools` — おすすめ無料ツール";
  }

  if (sub === "principles") {
    return "🚀 **一人企業の核心理論** (OPC methodology v2)\n\n" +
      "**1. スーパー個人になる**\n「会社の歯車」から「スーパー個人」へ。一人で複数の役割をAIでこなす。\n\n" +
      "**2. 小さく始めて速く回す**\n完璧を目指さない。MVP（最小限の製品）を1週間で出す。\n\n" +
      "**3. レバレッジを効かせる**\n• コード: 一度書けば何度でも動く\n• コンテンツ: 一度作れば何度でも見られる\n• AI: 一人を10人にする\n\n" +
      "**4. 収入の多様化**\n1つの収入源に依存しない。アフィリエイト+デジタル商品+自動化の組み合わせ。\n\n" +
      "**5. 自動化最優先**\n手作業は負け。AIエージェントに任せられることは全部任せる。";
  }

  if (sub === "checklist") {
    return "✅ **高校生向け副業チェックリスト**\n\n" +
      "**準備編**\n☐ 保護者の同意を得る（18歳未満は必須）\n☐ 銀行口座を確認（ネットバンキング対応か）\n☐ 作業時間を決める（週10時間以内推奨）\n\n" +
      "**スキル編**\n☐ AIツールの使い方を学ぶ（Claude/ChatGPT/Cursor）\n☐ 1つでいいから「得意」を作る（執筆/デザイン/コーディング）\n☐ 英語ができれば市場が100倍広がる\n\n" +
      "**実行編**\n☐ 最初の1円を稼ぐ（金額より「稼げた」という経験が大事）\n☐ SNSで発信を始める（X/note/YouTube）\n☐ ポートフォリオを作る（実績が信用になる）\n\n" +
      "⚠️ 「簡単に稼げる」は全部ウソ。時間と努力は必要。でもAIを使えば10倍速い。";
  }

  if (sub === "tools") {
    return "🛠️ **おすすめ無料ツール**\n\n" +
      "**AI**\n• Claude (claude.ai) — 文章作成・分析・コーディング\n• ChatGPT — アイデア出し・翻訳\n• Cursor — AIコーディング（学生無料）\n\n" +
      "**発信**\n• X (Twitter) — 情報発信の基本\n• note — 記事で収益化\n• GitHub — コードのポートフォリオ\n\n" +
      "**自動化**\n• Aikata (君のエージェント) — Discord/Telegram Bot\n• Make (make.com) — ノーコード自動化\n• GitHub Actions — 無料の定期実行";
  }

  return "📋 不明なサブコマンド。`/biz help` で一覧表示。";
});

// ==================== v1.62: 戦略セレクター（Evolverパターン） ====================

registerCommand("strategy", async (args) => {
  const { strategySelector } = await import("./strategy-selector");
  const sub = (args || "").trim().toLowerCase();

  if (sub === "stats" || sub === "status") {
    return strategySelector.formatStats();
  }

  if (sub === "force" || sub.startsWith("force ")) {
    const parts = sub.split(/\s+/);
    const preset = parts[1] as "speed" | "quality" | "balanced" | "cost-saving" | undefined;
    const validPresets = ["speed", "quality", "balanced", "cost-saving"];
    if (!preset || !validPresets.includes(preset)) {
      return `有効な戦略: ${validPresets.join(", ")}\n例: \`/strategy force speed\``;
    }
    const config = strategySelector.force(preset);
    return `✅ 戦略を強制設定: **${preset}**\n最大反復: ${config.maxIterations} | 思考: ${config.thinking ? "有効" : "無効"} | 並列: ${config.allowParallel ? "許可" : "禁止"} | 再試行: ${config.retries}回`;
  }

  if (sub.startsWith("test ") || sub.startsWith("select ")) {
    const task = sub.replace(/^(test|select)\s+/, "");
    if (!task) return "分析するタスク内容を指定してください。\n例: `/strategy test debug production error`";
    const match = strategySelector.select(task);
    return `🎯 **戦略分析**\nタスク: "${task.slice(0, 100)}"\n選択: **${match.config.preset}** (信頼度: ${match.confidence}%)\n理由: ${match.reason}\n\n設定: 最大${match.config.maxIterations}反復 | 思考${match.config.thinking ? "有効" : "無効"} | 並列${match.config.allowParallel ? "許可" : "禁止"} | 再試行${match.config.retries}回`;
  }

  // デフォルト: 利用可能な戦略一覧
  const presets = ["speed", "quality", "balanced", "cost-saving"] as const;
  const emojis: Record<string, string> = { speed: "⚡", quality: "💎", balanced: "⚖️", "cost-saving": "💰" };
  return "🎯 **戦略セレクター** (Evolverパターン)\n\n" +
    presets.map(p => {
      const c = strategySelector.force(p);
      return `${emojis[p]} **${p}**: 最大${c.maxIterations}反復 | 思考${c.thinking ? "○" : "×"} | 並列${c.allowParallel ? "○" : "×"} | 再試行${c.retries}回`;
    }).join("\n") +
    "\n\n`/strategy test <タスク>` — 最適戦略を分析\n`/strategy stats` — 統計\n`/strategy force <戦略>` — 強制設定";
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
  logger.info(" Aikata v1.34 起動中…");
  logger.info(" NEW REPOS: agent-plugins / prompt-budget / worktree / feedback-scoring / backend-factory");
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

  // v1.38: メモリパイプライン初期化（agentmemory由来）
  try {
    const { initMemoryPipeline, observeMemory } = await import("./memory");
    initMemoryPipeline();
    logger.info("[Memory] 4-Tierメモリパイプライン初期化: ハイブリッド検索(BM25+Vector+Graph+RRF)");
  } catch (err) {
    logger.warn("[Startup] メモリパイプライン初期化に失敗:", err);
  }

  logger.info(" /redirect /meet-agent /runtime /whatsapp /shell");
  logger.info(` ツール数: ${toolRegistry.list().length} | モジュール数: 99+`);

  // v1.43: 統合モジュール初期化
  try {
    // MCTSエンジン（Scenario Lab）
    const { MCTSEngine } = await import("./mcts-decision");
    logger.info("[MCTS] Monte Carlo Tree Search エンジン使用可能");
  } catch (err) {
    logger.debug("[Startup] MCTSスキップ");
  }
  try {
    // 累積コストキャッシュ（claude-pulse）
    const { cumulativeCost } = await import("./cumulative-cost");
    logger.info(`[CostCache] ${cumulativeCost.formatSummary().split("\\n")[0]}`);
  } catch (err) {
    logger.debug("[Startup] CostCacheスキップ");
  }

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
