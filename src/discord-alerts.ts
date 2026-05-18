// ==========================================
// Aikata - Discord通知拡張（Hydro0x01由来）
// 出典: Hydro0x01 (40rbidd3n/Hydro0x01) notification.service.ts
// 重大度色付きEmbed + テンプレート + レート制限
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type AlertLevel = "info" | "success" | "warning" | "error" | "critical";

export interface AlertNotification {
  level: AlertLevel;
  title: string;
  message: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  timestamp?: number;
  thumbnail?: string;
  url?: string;
}

interface AlertTemplate {
  id: string;
  titlePattern: string;
  color: number;
  emoji: string;
}

// ==================== 重大度→色マッピング（Hydro0x01 Discord embed coloring） ====================

const LEVEL_COLORS: Record<AlertLevel, number> = {
  info:     3447003,   // 青
  success:  5763719,   // 緑
  warning:  16776960,  // 黄
  error:    16711680,  // 赤
  critical: 16711680,  // 赤（errorと同じ）
};

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info:     "ℹ️",
  success:  "✅",
  warning:  "⚠️",
  error:    "❌",
  critical: "🚨",
};

const TEMPLATES: AlertTemplate[] = [
  { id: "memory_consolidated", titlePattern: "メモリ統合", color: LEVEL_COLORS.info, emoji: "🧠" },
  { id: "memory_forgotten", titlePattern: "メモリ忘却", color: LEVEL_COLORS.warning, emoji: "🗑️" },
  { id: "tool_error", titlePattern: "ツールエラー", color: LEVEL_COLORS.error, emoji: "🔧" },
  { id: "agent_started", titlePattern: "エージェント起動", color: LEVEL_COLORS.success, emoji: "🤖" },
  { id: "agent_completed", titlePattern: "エージェント完了", color: LEVEL_COLORS.success, emoji: "✅" },
  { id: "cost_threshold", titlePattern: "コスト警告", color: LEVEL_COLORS.warning, emoji: "💰" },
  { id: "pipeline_stage", titlePattern: "パイプライン", color: LEVEL_COLORS.info, emoji: "📊" },
  { id: "security_alert", titlePattern: "セキュリティ", color: LEVEL_COLORS.critical, emoji: "🔒" },
  { id: "system_startup", titlePattern: "システム起動", color: LEVEL_COLORS.info, emoji: "🚀" },
  { id: "system_shutdown", titlePattern: "システム停止", color: LEVEL_COLORS.warning, emoji: "⏹️" },
];

// ==================== レート制限（スパム防止） ====================

class RateLimiter {
  private recent = new Map<string, number[]>();

  /**
   * 送信可能かチェック
   * 同一IDの通知は10秒間に最大2回まで
   */
  canSend(templateId: string, maxPerWindow: number = 2, windowMs: number = 10000): boolean {
    const now = Date.now();
    let timestamps = this.recent.get(templateId) || [];
    timestamps = timestamps.filter(t => now - t < windowMs);
    this.recent.set(templateId, timestamps);

    if (timestamps.length >= maxPerWindow) return false;
    timestamps.push(now);
    return true;
  }

  /** レート制限をリセット */
  reset(): void {
    this.recent.clear();
  }
}

// ==================== Discord Embedビルダー ====================

class DiscordAlertBuilder {
  private rateLimiter = new RateLimiter();
  private history: AlertNotification[] = [];
  private maxHistory = 200;

  /**
   * Embedオブジェクトを生成（Hydro0x01 sendDiscord 相当）
   */
  buildEmbed(notification: AlertNotification): Record<string, unknown> {
    const color = LEVEL_COLORS[notification.level] || LEVEL_COLORS.info;
    const emoji = LEVEL_EMOJI[notification.level] || "ℹ️";

    const embed: Record<string, unknown> = {
      title: `${emoji} ${notification.title}`,
      description: notification.message,
      color,
      timestamp: new Date(notification.timestamp || Date.now()).toISOString(),
    };

    if (notification.fields && notification.fields.length > 0) {
      embed.fields = notification.fields.map(f => ({
        name: f.name,
        value: f.value,
        inline: f.inline ?? false,
      }));
    }

    if (notification.footer) {
      embed.footer = { text: notification.footer };
    }

    if (notification.thumbnail) {
      embed.thumbnail = { url: notification.thumbnail };
    }

    if (notification.url) {
      embed.url = notification.url;
    }

    return embed;
  }

