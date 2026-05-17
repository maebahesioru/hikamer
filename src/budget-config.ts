// ==========================================
// Aikata - トークンバジェット（Hermes Agent由来）
// ツール結果のサイズ制限をツール単位で設定可能に
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型 ====================

export interface BudgetConfig {
  /** デフォルトのツール結果最大文字数 */
  defaultResultSize: number;
  /** 集計ターン毎の最大チャー */
  turnBudget: number;
  /** DB永続化後のインラインスニペット長 */
  previewSize: number;
  /** ツール別オーバーライド */
  toolOverrides: Record<string, number>;
}

// ==================== デフォルト ====================

export const DEFAULT_BUDGET: BudgetConfig = Object.freeze({
  defaultResultSize: 50_000,
  turnBudget: 200_000,
  previewSize: 1_500,
  toolOverrides: {},
});

// ==================== ピン止め閾値 ====================

/** 一部のツールは常に全結果を返す（上書き不可） */
const PINNED_TOOLS = new Set([
  "memory",
  "sqlite",
  "schedule",
]);

// ==================== ランタイム ====================

let currentBudget: BudgetConfig = { ...DEFAULT_BUDGET };

/**
 * バジェット設定を更新
 */
export function setBudgetConfig(config: Partial<BudgetConfig>): void {
  currentBudget = { ...currentBudget, ...config };
  logger.info(`バジェット設定更新: defaultResultSize=${currentBudget.defaultResultSize}`);
}

/**
 * 現在のバジェット設定を取得
 */
export function getBudgetConfig(): BudgetConfig {
  return { ...currentBudget };
}

/**
 * 特定ツールの最大結果サイズを解決
 * 解決チェーン: PINNED → toolOverrides → defaultResultSize
 */
export function resolveMaxResultSize(toolName: string): number {
  if (PINNED_TOOLS.has(toolName)) return Infinity;
  if (currentBudget.toolOverrides[toolName] !== undefined) {
    return currentBudget.toolOverrides[toolName];
  }
  return currentBudget.defaultResultSize;
}

/**
 * ツール結果をバジェットに基づいてトリム
 * result が maxSize を超える場合、先頭を保持し末尾を切り詰める
 */
export function trimToolResult(toolName: string, result: string): string {
  const maxSize = resolveMaxResultSize(toolName);
  if (result.length <= maxSize) return result;

  const trimmed = result.slice(0, maxSize) +
    `\n\n…[バジェット超過: ${result.length}文字中${maxSize}文字まで表示]`;

  logger.debug(`結果トリム: ${toolName} ${result.length}→${maxSize}`);
  return trimmed;
}

/**
 * ツール結果のプレビュー（インライン表示用）
 */
export function getPreview(toolName: string, result: string): string {
  const size = currentBudget.previewSize;
  if (result.length <= size) return result;
  return result.slice(0, size) + `…[${result.length - size}文字省略]`;
}
