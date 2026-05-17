// ==========================================
// Aikata - Discord管理ツール（Hermes Agent由来）
// サーバー情報/メンバー一覧/チャンネル管理/スレッド作成
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";

// ==================== 内部 ====================

async function getDiscordClient(): Promise<any> {
  const { getDiscordClient: getClient } = await import("../messaging");
  const client = getClient();
  if (!client) throw new Error("Discordクライアント未接続");
  return client;
}

function chunkOutput(text: string, maxLen = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut === -1 || cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ==================== ツール: discord (コア) ====================

const discordCoreTool: ToolDescriptor = {
  name: "discord",
  emoji: "💬",
  owner: "core",
  description: "Discordサーバー情報を取得します。サーバー情報/チャンネル一覧/メンバー検索/スレッド作成。",
  availability: { requiresEnv: ["DISCORD_TOKEN"] },
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["server_info", "list_channels", "search_members", "member_info", "create_thread"],
        description: "実行するアクション",
      },
      guild_id: { type: "string", description: "サーバーID" },
      channel_id: { type: "string", description: "チャンネルID" },
      user_id: { type: "string", description: "ユーザーID" },
      query: { type: "string", description: "メンバー検索クエリ" },
      name: { type: "string", description: "作成するスレッド名" },
      limit: { type: "number", description: "取得件数制限（デフォルト25）", default: 25 },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;

    try {
      const client = await getDiscordClient();
      const guildId = args.guild_id as string;

      switch (action) {
        case "server_info": {
          if (!guildId) return "[エラー] guild_id が必要です";
          const guild = await client.guilds.fetch(guildId);
          const owner = await guild.fetchOwner();
          return `💬 **${guild.name}**\n` +
            `ID: \`${guild.id}\`\n` +
            `オーナー: ${owner.user.tag}\n` +
            `メンバー: ${guild.approximateMemberCount || guild.memberCount || "?"}\n` +
            `チャンネル: ${guild.channels.cache.size}件\n` +
            `ロール: ${guild.roles.cache.size}件\n` +
            `Boost: レベル${guild.premiumTier} (${guild.premiumSubscriptionCount || 0}ブースト)\n` +
            `作成日: ${guild.createdAt?.toLocaleDateString() || "?"}`;
        }

        case "list_channels": {
          if (!guildId) return "[エラー] guild_id が必要です";
          const guild = await client.guilds.fetch(guildId);
          const channels = guild.channels.cache
            .filter((c: any) => c.type === 0 || c.type === 5 || c.type === 2) // text/announcement/voice
            .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

          const limit = Math.min((args.limit as number) || 25, 100);
          const limited = Array.from(channels.values()).slice(0, limit);

          if (limited.length === 0) return `💬 チャンネルが見つかりません。`;

          // カテゴリでグループ化（Discord.jsのChannel型は複雑なのでanyで受ける）
          interface ChannelItem { name: string; id: string; type: number; position?: number; parent?: { name: string } | null }
          const chs = limited as ChannelItem[];

          const parents = Array.from(new Set(chs.map(c => c.parent?.name).filter((n): n is string => !!n)));
          const lines: string[] = [];

          for (const parent of parents) {
            const kids = chs.filter(c => c.parent?.name === parent);
            lines.push(`📁 **${parent}**`);
            for (const c of kids) {
              const typeIcon = c.type === 2 ? "🔊" : "💬";
              lines.push(`  ${typeIcon} #${c.name} \`${c.id}\``);
            }
          }

          // カテゴリなし
          const uncategorized = chs.filter(c => !c.parent);
          if (uncategorized.length > 0) {
            lines.push(`📁 **その他**`);
            for (const c of uncategorized) {
              const typeIcon = c.type === 2 ? "🔊" : "💬";
              lines.push(`  ${typeIcon} #${c.name} \`${c.id}\``);
            }
          }

          return chunkOutput(`💬 **チャンネル一覧** (${limited.length}件/${channels.size}件)\n\n${lines.join("\n")}`)[0]!;
        }

        case "search_members": {
          if (!guildId) return "[エラー] guild_id が必要です";
          const query = (args.query as string || "").toLowerCase();
          if (!query) return "[エラー] query が必要です";

          const guild = await client.guilds.fetch(guildId, { force: true });
          const members = await guild.members.fetch({ limit: 100 });
          const matched = members.filter((m: any) =>
            m.user.username.toLowerCase().includes(query) ||
            (m.nickname && m.nickname.toLowerCase().includes(query)) ||
            m.user.tag.toLowerCase().includes(query)
          ).slice(0, 20);

          if (matched.length === 0) return `💬 「${query}」に一致するメンバーはいません。`;

          const lines = matched.map((m: any) =>
            `• **${m.user.tag}**${m.nickname ? ` (${m.nickname})` : ""} \`${m.id}\``
          );

          return `💬 **メンバー検索: "${query}"** (${matched.length}件)\n\n${lines.join("\n")}`;
        }

        case "member_info": {
          if (!guildId) return "[エラー] guild_id が必要です";
          const userId = args.user_id as string;
          if (!userId) return "[エラー] user_id が必要です";

          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(userId);

          return `💬 **${member.user.tag}**\n` +
            `ID: \`${member.id}\`\n` +
            `ニックネーム: ${member.nickname || "(なし)"}\n` +
            `参加日: ${member.joinedAt?.toLocaleDateString() || "?"}\n` +
            `アカウント作成日: ${member.user.createdAt?.toLocaleDateString() || "?"}\n` +
            `Bot: ${member.user.bot ? "はい" : "いいえ"}\n` +
            `ロール: ${member.roles.cache.filter((r: any) => r.name !== "@everyone").map((r: any) => r.name).join(", ") || "(なし)"}`;
        }

        case "create_thread": {
          const channelId = args.channel_id as string;
          const name = (args.name as string || "").trim();
          if (!channelId) return "[エラー] channel_id が必要です";
          if (!name) return "[エラー] name が必要です";

          const channel = await client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased()) return "[エラー] テキストチャンネルを指定してください";

          const thread = await (channel as any).threads.create({
            name,
            autoArchiveDuration: 60,
            reason: "Aikata: スレッド作成",
          });

          return `💬 スレッド作成: **${name}**\nID: \`${thread.id}\``;
        }

        default:
          return `[エラー] 不明なアクション: ${action}`;
      }
    } catch (e: any) {
      return `[エラー] Discord操作失敗: ${e.message?.slice(0, 200)}`;
    }
  },
};

toolRegistry.register(discordCoreTool);
export { discordCoreTool };
