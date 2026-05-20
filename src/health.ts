// ==========================================
// Hikamer - ヘルス監視システム（OpenHuman health/connectivity由来）
// プロセス健全性チェック + 自動再起動
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { logger } from "./utils/logger";
import { getCostSummary } from "./cost-tracker";
import * as os from "os";

// ==================== 状態管理 ====================

interface HealthStatus {
  status: "healthy" | "degraded" | "down";
  uptime: number; // 秒
  startedAt: string;
  pid: number;
  memoryMB: number;
  cpuPercent: number;
  platform: string;
  nodeVersion: string;
  toolCount: number;
  sessionCount: number;
  costTotal: number;
  lastCheck: string;
  checks: HealthCheckResult[];
}

interface HealthCheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  durationMs: number;
}

const START_TIME = Date.now();
const HEALTH_PATH = resolve(process.env.DATA_DIR || "./data", "health.json");
let _cachedToolCount = 0;

export function setToolCount(n: number): void {
  _cachedToolCount = n;
}

// ==================== 個別チェック ====================

function checkMemory(): HealthCheckResult {
  const start = Date.now();
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);

  const status = heapUsedMB > 500 ? "warn" : "ok";
  return {
    name: "memory",
    status,
    detail: `heap: ${heapUsedMB}MB/${heapTotalMB}MB, RSS: ${rssMB}MB`,
    durationMs: Date.now() - start,
  };
}

