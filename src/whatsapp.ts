// ==========================================
// Hikamer - WhatsAppデータ（OpenHuman whatsapp_data/ 由来）
// WhatsAppチャットデータの解析・検索
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface WhatsAppChat {
  id: string;
  name: string;
  type: "individual" | "group";
  participants: string[];
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  filePath: string;
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  sender: string;
  text: string;
  timestamp: number;
  type: "text" | "media" | "system";
  isMine: boolean;
}

export interface WhatsAppExportStats {
  chatsFound: number;
  messagesParsed: number;
  participants: string[];
  dateRange: { from: string; to: string };
}

// ==================== WhatsAppマネージャー ====================

class WhatsAppManager {
  private chats: Map<string, WhatsAppChat> = new Map();
  private messages: Map<string, WhatsAppMessage[]> = new Map();
  private dataDir: string;
  private initialized = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? (process.env.WHATSAPP_DATA_DIR || "./whatsapp-data");
  }

  init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.scanExports();
    this.initialized = true;
    logger.info(`[WhatsApp] initialized: ${this.chats.size} chats`);
  }

  /** エクスポートファイルをスキャン */
  scanExports(): number {
    if (!fs.existsSync(this.dataDir)) return 0;

    let found = 0;
    try {
      const files = fs.readdirSync(this.dataDir);
      for (const file of files) {
        if (file.endsWith(".txt") && file.includes("WhatsApp")) {
          const chatId = `wa-${Date.now()}-${found}`;
          const filePath = path.join(this.dataDir, file);

          this.chats.set(chatId, {
            id: chatId,
            name: file.replace(/\.txt$/, "").replace(/_/g, " "),
            type: file.includes("Group") ? "group" : "individual",
            participants: [],
            messageCount: 0,
            lastMessageAt: null,
            createdAt: Date.now(),
            filePath,
          });
          found++;
        }
      }
    } catch {}
    return found;
  }

  /** WhatsAppエクスポートファイルを解析 */
  async parseExport(filePath: string): Promise<WhatsAppExportStats | null> {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      const chatId = `wa-${Date.now()}`;
      const messages: WhatsAppMessage[] = [];
      const participants = new Set<string>();

      // 一般的なWhatsAppエクスポート形式:
      // [日付, 時刻] 送信者: メッセージ
      const messageRegex = /\[?(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})[\s,]+(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:]+):\s+(.+)/;

      for (const line of lines) {
        const match = line.match(messageRegex);
        if (match) {
          const sender = match[3]?.trim() ?? "";
          const text = match[4]?.trim() ?? "";

          participants.add(sender);

          messages.push({
            id: `wam-${chatId}-${messages.length}`,
            chatId,
            sender,
            text,
            timestamp: Date.now() - (lines.length - messages.length) * 1000,
            type: text.startsWith("<") ? "system" : "text",
            isMine: sender.includes("自分") || sender.includes("You"),
          });
        }
      }

      this.chats.set(chatId, {
        id: chatId,
        name: path.basename(filePath).replace(/\.txt$/, ""),
        type: messages.length > 0 ? "group" : "individual",
        participants: Array.from(participants),
        messageCount: messages.length,
        lastMessageAt: messages.length > 0 ? messages[messages.length - 1]!.timestamp : null,
        createdAt: Date.now(),
        filePath,
      });

      this.messages.set(chatId, messages);

      logger.info(`[WhatsApp] parsed ${messages.length} messages from ${filePath}`);
      return {
        chatsFound: 1,
        messagesParsed: messages.length,
        participants: Array.from(participants),
        dateRange: { from: "unknown", to: "unknown" },
      };
    } catch (err) {
      logger.error(`[WhatsApp] parse failed:`, err);
      return null;
    }
  }

  /** チャット内を検索 */
  searchMessages(chatId: string, query: string): WhatsAppMessage[] {
    const msgs = this.messages.get(chatId);
    if (!msgs) return [];

    const lower = query.toLowerCase();
    return msgs
      .filter((m) => m.text.toLowerCase().includes(lower))
      .slice(0, 50);
  }

  /** 全てのチャットから検索 */
  searchAll(query: string): Array<{ chat: WhatsAppChat; messages: WhatsAppMessage[] }> {
    const results: Array<{ chat: WhatsAppChat; messages: WhatsAppMessage[] }> = [];
    for (const [chatId, msgs] of this.messages) {
      const chat = this.chats.get(chatId);
      if (!chat) continue;
      const matched = this.searchMessages(chatId, query);
      if (matched.length > 0) {
        results.push({ chat, messages: matched.slice(0, 10) });
      }
    }
    return results;
  }

  /** チャット一覧 */
  listChats(): WhatsAppChat[] {
    return Array.from(this.chats.values());
  }

  /** チャットのメッセージ */
  getMessages(chatId: string, limit = 100): WhatsAppMessage[] {
    const msgs = this.messages.get(chatId);
    if (!msgs) return [];
    return msgs.slice(-limit).reverse();
  }

  formatStatus(): string {
    const chats = this.listChats();
    const totalMessages = Array.from(this.messages.values()).reduce(
      (s, m) => s + m.length,
      0
    );
    return (
      `💬 **WhatsAppデータ**\n` +
      `データディレクトリ: ${this.dataDir}\n` +
      `チャット数: ${chats.length}\n` +
      `総メッセージ数: ${totalMessages.toLocaleString()}\n` +
      `エクスポートファイル: ${fs.existsSync(this.dataDir) ? fs.readdirSync(this.dataDir).filter(f => f.endsWith('.txt')).length : 0}`
    );
  }
}

// ==================== シングルトン ====================

export const whatsappManager = new WhatsAppManager();

export default WhatsAppManager;
