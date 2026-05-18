// ==========================================
// Aikata - トリアージ（OpenHuman agent/triage/ 由来）
// イベント分類パイプライン
// 受信メッセージの要/不要判定・ルーティング
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

/** トリガーエンベロープ（受信イベントをラップ） */
export interface TriggerEnvelope {
  id: string;
  type: "message" | "webhook" | "cron" | "system" | "notification";
  source: string;
  payload: Record<string, unknown>;
  receivedAt: number;
  priority: "low" | "normal" | "high" | "critical";
  metadata?: {
    userId?: string;
    channelId?: string;
    threadId?: string;
    platform?: string;
  };
}

/** トリアージ決定 */
export type TriageDecisionType =
  | "respond"      // 通常応答
  | "acknowledge"  // 簡単な確認のみ
  | "ignore"       // 無視（ノイズ）
  | "delegate"     // サブエージェントに委譲
  | "escalate"     // 上位にエスカレーション
  | "defer";       // 延期

export interface TriageDecision {
  type: TriageDecisionType;
  confidence: number; // 0.0-1.0
  reason: string;
  suggestedAction?: string;
  priority?: "low" | "normal" | "high" | "critical";
  deferUntilMs?: number;
  delegateTo?: string;
  metadata?: Record<string, unknown>;
}

/** トリアージ結果 */
export interface TriageResult {
  decision: TriageDecision;
  latencyMs: number;
  resolutionPath: "classifier" | "local" | "cloud";
}

/** トリアージルール */
export interface TriageRule {
  name: string;
  description: string;
  priority: number;
  /** マッチ条件（関数） */
  matcher: (envelope: TriggerEnvelope) => boolean;
  /** マッチ時の決定 */
  decision: TriageDecision;
  /** 有効/無効 */
  enabled: boolean;
}

// ==================== トリアージエンジン ====================

class TriageEngine {
  private rules: TriageRule[] = [];
  private initialized = false;
  private stats = {
    totalClassified: 0,
    responded: 0,
    acknowledged: 0,
    ignored: 0,
    delegated: 0,
    escalated: 0,
    deferred: 0,
    bySource: new Map<string, number>(),
  };

  init(): void {
    if (this.initialized) return;
    this.loadDefaultRules();
    this.initialized = true;
    logger.info(`[Triage] initialized with ${this.rules.length} rules`);
  }

  /**
   * エンベロープをトリアージ
   * ルールベースの分類 → 必要ならLLMによる詳細分類
   */
  async triage(envelope: TriggerEnvelope): Promise<TriageResult> {
    const start = Date.now();

    // Step 1: ルールベース分類
    const ruleResult = this.classifyByRules(envelope);
    if (ruleResult) {
      this.recordStats(ruleResult, envelope);
      return {
        decision: ruleResult,
        latencyMs: Date.now() - start,
        resolutionPath: "classifier",
      };
    }

    // Step 2: LLMによる分類（フォールバック）
    try {
      const llmDecision = await this.classifyByLLM(envelope);
      this.recordStats(llmDecision, envelope);
      return {
        decision: llmDecision,
        latencyMs: Date.now() - start,
        resolutionPath: "local",
      };
    } catch {
      // Step 3: デフォルト（確信が持てない場合は応答）
      const defaultDecision: TriageDecision = {
        type: "respond",
        confidence: 0.5,
        reason: "分類に失敗したためデフォルトで応答",
      };
      return {
        decision: defaultDecision,
        latencyMs: Date.now() - start,
        resolutionPath: "local",
      };
    }
  }

  /** 決定を適用（副作用を実行） */
  async applyDecision(
    decision: TriageDecision,
    envelope: TriggerEnvelope
  ): Promise<void> {
    eventBus.publish(
      createEvent("triage:decision", {
        envelopeId: envelope.id,
        decisionType: decision.type,
        reason: decision.reason,
        confidence: decision.confidence,
      })
    );

    switch (decision.type) {
      case "ignore":
        logger.debug(
          `[Triage] ignored ${envelope.id}: ${decision.reason}`
        );
        break;

      case "acknowledge":
        logger.info(
          `[Triage] acknowledged ${envelope.id}: ${decision.reason}`
        );
        break;

      case "respond":
        logger.info(
          `[Triage] will respond to ${envelope.id}: ${decision.reason}`
        );
        break;

      case "delegate":
        logger.info(
          `[Triage] delegating ${envelope.id} to ${decision.delegateTo}: ${decision.reason}`
        );
        break;

      case "escalate":
        logger.warn(
          `[Triage] escalating ${envelope.id}: ${decision.reason}`
        );
        break;

      case "defer": {
        const until = decision.deferUntilMs ?? Date.now() + 30000;
        logger.info(
          `[Triage] deferring ${envelope.id} until ${new Date(until).toISOString()}: ${decision.reason}`
        );
        // 実際の遅延処理は呼び出し元で
        break;
      }
    }
  }

  /** カスタムルールを登録 */
  addRule(rule: TriageRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
    logger.debug(`[Triage] added rule: ${rule.name}`);
  }

  /** ルールを削除 */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** ルール一覧を取得 */
  listRules(): { name: string; enabled: boolean; priority: number; description: string }[] {
    return this.rules.map((r) => ({
      name: r.name,
      enabled: r.enabled,
      priority: r.priority,
      description: r.description,
    }));
  }

  /** 統計を取得 */
  getStats() {
    return {
      ...this.stats,
      bySource: new Map(this.stats.bySource),
    };
  }

  // ---- ルールベース分類 ----

