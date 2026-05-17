// ==========================================
// Aikata - コンテキスト管理（OpenHuman context由来）
// LLMコンテキストウィンドウの最適化・自動圧縮判断
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

interface ContextLimits {
  maxTokens: number;
  warnAt: number;     // 警告発火 %
  forceCompressAt: number; // 強制圧縮 %
  emergencyAt: number;    // 緊急トリム %
}

interface ContextStats {
  totalMessages: number;
  estimatedTokens: number;
  usagePercent: number;
  systemPromptTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  isCompressed: boolean;
  lastCompressedAt: number | null;
}

interface ContextMessage {
  role: string;
  content: string;
  toolName?: string;
  tokenEstimate: number;
  age: number; // ミリ秒
}

// ==================== モデル別コンテキスト制限 ====================

const MODEL_LIMITS: Record<string, ContextLimits> = {
  "deepseek/deepseek-v4-pro":   { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "deepseek/deepseek-v4-flash": { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "deepseek-v4-pro":            { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "deepseek-v4-flash":          { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "gpt-5.5":                    { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "claude-sonnet-4":            { maxTokens: 200000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "claude-4.7-opus":            { maxTokens: 200000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
  "default":                    { maxTokens: 128000, warnAt: 0.7, forceCompressAt: 0.85, emergencyAt: 0.95 },
};

// トークン推定値（文字数ベースの簡易計算）
const TOKENS_PER_CHAR = 0.38;   // 日本語: 1文字≈0.38トークン
const TOKENS_PER_SYSTEM_CHAR = 0.35;
const TOKENS_PER_TOOL_CALL = 50; // ツール呼出オーバーヘッド
const MAX_HISTORY_MESSAGES = 200;

// ==================== コンテキストマネージャー ====================

class ContextManager {
  private messages: ContextMessage[] = [];
  private systemPromptTokens = 0;
  private modelKey = "default";
  private isCompressed = false;
  private lastCompressedAt: number | null = null;
  private compressCount = 0;

  /** モデル設定 */
  setModel(model: string): void {
    this.modelKey = Object.keys(MODEL_LIMITS).find(k => model.includes(k)) || "default";
  }

  /** システムプロンプトのトークン数を登録 */
  setSystemPrompt(text: string): void {
    this.systemPromptTokens = Math.round(text.length * TOKENS_PER_SYSTEM_CHAR);
  }

  /** メッセージを追加 */
  addMessage(role: string, content: string, toolName?: string): void {
    const tokenEstimate = this.estimateTokens(role, content, toolName);
    this.messages.push({
      role,
      content,
      toolName,
      tokenEstimate,
      age: Date.now(),
    });

    // 履歴上限
    if (this.messages.length > MAX_HISTORY_MESSAGES) {
      // 最初のシステムメッセージと最新50件を維持
      const excess = this.messages.length - MAX_HISTORY_MESSAGES;
      const toRemove = this.messages.slice(1, 1 + Math.min(excess, this.messages.length - 50));
      this.messages = [
        this.messages[0]!, // システムメッセージ維持
        ...this.messages.slice(1 + toRemove.length),
      ];
    }
  }

  /** トークン推定 */
  private estimateTokens(role: string, content: string, toolName?: string): number {
    const charRate = role === "system" ? TOKENS_PER_SYSTEM_CHAR : TOKENS_PER_CHAR;
    let tokens = Math.round(content.length * charRate);
    if (toolName) tokens += TOKENS_PER_TOOL_CALL;
    if (role === "tool") tokens += 20; // ツール結果
    if (role === "assistant" && toolName) tokens += 30; // ツール呼出
    return tokens;
  }

  /** 現在のコンテキスト統計 */
  getStats(): ContextStats {
    const limits = this.getLimits();
    const totalTokens = this.systemPromptTokens + this.messages.reduce((sum, m) => sum + m.tokenEstimate, 0);

    const byRole = { system: 0, user: 0, assistant: 0, tool: 0 };
    for (const m of this.messages) {
      if (m.role in byRole) (byRole as any)[m.role] += m.tokenEstimate;
    }

    return {
      totalMessages: this.messages.length,
      estimatedTokens: totalTokens,
      usagePercent: Math.round((totalTokens / limits.maxTokens) * 100),
      systemPromptTokens: this.systemPromptTokens,
      userTokens: byRole.user,
      assistantTokens: byRole.assistant,
      toolTokens: byRole.tool,
      isCompressed: this.isCompressed,
      lastCompressedAt: this.lastCompressedAt,
    };
  }

  /** コンテキスト状態を取得（圧縮判断用） */
  getContextStatus(): {
    status: "ok" | "warn" | "critical" | "emergency";
    usagePercent: number;
    totalTokens: number;
    maxTokens: number;
    suggestion?: string;
  } {
    const limits = this.getLimits();
    const stats = this.getStats();
    const percent = stats.usagePercent;

    if (percent >= limits.emergencyAt * 100) {
      return {
        status: "emergency",
        usagePercent: percent,
        totalTokens: stats.estimatedTokens,
        maxTokens: limits.maxTokens,
        suggestion: "緊急: 古いツール結果と会話ターンを削除してください",
      };
    }
    if (percent >= limits.forceCompressAt * 100) {
      return {
        status: "critical",
        usagePercent: percent,
        totalTokens: stats.estimatedTokens,
        maxTokens: limits.maxTokens,
        suggestion: "要圧縮: ツール出力を要約し、古い会話を圧縮",
      };
    }
    if (percent >= limits.warnAt * 100) {
      return {
        status: "warn",
        usagePercent: percent,
        totalTokens: stats.estimatedTokens,
        maxTokens: limits.maxTokens,
        suggestion: "警告: コンテキストが大きくなっています。古い情報は圧縮推奨",
      };
    }
    return {
      status: "ok",
      usagePercent: percent,
      totalTokens: stats.estimatedTokens,
      maxTokens: limits.maxTokens,
    };
  }

  /** コンテキストを圧縮（古いメッセージを丸める） */
  compress(): { removedMessages: number; savedTokens: number } {
    if (this.messages.length <= 3) {
      return { removedMessages: 0, savedTokens: 0 };
    }

    const limits = this.getLimits();
    const stats = this.getStats();
    const targetTokens = Math.round(limits.maxTokens * limits.forceCompressAt);

    // システムメッセージ（最初）は維持
    // アシスタント＋ツールのペアを古い方から除去
    let saved = 0;
    let removed = 0;

    const keep = [this.messages[0]!]; // システム維持
    // 最後の3メッセージは常に維持
    const tail = this.messages.slice(-3);
    const middle = this.messages.slice(1, -3);

    for (const msg of middle) {
      if (stats.estimatedTokens - saved <= targetTokens && keep.length > 2) {
        // 十分に圧縮された
        keep.push(msg);
      } else {
        saved += msg.tokenEstimate;
        removed++;
      }
    }

    this.messages = [...keep, ...tail];
    this.isCompressed = true;
    this.lastCompressedAt = Date.now();
    this.compressCount++;

    logger.info(`[Context] 圧縮: ${removed}メッセージ削除, ${saved}トークン節約`);
    return { removedMessages: removed, savedTokens: saved };
  }

  /** 緊急トリム（コンテキスト限界） */
  emergencyTrim(): { removedMessages: number; savedTokens: number } {
    const limits = this.getLimits();
    const emergencyTarget = Math.round(limits.maxTokens * 0.5);

    let saved = 0;
    let removed = 0;

    // システムと最新2メッセージ以外全部削除
    const keep: ContextMessage[] = [this.messages[0]!];
    const tail = this.messages.slice(-2);

    for (let i = 1; i < this.messages.length - 2; i++) {
      saved += this.messages[i]!.tokenEstimate;
      removed++;
    }

    this.messages = [...keep, ...tail];
    this.isCompressed = true;
    this.lastCompressedAt = Date.now();
    this.compressCount++;

    logger.warn(`[Context] 緊急トリム: ${removed}メッセージ削除, ${saved}トークン節約`);
    return { removedMessages: removed, savedTokens: saved };
  }

  /** 必要に応じて自動圧縮 */
  autoCompress(): { compressed: boolean; action: string } | null {
    const status = this.getContextStatus();

    if (status.status === "emergency") {
      const result = this.emergencyTrim();
      this.isCompressed = true;
      return { compressed: true, action: `emergency_trim: ${result.removedMessages}msg, ${result.savedTokens}tok saved` };
    }
    if (status.status === "critical") {
      const result = this.compress();
      return { compressed: true, action: `compress: ${result.removedMessages}msg, ${result.savedTokens}tok saved` };
    }
    if (status.status === "warn" && this.messages.length > 20) {
      // 警告段階では、ツール出力が多すぎる場合のみ圧縮
      const toolMessages = this.messages.filter(m => m.role === "tool");
      if (toolMessages.length > 15) {
        const result = this.compress();
        return { compressed: true, action: `compress(tools): ${result.removedMessages}msg, ${result.savedTokens}tok saved` };
      }
    }

    return null;
  }

  /** メッセージを取得（LLM送信用） */
  getMessages(): Array<{ role: string; content: string }> {
    return this.messages.slice(-100).map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  /** リセット */
  reset(): void {
    this.messages = [];
    this.isCompressed = false;
    this.compressCount = 0;
  }

  private getLimits(): ContextLimits {
    return MODEL_LIMITS[this.modelKey] || MODEL_LIMITS["default"]!;
  }

  /** フォーマット */
  formatStats(): string {
    const stats = this.getStats();
    const status = this.getContextStatus();
    const limits = this.getLimits();

    const statusEmoji = status.status === "ok" ? "✅" : status.status === "warn" ? "⚠️" : "🔴";

    return [
      `${statusEmoji} **コンテキスト状態**`,
      `モデル: \`${this.modelKey}\` (${limits.maxTokens.toLocaleString()}tok)`,
      `使用率: ${stats.usagePercent}% (${stats.estimatedTokens.toLocaleString()} / ${limits.maxTokens.toLocaleString()} tok)`,
      `メッセージ数: ${stats.totalMessages}`,
      `システム: ${stats.systemPromptTokens.toLocaleString()} | ユーザー: ${stats.userTokens.toLocaleString()}`,
      `アシスタント: ${stats.assistantTokens.toLocaleString()} | ツール: ${stats.toolTokens.toLocaleString()}`,
      `圧縮状態: ${stats.isCompressed ? "✅ 圧縮済み" : "❌ 未圧縮"}`,
      status.suggestion ? `\n💡 ${status.suggestion}` : "",
    ].filter(Boolean).join("\n");
  }
}

// ==================== シングルトン ====================

export const contextManager = new ContextManager();
