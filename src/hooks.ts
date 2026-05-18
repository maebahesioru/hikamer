// ==========================================
// Aikata - エージェントフック（OpenHuman agent/hooks.rs 由来）
// ターン後処理・自己学習・テレメトリー発火
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

/** ターン完了時のスナップショット */
export interface TurnContext {
  /** ユーザーメッセージ */
  userMessage: string;
  /** アシスタントの最終応答 */
  assistantResponse: string;
  /** 実行されたツール呼び出しの記録 */
  toolCalls: ToolCallRecord[];
  /** ターンの実行時間（ms） */
  turnDurationMs: number;
  /** オプションのセッション識別子 */
  sessionId?: string;
  /** ターン中のLLM呼び出し回数 */
  iterationCount: number;
  /** ターンID */
  turnId: string;
  /** スレッドID */
  threadId?: string;
}

/** ツール呼び出しの記録 */
export interface ToolCallRecord {
  /** ツール名 */
  toolName: string;
  /** ツール呼び出しID */
  callId: string;
  /** 引数（JSON文字列） */
  args: string;
  /** 実行結果 */
  result: string;
  /** 実行時間（ms） */
  durationMs: number;
  /** 成功したか */
  success: boolean;
  /** エラーメッセージ（失敗時） */
  errorMessage?: string;
  /** 結果のトークン推定サイズ */
  resultTokens: number;
}

/** フックの優先度 */
export type HookPriority = "high" | "normal" | "low";

/** フックの実行結果 */
export interface HookResult {
  hookName: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

// ==================== フックインターフェース ====================

/**
 * エージェントフック
 * ターン完了後に非同期的に実行される
 */
export interface AgentHook {
  /** フック名 */
  name: string;
  /** 優先度 */
  priority: HookPriority;
  /** 有効/無効 */
  enabled: boolean;
  /** フック実行 */
  execute(context: TurnContext): Promise<void>;
}

// ==================== 組み込みフック ====================

/** 学習フック: ターン情報を学習システムに送る */
class LearningHook implements AgentHook {
  name = "learning";
  priority: HookPriority = "normal";
  enabled = true;

  async execute(context: TurnContext): Promise<void> {
    try {
      // 簡易的な学習ログ
      const toolSummary = context.toolCalls
        .map(
          (t) =>
            `${t.toolName}(${t.success ? "✅" : "❌"})[${t.durationMs}ms]`
        )
        .join(", ");

      logger.debug(
        `[Hook:learning] turn=${context.turnId.slice(0, 8)} ` +
          `tools=${context.toolCalls.length} ` +
          `iter=${context.iterationCount} ` +
          `duration=${context.turnDurationMs}ms ` +
          `tools: ${toolSummary}`
      );

      // 重要ツールの学習（永続化）
      const significantCalls = context.toolCalls.filter(
        (t) =>
          t.durationMs > 5000 || // 5秒以上かかったツール
          !t.success // 失敗したツール
      );

      if (significantCalls.length > 0) {
        for (const call of significantCalls) {
          logger.info(
            `[Hook:learning] significant tool call: ${call.toolName} ` +
              `${call.success ? "slow" : "failed"} ` +
              `(${call.durationMs}ms)` +
              (call.errorMessage ? `: ${call.errorMessage.slice(0, 200)}` : "")
          );
        }
      }
    } catch (err) {
      logger.error(`[Hook:learning] error:`, err);
    }
  }
}

/** テレメトリーフック: 使用統計を収集 */
class TelemetryHook implements AgentHook {
  name = "telemetry";
  priority: HookPriority = "low";
  enabled = true;

  private metrics = {
    totalTurns: 0,
    totalToolCalls: 0,
    totalDuration: 0,
    failedToolCalls: 0,
    slowToolCalls: 0,
    byTool: new Map<string, { calls: number; errors: number; totalMs: number }>(),
  };

  async execute(context: TurnContext): Promise<void> {
    this.metrics.totalTurns++;
    this.metrics.totalToolCalls += context.toolCalls.length;
    this.metrics.totalDuration += context.turnDurationMs;

    for (const call of context.toolCalls) {
      const entry = this.metrics.byTool.get(call.toolName) ?? {
        calls: 0,
        errors: 0,
        totalMs: 0,
      };
      entry.calls++;
      entry.totalMs += call.durationMs;
      if (!call.success) {
        entry.errors++;
        this.metrics.failedToolCalls++;
      }
      if (call.durationMs > 10000) {
        this.metrics.slowToolCalls++;
      }
      this.metrics.byTool.set(call.toolName, entry);
    }

    // 50ターンごとにサマリー出力
    if (this.metrics.totalTurns % 50 === 0) {
      this.printSummary();
    }
  }

