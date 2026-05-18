// ==========================================
// Aikata - フィーチャー状態マシン
// 出典: clawpatch (openclaw/clawpatch) のFeature State Machine
// pending → claimed → reviewed → needs-fix → fixing → fixed → revalidated
// ==========================================

import { logger } from "./utils/logger";

// ==================== 状態定義（clawpatch feature lifecycle） ====================

export type FeatureStatus =
  | "pending"
  | "claimed"
  | "reviewed"
  | "needs-fix"
  | "fixing"
  | "fixed"
  | "revalidated"
  | "skipped"
  | "error";

export type FeatureKind =
  | "package" | "service" | "route" | "component"
  | "command" | "module" | "config" | "utility"
  | "test" | "documentation" | "unknown";

export type FindingCategory =
  | "bug" | "security" | "performance" | "concurrency"
  | "api-contract" | "data-loss" | "test-gap"
  | "docs-gap" | "build-release" | "maintainability";

export type TriageCategory =
  | "confirmed-bug" | "contract-mismatch" | "test-gap"
  | "risk" | "info";

// ==================== 状態遷移マップ ====================

const VALID_TRANSITIONS: Record<FeatureStatus, FeatureStatus[]> = {
  pending:     ["claimed", "skipped", "error"],
  claimed:     ["reviewed", "pending", "error"],
  reviewed:    ["needs-fix", "revalidated", "claimed", "error"],
  "needs-fix": ["fixing", "reviewed", "error"],
  fixing:      ["fixed", "needs-fix", "error"],
  fixed:       ["revalidated", "needs-fix", "error"],
  revalidated: ["pending", "error"], // 再マップ可能
  skipped:     ["pending", "error"],
  error:       ["pending", "claimed"],
};

// ==================== フィーチャー ====================

export interface Feature {
  id: string;
  title: string;
  summary: string;
  kind: FeatureKind;
  status: FeatureStatus;
  confidence: number;       // 0.0 - 1.0
  entrypoints: Array<{
    path: string;
    symbol?: string;
    route?: string;
  }>;
  ownedFiles: string[];
  contextFiles: string[];
  tests: string[];
  tags: string[];
  findingIds: string[];
  createdAt: number;
  updatedAt: number;
  locked: boolean;
}

// ==================== フィーチャーマネージャー ====================

class FeatureManager {
  private features = new Map<string, Feature>();
  private nextId = 1;

  /**
   * フィーチャーを生成（pending状態）
   */
  createFeature(params: {
    title: string;
    summary?: string;
    kind?: FeatureKind;
    entrypoints?: Feature["entrypoints"];
    ownedFiles?: string[];
    contextFiles?: string[];
    tests?: string[];
    tags?: string[];
  }): Feature {
    const id = `feat-${this.nextId++}`;
    const feature: Feature = {
      id,
      title: params.title,
      summary: params.summary || "",
      kind: params.kind || "unknown",
      status: "pending",
      confidence: 0.5,
      entrypoints: params.entrypoints || [],
      ownedFiles: params.ownedFiles || [],
      contextFiles: params.contextFiles || [],
      tests: params.tests || [],
      tags: params.tags || [],
      findingIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      locked: false,
    };

    this.features.set(id, feature);
    logger.info(`[FeatureManager] 作成: ${id} "${feature.title}"`);
    return feature;
  }

  /**
   * 状態遷移（clawpatch feature lifecycle state machine）
   */
  transition(featureId: string, newStatus: FeatureStatus): boolean {
    const feature = this.features.get(featureId);
    if (!feature) {
      logger.warn(`[FeatureManager] 遷移失敗: ${featureId} が見つかりません`);
      return false;
    }

    if (feature.locked && newStatus !== "error") {
      logger.warn(`[FeatureManager] 遷移失敗: ${featureId} はロック中`);
      return false;
    }

    const allowed = VALID_TRANSITIONS[feature.status];
    if (!allowed.includes(newStatus)) {
      logger.warn(`[FeatureManager] 不正な遷移: ${feature.status} → ${newStatus} (${featureId})`);
      return false;
    }

    const oldStatus = feature.status;
    feature.status = newStatus;
    feature.updatedAt = Date.now();
    logger.info(`[FeatureManager] 遷移: ${featureId} ${oldStatus} → ${newStatus}`);
    return true;
  }

  /**
   * フィーチャーをロック/アンロック（排他制御用）
   */
  setLock(featureId: string, locked: boolean): boolean {
    const feature = this.features.get(featureId);
    if (!feature) return false;
    feature.locked = locked;
    return true;
  }

  /**
   * 特定ステータスのフィーチャーを取得
   */
  getByStatus(status: FeatureStatus): Feature[] {
    return Array.from(this.features.values()).filter(f => f.status === status);
  }

  /**
   * 全フィーチャーを取得
   */
  getAll(): Feature[] {
    return Array.from(this.features.values());
  }

  /**
   * フィーチャーをIDで取得
   */
  get(id: string): Feature | undefined {
    return this.features.get(id);
  }

  /**
   * フィーチャー数を取得
   */
  get count(): number {
    return this.features.size;
  }

  /**
   * 統計情報
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = { total: this.features.size };
    Array.from(this.features.values()).forEach(f => {
      stats[f.status] = (stats[f.status] || 0) + 1;
    });
    return stats;
  }

  /**
   * 全フィーチャーの状態サマリー文字列
   */
  formatSummary(): string {
    const stats = this.getStats();
    const lines = [`📋 **フィーチャー管理 (${stats.total}件)**`];
    const order: FeatureStatus[] = ["pending", "claimed", "reviewed", "needs-fix", "fixing", "fixed", "revalidated", "skipped", "error"];
    for (const s of order) {
      if (stats[s]) {
        const emoji = s === "error" ? "❌" : s === "revalidated" ? "✅" : s === "needs-fix" ? "🔧" : "📌";
        lines.push(`${emoji} ${s}: ${stats[s]}`);
      }
    }
    return lines.join("\n");
  }
}

export const featureManager = new FeatureManager();
export { FeatureManager };
