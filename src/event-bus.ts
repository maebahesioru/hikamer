// ==========================================
// Aikata - イベントバス（OpenHuman由来）
// 内部pub/subでコンポーネント間の疎結合化
// ドメイン購読フィルタ + 非同期ハンドラ + パニック隔離
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

/** イベントドメイン */
export type EventDomain =
  | "system"      // 起動/終了/エラー
  | "agent"       // エージェントループ開始/終了/反復
  | "tool"        // ツール実行前/後
  | "message"     // メッセージ受信/送信
  | "memory"      // メモリ読み書き
  | "cron"        // スケジューラー
  | "heartbeat"   // 心拍エンジン
  | "channel"     // マルチチャンネル
  | "subagent"    // サブエージェント
  | "stream"      // ストリーミング
  | "provider"    // LLMプロバイダー
  | "error";      // エラー

/** 基底イベント */
export interface DomainEvent {
  domain: EventDomain;
  name: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

/** イベントハンドラ */
export interface EventHandler {
  name: string;
  domains?: EventDomain[];
  handle(event: DomainEvent): void | Promise<void>;
}

/** 購読解除ハンドル */
export interface SubscriptionHandle {
  unsubscribe(): void;
}

// ==================== イベントバス ====================

class EventBus {
  private handlers: Array<{ handler: EventHandler; once: boolean }> = [];
  private nextId = 0;

  /** イベントをパブリッシュ（全購読者にブロードキャスト） */
  publish(event: DomainEvent): void {
    const matching = this.handlers.filter(({ handler }) => {
      if (handler.domains && !handler.domains.includes(event.domain)) return false;
      return true;
    });

    for (const { handler, once } of matching) {
      try {
        const result = handler.handle(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            logger.error(`[EventBus] ハンドラ失敗: ${handler.name} — ${err.message}`);
          });
        }
      } catch (err: any) {
        logger.error(`[EventBus] ハンドラ例外: ${handler.name} — ${err.message}`);
      }

      if (once) {
        this.handlers = this.handlers.filter(h => h.handler !== handler);
      }
    }
  }

  /** イベントをパブリッシュして完了を待つ */
  async publishAsync(event: DomainEvent): Promise<void> {
    const matching = this.handlers.filter(({ handler }) => {
      if (handler.domains && !handler.domains.includes(event.domain)) return false;
      return true;
    });

    const promises: Promise<void>[] = [];
    const toRemove: EventHandler[] = [];

    for (const { handler, once } of matching) {
      try {
        const result = handler.handle(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (err: any) {
        logger.error(`[EventBus] ハンドラ例外: ${handler.name} — ${err.message}`);
      }
      if (once) toRemove.push(handler);
    }

    if (toRemove.length > 0) {
      this.handlers = this.handlers.filter(h => !toRemove.includes(h.handler));
    }

    await Promise.allSettled(promises);
  }

  /** ハンドラを購読 */
  subscribe(handler: EventHandler): SubscriptionHandle {
    const entry = { handler, once: false };
    this.handlers.push(entry);
    return {
      unsubscribe: () => {
        this.handlers = this.handlers.filter(h => h !== entry);
      },
    };
  }

  /** 1回だけ実行するハンドラを購読 */
  once(handler: EventHandler): SubscriptionHandle {
    const entry = { handler, once: true };
    this.handlers.push(entry);
    return {
      unsubscribe: () => {
        this.handlers = this.handlers.filter(h => h !== entry);
      },
    };
  }

  /** ドメインを指定して購読 */
  on(domain: EventDomain, name: string, fn: (event: DomainEvent) => void | Promise<void>): SubscriptionHandle {
    return this.subscribe({
      name: `${domain}:${name}`,
      domains: [domain],
      handle: fn,
    });
  }

  /** 全購読を解除 */
  clear(): void {
    this.handlers = [];
  }

  /** 購読者数を取得 */
  get subscriberCount(): number {
    return this.handlers.length;
  }
}

// ==================== グローバルシングルトン ====================

export const eventBus = new EventBus();

// ==================== ヘルパー ====================

/** イベント作成ヘルパー */
export function createEvent(
  domain: EventDomain,
  name: string,
  payload?: Record<string, unknown>,
): DomainEvent {
  return { domain, name, timestamp: Date.now(), payload };
}

/** 非同期ハンドララッパー */
export function asyncHandler(
  name: string,
  domains: EventDomain[],
  fn: (event: DomainEvent) => Promise<void>,
): EventHandler {
  return { name, domains, handle: fn };
}

/** 同期待ちのラッパー */
export function syncHandler(
  name: string,
  domains: EventDomain[],
  fn: (event: DomainEvent) => void,
): EventHandler {
  return { name, domains, handle: fn };
}
