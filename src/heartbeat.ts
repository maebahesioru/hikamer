// ==========================================
// Hikamer - Heartbeat + Planner Loop（OpenHuman heartbeat/ 由来）
// 定期的なバックグラウンドループで自律タスクを実行
// HEARTBEAT.mdファイル駆動・カレンダー・リマインダー連携
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { createHash } from "crypto";

// ==================== 型定義 ====================

export interface HeartbeatConfig {
  /** 心拍間隔（ms） */
  intervalMs: number;
  /** 初回遅延（ms） */
  initialDelayMs: number;
  /** HEARTBEAT.mdのパス */
  heartbeatPath: string;
  /** コミットメント自動抽出 */
  autoExtractCommitments: boolean;
  /** 自動ヒーリング */
  autoHeal: boolean;
}

export interface HeartbeatState {
  running: boolean;
  lastTick: number | null;
  nextTick: number | null;
  tickCount: number;
  config: HeartbeatConfig;
}

export type HeartbeatCategory =
  | "cron_reminder"
  | "calendar_meeting"
  | "relevant_notification"
  | "commitment_delivery"
  | "system_health";

export interface PendingEvent {
  id: string;
  category: HeartbeatCategory;
  title: string;
  preview: string;
  priority: number; // 0-100
  dueAt: number;
  source: string;
}

export interface PlannerRunSummary {
  timestamp: number;
  eventsProcessed: number;
  eventsDelivered: number;
  durationMs: number;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalMs: 300_000, // 5分
  initialDelayMs: 30_000, // 30秒
  heartbeatPath: "./HEARTBEAT.md",
  autoExtractCommitments: true,
  autoHeal: false,
};

// ==================== 内部状態 ====================

let state: HeartbeatState = {
  running: false,
  lastTick: null,
  nextTick: null,
  tickCount: 0,
  config: { ...DEFAULT_CONFIG },
};

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

// イベントストア（シンプルなJSON永続化）
interface EventStore {
  sentEventIds: string[];
  prunedAt: number;
}

function getStorePath(): string {
  return resolve(process.env.DATA_DIR || "./data", "heartbeat", "events.json");
}

function loadEventStore(): EventStore {
  const path = getStorePath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch { /* ignore */ }
  return { sentEventIds: [], prunedAt: Date.now() };
}

function saveEventStore(store: EventStore): void {
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), "utf-8");
}

function pruneSentEvents(store: EventStore): void {
  // 14日以上前のイベントを削除
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  store.sentEventIds = store.sentEventIds.filter(() => true); // keep all for now
  store.prunedAt = Date.now();
  saveEventStore(store);
}

function isAlreadySent(id: string, store: EventStore): boolean {
  return store.sentEventIds.includes(id);
}

function markSent(id: string, store: EventStore): void {
  if (!store.sentEventIds.includes(id)) {
    store.sentEventIds.push(id);
    saveEventStore(store);
  }
}

// ==================== プライマリ：心拍エンジン ====================

/** 最新のHEARTBEAT.mdを読み込む */
function loadHeartbeatMd(): string | null {
  const hbPath = resolve(state.config.heartbeatPath);
  if (!existsSync(hbPath)) return null;
  try {
    return readFileSync(hbPath, "utf-8");
  } catch {
    return null;
  }
}

