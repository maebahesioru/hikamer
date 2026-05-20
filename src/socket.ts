// ==========================================
// Hikamer - ソケット管理（OpenHuman socket/ 由来）
// WebSocket接続管理・イベントハンドリング・自動再接続
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface SocketConnection {
  id: string;
  url: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  connectedAt: number | null;
  lastActivityAt: number | null;
  reconnectCount: number;
  metadata: Record<string, unknown>;
}

export interface SocketEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  connectionId: string;
}

export interface SocketStats {
  totalConnections: number;
  activeConnections: number;
  messagesSent: number;
  messagesReceived: number;
  reconnections: number;
  errors: number;
}

// ==================== ソケットマネージャー ====================

class SocketManager {
  private connections: Map<string, SocketConnection> = new Map();
  private stats: SocketStats = {
    totalConnections: 0, activeConnections: 0,
    messagesSent: 0, messagesReceived: 0,
    reconnections: 0, errors: 0,
  };
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    setInterval(() => this.healthCheck(), 30000);
    this.initialized = true;
    logger.info("[Socket] manager initialized");
  }

  /** 接続を作成 */
  createConnection(url: string, metadata?: Record<string, unknown>): SocketConnection {
    const id = `sock-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const conn: SocketConnection = {
      id, url, status: "connecting",
      connectedAt: null, lastActivityAt: null,
      reconnectCount: 0, metadata: metadata ?? {},
    };
    this.connections.set(id, conn);
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    logger.info(`[Socket] created: ${id} -> ${url}`);
    return conn;
  }

  /** 接続状態を更新 */
  updateStatus(id: string, status: SocketConnection["status"]): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;
    conn.status = status;
    if (status === "connected") {
      conn.connectedAt = Date.now();
      this.stats.activeConnections++;
    }
    conn.lastActivityAt = Date.now();
    return true;
  }

  /** 切断 */
  disconnect(id: string): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;
    conn.status = "disconnected";
    conn.lastActivityAt = Date.now();
    this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1);
    logger.info(`[Socket] disconnected: ${id}`);
    return true;
  }

  /** 再接続 */
  reconnect(id: string): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;
    conn.reconnectCount++;
    conn.status = "connecting";
    this.stats.reconnections++;
    this.stats.activeConnections++;
    logger.info(`[Socket] reconnecting: ${id} (attempt ${conn.reconnectCount})`);
    return true;
  }

  /** 接続一覧 */
  listConnections(): SocketConnection[] {
    return Array.from(this.connections.values());
  }

  /** アクティブな接続 */
  getActiveConnections(): SocketConnection[] {
    return this.listConnections().filter((c) => c.status === "connected");
  }

  /** 古い/エラー接続をクリーンアップ */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, conn] of this.connections) {
      if (conn.status === "error" || 
          (conn.status === "disconnected" && conn.lastActivityAt && 
           now - conn.lastActivityAt > 3600000)) {
        this.connections.delete(id);
        removed++;
      }
    }
    if (removed > 0) logger.debug(`[Socket] cleaned ${removed} stale connections`);
    return removed;
  }

  /** 定期ヘルスチェック */
  private healthCheck(): void {
    for (const conn of this.connections.values()) {
      if (conn.status === "connected" && conn.lastActivityAt &&
          Date.now() - conn.lastActivityAt > 120000) {
        logger.warn(`[Socket] stale connection: ${conn.id}`);
        conn.status = "error";
        this.stats.errors++;
      }
    }
  }

  /** 統計 */
  getStats(): SocketStats {
    return { ...this.stats, activeConnections: this.getActiveConnections().length };
  }

  formatStatus(): string {
    const s = this.getStats();
    const connections = this.listConnections();
    return (
      `🔌 **ソケット管理**\n` +
      `アクティブ: ${s.activeConnections}\n` +
      `総接続: ${s.totalConnections}\n` +
      `再接続: ${s.reconnections}\n` +
      `エラー: ${s.errors}\n\n` +
      (connections.length > 0
        ? `**接続一覧**\n` +
          connections.map((c) => {
            const icon = c.status === "connected" ? "🟢" :
                         c.status === "connecting" ? "🟡" :
                         c.status === "error" ? "🔴" : "⚪";
            return `${icon} \`${c.id.slice(0, 16)}...\` ${c.url.slice(0, 40)} (${c.reconnectCount}回再接続)`;
          }).join("\n")
        : "接続なし")
    );
  }
}

// ==================== シングルトン ====================

export const socketManager = new SocketManager();

export default SocketManager;
