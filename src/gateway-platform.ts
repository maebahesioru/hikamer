// ==========================================
// Aikata - ゲートウェイプラットフォーム（Hermes Agent gateway/ 由来）
// マルチプラットフォームメッセージング抽象化
// プラットフォームの登録・ルーティング・配信
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

/** プラットフォーム識別子 */
export type PlatformId = "discord" | "telegram" | "cli" | "web" | "slack" | "signal" | "matrix" | "custom";

/** メッセージの方向 */
export type MessageDirection = "incoming" | "outgoing";

/** メッセージの重要度 */
export type MessagePriority = "low" | "normal" | "high" | "critical";

/** メッセージ */
export interface PlatformMessage {
  id: string;
  platform: PlatformId;
  direction: MessageDirection;
  channelId: string;
  userId?: string;
  threadId?: string;
  content: string;
  attachments?: PlatformAttachment[];
  priority: MessagePriority;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/** 添付ファイル */
export interface PlatformAttachment {
  type: "text" | "image" | "file" | "audio" | "video";
  url?: string;
  data?: string;
  mimeType?: string;
  filename?: string;
  size?: number;
}

/** プラットフォームアダプター */
export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  enabled: boolean;
  capabilities: PlatformCapability[];
  /** メッセージ送信 */
  send(message: PlatformMessage): Promise<boolean>;
  /** プラットフォーム固有の変換 */
  transform?(message: PlatformMessage): PlatformMessage;
  /** 死活監視 */
  healthCheck(): Promise<boolean>;
  /** 初期化 */
  init?(config: Record<string, unknown>): Promise<void>;
  /** 終了処理 */
  shutdown?(): Promise<void>;
}

/** プラットフォームの機能 */
export type PlatformCapability =
  | "send_text"
  | "send_image"
  | "send_file"
  | "send_audio"
  | "send_video"
  | "receive_message"
  | "threads"
  | "reactions"
  | "edit_message"
  | "delete_message"
  | "voice_call"
  | "video_call";

/** ルーティングルール */
export interface RoutingRule {
  name: string;
  priority: number;
  /** マッチ条件 */
  matcher: (message: PlatformMessage) => boolean;
  /** 転送先プラットフォーム */
  targetPlatforms: PlatformId[];
  /** 有効 */
  enabled: boolean;
}

// ==================== ゲートウェイ ====================

class Gateway {
  private adapters: Map<PlatformId, PlatformAdapter> = new Map();
  private routingRules: RoutingRule[] = [];
  private stats = {
    messagesSent: 0,
    messagesReceived: 0,
    routingMatches: 0,
    failures: 0,
  };
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.loadDefaultRoutingRules();
    this.initialized = true;
    logger.info("[Gateway] initialized");
  }

  /** プラットフォームアダプターを登録 */
  registerAdapter(adapter: PlatformAdapter): void {
    if (this.adapters.has(adapter.id)) {
      logger.warn(`[Gateway] adapter ${adapter.id} already registered, overwriting`);
    }
    this.adapters.set(adapter.id, adapter);
    logger.info(`[Gateway] registered platform: ${adapter.name} (${adapter.capabilities.length} capabilities)`);
  }

  /** アダプターを登録解除 */
  unregisterAdapter(platformId: PlatformId): boolean {
    const removed = this.adapters.delete(platformId);
    if (removed) logger.info(`[Gateway] unregistered platform: ${platformId}`);
    return removed;
  }

  /** アダプター一覧 */
  listAdapters(): { id: PlatformId; name: string; enabled: boolean; capabilities: PlatformCapability[] }[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      capabilities: a.capabilities,
    }));
  }

  /** アダプターを取得 */
  getAdapter(platformId: PlatformId): PlatformAdapter | undefined {
    return this.adapters.get(platformId);
  }

  /** メッセージを送信 */
  async sendMessage(message: PlatformMessage): Promise<boolean> {
    const adapter = this.adapters.get(message.platform);
    if (!adapter || !adapter.enabled) {
      logger.warn(`[Gateway] no adapter for ${message.platform}`);
      this.stats.failures++;
      return false;
    }

    try {
      // ルーティングルールをチェック
      this.applyRouting(message);

      // プラットフォーム固有の変換
      const transformed = adapter.transform ? adapter.transform(message) : message;

      const result = await adapter.send(transformed);
      if (result) {
        this.stats.messagesSent++;
        eventBus.publish(createEvent("gateway:sent", {
          platform: message.platform,
          channelId: message.channelId,
          messageId: message.id,
        }));
      } else {
        this.stats.failures++;
      }
      return result;
    } catch (err) {
      this.stats.failures++;
      logger.error(`[Gateway] send to ${message.platform} failed:`, err);
      return false;
    }
  }

  /** 受信メッセージを処理 */
  async receiveMessage(message: PlatformMessage): Promise<void> {
    this.stats.messagesReceived++;

    eventBus.publish(createEvent("gateway:received", {
      platform: message.platform,
      channelId: message.channelId,
      messageId: message.id,
    }));

    // ルーティング
    this.applyRouting(message);
  }

  /** ルーティングルールを追加 */
  addRoutingRule(rule: RoutingRule): void {
    this.routingRules.push(rule);
    this.routingRules.sort((a, b) => b.priority - a.priority);
  }

  /** ルーティングルール一覧 */
  listRoutingRules(): RoutingRule[] {
    return [...this.routingRules];
  }

  /** 全アダプターのヘルスチェック */
  async healthCheckAll(): Promise<Record<PlatformId, boolean>> {
    const results: Record<PlatformId, boolean> = {};
    for (const [id, adapter] of this.adapters) {
      try {
        results[id] = await adapter.healthCheck();
      } catch {
        results[id] = false;
      }
    }
    return results;
  }

  /** 統計を取得 */
  getStats() {
    return { ...this.stats };
  }

  /** メッセージをミラーリング（全プラットフォームにブロードキャスト） */
  async broadcast(message: Omit<PlatformMessage, "id" | "platform" | "timestamp">): Promise<Record<PlatformId, boolean>> {
    const results: Record<PlatformId, boolean> = {};
    const base: Partial<PlatformMessage> = {
      ...message,
      timestamp: Date.now(),
    };

    for (const [platformId, adapter] of this.adapters) {
      if (!adapter.enabled) continue;
      try {
        const msg: PlatformMessage = {
          ...base,
          id: `broadcast-${Date.now()}-${platformId}`,
          platform: platformId,
        } as PlatformMessage;
        results[platformId] = await adapter.send(msg);
      } catch {
        results[platformId] = false;
      }
    }

    return results;
  }

  /** メッセージを生成 */
  createMessage(options: {
    platform: PlatformId;
    channelId: string;
    content: string;
    direction?: MessageDirection;
    userId?: string;
    threadId?: string;
    priority?: MessagePriority;
    attachments?: PlatformAttachment[];
  }): PlatformMessage {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platform: options.platform,
      direction: options.direction ?? "outgoing",
      channelId: options.channelId,
      content: options.content,
      userId: options.userId,
      threadId: options.threadId,
      priority: options.priority ?? "normal",
      attachments: options.attachments,
      metadata: {},
      timestamp: Date.now(),
    };
  }

  // ---- 内部実装 ----

  private applyRouting(message: PlatformMessage): void {
    for (const rule of this.routingRules) {
      if (!rule.enabled) continue;
      if (!rule.targetPlatforms.includes(message.platform)) continue;
      if (rule.matcher(message)) {
        this.stats.routingMatches++;
        eventBus.publish(createEvent("gateway:routed", {
          messageId: message.id,
          ruleName: rule.name,
          fromPlatform: message.platform,
        }));
      }
    }
  }

  private loadDefaultRoutingRules(): void {
    // クリティカル優先度は全プラットフォームに転送
    this.addRoutingRule({
      name: "critical-broadcast",
      priority: 100,
      matcher: (m) => m.priority === "critical",
      targetPlatforms: ["discord", "telegram", "cli"],
      enabled: true,
    });

    // 高優先度は通知として転送
    this.addRoutingRule({
      name: "high-priority-notify",
      priority: 70,
      matcher: (m) => m.priority === "high",
      targetPlatforms: ["discord", "telegram"],
      enabled: true,
    });
  }
}