  private classifyByRules(envelope: TriggerEnvelope): TriageDecision | null {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try {
        if (rule.matcher(envelope)) {
          return rule.decision;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // ---- LLM分類（フォールバック） ----

  private async classifyByLLM(
    envelope: TriggerEnvelope
  ): Promise<TriageDecision> {
    // LLMエンドポイントがなければルールベースにフォールバック
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        type: "respond",
        confidence: 0.6,
        reason: "LLM分類が利用不可、デフォルトで応答",
      };
    }

    const payload = JSON.stringify(envelope.payload).slice(0, 1000);
    const prompt =
      `Classify this incoming ${envelope.type} from ${envelope.source}:\n\n` +
      `Payload: ${payload}\n\n` +
      `Choose: respond | acknowledge | ignore | delegate | escalate | defer\n` +
      `Respond with JSON: {"type": "...", "confidence": 0.0-1.0, "reason": "..."}`;

    try {
      const res = await fetch(
        process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "deepseek/deepseek-v4-flash",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 200,
          }),
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(text) as {
        type?: string;
        confidence?: number;
        reason?: string;
      };

      const validTypes: TriageDecisionType[] = [
        "respond", "acknowledge", "ignore", "delegate", "escalate", "defer",
      ];

      return {
        type: validTypes.includes(parsed.type as TriageDecisionType)
          ? (parsed.type as TriageDecisionType)
          : "respond",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reason: parsed.reason ?? "LLM分類結果",
      };
    } catch (err) {
      throw new Error(
        `LLM classification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- デフォルトルール ----

  private loadDefaultRules(): void {
    // 1. クリティカル優先度は常に応答
    this.addRule({
      name: "critical-priority",
      description: "クリティカル優先度のイベントは常に応答",
      priority: 100,
      matcher: (e) => e.priority === "critical",
      decision: {
        type: "respond",
        confidence: 1.0,
        reason: "クリティカル優先度イベント",
      },
      enabled: true,
    });

    // 2. システムイベントは確認のみ
    this.addRule({
      name: "system-acknowledge",
      description: "システムイベントは確認のみ",
      priority: 80,
      matcher: (e) => e.type === "system",
      decision: {
        type: "acknowledge",
        confidence: 0.9,
        reason: "システムイベント",
      },
      enabled: true,
    });

    // 3. cronトリガーは基本応答
    this.addRule({
      name: "cron-respond",
      description: "cronトリガーは応答",
      priority: 60,
      matcher: (e) => e.type === "cron",
      decision: {
        type: "respond",
        confidence: 0.8,
        reason: "定期実行トリガー",
      },
      enabled: true,
    });

    // 4. 低優先度・通知は確認のみ
    this.addRule({
      name: "low-priority-acknowledge",
      description: "低優先度は確認のみ",
      priority: 40,
      matcher: (e) => e.priority === "low",
      decision: {
        type: "acknowledge",
        confidence: 0.7,
        reason: "低優先度イベント",
      },
      enabled: true,
    });

    // 5. Webhook通知は種類による
    this.addRule({
      name: "webhook-check",
      description: "Webhookはペイロード内容で判断",
      priority: 30,
      matcher: (e) =>
        e.type === "webhook" && !e.payload?.action,
      decision: {
        type: "acknowledge",
        confidence: 0.6,
        reason: "アクション未指定のWebhook",
      },
      enabled: true,
    });
  }

  private recordStats(decision: TriageDecision, envelope: TriggerEnvelope): void {
    this.stats.totalClassified++;
    switch (decision.type) {
      case "respond":
        this.stats.responded++;
        break;
      case "acknowledge":
        this.stats.acknowledged++;
        break;
      case "ignore":
        this.stats.ignored++;
        break;
      case "delegate":
        this.stats.delegated++;
        break;
      case "escalate":
        this.stats.escalated++;
        break;
      case "defer":
        this.stats.deferred++;
        break;
    }
    const srcCount = this.stats.bySource.get(envelope.source) ?? 0;
    this.stats.bySource.set(envelope.source, srcCount + 1);
  }
}

// ==================== シングルトン ====================

export const triageEngine = new TriageEngine();

// ==================== システムコマンド ====================

export function getTriageCommands(): Record<string, (args: string[]) => string> {
  return {
    "/triage": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "rules":
        case "list": {
          const rules = triageEngine.listRules();
          if (rules.length === 0) return "📭 トリアージルールがありません";
          return (
            `📋 **トリアージルール (${rules.length})**\n\n` +
            rules
              .map(
                (r, i) =>
                  `${i + 1}. ${r.enabled ? "✅" : "⛔"} **${r.name}** (p${r.priority})\n   ${r.description}`
              )
              .join("\n")
          );
        }

        case "stats": {
          const stats = triageEngine.getStats();
          return (
            `📊 **トリアージ統計**\n` +
            `分類総数: ${stats.totalClassified}\n` +
            `応答: ${stats.responded}\n` +
            `確認: ${stats.acknowledged}\n` +
            `無視: ${stats.ignored}\n` +
            `委譲: ${stats.delegated}\n` +
            `エスカレーション: ${stats.escalated}\n` +
            `延期: ${stats.deferred}\n` +
            (stats.bySource.size > 0
              ? `\n**ソース別**\n` +
                [...stats.bySource.entries()]
                  .map(([src, count]) => `- ${src}: ${count}`)
                  .join("\n")
              : "")
          );
        }

        default:
          return (
            `📋 **トリアージコマンド**\n` +
            `/triage rules — ルール一覧\n` +
            `/triage stats — 統計\n`
          );
      }
    },
  };
}

export default TriageEngine;
