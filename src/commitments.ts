// ==========================================
// Hikamer - Commitments System（OpenClaw commitments/ 由来）
// 会話から約束・期限・フォローアップを自動抽出、追跡、通知
// ==========================================

import { logger } from "./utils/logger";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";

// ==================== 型定義 ====================

export type CommitmentKind = "event_check_in" | "deadline_check" | "care_check_in" | "open_loop";
export type CommitmentSensitivity = "routine" | "personal" | "care";
export type CommitmentStatus = "pending" | "sent" | "dismissed" | "snoozed" | "expired";
export type CommitmentSource = "inferred_user_context" | "agent_promise";

export interface CommitmentScope {
  agentId: string;
  sessionKey: string;
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  senderId?: string;
}

export interface CommitmentDueWindow {
  earliestMs: number;
  latestMs: number;
  timezone: string;
}

export interface CommitmentRecord extends CommitmentScope {
  id: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  status: CommitmentStatus;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: CommitmentDueWindow;
  sourceMessageId?: string;
  sourceRunId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  lastAttemptAtMs?: number;
  sentAtMs?: number;
  dismissedAtMs?: number;
  snoozedUntilMs?: number;
  expiredAtMs?: number;
}

export interface CommitmentStoreFile {
  version: number;
  commitments: CommitmentRecord[];
}

export interface CommitmentCandidate {
  itemId: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: {
    earliest: string;
    latest?: string;
    timezone?: string;
  };
}

export interface CommitmentExtractionItem extends CommitmentScope {
  itemId: string;
  nowMs: number;
  timezone: string;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  existingPending: Array<{
    kind: CommitmentKind;
    reason: string;
    dedupeKey: string;
    earliestMs: number;
    latestMs: number;
  }>;
}

export interface CommitmentExtractionBatchResult {
  candidates: CommitmentCandidate[];
}

