// ==========================================
// Hikamer - 永続メモリツール（v1.39 拡張版）
// 従来のFrozenSnapshot + ハイブリッド検索 + 4-Tierパイプライン
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { getAgentMemory, writeAgentMemory, getUserProfile, writeUserProfile } from "../memory";
import {
  searchMemory,
  observeMemory,
  rememberExplicitly,
  getMemoryStats,
  consolidateNow,
} from "../memory-bridge";

const memoryTool: ToolDescriptor = {
  name: "memory",
  emoji: "🧠",
  owner: "core",
  description: "セッションを超えた永続メモリを読み書き・検索します。MEMORY（エージェントの知見）・USER（ユーザー情報）+ ハイブリッド検索・自動観察・4階層メモリパイプライン。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write", "search", "observe", "remember", "stats", "consolidate"],
        description: "read=読み取り, write=上書き保存, search=ハイブリッド検索, observe=自動観察記録, remember=明示的記憶, stats=統計, consolidate=統合実行",
      },
      target: {
        type: "string",
        enum: ["agent", "user", "memory"],
        description: "agent=エージェントの知見, user=ユーザー情報, memory=メモリパイプライン",
      },
      content: {
        type: "string",
        description: "write/observe/remember時の内容。Markdown形式でコンパクトに。",
      },
      query: {
        type: "string",
        description: "search時の検索クエリ。BM25+ベクトル+グラフのハイブリッド検索。",
      },
      limit: {
        type: "number",
        description: "search時の結果数（最大20、デフォルト5）",
      },
      importance: {
        type: "number",
        description: "remember時の重要度（0.0〜1.0、デフォルト0.7）",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;

    // ---- 従来アクション（互換） ----
    if (action === "read") {
      const target = args.target as string;
      if (target === "agent") {
        const mem = getAgentMemory();
        return mem ? `🧠 **エージェントメモリ:**\n${mem}` : "🧠 エージェントメモリは空です。";
      }
      if (target === "user") {
        const prof = getUserProfile();
        return prof ? `👤 **ユーザープロファイル:**\n${prof}` : "👤 ユーザープロファイルは未設定です。";
      }
      if (target === "memory") {
        const stats = getMemoryStats();
        return `🧠 **メモリパイプライン統計**\n- 総メモリ: ${stats.total}件\n- Working: ${stats.working}\n- Episodic: ${stats.episodic}\n- Semantic: ${stats.semantic}\n- Procedural: ${stats.procedural}`;
      }
      return `🧠 **エージェントメモリ:**\n${getAgentMemory() || "空"}`
        + `\n\n👤 **ユーザープロファイル:**\n${getUserProfile() || "未設定"}`
        + `\n\n📊 **メモリ統計:** W:${getMemoryStats().working} E:${getMemoryStats().episodic} S:${getMemoryStats().semantic} P:${getMemoryStats().procedural}`;
    }

    if (action === "write") {
      const target = args.target as string;
      const content = String(args.content || "").trim();
      if (!content) return "[エラー] content が必要です。";

      if (target === "agent") {
        writeAgentMemory(content);
        return `✅ エージェントメモリを更新 (${content.length}文字)`;
      }
      if (target === "user") {
        writeUserProfile(content);
        return `✅ ユーザープロファイルを更新 (${content.length}文字)`;
      }
      return "[エラー] target=agent または target=user を指定してください。";
    }

    // ---- 新アクション（拡張） ----

    if (action === "search") {
      const query = (args.query as string) || "";
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
      if (!query) return "[エラー] 検索クエリ(query)が必要です。";

      const results = await searchMemory(query, limit);
      if (results.length === 0) return "🔍 該当するメモリが見つかりませんでした。";
      return `🔍 **メモリ検索結果**（"${query}"）\n${results.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
    }

    if (action === "observe") {
      const content = String(args.content || "").trim();
      if (!content) return "[エラー] 観察内容(content)が必要です。";

      await observeMemory(content, {
        importance: 0.3,
        tier: "working",
      });
      return `👁️ 観察を記録しました: ${content.length}文字`;
    }

    if (action === "remember") {
      const content = String(args.content || "").trim();
      if (!content) return "[エラー] 記憶内容(content)が必要です。";

      const importance = Math.min(Math.max(Number(args.importance) || 0.7, 0), 1);
      await rememberExplicitly(content, importance);
      return `💾 記憶しました！重要度: ${importance}\n${content}`;
    }

    if (action === "stats") {
      const stats = getMemoryStats();
      return `📊 **メモリパイプライン統計**\n`
        + `- 総メモリ: ${stats.total}件\n`
        + `- Working（作業記憶）: ${stats.working}\n`
        + `- Episodic（体験記憶）: ${stats.episodic}\n`
        + `- Semantic（意味記憶）: ${stats.semantic}\n`
        + `- Procedural（手続き記憶）: ${stats.procedural}\n\n`
        + `各階層のメモリは自動的に昇格・減衰・忘却されます。\n`
        + `アクセス頻度の高い重要なメモリほど上位階層に留まります。`;
    }

    if (action === "consolidate") {
      await consolidateNow();
      const stats = getMemoryStats();
      return `🔄 メモリ統合完了。\n現在: W:${stats.working} E:${stats.episodic} S:${stats.semantic} P:${stats.procedural}`;
    }

    return `[エラー] 不明なアクション: ${action}`;
  },
};

toolRegistry.register(memoryTool);
export { memoryTool };
