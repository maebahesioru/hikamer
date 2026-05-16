// ==========================================
// Aikata - Discord Bot (スレッド + スラッシュコマンド)
// ==========================================

import { Client, Events, GatewayIntentBits, ChannelType, SlashCommandBuilder, REST, Routes } from "discord.js";
import { agentLoop } from "./agent";
import { SYSTEM_PROMPT } from "./system-prompt";
import { resetConversation, updateConversationTitle, getConversationThreadId } from "./repo";
import { logger } from "./utils/logger";
import {
  getProviders, addProvider, removeProvider,
  setActiveProvider, setActiveModelOnly, getActiveModel,
  getRuntimeConfig, setMaxIterations,
  type ProviderType,
} from "./utils/config";
import { createActiveProvider, fetchModels } from "./providers/base";
import type { LLMProvider } from "./types";

let provider = createActiveProvider();
const processing = new Set<string>();
let discordClient: Client | null = null;

export function getDiscordClient(): Client | null {
  return discordClient;
}

export async function startDiscord(token: string): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  discordClient = client;

  // ==================== スラッシュコマンド登録 ====================

  const commands = [
    new SlashCommandBuilder().setName("reset").setDescription("会話履歴をリセット"),
    new SlashCommandBuilder().setName("maxiter").setDescription("最大反復回数を設定")
      .addIntegerOption(o => o.setName("回数").setDescription("1〜1000").setRequired(true)),
    new SlashCommandBuilder().setName("provider").setDescription("プロバイダー管理")
      .addSubcommand(s => s.setName("list").setDescription("一覧表示"))
      .addSubcommand(s => s.setName("set").setDescription("使用プロバイダー切替")
        .addStringOption(o => o.setName("名前").setDescription("プロバイダー名").setRequired(true)))
      .addSubcommand(s => s.setName("add").setDescription("新規追加")
        .addStringOption(o => o.setName("key").setDescription("キー名").setRequired(true))
        .addStringOption(o => o.setName("type").setDescription("API形式").setRequired(true)
          .addChoices({name:"OpenAI",value:"openai"},{name:"Anthropic",value:"anthropic"},{name:"Gemini",value:"gemini"}))
        .addStringOption(o => o.setName("baseurl").setDescription("APIベースURL").setRequired(true))
        )
      .addSubcommand(s => s.setName("del").setDescription("削除")
        .addStringOption(o => o.setName("key").setDescription("プロバイダーキー").setRequired(true))),
    new SlashCommandBuilder().setName("model").setDescription("モデル切替")
      .addStringOption(o => o.setName("名前").setDescription("モデル名").setRequired(true)),
    new SlashCommandBuilder().setName("models").setDescription("利用可能なモデル一覧"),
    new SlashCommandBuilder().setName("info").setDescription("現在の設定を表示"),
  ];

  const rest = new REST({ version: "10" }).setToken(token);

  client.once(Events.ClientReady, async () => {
    logger.info(`Discord ログイン: ${client.user?.tag}`);
    try {
      await rest.put(Routes.applicationCommands(client.user!.id), {
        body: commands.map(c => c.toJSON()),
      });
      logger.info("スラッシュコマンド登録完了");
    } catch (e: any) {
      logger.warn(`スラッシュコマンド登録失敗: ${e.message}`);
    }
  });

  // ==================== スラッシュコマンド処理 ====================

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "reset": {
          const cid = interaction.channelId;
          resetConversation(cid);
          await interaction.reply("会話履歴をリセットしたぜ。");
          break;
        }
        case "maxiter": {
          const n = interaction.options.getInteger("回数", true);
          setMaxIterations(n);
          await interaction.reply(`最大反復回数を ${n} に設定した。`);
          break;
        }
        case "provider": {
          const sub = interaction.options.getSubcommand();
          switch (sub) {
            case "list": {
              const providers = getProviders();
              const active = getActiveModel();
              const list = Object.entries(providers.providers).map(([k, v]) =>
                `${k === active.provider ? "▶ " : "   "}**${k}** (${v.type}) → ${v.baseUrl}`
              ).join("\n");
              await interaction.reply(`プロバイダー一覧:\n${list || "(登録なし)"}`);
              break;
            }
            case "set": {
              const name = interaction.options.getString("名前", true);
              setActiveProvider(name);
              provider = createActiveProvider();
              await interaction.reply(`プロバイダーを **${name}** に切替。`);
              break;
            }
            case "add": {
              const key = interaction.options.getString("key", true);
              const type = interaction.options.getString("type", true) as ProviderType;
              const baseUrl = interaction.options.getString("baseurl", true);
              const apiKey = interaction.options.getString("apikey", true);
              addProvider(key, { name: key, type, baseUrl });
              await interaction.reply(`**${key}** (${type}) を追加。\n\`/provider set ${key}\` で切替可能。`);
              break;
            }
            case "del": {
              const key = interaction.options.getString("key", true);
              const ok = removeProvider(key);
              await interaction.reply(ok ? `**${key}** を削除。` : `**${key}** は存在しません。`);
              break;
            }
          }
          break;
        }
        case "model": {
          const name = interaction.options.getString("名前", true);
          setActiveModelOnly(name);
          provider = createActiveProvider();
          await interaction.reply(`モデルを **${name}** に切替えた。`);
          break;
        }
        case "models": {
          await interaction.deferReply();
          try {
            const active = getActiveModel();
            const models = await fetchModels(active.provider);
            const list = models.slice(0, 30).join("\n");
            await interaction.editReply(`**${active.provider}** のモデル一覧 (${models.length}件):\n${list}${models.length > 30 ? `\n…他 ${models.length - 30} 件` : ""}`);
          } catch (e: any) {
            await interaction.editReply(`モデル取得失敗: ${e.message}`);
          }
          break;
        }
        case "providers": {
          const providers = getProviders();
          const active = getActiveModel();
          const list = Object.entries(providers.providers).map(([k, v]) =>
            `${k === active.provider ? "▶ " : "   "}**${k}** → ${v.baseUrl}`
          ).join("\n");
          await interaction.reply(`プロバイダー一覧:\n${list || "(登録なし)"}`);
          break;
        }
        case "info": {
          const active = getActiveModel();
          const runtime = getRuntimeConfig();
          await interaction.reply(
            `**Aikata 設定**\n` +
            `プロバイダー: ${active.provider}\n` +
            `モデル: ${active.model}\n` +
            `最大反復: ${runtime.maxIterations}\n` +
            `SearXNG: ${process.env.SEARXNG_URL || "http://localhost:18080"}`
          );
          break;
        }
      }
    } catch (e: any) {
      logger.error(`コマンドエラー: ${e.message}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`エラー: ${e.message}`).catch(() => {});
      } else {
        await interaction.reply(`エラー: ${e.message}`).catch(() => {});
      }
    }
  });

  // ==================== メッセージ処理（スレッド対応） ====================

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const botMentioned = message.mentions.has(client.user!.id);
    const isDM = !message.guildId;
    const isThread = message.channel.isThread();

    if (!botMentioned && !isDM && !isThread) return;

    // スレッド内またはDMでは常に反応。サーバーチャンネルではメンション必須
    const cid = isDM ? `dm-${message.author.id}` : message.channelId;

    if (processing.has(cid)) {
      await message.reply("ちょっと待ってくれ、今別の処理中だ。").catch(() => {});
      return;
    }

    const cleanContent = message.content.replace(/<@\d+>/g, "").trim();
    if (!cleanContent && !isThread && !isDM) return;

    processing.add(cid);

    // サーバーチャンネルでメンション → スレッド作成
    let replyTarget = message;
    let threadId: string | null = null;

    if (!isDM && !isThread && botMentioned) {
      try {
        const title = cleanContent.slice(0, 80) || "Aikata 会話";
        const thread = await message.startThread({
          name: title,
          autoArchiveDuration: 60,
        });
        threadId = thread.id;
        replyTarget = await thread.send("了解！このスレッドで続けよう。");
        // 会話IDをスレッドIDに更新
        updateConversationTitle(cid, title);
        logger.info(`スレッド作成: ${thread.id} "${title}"`);
      } catch (e: any) {
        logger.warn(`スレッド作成失敗: ${e.message}`);
      }
    }

    const thinking = await replyTarget.reply("考え中…").catch(() => null);

    try {
      const result = await agentLoop(
        provider,
        SYSTEM_PROMPT,
        cleanContent || "こんにちは",
        threadId || cid,
        "discord"
      );

      // AIによるスレッドタイトル生成（最初の応答時）
      if (threadId && result.response) {
        const title = result.response.slice(0, 80).replace(/\n/g, " ").trim();
        try {
          const channel = message.channel;
          if ("threads" in channel) {
            const thread = await (channel as any).threads.fetch(threadId);
            await thread.setName(title.slice(0, 80));
          }
          updateConversationTitle(threadId || cid, title);
        } catch {}
      }

      const response = result.response;
      if (response.length <= 2000) {
        if (thinking) await thinking.edit(response).catch(() => {});
        else await message.reply(response).catch(() => {});
      } else {
        if (thinking) await thinking.delete().catch(() => {});
        const chunks = splitMessage(response, 1900);
        for (const chunk of chunks) {
          await replyTarget.reply(chunk).catch(() => {});
        }
      }

      logger.info(`Discord応答: ${cid} (${result.iterations}反復)`);
    } catch (e: any) {
      logger.error(`Discordエラー: ${e.message}`);
      const errMsg = `すまん、エラーが起きた: ${e.message.slice(0, 1800)}`;
      if (thinking) await thinking.edit(errMsg).catch(() => {});
      else await message.reply(errMsg).catch(() => {});
    } finally {
      processing.delete(cid);
    }
  });

  await client.login(token);
  return client;
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
