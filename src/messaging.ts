// ==========================================
// Aikata - Messaging (Discord + Telegram)
// ==========================================

import { Client, Events, GatewayIntentBits, ChannelType, SlashCommandBuilder, REST, Routes } from "discord.js";
import { Bot } from "grammy";
import { agentLoop, type AgentOptions } from "./agent";
import { SYSTEM_PROMPT } from "./system-prompt";
import { resetConversation, updateConversationTitle, getConversationThreadId, listCronJobs } from "./repo";
import { logger } from "./utils/logger";
import {
  getProviders, addProvider, removeProvider,
  setActiveProvider, setActiveModelOnly, getActiveModel,
  getRuntimeConfig, setMaxIterations,
  type ProviderType,
} from "./utils/config";
import { createActiveProvider, fetchModels, setOnRetry } from "./providers/base";
import type { LLMProvider, LLMChunk } from "./types";
import { toolRegistry } from "./tools/registry";

// ==================== 共通: プロバイダー管理 ====================
let provider = createActiveProvider();

function reloadProvider() {
  provider = createActiveProvider();
}

const processing = new Set<string>();

// ==================== 共通: メッセージ分割 ====================
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

// ==================== 共通: ツール表示 ====================
function formatTool(toolName: string, args: Record<string, unknown>): string {
  // レジストリから絵文字+表示名を動的に取得
  const desc = toolRegistry.getDescriptor(toolName);
  const emoji = desc?.emoji || "🔧";
  const label = toolName;

  switch (toolName) {
    case "terminal": {
      const c = String(args.command || "?");
      return `${emoji} ${label}: ${c.length > 70 ? c.slice(0, 70) + "…" : c}`;
    }
    case "web_search": {
      return `${emoji} Web検索: ${(args.query as string)?.slice(0, 80) || "?"}`;
    }
    case "code_execute": {
      const c = String(args.code || "?");
      return `${emoji} コード実行: ${c.length > 60 ? c.slice(0, 60) + "…" : c}`;
    }
    case "browser": {
      const action = String(args.action || "?");
      switch (action) {
        case "navigate": return `${emoji} ブラウザ: ${(args.url as string)?.slice(0, 60) || "?"}`;
        case "click": return `🖱️ ブラウザクリック: ${(args.selector as string)?.slice(0, 40) || "?"}`;
        case "type": return `⌨️ ブラウザ入力: "${(args.text as string)?.slice(0, 30) || "?"}" → ${(args.selector as string)?.slice(0, 30) || "?"}`;
        case "extract": return `📄 ブラウザ抽出`;
        case "screenshot": return `📸 ブラウザスクリーンショット`;
        default: return `${emoji} ブラウザ: ${action}`;
      }
    }
    default: {
      // fallback: ツール名の先頭action引数があれば表示
      const action = args.action ? ` (${String(args.action)})` : "";
      return `${emoji} ${toolName}${action}`;
    }
  }
}

// ==================== Discord クライアント参照 ====================
let discordClient: Client | null = null;

export function getDiscordClient(): Client | null {
  return discordClient;
}

// ==================== Discord ストリーミング設定 ====================
let streamEnabled = true;

// ==================== Discord スレッドタイトル生成 ====================
async function generateThreadTitle(response: string): Promise<string> {
  try {
    const titleProvider = createActiveProvider();
    const result = await titleProvider.chat(
      [{ role: "user", content: `以下の会話の内容を80文字以内のスレッドタイトルに要約して。タイトルだけを返して。\n\n${response.slice(0, 1500)}` }],
      [],
    );
    const title = (result.content || "Aikata 会話").replace(/\n/g, " ").trim().slice(0, 80);
    return title || "Aikata 会話";
  } catch {
    return response.replace(/\n/g, " ").trim().slice(0, 80) || "Aikata 会話";
  }
}

// ==================== Discord ヘルパー ====================

