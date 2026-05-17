// ==========================================
// Aikata - セルフヒーリング（OpenHuman connectivity + heartbeat由来）
// 自動復旧・プロセス監視・障害対応
// ==========================================

import { execSync } from "child_process";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import { runHealthCheck } from "./health";

// ==================== 型定義 ====================

interface HealingAction {
  name: string;
  description: string;
  check: () => Promise<boolean>;
  heal: () => Promise<boolean>;
  cooldownMs: number;
  lastAttempt: number;
  maxRetries: number;
  retryCount: number;
}

type HealingReport = {
  timestamp: string;
  actions: Array<{
    name: string;
    success: boolean;
    detail: string;
    durationMs: number;
  }>;
  overall: "healthy" | "recovered" | "failed";
};

// ==================== ヒーリングアクション ====================

const HEALING_ACTIONS: HealingAction[] = [
  // === MCP接続復旧 ===
  {
    name: "mcp-reconnect",
    description: "MCPサーバー再接続",
    check: async () => {
      try {
        const { toolRegistry } = await import("./tools/registry");
        return toolRegistry.list().filter(t => t.name.startsWith("mcp_")).length === 0;
      } catch { return true; }
    },
    heal: async () => {
      try {
        const { connectAllMcpServers } = await import("./tools/mcp-client");
        await connectAllMcpServers();
        return true;
      } catch { return false; }
    },
    cooldownMs: 60000,
    lastAttempt: 0,
    maxRetries: 3,
    retryCount: 0,
  },

  // === プロセス過剰検出 ===
  {
    name: "zombie-cleanup",
    description: "ゾンビプロセス削除",
    check: async () => {
      try {
        const { processRegistry } = await import("./tools/process");
        return processRegistry.list().filter(p => p.status === "running").length > 20;
      } catch { return false; }
    },
    heal: async () => {
      try {
        const { processRegistry } = await import("./tools/process");
        for (const proc of processRegistry.list()) {
          if (proc.status === "running" && Date.now() - proc.startedAt > 3600000) {
            processRegistry.kill(proc.id);
          }
        }
        return true;
      } catch { return false; }
    },
    cooldownMs: 300000,
    lastAttempt: 0,
    maxRetries: 2,
    retryCount: 0,
  },

  // === ディスク容量 ===
  {
    name: "disk-cleanup",
    description: "ディスク容量復旧",
    check: async () => {
      try {
        const dataDir = process.env.DATA_DIR || "./data";
        const out = execSync(`df -k "${dataDir}" 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
        const parts = out.split(/\s+/);
        return parts.length >= 5 && parseInt(parts[4]!, 10) > 90;
      } catch { return false; }
    },
    heal: async () => {
      try {
        // 古いログ削除
        execSync("find ./data -name '*.log' -mtime +7 -delete 2>/dev/null || true", { timeout: 5000 });
        execSync("find ./data/tts -name '*.mp3' -mtime +1 -delete 2>/dev/null || true", { timeout: 5000 });
        execSync("find ./data/ocr -name '*.png' -mtime +1 -delete 2>/dev/null || true", { timeout: 5000 });
        return true;
      } catch { return false; }
    },
    cooldownMs: 3600000,
    lastAttempt: 0,
    maxRetries: 1,
    retryCount: 0,
  },
];

// ==================== ヒーリングエンジン ====================

class SelfHealer {
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private history: HealingReport[] = [];
  private maxHistory = 20;
  private actions: HealingAction[];

  constructor() {
    this.actions = HEALING_ACTIONS.map(a => ({ ...a }));
  }

  /** ヒーリングループ開始 */
  start(intervalMs: number = 60000): void {
    if (this.running) return;
    this.running = true;

    logger.info(`[Healer] 起動 (interval=${intervalMs}ms, ${this.actions.length}アクション)`);
    eventBus.publish(createEvent("system", "healerStarted", {
      actions: this.actions.map(a => a.name),
      intervalMs,
    }));

    this.interval = setInterval(() => this.heal(), intervalMs);

    // 初回は30秒後
    setTimeout(() => this.heal(), 30000);
  }

  /** ヒーリング実行 */
  private async heal(): Promise<void> {
    const timestamp = new Date().toISOString();
    const actionResults: HealingReport["actions"] = [];
    let hasIssues = false;

    for (const action of this.actions) {
      // クールダウンチェック
      if (Date.now() - action.lastAttempt < action.cooldownMs) continue;

      try {
        const start = Date.now();
        const needsHealing = await action.check();

        if (needsHealing) {
          hasIssues = true;
          logger.warn(`[Healer] 検出: ${action.name} — ${action.description}`);

          if (action.retryCount >= action.maxRetries) {
            actionResults.push({
              name: action.name,
              success: false,
              detail: "最大リトライ回数超過",
              durationMs: Date.now() - start,
            });
            continue;
          }

          const healed = await action.heal();
          action.lastAttempt = Date.now();
          action.retryCount = healed ? 0 : action.retryCount + 1;

          actionResults.push({
            name: action.name,
            success: healed,
            detail: healed ? "復旧成功" : `復旧失敗 (retry=${action.retryCount})`,
            durationMs: Date.now() - start,
          });

          if (healed) {
            logger.info(`[Healer] 復旧成功: ${action.name}`);
            eventBus.publish(createEvent("system", "healed", {
              action: action.name,
              detail: action.description,
            }));
          } else {
            logger.error(`[Healer] 復旧失敗: ${action.name}`);
          }
        }
      } catch (e: any) {
        logger.warn(`[Healer] チェックエラー: ${action.name} — ${e.message}`);
      }
    }

    if (actionResults.length > 0) {
      const report: HealingReport = {
        timestamp,
        actions: actionResults,
        overall: actionResults.every(a => a.success) ? "recovered" : "failed",
      };
      this.history.push(report);
      if (this.history.length > this.maxHistory) this.history.shift();
    }

    // 何も問題なければリトライカウンタをリセット（徐々に）
    if (!hasIssues) {
      for (const action of this.actions) {
        action.retryCount = Math.max(0, action.retryCount - 1);
      }
    }
  }

  /** 停止 */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    logger.info("[Healer] 停止");
  }

  /** カスタムアクション追加 */
  addAction(action: Omit<HealingAction, "lastAttempt" | "retryCount">): void {
    this.actions.push({ ...action, lastAttempt: 0, retryCount: 0 });
    logger.info(`[Healer] アクション追加: ${action.name}`);
  }

  /** フォーマット */
  formatStatus(): string {
    const lines: string[] = [];
    lines.push(`🩺 **セルフヒーリング**`);
    lines.push(`状態: ${this.running ? "✅ 動作中" : "⏸️ 停止中"}`);
    lines.push(`アクション: ${this.actions.length}件`);
    lines.push("");

    for (const action of this.actions) {
      const cooldownLeft = Math.max(0, action.cooldownMs - (Date.now() - action.lastAttempt));
      const cooldownStr = cooldownLeft > 0 ? ` (クールダウン: ${Math.round(cooldownLeft / 1000)}s)` : "";
      const retryStr = action.retryCount > 0 ? ` [リトライ${action.retryCount}/${action.maxRetries}]` : "";
      lines.push(`• **${action.description}**${retryStr}${cooldownStr}`);
    }

    const lastReport = this.history[this.history.length - 1];
    if (lastReport) {
      lines.push("");
      lines.push(`**最終レポート:** ${lastReport.overall}`);
      for (const a of lastReport.actions) {
        lines.push(`  ${a.success ? "✅" : "❌"} ${a.name}: ${a.detail} (${a.durationMs}ms)`);
      }
    }

    return lines.join("\n");
  }
}

// ==================== シングルトン ====================

export const selfHealer = new SelfHealer();