function checkDisk(): HealthCheckResult {
  const start = Date.now();
  try {
    const dataDir = process.env.DATA_DIR || "./data";
    // df で使用率取得
    const dfOut = execSync(`df -k "${dataDir}" 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
    const parts = dfOut.split(/\s+/);
    if (parts.length >= 5) {
      const usedPercent = parseInt(parts[4], 10);
      const status = usedPercent > 90 ? "warn" : usedPercent > 95 ? "fail" : "ok";
      return {
        name: "disk",
        status,
        detail: `使用率: ${usedPercent}% (${parts[2]}KB/${parts[1]}KB)`,
        durationMs: Date.now() - start,
      };
    }
    return { name: "disk", status: "ok", detail: "取得不可", durationMs: Date.now() - start };
  } catch {
    return { name: "disk", status: "ok", detail: "チェックスキップ(Win)", durationMs: Date.now() - start };
  }
}

function checkEventLoop(): HealthCheckResult {
  const start = Date.now();
  return new Promise((resolve) => {
    // イベントループ遅延計測
    const checkDelay = Date.now();
    setImmediate(() => {
      const delay = Date.now() - checkDelay;
      const status = delay > 100 ? "warn" : delay > 500 ? "fail" : "ok";
      resolve({
        name: "eventloop",
        status,
        detail: `遅延: ${delay}ms`,
        durationMs: Date.now() - start,
      });
    });
    setTimeout(() => resolve({
      name: "eventloop",
      status: "warn",
      detail: "タイムアウト（50ms）",
      durationMs: Date.now() - start,
    }), 50);
  }) as unknown as HealthCheckResult;
}

async function checkCostHealth(): Promise<HealthCheckResult> {
  const start = Date.now();
  const summary = getCostSummary();
  const today = new Date().toISOString().slice(0, 10);
  const todayCost = summary.dailyCosts[today] || 0;

  const status = todayCost > 1.0 ? "warn" : "ok";
  return {
    name: "cost",
    status,
    detail: `総コスト: $${summary.totalCost.toFixed(4)}, 今日: $${todayCost.toFixed(4)}, 呼出: ${summary.totalCalls}`,
    durationMs: Date.now() - start,
  };
}

// ==================== メインチェック実行 ====================

export async function runHealthCheck(): Promise<HealthStatus> {
  const checks = await Promise.all([
    checkMemory(),
    checkDisk(),
    checkCostHealth(),
  ]);

  // eventloopは同期Promiseで
  const eventLoopCheck = checkEventLoop();
  checks.push(eventLoopCheck);

  const failCount = checks.filter(c => c.status === "fail").length;
  const warnCount = checks.filter(c => c.status === "warn").length;

  let overall: "healthy" | "degraded" | "down" = "healthy";
  if (failCount > 0) overall = "down";
  else if (warnCount > 0) overall = "degraded";

  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  const summary = getCostSummary();
  const totalMem = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const status: HealthStatus = {
    status: overall,
    uptime,
    startedAt: new Date(START_TIME).toISOString(),
    pid: process.pid,
    memoryMB: totalMem,
    cpuPercent: 0, // 簡易版：パス
    platform: process.platform,
    nodeVersion: process.version,
    toolCount: _cachedToolCount || 0,
    sessionCount: Object.keys(summary.sessions).length,
    costTotal: summary.totalCost,
    lastCheck: new Date().toISOString(),
    checks,
  };

  // 永続化
  try {
    const dir = dirname(HEALTH_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(HEALTH_PATH, JSON.stringify(status, null, 2), "utf-8");
  } catch {}

  return status;
}

// ==================== ウォッチドッグ ====================

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let lastErrorCount = 0;
let consecutiveErrors = 0;

interface ErrorEntry {
  message: string;
  timestamp: string;
  stack?: string;
}

const errorLog: ErrorEntry[] = [];

export function logError(err: Error | string): void {
  const msg = typeof err === "string" ? err : err.message;
  errorLog.push({
    message: msg,
    timestamp: new Date().toISOString(),
    stack: typeof err === "string" ? undefined : err.stack,
  });
  if (errorLog.length > 100) errorLog.shift();
  consecutiveErrors++;
}

export function clearErrorLog(): void {
  errorLog.length = 0;
  consecutiveErrors = 0;
}

/**
 * ウォッチドッグ起動
 * - 定期的にヘルスチェック
 * - エラー率が急増したら警告
 * - 深刻な状態ならプロセス再起動
 */
export function startWatchdog(
  options: {
    intervalMs?: number;
    onAlert?: (status: HealthStatus) => void;
    onRestart?: () => void;
  } = {},
): void {
  if (watchdogInterval) return;

  const intervalMs = options.intervalMs || 60000; // デフォルト1分

  watchdogInterval = setInterval(async () => {
    try {
      const status = await runHealthCheck();

      // エラー急増検出
      const recentErrors = errorLog.length;
      const errorDelta = recentErrors - lastErrorCount;
      lastErrorCount = recentErrors;

      if (consecutiveErrors > 10 && errorDelta > 5) {
        logger.warn(`[Watchdog] エラー急増: ${consecutiveErrors}回連続`);
        if (options.onAlert) options.onAlert(status);
      }

      // ダウン検出
      if (status.status === "down") {
        logger.error(`[Watchdog] 深刻な状態: ${JSON.stringify(status.checks.filter(c => c.status === "fail").map(c => c.name))}`);
        if (options.onAlert) options.onAlert(status);
        // 自動再起動
        if (options.onRestart) {
          logger.warn("[Watchdog] 自動再起動を試行…");
          options.onRestart();
        }
      }

      // degraded時は警告
      if (status.status === "degraded") {
        logger.warn(`[Watchdog] 警告状態: ${status.checks.filter(c => c.status === "warn").map(c => `${c.name}(${c.detail})`).join(", ")}`);
      }

      // エラーカウンタ減衰（時間経過でリセット）
      consecutiveErrors = Math.max(0, consecutiveErrors - 1);
    } catch (e: any) {
      logger.error(`[Watchdog] チェック中エラー: ${e.message}`);
    }
  }, intervalMs);

  logger.info(`[Watchdog] 起動 (interval=${intervalMs}ms)`);
}

export function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    logger.info("[Watchdog] 停止");
  }
}

// ==================== フォーマット ====================

export function formatHealth(status: HealthStatus): string {
  const emoji = status.status === "healthy" ? "✅" : status.status === "degraded" ? "⚠️" : "🚨";
  const uptimeStr = fmtDuration(status.uptime);

  const lines = [
    `${emoji} **Hikamer ヘルスステータス**`,
    `状態: \`${status.status}\``,
    `稼働時間: ${uptimeStr}`,
    `起動: ${status.startedAt}`,
    `PID: ${status.pid} | Node: ${status.nodeVersion} | ${status.platform}`,
    `メモリ: ${status.memoryMB}MB`,
    `ツール数: ${status.toolCount} | セッション数: ${status.sessionCount}`,
    `コスト: $${status.costTotal.toFixed(4)}`,
    "",
    "**個別チェック:**",
    ...status.checks.map(c => {
      const icon = c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
      return `${icon} **${c.name}**: ${c.detail} (${c.durationMs}ms)`;
    }),
  ];

  return lines.join("\n");
}

function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ==================== コマンド応答 ====================

export async function handleHealthCommand(): Promise<string> {
  const status = await runHealthCheck();
  return formatHealth(status);
}