  getMetrics() {
    return { ...this.metrics, byTool: new Map(this.metrics.byTool) };
  }

  private printSummary(): void {
    const avgDuration = Math.round(
      this.metrics.totalDuration / this.metrics.totalTurns
    );
    const topTools = [...this.metrics.byTool.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 5)
      .map(
        ([name, stats]) =>
          `${name}: ${stats.calls}回 (error=${stats.errors}, avg=${Math.round(stats.totalMs / stats.calls)}ms)`
      );

    logger.info(
      `[Hook:telemetry] === 統計 ===\n` +
        `  ターン: ${this.metrics.totalTurns}\n` +
        `  ツール呼出: ${this.metrics.totalToolCalls}\n` +
        `  平均時間: ${avgDuration}ms\n` +
        `  失敗: ${this.metrics.failedToolCalls}\n` +
        `  低速: ${this.metrics.slowToolCalls}\n` +
        `  Top5: ${topTools.join(" | ")}`
    );
  }
}

/** アラートフック: 異常を検知して通知 */
class AlertHook implements AgentHook {
  name = "alert";
  priority: HookPriority = "high";
  enabled = true;

  async execute(context: TurnContext): Promise<void> {
    // 異常検知ルール
    const alerts: string[] = [];

    // 1. ツールが大量に失敗
    const failedCount = context.toolCalls.filter((t) => !t.success).length;
    if (
      context.toolCalls.length >= 3 &&
      failedCount / context.toolCalls.length > 0.5
    ) {
      alerts.push(
        `ツール失敗率 ${Math.round((failedCount / context.toolCalls.length) * 100)}% ` +
          `(${failedCount}/${context.toolCalls.length})`
      );
    }

    // 2. ターンが異常に長い
    if (context.turnDurationMs > 120_000) {
      alerts.push(
        `異常なターン時間: ${(context.turnDurationMs / 1000).toFixed(1)}秒`
      );
    }

    // 3. イテレーションが多すぎる
    if (context.iterationCount > 15) {
      alerts.push(
        `過剰なイテレーション: ${context.iterationCount}回`
      );
    }

    // 4. 空の応答
    if (!context.assistantResponse?.trim() && context.toolCalls.length === 0) {
      alerts.push("空の応答（ツール実行なし）");
    }

    if (alerts.length > 0) {
      logger.warn(
        `[Hook:alert] turn=${context.turnId.slice(0, 8)} 異常検出:\n` +
          alerts.map((a) => `  ⚠ ${a}`).join("\n")
      );
    }
  }
}

/** パフォーマンストレーサーフック */
class TraceHook implements AgentHook {
  name = "trace";
  priority: HookPriority = "low";
  enabled = false; // デフォルトOFF（詳細すぎるため）

  async execute(context: TurnContext): Promise<void> {
    const timeline: string[] = [];
    for (const call of context.toolCalls) {
      timeline.push(
        `  ${call.toolName}: ${call.durationMs}ms ${call.success ? "✅" : "❌"}` +
          (call.resultTokens > 0 ? ` [${call.resultTokens}tok]` : "")
      );
    }

    logger.debug(
      `[Hook:trace] turn=${context.turnId.slice(0, 8)}\n` +
        `  user: ${context.userMessage.slice(0, 100)}...\n` +
        `  duration: ${context.turnDurationMs}ms\n` +
        timeline.join("\n")
    );
  }
}

// ==================== フックマネージャー ====================

class HookManager {
  private hooks: AgentHook[] = [];
  private pendingResults: HookResult[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;

    // 組み込みフックを登録
    this.register(new LearningHook());
    this.register(new TelemetryHook());
    this.register(new AlertHook());
    this.register(new TraceHook());

    this.initialized = true;
    logger.info(`[Hooks] initialized with ${this.hooks.length} hooks`);
  }

