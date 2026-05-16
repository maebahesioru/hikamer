// ==========================================
// Aikata - Telegram Bot (v1.1)
// ==========================================

import { Bot } from "grammy";
import { agentLoop } from "./agent";
import { SYSTEM_PROMPT } from "./system-prompt";
import { resetConversation, listCronJobs } from "./repo";
import { logger } from "./utils/logger";
import {
  getProviders, addProvider, removeProvider, getActiveConfig,
  setActiveProvider, setActiveModel, getRuntimeConfig, setMaxIterations,
} from "./utils/config";
import { createActiveProvider, fetchModels } from "./providers/base";
import type { LLMProvider } from "./types";

let _provider: LLMProvider | null = null;

function getProvider(): LLMProvider {
  if (!_provider) _provider = createActiveProvider();
  return _provider;
}

function reloadProvider(): LLMProvider {
  _provider = createActiveProvider();
  return _provider;
}

const processing = new Set<string>();

export async function startTelegramBot(
  token: string,
  onReady?: () => void
): Promise<Bot> {
  const bot = new Bot(token);

  bot.catch((err) => {
    logger.error(`Telegram エラー: ${err.message}`);
  });

  // === コマンド ===

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Aikata v1.1 起動！\n" +
      "/provider /model /models /maxiter /info で設定\n" +
      "/addprovider /delprovider でプロバイダ管理\n" +
      "/reset /jobs"
    );
  });

  bot.command("reset", async (ctx) => {
    resetConversation(`tg-${ctx.chat.id}`);
    await ctx.reply("会話履歴をリセット。");
  });

  bot.command("jobs", async (ctx) => {
    const jobs = listCronJobs(`tg-${ctx.chat.id}`) as any[];
    if (jobs.length === 0) {
      await ctx.reply("スケジュールなし。");
    } else {
      const lines = jobs.map((j: any) =>
        `• ${j.label || j.id}: \`${j.cron_expr}\` → "${j.prompt.slice(0, 60)}" [${j.enabled ? "有効" : "無効"}]`
      );
      await ctx.reply(`📋 ${jobs.length}件:\n${lines.join("\n")}`);
    }
  });

  bot.command("info", async (ctx) => {
    const active = getActiveConfig();
    const runtime = getRuntimeConfig();
    await ctx.reply(
      `プロバイダー: ${active.provider}\nモデル: ${active.model}\n最大反復: ${runtime.maxIterations}`
    );
  });

  bot.command("provider", async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) { await ctx.reply("使い方: /provider <名前>"); return; }
    try {
      setActiveProvider(arg);
      reloadProvider();
      await ctx.reply(`プロバイダーを **${arg}** に切替。`);
    } catch (e: any) { await ctx.reply(`エラー: ${e.message}`); }
  });

  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) { await ctx.reply("使い方: /model <モデル名>"); return; }
    setActiveModel(arg);
    reloadProvider();
    await ctx.reply(`モデルを **${arg}** に切替。`);
  });

  bot.command("models", async (ctx) => {
    const active = getActiveConfig();
    try {
      const models = await fetchModels(active.provider);
      await ctx.reply(`**${active.provider}** (${models.length}件):\n${models.slice(0, 20).join("\n")}`);
    } catch (e: any) { await ctx.reply(`取得失敗: ${e.message}`); }
  });

  bot.command("providers", async (ctx) => {
    const providers = getProviders();
    const active = getActiveConfig();
    const list = Object.entries(providers.providers).map(([k, v]) =>
      `${k === active.provider ? "▶ " : "  "}${k} → ${v.baseUrl}`
    ).join("\n");
    await ctx.reply(`プロバイダー:\n${list || "(登録なし)"}`);
  });

  bot.command("addprovider", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/) || [];
    if (parts.length < 3) { await ctx.reply("使い方: /addprovider <key> <baseUrl> <apiKey>"); return; }
    const [key, baseUrl, apiKey] = parts;
    addProvider(key!, { name: key!, baseUrl: baseUrl!, apiKey: apiKey! });
    await ctx.reply(`プロバイダー **${key}** を追加。`);
  });

  bot.command("delprovider", async (ctx) => {
    const key = ctx.match?.trim();
    if (!key) { await ctx.reply("使い方: /delprovider <key>"); return; }
    const ok = removeProvider(key);
    await ctx.reply(ok ? `**${key}** を削除。` : `**${key}** は存在しない。`);
  });

  bot.command("maxiter", async (ctx) => {
    const n = parseInt(ctx.match?.trim() || "");
    if (!n || n < 1 || n > 1000) { await ctx.reply("使い方: /maxiter <1〜1000>"); return; }
    setMaxIterations(n);
    await ctx.reply(`最大反復 → ${n}`);
  });

  // === メッセージ ===

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const cid = `tg-${chatId}`;

    if (processing.has(cid)) {
      await ctx.reply("ちょっと待ってくれ。");
      return;
    }

    processing.add(cid);
    const thinking = await ctx.reply("考え中…");

    try {
      const result = await agentLoop(getProvider(), SYSTEM_PROMPT, ctx.message.text, cid, "telegram");

      if (result.response.length <= 4000) {
        await ctx.api.editMessageText(chatId, thinking.message_id, result.response);
      } else {
        await ctx.api.deleteMessage(chatId, thinking.message_id);
        for (const chunk of splitMessage(result.response, 4000)) {
          await ctx.reply(chunk);
        }
      }
      logger.info(`TG応答: ${cid} (${result.iterations}反復)`);
    } catch (e: any) {
      logger.error(`TGエラー: ${e.message}`);
      await ctx.api.editMessageText(chatId, thinking.message_id, `エラー: ${e.message.slice(0, 3500)}`).catch(() => {});
    } finally {
      processing.delete(cid);
    }
  });

  bot.start({
    onStart: () => {
      logger.info(`Telegram ログイン: @${bot.botInfo.username}`);
      onReady?.();
    },
  });

  return bot;
}

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
