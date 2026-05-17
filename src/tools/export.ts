// ==========================================
// Aikata - 会話エクスポートツール（Hermes Agent由来）
// Markdown/JSON形式で会話履歴を出力
// ==========================================

import type { ToolDescriptor, Message } from "../types";
import { toolRegistry } from "./registry";
import { getHistory, getConversationTitle } from "../repo";
import { logger } from "../utils/logger";

// ==================== Markdownエクスポート ====================

function exportAsMarkdown(conversationId: string, messages: Message[]): string {
  const title = getConversationTitle(conversationId) || conversationId;
  const lines: string[] = [
    `# 会話: ${title}`,
    `> ID: ${conversationId}`,
    `> メッセージ数: ${messages.length}`,
    `> エクスポート: ${new Date().toISOString()}`,
    "",
  ];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        lines.push(`## 👤 ユーザー\n${msg.content}\n`);
        break;
      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          lines.push(`## 🤖 アシスタント (ツール呼び出し)`);
          for (const tc of msg.tool_calls) {
            lines.push(`- **${tc.function.name}**: \`${tc.function.arguments.slice(0, 500)}\``);
          }
          if (msg.content) lines.push(`\n${msg.content}`);
          lines.push("");
        } else {
          lines.push(`## 🤖 アシスタント\n${msg.content}\n`);
        }
        break;
      case "tool":
        lines.push(`## 🔧 ツール結果\n\`\`\`\n${msg.content.slice(0, 2000)}\n\`\`\`\n`);
        break;
      case "system":
        lines.push(`## ⚙️ システム\n${msg.content}\n`);
        break;
    }
  }

  return lines.join("\n");
}

// ==================== JSONエクスポート ====================

function exportAsJson(conversationId: string, messages: Message[]): string {
  const title = getConversationTitle(conversationId) || conversationId;
  const exportData = {
    exportedAt: new Date().toISOString(),
    conversationId,
    title,
    messageCount: messages.length,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls || undefined,
      tool_call_id: m.tool_call_id || undefined,
    })),
  };
  return JSON.stringify(exportData, null, 2);
}

// ==================== トリミングエクスポート（会話の要約版） ====================

function exportTruncated(conversationId: string, messages: Message[]): string {
  const title = getConversationTitle(conversationId) || conversationId;
  const lines: string[] = [
    `📋 **会話: ${title}**`,
    `ID: \`${conversationId}\``,
    `全${messages.length}メッセージ（うち表示: ${Math.min(messages.length, 50)}）`,
    "",
  ];

  const display = messages.length > 50 ? messages.slice(0, 25).concat(messages.slice(-25)) : messages;
  const truncated = messages.length > 50;

  for (const msg of display) {
    const icon = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : msg.role === "tool" ? "🔧" : "⚙️";
    const content = msg.content.slice(0, 300);
    if (msg.tool_calls) {
      const names = msg.tool_calls.map(tc => tc.function.name).join(", ");
      lines.push(`${icon} **[${msg.role}]** ツール: ${names}`);
    } else {
      lines.push(`${icon} **[${msg.role}]** ${content}`);
    }
  }

  if (truncated) {
    lines.push(`\n…中間 ${messages.length - 50} メッセージ省略`);
  }

  return lines.slice(0, 55).join("\n");
}

// ==================== ツール登録 ====================

const exportTool: ToolDescriptor = {
  name: "export_conversation",
  emoji: "📤",
  owner: "core",
  description: "会話履歴をMarkdown/JSON/要約形式でエクスポートします。",
  parameters: {
    type: "object",
    properties: {
      conversation_id: {
        type: "string",
        description: "エクスポートする会話ID（省略時は現在の会話）",
      },
      format: {
        type: "string",
        enum: ["markdown", "json", "truncated"],
        description: "出力形式。markdown=全文Markdown, json=JSON, truncated=要約版",
        default: "truncated",
      },
      limit: {
        type: "number",
        description: "読み込むメッセージ数上限（デフォルト200）",
        default: 200,
      },
    },
    required: [],
  },
  async execute(args) {
    const cid = String(args.conversation_id || args._conversation_id || "").trim();
    const format = (args.format as string) || "truncated";
    const limit = Math.min((args.limit as number) || 200, 5000);

    if (!cid) return "[エラー] conversation_id が必要です";

    const messages = getHistory(cid, limit);
    if (messages.length === 0) {
      return `📤 会話 \`${cid}\` にはメッセージがありません。`;
    }

    logger.info(`会話エクスポート: ${cid} (${messages.length}件, ${format})`);

    switch (format) {
      case "markdown":
        return exportAsMarkdown(cid, messages).slice(0, 15000);
      case "json":
        return exportAsJson(cid, messages).slice(0, 15000);
      case "truncated":
      default:
        return exportTruncated(cid, messages).slice(0, 1950);
    }
  },
};

toolRegistry.register(exportTool);
export { exportTool };