  /**
   * テンプレートからEmbedを生成
   */
  buildFromTemplate(templateId: string, data: Record<string, string>): Record<string, unknown> | null {
    const tpl = TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return null;

    // レート制限チェック
    if (!this.rateLimiter.canSend(templateId)) return null;

    return this.buildEmbed({
      level: "info",
      title: `${tpl.emoji} ${tpl.titlePattern}${data.title_suffix ? `: ${data.title_suffix}` : ""}`,
      message: data.message || "",
      fields: data.fields ? this.parseFields(data.fields) : undefined,
      footer: data.footer || "Aikata Notification System",
    });
  }

  /**
   * アラート通知を送信（Discord Webhook経由）
   * Hydro0x01: sendDiscord() 相当
   */
  async sendDiscord(webhookUrl: string, notification: AlertNotification): Promise<boolean> {
    const embed = this.buildEmbed(notification);
    const payload = { embeds: [embed] };

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        logger.warn(`[DiscordAlert] Webhook失敗: HTTP ${resp.status}`);
      }

      this.history.push(notification);
      if (this.history.length > this.maxHistory) {
        this.history = this.history.slice(-this.maxHistory);
      }

      return resp.ok;
    } catch (e: any) {
      logger.error(`[DiscordAlert] 送信失敗: ${e.message}`);
      return false;
    }
  }

  /**
   * アラート履歴を取得
   */
  getHistory(limit: number = 10): AlertNotification[] {
    return this.history.slice(-limit);
  }

  /**
   * 重大度フィルターで履歴を取得
   */
  getByLevel(level: AlertLevel, limit: number = 10): AlertNotification[] {
    return this.history.filter(a => a.level === level).slice(-limit);
  }

  private parseFields(fieldsStr: string): Array<{ name: string; value: string }> {
    try {
      return JSON.parse(fieldsStr);
    } catch {
      return [];
    }
  }
}

// ==================== クイック通知ヘルパー ====================

class DiscordAlert {
  private builder = new DiscordAlertBuilder();

  /**
   * 情報通知
   */
  info(title: string, message: string): void {
    logger.info(`[Alert] ℹ️ ${title}: ${message.slice(0, 100)}`);
    this.builder.buildEmbed({ level: "info", title, message });
  }

  /**
   * 成功通知
   */
  success(title: string, message: string): void {
    logger.info(`[Alert] ✅ ${title}: ${message.slice(0, 100)}`);
    this.builder.buildEmbed({ level: "success", title, message });
  }

  /**
   * 警告通知
   */
  warn(title: string, message: string): void {
    logger.warn(`[Alert] ⚠️ ${title}: ${message.slice(0, 100)}`);
    this.builder.buildEmbed({ level: "warning", title, message });
  }

  /**
   * エラー通知
   */
  error(title: string, message: string): void {
    logger.error(`[Alert] ❌ ${title}: ${message.slice(0, 100)}`);
    this.builder.buildEmbed({ level: "error", title, message });
  }

  /**
   * 重大通知
   */
  critical(title: string, message: string): void {
    logger.error(`[Alert] 🚨 ${title}: ${message.slice(0, 100)}`);
    this.builder.buildEmbed({ level: "critical", title, message });
  }

  /**
   * Embedを生成して返す（Discordに直接ポストしない場合）
   */
  createEmbed(level: AlertLevel, title: string, message: string, fields?: AlertNotification["fields"]): Record<string, unknown> {
    return this.builder.buildEmbed({ level, title, message, fields });
  }
}

export const discordAlert = new DiscordAlert();
export { DiscordAlertBuilder, LEVEL_COLORS, LEVEL_EMOJI, TEMPLATES };