/** タスクをコレクション */
function collectEvents(): PendingEvent[] {
  const events: PendingEvent[] = [];
  const now = Date.now();
  const store = loadEventStore();

  // 1. HEARTBEAT.mdからのタスク
  const hbContent = loadHeartbeatMd();
  if (hbContent) {
    const taskLines = hbContent.split("\n")
      .map((line) => line.replace(/^[#\s*-]+/, "").trim())
      .filter((line) => line.length > 10 && !line.startsWith("["));

    for (const task of taskLines) {
      const id = `hb_${createHash("sha256").update(task).digest("hex").slice(0, 12)}`;
      if (isAlreadySent(id, store)) continue;

      events.push({
        id,
        category: "cron_reminder",
        title: "HEARTBEATタスク",
        preview: task.slice(0, 120),
        priority: 50,
        dueAt: now,
        source: "HEARTBEAT.md",
      });
    }
  }

  // 2. コミットメント
  try {
    const { listDueForSession } = require("./commitments");
    // 汎用的なセッションキーでコミットメント取得
    const due = listDueForSession("hikamer", "heartbeat", { limit: 5 });
    for (const c of due) {
      const id = `cm_${c.id}`;
      if (isAlreadySent(id, store)) continue;

      events.push({
        id,
        category: "commitment_delivery",
        title: c.kind.replace(/_/g, " "),
        preview: c.suggestedText.slice(0, 120),
        priority: Math.round(c.confidence * 100),
        dueAt: c.dueWindow.earliestMs,
        source: "commitments",
      });
    }
  } catch { /* commitments not available */ }

  // 3. システムヘルス
  if (state.config.autoHeal) {
    events.push({
      id: `health_${now}`,
      category: "system_health",
      title: "定期ヘルスチェック",
      preview: "システム状態の自動確認",
      priority: 30,
      dueAt: now,
      source: "heartbeat",
    });
  }

  return events;
}

/** イベントを評価・ディスパッチ */
async function evaluateAndDispatch(): Promise<PlannerRunSummary> {
  const start = Date.now();
  const events = collectEvents();
  const store = loadEventStore();
  let delivered = 0;

  for (const event of events) {
    if (isAlreadySent(event.id, store)) continue;

    // 優先度フィルタ
    if (event.priority < 20) continue;

    // イベント発行
    eventBus.publish(createEvent("heartbeat", "event", {
      category: event.category,
      title: event.title,
      preview: event.preview,
      priority: event.priority,
    }));

    markSent(event.id, store);
    delivered++;
  }

  return {
    timestamp: Date.now(),
    eventsProcessed: events.length,
    eventsDelivered: delivered,
    durationMs: Date.now() - start,
  };
}

/** 心拍ティック */
async function tick(): Promise<void> {
  const tickStart = Date.now();
  state.lastTick = tickStart;
  state.tickCount++;

  try {
    const summary = await evaluateAndDispatch();

    // 自動ヒーリング
    if (state.config.autoHeal && state.tickCount % 12 === 0) {
      try {
        const { executeOperation, parseOperation, collectOverview } = await import("./crestodian");
        const overview = await collectOverview();
        if (!overview.config.valid) {
          await executeOperation(parseOperation("doctor-fix"), false);
        }
      } catch { /* crestodian not available */ }
    }

    logger.info(
      `[Heartbeat] tick #${state.tickCount}: ${summary.eventsDelivered}/${summary.eventsProcessed} events (${summary.durationMs}ms)`,
    );

    eventBus.publish(createEvent("heartbeat", "tick", {
      tickCount: state.tickCount,
      tickDurationMs: Date.now() - tickStart,
      eventsProcessed: summary.eventsProcessed,
      eventsDelivered: summary.eventsDelivered,
      plannerDurationMs: summary.durationMs,
    }));
  } catch (e: any) {
    logger.error(`[Heartbeat] tick error: ${e.message}`);
  }

  state.nextTick = Date.now() + state.config.intervalMs;
}

// ==================== 公開API ====================

/** 心拍開始 */
export function startHeartbeat(config?: Partial<HeartbeatConfig>): void {
  if (state.running) {
    logger.warn("[Heartbeat] 既に実行中");
    return;
  }

  if (config) {
    state.config = { ...DEFAULT_CONFIG, ...config };
  }

  state.running = true;
  logger.info(`[Heartbeat] 開始 (interval=${state.config.intervalMs}ms)`);

  // 初回遅延付き開始
  initialTimer = setTimeout(() => {
    tick().catch((e) => logger.error(`[Heartbeat] 初回tickエラー: ${e}`));
    timer = setInterval(() => {
      tick().catch((e) => logger.error(`[Heartbeat] tickエラー: ${e}`));
    }, state.config.intervalMs);
  }, state.config.initialDelayMs);

  eventBus.publish(createEvent("heartbeat", "started", { config: state.config }));
}

/** 心拍停止 */
export function stopHeartbeat(): void {
  if (!state.running) return;

  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);

  initialTimer = null;
  timer = null;
  state.running = false;
  state.nextTick = null;

  logger.info("[Heartbeat] 停止");
  eventBus.publish(createEvent("heartbeat", "stopped", {}));
}

/** 即時ティック実行 */
export async function tickNow(): Promise<PlannerRunSummary> {
  return evaluateAndDispatch();
}

/** 心拍状態取得 */
export function getHeartbeatState(): Readonly<HeartbeatState> {
  return { ...state };
}

/** 設定更新 */
export function setHeartbeatConfig(config: Partial<HeartbeatConfig>): void {
  state.config = { ...state.config, ...config };
  logger.info(`[Heartbeat] 設定更新: interval=${state.config.intervalMs}ms`);
}

/** HEARTBEAT.mdの内容を更新 */
export function writeHeartbeatMd(content: string): void {
  const hbPath = resolve(state.config.heartbeatPath);
  mkdirSync(dirname(hbPath), { recursive: true });
  writeFileSync(hbPath, content, "utf-8");
  logger.info(`[Heartbeat] HEARTBEAT.md更新: ${hbPath}`);
}

/** 心拍設定のフォーマット */
export function formatHeartbeatStatus(): string {
  const lines: string[] = [
    "💓 **Heartbeat Engine**",
    state.running ? "✅ 動作中" : "⏸️ 停止中",
    "",
  ];

  if (state.running) {
    lines.push(`**ティック**: #${state.tickCount}`);
    lines.push(`**最終実行**: ${state.lastTick ? new Date(state.lastTick).toLocaleString() : "未実行"}`);
    if (state.nextTick) {
      const remaining = Math.max(0, state.nextTick - Date.now());
      lines.push(`**次回**: ${new Date(state.nextTick).toLocaleString()} (${Math.round(remaining / 1000)}秒後)`);
    }
  }

  lines.push("");
  lines.push("**設定**:");
  lines.push(`  間隔: ${(state.config.intervalMs / 1000).toFixed(0)}秒`);
  lines.push(`  自動コミットメント抽出: ${state.config.autoExtractCommitments ? "ON" : "OFF"}`);
  lines.push(`  自動ヒーリング: ${state.config.autoHeal ? "ON" : "OFF"}`);
  lines.push(`  HEARTBEAT.md: ${resolve(state.config.heartbeatPath)}`);

  return lines.join("\n");
}
