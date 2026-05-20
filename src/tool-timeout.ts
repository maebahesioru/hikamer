// ==========================================
// Hikamer - ツールタイムアウト管理（OpenHuman tool_timeout/ 由来）
// ツールごとのタイムアウト設定・実行時間監視
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface ToolTimeoutConfig {
  toolName: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  warnThresholdMs: number;
  action: "warn" | "cancel" | "allow";
}

export interface ToolExecutionRecord {
  id: string;
  toolName: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  timeoutMs: number;
  status: "running" | "completed" | "timed_out" | "cancelled";
  error?: string;
}

export interface TimeoutStats {
  totalExecutions: number;
  completed: number;
  timedOut: number;
  cancelled: number;
  avgDurationMs: number;
  maxDurationMs: number;
  byTool: Record<string, { count: number; avgMs: number; timeouts: number }>;
}

// ==================== タイムアウト管理 ====================

class ToolTimeoutManager {
  private configs: Map<string, ToolTimeoutConfig> = new Map();
  private executions: ToolExecutionRecord[] = [];
  private maxRecords = 500;
  private initialized = false;

  // デフォルト設定
  private DEFAULT_CONFIGS: Record<string, Partial<ToolTimeoutConfig>> = {
    "terminal": { defaultTimeoutMs: 180000, maxTimeoutMs: 600000, warnThresholdMs: 120000 },
    "browser": { defaultTimeoutMs: 60000, maxTimeoutMs: 300000, warnThresholdMs: 45000 },
    "search": { defaultTimeoutMs: 30000, maxTimeoutMs: 60000, warnThresholdMs: 20000 },
    "web_fetch": { defaultTimeoutMs: 30000, maxTimeoutMs: 60000, warnThresholdMs: 20000 },
    "code": { defaultTimeoutMs: 60000, maxTimeoutMs: 300000, warnThresholdMs: 45000 },
    "image_gen": { defaultTimeoutMs: 120000, maxTimeoutMs: 300000, warnThresholdMs: 90000 },
    "default": { defaultTimeoutMs: 30000, maxTimeoutMs: 120000, warnThresholdMs: 20000 },
  };

  init(): void {
    if (this.initialized) return;
    this.loadDefaults();
    this.initialized = true;
    logger.info(`[ToolTimeout] initialized: ${this.configs.size} tools`);
  }

  /** ツールのタイムアウト設定を取得 */
  getConfig(toolName: string): ToolTimeoutConfig {
    return this.configs.get(toolName) ?? this.configs.get("default")!;
  }

  /** ツールのタイムアウト設定を更新 */
  setConfig(toolName: string, config: Partial<ToolTimeoutConfig>): void {
    const existing = this.getConfig(toolName);
    this.configs.set(toolName, { ...existing, ...config });
  }

  /** 実行を記録 */
  startExecution(toolName: string, timeoutOverride?: number): string {
    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const config = this.getConfig(toolName);

    const record: ToolExecutionRecord = {
      id,
      toolName,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      timeoutMs: timeoutOverride ?? config.defaultTimeoutMs,
      status: "running",
    };

    this.executions.push(record);
    if (this.executions.length > this.maxRecords) {
      this.executions = this.executions.slice(-this.maxRecords);
    }

    return id;
  }

  /** 実行完了を記録 */
  completeExecution(executionId: string): boolean {
    const record = this.executions.find((e) => e.id === executionId);
    if (!record || record.status !== "running") return false;

    record.endTime = Date.now();
    record.durationMs = record.endTime - record.startTime;
    record.status = "completed";
    return true;
  }

  /** 実行がタイムアウトしたかチェック */
  checkTimeout(executionId: string): "running" | "completed" | "timed_out" | "cancelled" {
    const record = this.executions.find((e) => e.id === executionId);
    if (!record) return "completed";

    if (record.status !== "running") return record.status;

    const elapsed = Date.now() - record.startTime;
    if (elapsed > record.timeoutMs) {
      record.status = "timed_out";
      record.endTime = Date.now();
      record.durationMs = elapsed;
      logger.warn(`[ToolTimeout] ${record.toolName} timed out after ${elapsed}ms`);
      return "timed_out";
    }

    // 警告閾値
    const config = this.getConfig(record.toolName);
    if (elapsed > config.warnThresholdMs && config.action === "warn") {
      // 警告はログのみ
    }

    return "running";
  }

  /** 実行をキャンセル */
  cancelExecution(executionId: string): boolean {
    const record = this.executions.find((e) => e.id === executionId);
    if (!record) return false;
    record.status = "cancelled";
    record.endTime = Date.now();
    record.durationMs = Date.now() - record.startTime;
    return true;
  }

  /** 実行中のツール一覧 */
  getRunningExecutions(): ToolExecutionRecord[] {
    return this.executions.filter((e) => e.status === "running");
  }

  /** 統計 */
  getStats(): TimeoutStats {
    const completed = this.executions.filter((e) => e.status === "completed");
    const timedOut = this.executions.filter((e) => e.status === "timed_out");
    const cancelled = this.executions.filter((e) => e.status === "cancelled");
    const allDurations = completed
      .map((e) => e.durationMs)
      .filter((d): d is number => d !== null);

    const byTool: Record<string, { count: number; avgMs: number; timeouts: number }> = {};
    for (const e of this.executions) {
      if (!byTool[e.toolName]) {
        byTool[e.toolName] = { count: 0, avgMs: 0, timeouts: 0 };
      }
      byTool[e.toolName]!.count++;
      if (e.durationMs) {
        const prev = byTool[e.toolName]!;
        prev.avgMs = (prev.avgMs * (prev.count - 1) + e.durationMs) / prev.count;
      }
      if (e.status === "timed_out") byTool[e.toolName]!.timeouts++;
    }

    return {
      totalExecutions: this.executions.length,
      completed: completed.length,
      timedOut: timedOut.length,
      cancelled: cancelled.length,
      avgDurationMs: allDurations.length > 0
        ? allDurations.reduce((s, d) => s + d, 0) / allDurations.length
        : 0,
      maxDurationMs: allDurations.length > 0 ? Math.max(...allDurations) : 0,
      byTool,
    };
  }

  /** 設定一覧 */
  listConfigs(): ToolTimeoutConfig[] {
    return Array.from(this.configs.values());
  }

  private loadDefaults(): void {
    for (const [toolName, config] of Object.entries(this.DEFAULT_CONFIGS)) {
      this.configs.set(toolName, {
        toolName,
        defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
        maxTimeoutMs: config.maxTimeoutMs ?? 120000,
        warnThresholdMs: config.warnThresholdMs ?? 20000,
        action: "warn",
      });
    }
  }

  formatStats(): string {
    const s = this.getStats();
    return (
      `⏱️ **ツールタイムアウト統計**\n` +
      `総実行: ${s.totalExecutions}\n` +
      `完了: ${s.completed}\n` +
      `タイムアウト: ${s.timedOut}\n` +
      `キャンセル: ${s.cancelled}\n` +
      `平均時間: ${(s.avgDurationMs / 1000).toFixed(1)}秒\n` +
      `最大時間: ${(s.maxDurationMs / 1000).toFixed(1)}秒\n\n` +
      (Object.keys(s.byTool).length > 0
        ? `**ツール別**\n` +
          Object.entries(s.byTool)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10)
            .map(
              ([name, st]) =>
                `- ${name}: ${st.count}回 (平均${(st.avgMs / 1000).toFixed(1)}秒, TO: ${st.timeouts})`
            )
            .join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const toolTimeoutManager = new ToolTimeoutManager();

export default ToolTimeoutManager;