// ==================== CLIアダプター（ビルトイン） ====================

class CliAdapter implements PlatformAdapter {
  id: PlatformId = "cli";
  name = "CLI";
  enabled = true;
  capabilities: PlatformCapability[] = ["send_text", "receive_message"];

  async send(message: PlatformMessage): Promise<boolean> {
    console.log(`[CLI] ${message.content}`);
    return true;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ==================== シングルトン ====================

export const gateway = new Gateway();
gateway.registerAdapter(new CliAdapter());

// ==================== システムコマンド ====================

export function getGatewayCommands(): Record<
  string,
  (args: string[]) => string | Promise<string>
> {
  return {
    "/gateway": async (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "platforms":
        case "list": {
          const adapters = gateway.listAdapters();
          if (adapters.length === 0) return "📭 登録済みプラットフォームはありません";
          return (
            `🌐 **プラットフォーム一覧 (${adapters.length})**\n\n` +
            adapters
              .map(
                (a) =>
                  `${a.enabled ? "✅" : "⛔"} **${a.name}** (\`${a.id}\`)\n` +
                  `   capabilities: ${a.capabilities.join(", ")}`
              )
              .join("\n\n")
          );
        }

        case "health": {
          const health = await gateway.healthCheckAll();
          return (
            `🏥 **プラットフォームヘルス**\n\n` +
            Object.entries(health)
              .map(
                ([platform, ok]) =>
                  `${ok ? "✅" : "❌"} ${platform}`
              )
              .join("\n")
          );
        }

        case "routes":
        case "rules": {
          const rules = gateway.listRoutingRules();
          if (rules.length === 0) return "📭 ルーティングルールがありません";
          return (
            `🔀 **ルーティングルール (${rules.length})**\n\n` +
            rules
              .map(
                (r, i) =>
                  `${i + 1}. ${r.enabled ? "✅" : "⛔"} **${r.name}** (p${r.priority})\n` +
                  `   転送先: ${r.targetPlatforms.join(", ")}`
              )
              .join("\n\n")
          );
        }

        case "stats": {
          const stats = gateway.getStats();
          return (
            `📊 **ゲートウェイ統計**\n` +
            `送信: ${stats.messagesSent}\n` +
            `受信: ${stats.messagesReceived}\n` +
            `ルーティング: ${stats.routingMatches}\n` +
            `失敗: ${stats.failures}`
          );
        }

        default:
          return (
            `🌐 **ゲートウェイコマンド**\n` +
            `/gateway platforms — プラットフォーム一覧\n` +
            `/gateway health — ヘルスチェック\n` +
            `/gateway routes — ルーティングルール\n` +
            `/gateway stats — 統計`
          );
      }
    },
  };
}

export default Gateway;
