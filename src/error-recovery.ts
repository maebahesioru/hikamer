// ==========================================
// Hikamer - Error Recovery Patterns (v1.67)
// 出典: tanayshah11/ai-agent-error-patterns
// 4つの実戦テスト済み信頼性パターン
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface CircuitState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
  openedAt: number;
}

export interface GracefulDegradation<T> {
  primary: () => Promise<T>;
  fallbacks: Array<() => Promise<T>>;
}

export interface PartialSuccess<T> {
  items: T[];
  errors: { item: unknown; error: string }[];
  totalAttempted: number;
  succeeded: number;
}

// ==================== 1. サーキットブレーカー ====================

class CircuitBreaker {
  private circuits: Map<string, CircuitState> = new Map();

  private readonly FAILURE_THRESHOLD = 5;     // 5回連続失敗でオープン
  private readonly TIMEOUT_MS = 30_000;        // 30秒後にハーフオープン
  private readonly HALF_OPEN_LIMIT = 2;        // ハーフオープンで2回試行

  /**
   * サーキットブレーカーで保護された関数を実行
   * @returns 結果。サーキットオープン時はnull
   */
  async execute<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    let circuit = this.circuits.get(name);
    if (!circuit) {
      circuit = { failures: 0, lastFailure: 0, state: "closed", openedAt: 0 };
      this.circuits.set(name, circuit);
    }

    // オープン: タイムアウトチェック
    if (circuit.state === "open") {
      if (Date.now() - circuit.openedAt > this.TIMEOUT_MS) {
        circuit.state = "half-open";
        logger.info(`[CircuitBreaker] ${name}: ハーフオープン（再試行開始）`);
      } else {
        logger.warn(`[CircuitBreaker] ${name}: サーキットオープン中、スキップ`);
        return null;
      }
    }

    try {
      const result = await fn();

      // 成功: リセット
      if (circuit.state === "half-open") {
        circuit.state = "closed";
        circuit.failures = 0;
        logger.info(`[CircuitBreaker] ${name}: 回復 → クローズ`);
      } else {
        circuit.failures = 0;
      }

      return result;
    } catch (e: any) {
      circuit.failures++;
      circuit.lastFailure = Date.now();

      if (circuit.failures >= this.FAILURE_THRESHOLD || circuit.state === "half-open") {
        circuit.state = "open";
        circuit.openedAt = Date.now();
        logger.error(`[CircuitBreaker] ${name}: 閾値到達 → オープン (${circuit.failures}連続失敗)`);
      }

      throw e; // 呼び出し元にエラーを伝播
    }
  }

  /** サーキットを強制リセット */
  reset(name: string): void {
    const circuit = this.circuits.get(name);
    if (circuit) {
      circuit.state = "closed";
      circuit.failures = 0;
      logger.info(`[CircuitBreaker] ${name}: 手動リセット`);
    }
  }

  formatStatus(): string {
    const lines: string[] = ["⚡ **サーキットブレーカー**"];
    for (const [name, c] of this.circuits) {
      const icon = c.state === "open" ? "🔴" : c.state === "half-open" ? "🟡" : "🟢";
      lines.push(`  ${icon} ${name}: ${c.state} (失敗:${c.failures})`);
    }
    return lines.join("\n");
  }
}

// ==================== 2. グレースフルデグラデーション ====================

class GracefulDegradationExecutor {
  /**
   * プライマリ関数 → 失敗時はフォールバックチェーンを順次試行
   */
  async execute<T>(name: string, primary: () => Promise<T>, fallbacks: Array<() => Promise<T>>): Promise<T> {
    // プライマリ試行
    try {
      return await primary();
    } catch (e: any) {
      logger.warn(`[GracefulDegradation] ${name}: プライマリ失敗 → フォールバック (${fallbacks.length}段階)`);
    }

    // フォールバックチェーン
    const errors: string[] = [];
    for (let i = 0; i < fallbacks.length; i++) {
      try {
        const result = await fallbacks[i]!();
        logger.info(`[GracefulDegradation] ${name}: フォールバック${i + 1}成功`);
        return result;
      } catch (e: any) {
        errors.push(`FB${i + 1}: ${e.message}`);
      }
    }

    throw new Error(`[GracefulDegradation] ${name}: 全フォールバック失敗: ${errors.join(" | ")}`);
  }
}

