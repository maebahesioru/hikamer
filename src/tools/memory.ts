// ==========================================
// Aikata - 永続メモリツール（Frozen Snapshot）
// MEMORY.md（エージェントの学習・知見）
// USER.md（ユーザー情報・好み）
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { getAgentMemory, writeAgentMemory, getUserProfile, writeUserProfile } from "../memory";

const memoryTool: ToolDescriptor = {
  name: "memory",
  emoji: "🧠",
  owner: "core",
  description: "セッションを超えた永続メモリを読み書きします。MEMORY（エージェントの知見・学習）とUSER（ユーザー情報・好み・環境設定）の2種類。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write"],
        description: "read=読み取り, write=上書き保存",
      },
      target: {
        type: "string",
        enum: ["agent", "user"],
        description: "agent=エージェントの知見, user=ユーザー情報",
      },
      content: {
        type: "string",
        description: "write時の内容。Markdown形式。箇条書きでコンパクトに。",
      },
    },
    required: ["action", "target"],
  },
  async execute(args) {
    const action = args.action as string;
    const target = args.target as string;

    if (action === "read") {
      if (target === "agent") {
        const mem = getAgentMemory();
        return mem ? `🧠 **エージェントメモリ:**\n${mem}` : "🧠 エージェントメモリは空です。何か学んだことがあれば `memory write` で保存してください。";
      } else {
        const prof = getUserProfile();
        return prof ? `👤 **ユーザープロファイル:**\n${prof}` : "👤 ユーザープロファイルは未設定です。会話から学んだことを `memory write target=user` で保存してください。";
      }
    }

    if (action === "write") {
      const content = String(args.content || "").trim();
      if (!content) return "[エラー] content が必要です。";

      if (target === "agent") {
        writeAgentMemory(content);
        return `✅ エージェントメモリを更新しました (${content.length}文字)`;
      } else {
        writeUserProfile(content);
        return `✅ ユーザープロファイルを更新しました (${content.length}文字)`;
      }
    }

    return `[エラー] 不明なアクション: ${action}`;
  },
};

toolRegistry.register(memoryTool);
export { memoryTool };