export interface CommitmentsConfig {
  enabled: boolean;
  maxPerDay: number;
  extraction: {
    debounceMs: number;
    batchMaxItems: number;
    queueMaxItems: number;
    confidenceThreshold: number;
    careConfidenceThreshold: number;
    timeoutSeconds: number;
  };
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: CommitmentsConfig = {
  enabled: true,
  maxPerDay: 3,
  extraction: {
    debounceMs: 15000,
    batchMaxItems: 8,
    queueMaxItems: 64,
    confidenceThreshold: 0.72,
    careConfidenceThreshold: 0.86,
    timeoutSeconds: 45,
  },
};

const EXPIRE_AFTER_MS = 72 * 60 * 60 * 1000; // 72h after latestMs

// ==================== 内部状態 ====================

interface ExtractionQueueItem extends CommitmentScope {
  cfg?: Partial<CommitmentsConfig>;
  nowMs?: number;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
}

interface LoadedStore {
  store: CommitmentStoreFile;
  hasLegacy: boolean;
  path: string;
}

let extractionQueue: ExtractionQueueItem[] = [];
let queueTimer: ReturnType<typeof setTimeout> | null = null;
let queueDraining = false;
let queueOverflowWarned = false;
const cooldowns = new Map<string, number>(); // agentId → cooldown until

// ==================== ユーティリティ ====================

function commitmentStoreDir(storePath?: string): string {
  const base = storePath || process.env.DATA_DIR || "./data";
  return resolve(base, "commitments");
}

function commitmentStorePath(storePath?: string): string {
  return resolve(commitmentStoreDir(storePath), "commitments.json");
}

function emptyStore(): CommitmentStoreFile {
  return { version: 1, commitments: [] };
}

function generateId(nowMs: number): string {
  const ts = nowMs.toString(36);
  const rand = randomBytes(5).toString("hex");
  return `cm_${ts}_${rand}`;
}

function scopeKey(scope: CommitmentScope): string {
  return [scope.agentId, scope.sessionKey, scope.channel, scope.accountId || "", scope.to || "", scope.threadId || "", scope.senderId || ""].join("\x1f");
}

function isActiveStatus(status: CommitmentStatus): boolean {
  return status === "pending" || status === "snoozed";
}

const KIND_VALUES = new Set<CommitmentKind>(["event_check_in", "deadline_check", "care_check_in", "open_loop"]);
const SENSITIVITY_VALUES = new Set<CommitmentSensitivity>(["routine", "personal", "care"]);
const SOURCE_VALUES = new Set<CommitmentSource>(["inferred_user_context", "agent_promise"]);

function coerceCommitment(raw: Record<string, unknown>): CommitmentRecord | undefined {
  try {
    const kind = raw.kind as CommitmentKind;
    if (!KIND_VALUES.has(kind)) return undefined;
    const sensitivity = raw.sensitivity as CommitmentSensitivity;
    if (!SENSITIVITY_VALUES.has(sensitivity)) return undefined;
    const source = raw.source as CommitmentSource;
    if (!SOURCE_VALUES.has(source)) return undefined;

    const dueWindow = raw.dueWindow as Record<string, unknown>;
    if (!dueWindow || typeof dueWindow.earliestMs !== "number" || typeof dueWindow.latestMs !== "number") return undefined;
    if (dueWindow.latestMs < dueWindow.earliestMs) return undefined;

    return raw as unknown as CommitmentRecord;
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ==================== ストア ====================

function loadStoreFromDisk(storePath?: string): LoadedStore {
  const filePath = commitmentStorePath(storePath);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    const store = emptyStore();
    writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
    return { store, hasLegacy: false, path: filePath };
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const store: CommitmentStoreFile = { version: raw.version || 1, commitments: [] };
    let hasLegacy = false;

    if (Array.isArray(raw.commitments)) {
      store.commitments = raw.commitments
        .map((c: unknown) => coerceCommitment(c as Record<string, unknown>))
        .filter((c: CommitmentRecord | undefined): c is CommitmentRecord => c !== undefined);

      hasLegacy = raw.commitments.some(
        (c: Record<string, unknown>) => typeof c.sourceUserText === "string" || typeof c.sourceAssistantText === "string",
      );
    }

    return { store, hasLegacy, path: filePath };
  } catch (e) {
    logger.warn(`[Commitments] ストア読み込みエラー、初期化: ${e}`);
    const store = emptyStore();
    writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
    return { store, hasLegacy: false, path: filePath };
  }
}

function saveStore(store: CommitmentStoreFile, storePath?: string): void {
  const filePath = commitmentStorePath(storePath);
  mkdirSync(dirname(filePath), { recursive: true });
  // Clean legacy fields before write
  const clean = {
    version: store.version,
    commitments: store.commitments.map((c) => {
      const { ...rest } = c as Record<string, unknown>;
      delete rest.sourceUserText;
      delete rest.sourceAssistantText;
      return rest as CommitmentRecord;
    }),
  };
  writeFileSync(filePath, JSON.stringify(clean, null, 2), "utf-8");
}

function expireStale(store: CommitmentStoreFile, nowMs: number): boolean {
  let changed = false;
  for (const c of store.commitments) {
    if (isActiveStatus(c.status) && c.dueWindow.latestMs + EXPIRE_AFTER_MS < nowMs) {
      c.status = "expired";
      c.expiredAtMs = nowMs;
      c.updatedAtMs = nowMs;
      changed = true;
    }
  }
  return changed;
}

// ==================== 公開API ====================

export function loadCommitmentStore(storePath?: string): CommitmentStoreFile {
  const { store } = loadStoreFromDisk(storePath);
  return store;
}

export function saveCommitmentStore(store: CommitmentStoreFile, storePath?: string): void {
  const nowMs = Date.now();
  expireStale(store, nowMs);
  saveStore(store, storePath);
}

export function listPendingForScope(
  scope: CommitmentScope,
  options?: { limit?: number; storePath?: string; nowMs?: number },
): CommitmentRecord[] {
  const { store } = loadStoreFromDisk(options?.storePath);
  const nowMs = options?.nowMs ?? Date.now();
  const scopeStr = scopeKey(scope);

  return store.commitments
    .filter((c) => {
      if (scopeKey(c) !== scopeStr) return false;
      if (!isActiveStatus(c.status)) return false;
      if (c.status === "snoozed" && (c.snoozedUntilMs ?? 0) > nowMs) return false;
      return true;
    })
    .sort((a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs)
    .slice(0, options?.limit ?? 20);
}

export function upsertCommitments(
  scope: CommitmentScope,
  candidates: CommitmentCandidate[],
  options?: { storePath?: string; nowMs?: number },
): CommitmentRecord[] {
  const nowMs = options?.nowMs ?? Date.now();
  const { store, path } = loadStoreFromDisk(options?.storePath);
  const scopeStr = scopeKey(scope);
  const created: CommitmentRecord[] = [];

  for (const cand of candidates) {
    const earliestMs = new Date(cand.dueWindow.earliest).getTime();
    const latestMs = cand.dueWindow.latest ? new Date(cand.dueWindow.latest).getTime() : earliestMs + 12 * 60 * 60 * 1000;
    const timezone = cand.dueWindow.timezone ?? "UTC";
    const dedupeKey = `${scopeStr}:${cand.dedupeKey}`;

    // 重複チェック
    const existing = store.commitments.find(
      (c) => `${scopeKey(c)}:${c.dedupeKey}` === dedupeKey && isActiveStatus(c.status),
    );

    if (existing) {
      existing.reason = cand.reason;
      existing.suggestedText = cand.suggestedText;
      existing.confidence = Math.max(existing.confidence, cand.confidence);
      existing.dueWindow = { earliestMs, latestMs, timezone };
      existing.updatedAtMs = nowMs;
    } else {
      const record: CommitmentRecord = {
        id: generateId(nowMs),
        ...scope,
        kind: cand.kind,
        sensitivity: cand.sensitivity,
        source: cand.source,
        status: "pending",
        reason: cand.reason,
        suggestedText: cand.suggestedText,
        dedupeKey: cand.dedupeKey,
        confidence: cand.confidence,
        dueWindow: { earliestMs, latestMs, timezone },
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        attempts: 0,
      };
      store.commitments.push(record);
      created.push(record);
    }
  }

  saveStore(store, options?.storePath);
  return created;
}

export function listDueForSession(
  agentId: string,
  sessionKey: string,
  options?: { limit?: number; storePath?: string; nowMs?: number; maxPerDay?: number },
): CommitmentRecord[] {
  const nowMs = options?.nowMs ?? Date.now();
  const { store } = loadStoreFromDisk(options?.storePath);
  const maxPerDay = options?.maxPerDay ?? DEFAULT_CONFIG.maxPerDay;

  // 今日送信済みの数をカウント
  const sentToday = store.commitments.filter(
    (c) => c.agentId === agentId && c.sessionKey === sessionKey && c.status === "sent" && (c.sentAtMs ?? 0) > nowMs - 86400000,
  ).length;

  const remaining = Math.max(0, maxPerDay - sentToday);
  if (remaining <= 0) return [];

  return store.commitments
    .filter((c) => {
      if (c.agentId !== agentId || c.sessionKey !== sessionKey) return false;
      if (!isActiveStatus(c.status)) return false;
      if (c.dueWindow.earliestMs > nowMs) return false;
      if (c.dueWindow.latestMs + EXPIRE_AFTER_MS < nowMs) return false;
      if (c.status === "snoozed" && (c.snoozedUntilMs ?? 0) > nowMs) return false;
      return true;
    })
    .sort((a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs)
    .slice(0, remaining);
}

export function markAttempted(ids: string[], options?: { storePath?: string; nowMs?: number }): void {
  const nowMs = options?.nowMs ?? Date.now();
  const { store, path } = loadStoreFromDisk(options?.storePath);
  let changed = false;

  for (const c of store.commitments) {
    if (ids.includes(c.id) && isActiveStatus(c.status)) {
      c.attempts++;
      c.lastAttemptAtMs = nowMs;
      c.updatedAtMs = nowMs;
      changed = true;
    }
  }

  if (changed) saveStore(store, options?.storePath);
}

export function markStatus(
  ids: string[],
  status: "sent" | "dismissed" | "expired",
  options?: { storePath?: string; nowMs?: number },
): void {
  const nowMs = options?.nowMs ?? Date.now();
  const { store, path } = loadStoreFromDisk(options?.storePath);
  let changed = false;

  for (const c of store.commitments) {
    if (ids.includes(c.id) && isActiveStatus(c.status)) {
      c.status = status;
      c.updatedAtMs = nowMs;
      if (status === "sent") c.sentAtMs = nowMs;
      if (status === "dismissed") c.dismissedAtMs = nowMs;
      if (status === "expired") c.expiredAtMs = nowMs;
      changed = true;
    }
  }

  if (changed) saveStore(store, options?.storePath);
}

export function listAllCommitments(options?: { status?: CommitmentStatus; agentId?: string; storePath?: string }): CommitmentRecord[] {
  const { store } = loadStoreFromDisk(options?.storePath);
  return store.commitments
    .filter((c) => {
      if (options?.status && c.status !== options.status) return false;
      if (options?.agentId && c.agentId !== options.agentId) return false;
      return true;
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// ==================== 抽出パイプライン（会話→候補） ====================

/** プロンプト構築（LLMからCommitmentCandidateを抽出） */
export function buildExtractionPrompt(items: CommitmentExtractionItem[]): string {
  const lines: string[] = [
    "あなたは会話から約束・期限・フォローアップを抽出するアシスタントです。",
    "指示: 以下の会話ターンから、ユーザーが言及した約束、期限、チェックイン予定を抽出し、JSONで出力してください。",
    "ルール:",
    "- 明示的な約束や期限のみを抽出（「今度」「いつか」は除外）",
    "- リマインダー依頼（「忘れないで」「リマインドして」）は除外",
    "- 各候補のdedupeKeyはユニークに（内容の要約ハッシュとして）",
    "- 確信度(confidence)は0.0〜1.0で、曖昧なものは低く",
    "- care_check_inは高い確信度(0.86以上)が必要",
    "- dueWindow.earliestはISO8601形式（例: 2026-05-20T15:00:00+09:00）",
    "- dueWindow.latestは省略可（省略時はearliest+12h）",
    "",
    "出力形式: {\"candidates\": [{\"itemId\": \"...\", \"kind\": \"deadline_check\"|\"event_check_in\"|\"care_check_in\"|\"open_loop\", \"sensitivity\": \"routine\"|\"personal\"|\"care\", \"source\": \"inferred_user_context\"|\"agent_promise\", \"reason\": \"短い理由\", \"suggestedText\": \"フォローアップメッセージ案\", \"dedupeKey\": \"一意キー\", \"confidence\": 0.85, \"dueWindow\": {\"earliest\": \"ISO8601\", \"latest?\": \"ISO8601\", \"timezone?\": \"Asia/Tokyo\"}}]}",
    "",
    ...items.map((item, i) => {
      const pendingStr = item.existingPending.length > 0
        ? `\n既存の保留中約束:\n${item.existingPending.map(p => `  - ${p.kind}: ${p.reason} (${new Date(p.earliestMs).toISOString()}〜${new Date(p.latestMs).toISOString()})`).join("\n")}`
        : "";
      return [
        `--- Item ${i + 1} (id: ${item.itemId}) ---`,
        `現在時刻: ${new Date(item.nowMs).toISOString()}`,
        `タイムゾーン: ${item.timezone}`,
        `ユーザー: ${item.userText}`,
        item.assistantText ? `アシスタント: ${item.assistantText}` : "",
        pendingStr,
      ].filter(Boolean).join("\n");
    }),
  ];

  return lines.join("\n");
}

/** LLM出力から候補をパース */
export function parseExtractionOutput(raw: string): CommitmentExtractionBatchResult {
  const candidates: CommitmentCandidate[] = [];

  try {
    // 直接JSONパース試行
    const parsed = JSON.parse(raw);
    if (parsed.candidates && Array.isArray(parsed.candidates)) {
      for (const cand of parsed.candidates) {
        if (cand.action === "skip") continue;
        const parsed_candidate = coerceCandidate(cand);
        if (parsed_candidate) candidates.push(parsed_candidate);
      }
    }
    return { candidates };
  } catch {
    // JSON抽出失敗 → bracesマッチングでJSONオブジェクトを探す
    const jsonObjects = extractJsonObjects(raw);
    for (const jsonStr of jsonObjects) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.candidates && Array.isArray(parsed.candidates)) {
          for (const cand of parsed.candidates) {
            if (cand.action === "skip") continue;
            const parsed_candidate = coerceCandidate(cand);
            if (parsed_candidate) candidates.push(parsed_candidate);
          }
        }
      } catch { /* skip malformed JSON */ }
    }
    return { candidates };
  }
}

function coerceCandidate(raw: Record<string, unknown>): CommitmentCandidate | undefined {
  if (!raw.itemId || !raw.kind || !raw.reason || !raw.suggestedText || !raw.dedupeKey) return undefined;
  const kind = raw.kind as string;
  if (!KIND_VALUES.has(kind as CommitmentKind)) return undefined;
  if (typeof raw.confidence !== "number") return undefined;
  return {
    itemId: raw.itemId as string,
    kind: kind as CommitmentKind,
    sensitivity: (raw.sensitivity as CommitmentSensitivity) || "routine",
    source: (raw.source as CommitmentSource) || "inferred_user_context",
    reason: raw.reason as string,
    suggestedText: raw.suggestedText as string,
    dedupeKey: raw.dedupeKey as string,
    confidence: raw.confidence as number,
    dueWindow: {
      earliest: (raw.dueWindow as Record<string, unknown>)?.earliest as string || new Date().toISOString(),
      latest: (raw.dueWindow as Record<string, unknown>)?.latest as string | undefined,
      timezone: (raw.dueWindow as Record<string, unknown>)?.timezone as string | undefined,
    },
  };
}

function extractJsonObjects(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        result.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return result;
}

/** 候補の検証 */
export function validateCandidates(
  items: CommitmentExtractionItem[],
  result: CommitmentExtractionBatchResult,
  nowMs?: number,
): Array<{ item: CommitmentExtractionItem; candidates: CommitmentCandidate[] }> {
  const n = nowMs ?? Date.now();
  const itemIds = new Set(items.map((i) => i.itemId));
  const validItemIds = new Set(
    result.candidates
      .filter((c) => itemIds.has(c.itemId))
      .map((c) => c.itemId),
  );

  const grouped = new Map<string, CommitmentCandidate[]>();
  for (const c of result.candidates) {
    if (!itemIds.has(c.itemId)) continue;
    if (c.confidence < DEFAULT_CONFIG.extraction.confidenceThreshold) continue;
    if (c.sensitivity === "care" && c.confidence < DEFAULT_CONFIG.extraction.careConfidenceThreshold) continue;

    const earliestMs = new Date(c.dueWindow.earliest).getTime();
    if (isNaN(earliestMs) || earliestMs <= n) continue; // 未来の時刻のみ

    if (!grouped.has(c.itemId)) grouped.set(c.itemId, []);
    grouped.get(c.itemId)!.push(c);
  }

  return items
    .filter((item) => grouped.has(item.itemId))
    .map((item) => ({ item, candidates: grouped.get(item.itemId)! }));
}

// ==================== キュー管理 ====================

/** コミットメント抽出をキューに追加 */
export function enqueueExtraction(input: ExtractionQueueItem): boolean {
  if (!DEFAULT_CONFIG.enabled) return false;

  // クールダウンチェック
  const cooldownUntil = cooldowns.get(input.agentId) ?? 0;
  if (Date.now() < cooldownUntil) return false;

  // テキストチェック
  if (!input.userText?.trim() || !input.assistantText?.trim()) return false;

  // キューサイズ制限
  if (extractionQueue.length >= DEFAULT_CONFIG.extraction.queueMaxItems) {
    if (!queueOverflowWarned) {
      logger.warn(`[Commitments] 抽出キューオーバーフロー (max=${DEFAULT_CONFIG.extraction.queueMaxItems})`);
      queueOverflowWarned = true;
    }
    return false;
  }

  extractionQueue.push(input);
  queueOverflowWarned = false;

  // デバウンスタイマー
  if (!queueTimer) {
    queueTimer = setTimeout(() => {
      drainQueue().catch((e) => logger.error(`[Commitments] ドレインエラー: ${e}`));
    }, DEFAULT_CONFIG.extraction.debounceMs);
  }

  return true;
}

/** キューをドレインして抽出実行 */
export async function drainQueue(
  customConfig?: Partial<CommitmentsConfig>,
): Promise<number> {
  if (queueDraining) return 0;
  queueDraining = true;
  queueTimer = null;

  const cfg = { ...DEFAULT_CONFIG.extraction, ...customConfig?.extraction };
  const batch = extractionQueue.splice(0, cfg.batchMaxItems);

  try {
    if (batch.length === 0) return 0;

    const nowMs = Date.now();
    const items: CommitmentExtractionItem[] = batch.map((input) => {
      const scope: CommitmentScope = {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        channel: input.channel,
        accountId: input.accountId,
        to: input.to,
        threadId: input.threadId,
        senderId: input.senderId,
      };

      return {
        ...scope,
        itemId: `ext_${nowMs.toString(36)}_${randomBytes(3).toString("hex")}`,
        nowMs,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        userText: input.userText,
        assistantText: input.assistantText,
        sourceMessageId: input.sourceMessageId,
        sourceRunId: input.sourceRunId,
        existingPending: listPendingForScope(scope).map((c) => ({
          kind: c.kind,
          reason: c.reason,
          dedupeKey: c.dedupeKey,
          earliestMs: c.dueWindow.earliestMs,
          latestMs: c.dueWindow.latestMs,
        })),
      };
    });

    const prompt = buildExtractionPrompt(items);

    // LLM呼び出し（外部に委譲）
    const result = await callCommitmentExtractionLLM(prompt, cfg.timeoutSeconds);
    const parsed = parseExtractionOutput(result);
    const validated = validateCandidates(items, parsed, nowMs);

    for (const { item, candidates } of validated) {
      const scope: CommitmentScope = {
        agentId: item.agentId,
        sessionKey: item.sessionKey,
        channel: item.channel,
        accountId: item.accountId,
        to: item.to,
        threadId: item.threadId,
        senderId: item.senderId,
      };
      upsertCommitments(scope, candidates);
    }

    return validated.reduce((sum, v) => sum + v.candidates.length, 0);
  } finally {
    queueDraining = false;

    // まだキューに残りがあれば再スケジュール
    if (extractionQueue.length > 0) {
      queueTimer = setTimeout(() => {
        drainQueue(customConfig).catch((e) => logger.error(`[Commitments] ドレインエラー: ${e}`));
      }, cfg.debounceMs);
    }
  }
}

/** LLM呼び出し（デフォルトはエラーハンドリング付きプレースホルダー） */
let commitmentExtractionLLM: ((prompt: string, timeoutSeconds: number) => Promise<string>) | null = null;

export function setCommitmentExtractionLLM(fn: (prompt: string, timeoutSeconds: number) => Promise<string>): void {
  commitmentExtractionLLM = fn;
}

async function callCommitmentExtractionLLM(prompt: string, timeoutSeconds: number): Promise<string> {
  if (commitmentExtractionLLM) {
    return commitmentExtractionLLM(prompt, timeoutSeconds);
  }
  // デフォルト：ダミー実装（実際の使用時はsetCommitmentExtractionLLMで注入）
  return JSON.stringify({ candidates: [] });
}

// ==================== コマンド出力 ====================

export function formatCommitments(
  commitments: CommitmentRecord[],
  verbose = false,
): string {
  if (commitments.length === 0) return "📋 **約束・期限**: 保留中の項目はありません。";

  const lines: string[] = ["📋 **約束・期限**"];

  for (const c of commitments) {
    const kindIcon: Record<CommitmentKind, string> = {
      event_check_in: "📅",
      deadline_check: "⏰",
      care_check_in: "💚",
      open_loop: "🔄",
    };
    const statusIcon: Record<CommitmentStatus, string> = {
      pending: "⏳",
      sent: "✅",
      dismissed: "❌",
      snoozed: "💤",
      expired: "⌛",
    };

    lines.push("");
    lines.push(`${statusIcon[c.status] ?? "⏳"} ${kindIcon[c.kind] ?? "📌"} **${c.reason}**`);
    lines.push(`  📝 ${c.suggestedText.slice(0, 80)}`);
    lines.push(`  🎯 ${new Date(c.dueWindow.earliestMs).toLocaleString()} 〜 ${new Date(c.dueWindow.latestMs).toLocaleString()}`);
    lines.push(`  🔗 ${c.channel} / ${c.sessionKey}`);

    if (verbose) {
      lines.push(`  ID: ${c.id} | 確信度: ${(c.confidence * 100).toFixed(0)}% | 試行: ${c.attempts}`);
      lines.push(`  種別: ${c.kind} | 感度: ${c.sensitivity} | 作成: ${new Date(c.createdAtMs).toLocaleString()}`);
    }
  }

  return lines.join("\n");
}

export function setCooldown(agentId: string, durationMs = 900000): void {
  cooldowns.set(agentId, Date.now() + durationMs);
}

export function clearCooldown(agentId: string): void {
  cooldowns.delete(agentId);
}

export function getQueueStats(): { size: number; draining: boolean; cooldowns: number } {
  return {
    size: extractionQueue.length,
    draining: queueDraining,
    cooldowns: cooldowns.size,
  };
}