  /** フックを登録 */
  register(hook: AgentHook): void {
    this.hooks.push(hook);
    // 優先度でソート
    this.hooks.sort((a, b) => {
      const order = { high: 0, normal: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
  }

  /** フックを登録解除 */
  unregister(name: string): boolean {
    const idx = this.hooks.findIndex((h) => h.name === name);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  /** 全フックを実行（非同期・結果を待たない） */
  async executeAll(context: TurnContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    const enabledHooks = this.hooks.filter((h) => h.enabled);

    logger.debug(
      `[Hooks] executing ${enabledHooks.length} hooks for turn ${context.turnId.slice(0, 8)}`
    );

    for (const hook of enabledHooks) {
      const start = Date.now();
      try {
        await hook.execute(context);
        results.push({
          hookName: hook.name,
          success: true,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[Hooks] ${hook.name} failed: ${errorMsg}`);
        results.push({
          hookName: hook.name,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - start,
        });
      }
    }

    this.pendingResults.push(...results);
    // 最大100件まで保持
    if (this.pendingResults.length > 100) {
      this.pendingResults = this.pendingResults.slice(-100);
    }

    return results;
  }

  /** フック一覧 */
  listHooks(): { name: string; enabled: boolean; priority: HookPriority }[] {
    return this.hooks.map((h) => ({
      name: h.name,
      enabled: h.enabled,
      priority: h.priority,
    }));
  }

  /** フックの有効/無効を設定 */
  setEnabled(name: string, enabled: boolean): boolean {
    const hook = this.hooks.find((h) => h.name === name);
    if (!hook) return false;
    hook.enabled = enabled;
    logger.info(`[Hooks] ${name} ${enabled ? "有効化" : "無効化"}`);
    return true;
  }

  /** 直近の結果を取得 */
  getRecentResults(count = 10): HookResult[] {
    return this.pendingResults.slice(-count);
  }

  /** テレメトリーメトリクスを取得 */
  getTelemetry() {
    const telemetryHook = this.hooks.find(
      (h) => h.name === "telemetry"
    ) as TelemetryHook | undefined;
    return telemetryHook?.getMetrics() ?? null;
  }
}

// ==================== シングルトン ====================

export const hookManager = new HookManager();

// ==================== システムコマンド ====================

export function getHooksCommands(): Record<
  string,
  (args: string[]) => string
> {
  return {
    "/hooks": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "list":
        case "ls": {
          const hooks = hookManager.listHooks();
          if (hooks.length === 0) return "📭 フックがありません";
          return (
            `🪝 **フック一覧 (${hooks.length})**\n\n` +
            hooks
              .map(
                (h) =>
                  `- ${h.enabled ? "✅" : "⛔"} **${h.name}** (${h.priority})`
              )
              .join("\n")
          );
        }

        case "enable": {
          const name = args[1];
          if (!name) return "⚠️ フック名が必要です";
          return hookManager.setEnabled(name, true)
            ? `✅ ${name} を有効化しました`
            : `❌ フック ${name} が見つかりません`;
        }

        case "disable": {
          const name = args[1];
          if (!name) return "⚠️ フック名が必要です";
          return hookManager.setEnabled(name, false)
            ? `⛔ ${name} を無効化しました`
            : `❌ フック ${name} が見つかりません`;
        }

        case "results":
        case "log": {
          const results = hookManager.getRecentResults(10);
          if (results.length === 0) return "📭 フック実行履歴がありません";
          return (
            `📊 **フック実行履歴 (直近${results.length}件)**\n\n` +
            results
              .map(
                (r) =>
                  `${r.success ? "✅" : "❌"} **${r.hookName}** ` +
                  `(${r.durationMs}ms)` +
                  (r.error ? `: ${r.error}` : "")
              )
              .join("\n")
          );
        }

        case "telemetry":
        case "stats": {
          const metrics = hookManager.getTelemetry();
          if (!metrics) return "📭 テレメトリーデータがありません（まだ50ターン未満）";
          const avgMs = Math.round(metrics.totalDuration / metrics.totalTurns);
          return (
            `📊 **テレメトリー統計**\n` +
            `総ターン数: ${metrics.totalTurns}\n` +
            `総ツール呼出: ${metrics.totalToolCalls}\n` +
            `平均時間: ${avgMs}ms\n` +
            `失敗: ${metrics.failedToolCalls}\n` +
            `低速: ${metrics.slowToolCalls}\n` +
            `\n**ツール別**\n` +
            [...metrics.byTool.entries()]
              .sort((a, b) => b[1].calls - a[1].calls)
              .slice(0, 10)
              .map(
                ([name, stats]) =>
                  `- ${name}: ${stats.calls}回 (err=${stats.errors}, avg=${Math.round(stats.totalMs / stats.calls)}ms)`
              )
              .join("\n")
          );
        }

        default:
          return (
            `🪝 **フックコマンド**\n` +
            `/hooks list — フック一覧\n` +
            `/hooks enable <name> — フック有効化\n` +
            `/hooks disable <name> — フック無効化\n` +
            `/hooks results — 直近の実行結果\n` +
            `/hooks stats — テレメトリー統計`
          );
      }
    },
  };
}

export default HookManager;