// ==================== 3. 部分成功 ====================

class PartialSuccessHandler {
  /**
   * バッチ処理: 個別アイテムの失敗を許容し、成功したものだけを返す
   */
  async executeBatch<T, R>(
    items: T[],
    processor: (item: T, index: number) => Promise<R>,
  ): Promise<PartialSuccess<R>> {
    const results: R[] = [];
    const errors: { item: T; error: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const result = await processor(items[i]!, i);
        results.push(result);
      } catch (e: any) {
        errors.push({ item: items[i]!, error: e.message });
        logger.warn(`[PartialSuccess] item[${i}] 失敗: ${e.message}`);
      }
    }

    const total = items.length;
    const succeeded = results.length;

    if (succeeded === 0) {
      throw new Error(`[PartialSuccess] 全${total}件失敗: ${errors.map(e => e.error).join("; ")}`);
    }

    if (errors.length > 0) {
      logger.info(`[PartialSuccess] ${succeeded}/${total}成功, ${errors.length}失敗`);
    }

    return {
      items: results,
      errors,
      totalAttempted: total,
      succeeded,
    };
  }

  /** 結果をフォーマット */
  formatResult<T>(result: PartialSuccess<T>): string {
    const rate = ((result.succeeded / result.totalAttempted) * 100).toFixed(0);
    return `📊 部分成功: ${result.succeeded}/${result.totalAttempted} (${rate}%)` +
      (result.errors.length > 0 ? `\n⚠️ 失敗: ${result.errors.map(e => e.error).join(", ")}` : "");
  }
}

// ==================== 4. Human-in-the-Loop ====================

class HumanInTheLoop {
  private pendingApprovals: Map<string, {
    description: string;
    options: string[];
    resolve: (value: string) => void;
    createdAt: number;
  }> = new Map();

  private timeoutMs = 300_000; // 5分

  /**
   * 確認が必要な操作を保留し、人間の判断を待つ
   */
  async requestApproval(id: string, description: string, options: string[] = ["approve", "reject"]): Promise<string> {
    return new Promise<string>((resolve) => {
      this.pendingApprovals.set(id, {
        description,
        options,
        resolve,
        createdAt: Date.now(),
      });

      // タイムアウト: 自動却下
      setTimeout(() => {
        const pending = this.pendingApprovals.get(id);
        if (pending) {
          this.pendingApprovals.delete(id);
          logger.warn(`[HumanInTheLoop] ${id}: タイムアウト → 自動却下`);
          resolve("reject");
        }
      }, this.timeoutMs);

      logger.info(`[HumanInTheLoop] ${id}: 承認待ち — "${description.slice(0, 80)}"`);
    });
  }

  /** 人間が判断を下す */
  respond(id: string, decision: string): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;

    if (!pending.options.includes(decision)) {
      logger.warn(`[HumanInTheLoop] ${id}: 無効な判断 "${decision}" (有効: ${pending.options.join(", ")})`);
      return false;
    }

    this.pendingApprovals.delete(id);
    pending.resolve(decision);
    logger.info(`[HumanInTheLoop] ${id}: → ${decision}`);
    return true;
  }

  /** 保留中の承認一覧 */
  listPending(): { id: string; description: string; waiting: number }[] {
    const now = Date.now();
    return [...this.pendingApprovals.entries()].map(([id, p]) => ({
      id,
      description: p.description,
      waiting: Math.round((now - p.createdAt) / 1000),
    }));
  }

  formatPending(): string {
    const pending = this.listPending();
    if (pending.length === 0) return "📋 保留中の承認はありません。";
    return pending.map(p =>
      `⏳ **${p.id}**: ${p.description.slice(0, 60)} (待機${p.waiting}秒)\n  \`/approve ${p.id}\` or \`/reject ${p.id}\``
    ).join("\n\n");
  }
}

// ==================== シングルトン ====================

export const circuitBreaker = new CircuitBreaker();
export const gracefulDegradation = new GracefulDegradationExecutor();
export const partialSuccess = new PartialSuccessHandler();
export const humanInTheLoop = new HumanInTheLoop();