async function updateStatusMessage(
  msg: any,
  reasoning: string,
  content: string,
  activeTools: string[],
  finishReason: string | null,
): Promise<void> {
  const done = !!finishReason;
  const cursor = done ? "" : " ▉";
  let display = "";

  // ツール実行表示
  if (activeTools.length > 0) {
    display += done
      ? `🔧 **使用ツール:** ${activeTools.join(", ")}\n`
      : `🔧 **ツール実行中:** ${activeTools.join(", ")}\n`;
  }

  if (reasoning) {
    display += done
      ? `🔍 **思考過程:**\n\`\`\`\n${reasoning.slice(-1200)}\n\`\`\``
      : `🧠 **思考中…**\n\`\`\`\n${reasoning.slice(-1000)}\n\`\`\``;
    if (content) {
      display += `\n\n📝 **回答:**\n${content.slice(-1500)}${cursor}`;
    } else {
      display += cursor;
    }
  } else if (content) {
    display += done
      ? `${content.slice(-1900)}`
      : `📝 **回答中…**\n${content.slice(-1800)}${cursor}`;
  } else if (!display) {
    display = `🧠 思考中…${cursor}`;
  } else {
    display += cursor;
  }

  if (display.length > 1950) display = display.slice(0, 1950) + "…";

  try {
    if (msg.content !== display) {
      await msg.edit(display);
    }
  } catch {
    // 編集失敗は無視
  }
}

/** statusMsgを編集。失敗したら同チャンネルに新規送信（1メッセージのみ保証） */
async function replaceMessage(statusMsg: any, content: string): Promise<void> {
  if (!statusMsg) return;
  const chunks = splitMessage(content, 1950);
  try {
    await statusMsg.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      if (statusMsg.channel && "send" in statusMsg.channel) {
        await (statusMsg.channel as any).send(chunks[i]);
      }
    }
  } catch {
    try { await statusMsg.delete(); } catch {}
    for (const chunk of chunks) {
      if (statusMsg.channel && "send" in statusMsg.channel) {
        await (statusMsg.channel as any).send(chunk).catch(() => {});
      }
    }
  }
}

/** スレッド/DMに初期メッセージを送信 */
async function sendInitialMessage(
  threadId: string | null,
  message: any,
  isThread: boolean,
  isDM: boolean,
): Promise<any> {
  try {
    if (threadId) {
      // 作成したスレッドに送信
      const guild = message.guild;
      if (guild) {
        const channel = await guild.channels.fetch(threadId).catch(() => null);
        if (channel && "send" in channel) {
          return await (channel as any).send("…");
        }
      }
    }
    // スレッド内/DMの場合のみ返信。チャンネルには絶対に送らない
    if (isThread || isDM) {
      return await message.reply("…").catch(() => null);
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== Discord Bot 起動 ====================
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
    new SlashCommandBuilder().setName("ping").setDescription("Botの生存確認"),
    new SlashCommandBuilder().setName("stream").setDescription("ストリーミング出力のON/OFF切替")
      .addStringOption(o => o.setName("状態").setDescription("on/off").setRequired(true)
        .addChoices({name:"on",value:"on"},{name:"off",value:"off"})),
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
          resetConversation(interaction.channelId);
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
              reloadProvider();
              await interaction.reply(`プロバイダーを **${name}** に切替。`);
              break;
            }
            case "add": {
              const key = interaction.options.getString("key", true);
              const type = interaction.options.getString("type", true) as ProviderType;
              const baseUrl = interaction.options.getString("baseurl", true);
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
          reloadProvider();
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
            `ストリーミング: ${streamEnabled ? "ON" : "OFF"}\n` +
            `SearXNG: ${process.env.SEARXNG_URL || "http://localhost:18080"}`
          );
          break;
        }
        case "ping": {
          const uptime = Math.floor(process.uptime());
          const mem = process.memoryUsage();
          await interaction.reply(
            `🏓 Pong!\n` +
            `稼働時間: ${Math.floor(uptime / 60)}分${uptime % 60}秒\n` +
            `メモリ: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB\n` +
            `PID: ${process.pid}`
          );
          break;
        }
        case "stream": {
          const state = interaction.options.getString("状態", true);
          streamEnabled = state === "on";
          await interaction.reply(`ストリーミング出力: **${streamEnabled ? "ON" : "OFF"}**`);
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

  // ==================== メッセージ処理 ====================
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const botMentioned = message.mentions.has(client.user!.id);
    const isDM = !message.guildId;
    const isThread = message.channel.isThread();

    if (!botMentioned && !isDM && !isThread) return;

    let cid: string;
    let lockKey: string;

    if (isThread) {
      cid = message.channelId;
      lockKey = message.channelId; // スレッド単位でロック→並列タイトル変更バグ防止
    } else if (isDM) {
      cid = 'dm-' + message.author.id;
      lockKey = cid;
    } else {
      cid = message.channelId;
      lockKey = cid;
    }

    if (processing.has(lockKey)) return;

    const cleanContent = message.content.replace(/<@\d+>/g, "").trim();
    if (!cleanContent && !isThread && !isDM) return;

    processing.add(lockKey);

    // ========== スレッド作成 ==========
    let threadId: string | null = null;

    if (!isDM && !isThread && botMentioned) {
      // 既存スレッドを検出 → それを使う。なければ新規作成
      if (message.thread) {
        threadId = message.thread.id;
        logger.info(`既存スレッドに参加: ${threadId}`);
      } else {
        let threadCreated = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const title = cleanContent.slice(0, 80) || "Aikata 会話";
            const thread = await message.startThread({
              name: title,
              autoArchiveDuration: 60,
            });
            threadId = thread.id;
            threadCreated = true;
            logger.info(`スレッド作成: ${thread.id} "${title}"`);
            break;
          } catch (e: any) {
            // "already has a thread" → 再fetchでthreadプロパティが更新されるか試す
            if (e.message?.includes("already has a thread")) {
              try {
                const refreshed = await message.fetch(true);
                if (refreshed.thread) {
                  threadId = refreshed.thread.id;
                  threadCreated = true;
                  logger.info(`既存スレッド(再取得): ${threadId}`);
                  break;
                }
              } catch {}
            }
            if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
          }
        }
        
        if (!threadCreated) {
          // 完全沈黙。チャンネルには絶対に送らない
          logger.warn(`スレッド作成不能 → 完全沈黙`);
          processing.delete(lockKey);
          return;
        }
      }

      // スレッド作成成功 → ロックをチャンネルID→スレッドIDに切替
      if (threadId && threadId !== lockKey) {
        processing.delete(lockKey);
        lockKey = threadId;
        processing.add(lockKey);
      }
    } else if (isThread || isDM) {
      // スレッド内/DMでは遅延送信（statusMsgはstreamingか応答完了時に設定）
    }

    // ========== エージェント実行 ==========
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      const noEmbed = { allowedMentions: { parse: [] as any }, flags: 4 };

      // スレッドチャンネル解決
      async function getThreadChannel(): Promise<any> {
        if (!threadId) return null;
        return message.guild?.channels.fetch(threadId).catch(() => null) ?? null;
      }

      async function sendInThread(text: string): Promise<any> {
        if (!text) return null;
        const target = await getThreadChannel();
        // スレッドがあればスレッドに送信
        if (target && "send" in target) return (target as any).send({ content: text.slice(0, 1950), ...noEmbed });
        // DM/スレッド内なら元チャンネルに送信
        if (isThread || isDM) return message.channel.send({ content: text.slice(0, 1950), ...noEmbed }).catch(() => null);
        // 最後の手段：エラー時だけ元チャンネルに送信（失敗なら諦める）
        return message.channel.send({ content: text.slice(0, 1950), ...noEmbed }).catch(() => null);
      }

      // スレッド内では返信形式不可（クロスチャンネルNG）→ sendInThreadに一本化
      async function sendReplyInThread(text: string): Promise<any> {
        return sendInThread(text);
      }

      // 入力中表示（10秒で切れるので定期更新）
      // スレッド/チャンネル両対応：threadChan があればスレッドに、なければ元チャンネルに送信
      const threadChan = await getThreadChannel();
      const typingTarget = threadChan || message.channel;
      typingTarget.sendTyping().catch(() => {});
      typingInterval = setInterval(() => typingTarget.sendTyping().catch(() => {}), 8000);
      message.react("👀").catch(() => {});

      let preMsg: any = null;
      let postMsg: any = null;
      let answerMsg: any = null;
      let preCreating = false;
      let postCreating = false;
      let answerCreating = false;
      let preReasoning = "";
      let postReasoning = "";
      let preFlushed = false;
      let isPostTool = false;
      let curLen = 0;
      let lastEdit = 0;

      const options: AgentOptions = {
        streaming: streamEnabled,
        onChunk: streamEnabled ? async (chunk: LLMChunk, acc: { reasoning: string; content: string }) => {
          const now = Date.now();

          // 推論(reasoning)から回答(content)への遷移を検出
          // DeepSeek V4系: reasoningが単調増加→止まる→content開始 のタイミングで切替
          // 非reasoningモデル: contentが最初から流れるので即座に遷移
          if (!isPostTool && acc.content.length > 0) {
            if (!preFlushed && preReasoning) {
              preFlushed = true;
              const text = `🔍 **思考過程:**\n\`\`\`\n${preReasoning.slice(-1800)}\n\`\`\``;
              if (preMsg) await preMsg.edit(text).catch(() => {});
              else await sendInThread(text);
            }
            isPostTool = true;
            postReasoning = acc.reasoning; // 遷移時点のreasoningを保存→重複表示防止
            lastEdit = 0; // スロットルリセット→回答ストリーミングを即座に開始
          }
          curLen = acc.reasoning.length;

          // 事前思考ストリーミング（最初から 🔍 思考過程: 表示）
          if (!isPostTool && !preFlushed) {
            preReasoning = acc.reasoning;
            if (now - lastEdit > 500 && preReasoning) {
              lastEdit = now;
              const text = `🔍 **思考過程:**\n\`\`\`\n${preReasoning.slice(-1700)} ▉\n\`\`\``;
              if (!preMsg && !preCreating) {
                preCreating = true;
                preMsg = await sendInThread(text);
                preCreating = false;
              } else if (preMsg) {
                await preMsg.edit(text).catch(() => {});
              }
            }
          }

          // ツール後：新規reasoning発生時は思考過程を表示、回答は常時ストリーミング
          if (isPostTool) {
            // 思考過程（新規reasoning発生時のみ→重複防止）
            if (acc.reasoning.length > postReasoning.length) {
              postReasoning = acc.reasoning;
              if (now - lastEdit > 500 && postReasoning) {
                lastEdit = now;
                const text = `🔍 **思考過程:**\n\`\`\`\n${postReasoning.slice(-1700)} ▉\n\`\`\``;
                if (!postMsg && !postCreating) {
                  postCreating = true;
                  postMsg = await sendReplyInThread(text);
                  postCreating = false;
                } else if (postMsg) {
                  await postMsg.edit(text).catch(() => {});
                }
              }
            }
            // 回答ストリーミング（最終出力・常時）
            if (acc.content && now - lastEdit > 500) {
              lastEdit = now;
              // 初回は先頭から、以降は常に最新末尾を表示
              const text = !answerMsg
                ? `${acc.content.slice(0, 1900)} ▉`
                : `${acc.content.slice(-1900)} ▉`;
              if (!answerMsg && !answerCreating) {
                answerCreating = true;
                answerMsg = await sendReplyInThread(text);
                answerCreating = false;
              } else if (answerMsg) {
                await answerMsg.edit(text).catch(() => {});
              }
            }
          }

          // ツール呼び出し → 事前思考を確定（カーソル消す）
          if (!preFlushed && chunk.tool_calls && preReasoning) {
            preFlushed = true;
            const text = `🔍 **思考過程:**\n\`\`\`\n${preReasoning.slice(-1800)}\n\`\`\``;
            if (preMsg) await preMsg.edit(text).catch(() => {});
            else await sendInThread(text);
          }
        } : undefined,

        onToolStart: async (toolName, args) => {
          sendInThread(formatTool(toolName, args)).catch(() => {});
        },
        onToolEnd: undefined,
      };

      // リトライ通知をスレッドに表示
      setOnRetry((msg) => { sendInThread(msg).catch(() => {}); });

      const result = await agentLoop(
        provider, SYSTEM_PROMPT, cleanContent || "こんにちは",
        threadId || cid, "discord", options,
      );

      setOnRetry(null); // クリア（次の呼び出しでリセット）

      // ========== 最終確定 ==========
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

      if (!preFlushed && preReasoning) {
        preFlushed = true;
        const text = `🔍 **思考過程:**\n\`\`\`\n${preReasoning.slice(-1800)}\n\`\`\``;
        if (preMsg) await preMsg.edit(text).catch(() => {});
        else await sendInThread(text);
      }

      if (postMsg && postReasoning && postReasoning.length > 10) {
        await postMsg.edit(`🔍 **思考過程:**\n\`\`\`\n${postReasoning.slice(0, 1900)}\n\`\`\``).catch(() => {});
      } else if (!postMsg && postReasoning && postReasoning.length > 10) {
        await sendReplyInThread(`🔍 **思考過程:**\n\`\`\`\n${postReasoning.slice(0, 1900)}\n\`\`\``);
      }

      // 回答確定 or エラー送信
      if (result.response.startsWith("[致命的エラー]")) {
        // エラー時は❌リアクション + エラーメッセージをスレッドに送信
        message.react("❌").catch(() => {});
        await sendReplyInThread(`💀 **エラー:**\n${result.response.slice(9, 1900)}`);
      } else if (answerMsg && result.response) {
        await answerMsg.edit(result.response.slice(0, 1950)).catch(() => {});
      } else if (result.response) {
        await sendReplyInThread(result.response.slice(0, 1950));
      }

      // 完了リアクション
      message.reactions.removeAll().catch(() => {});
      message.react("✅").catch(() => {});

      // スレッドタイトル生成（AIが成功応答を返した場合のみ）
      if (threadId && !result.response.startsWith("[致命的エラー]")) {
        try {
          const title = await generateThreadTitle(result.response);
          const channel = message.channel;
          if ("threads" in channel) {
            const thread = await (channel as any).threads.fetch(threadId);
            await thread.setName(title);
          }
          updateConversationTitle(threadId, title);
        } catch {}
      }

      logger.info(`Discord応答: ${threadId || cid} (${result.iterations}反復)`);
    } catch (e: any) {
      setOnRetry(null);
      logger.error(`Discordエラー: ${e.message}`);
      const errMsg = `💀 エラー: ${e.message.slice(0, 1800)}`;
      try { sendInThread(errMsg).catch(() => {}); } catch {}
    } finally {
      setOnRetry(null);
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(lockKey);
    }
  });

  await client.login(token);
  return client;
}

// ==================== Telegram Bot 起動 ====================

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
    const active = getActiveModel();
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
    setActiveModelOnly(arg);
    reloadProvider();
    await ctx.reply(`モデルを **${arg}** に切替。`);
  });

  bot.command("models", async (ctx) => {
    const active = getActiveModel();
    try {
      const models = await fetchModels(active.provider);
      await ctx.reply(`**${active.provider}** (${models.length}件):\n${models.slice(0, 20).join("\n")}`);
    } catch (e: any) { await ctx.reply(`取得失敗: ${e.message}`); }
  });

  bot.command("providers", async (ctx) => {
    const providers = getProviders();
    const active = getActiveModel();
    const list = Object.entries(providers.providers).map(([k, v]) =>
      `${k === active.provider ? "▶ " : "  "}${k} → ${v.baseUrl}`
    ).join("\n");
    await ctx.reply(`プロバイダー:\n${list || "(登録なし)"}`);
  });

  bot.command("addprovider", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/) || [];
    if (parts.length < 3) { await ctx.reply("使い方: /addprovider <key> <type> <baseUrl>"); return; }
    const [key, type, baseUrl] = parts;
    addProvider(key!, { name: key!, type: (type as any), baseUrl: baseUrl! });
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
      const result = await agentLoop(provider, SYSTEM_PROMPT, ctx.message.text, cid, "telegram");

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
