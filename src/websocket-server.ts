// ==========================================
// Hikamer - WebSocketサーバー（OpenHuman socket由来）
// リアルタイム双方向通信で外部クライアントと接続
// ==========================================

import { createServer, IncomingMessage, Server } from "http";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== WebSocket（生実装） ====================

interface WSClient {
  id: string;
  socket: any;
  connectedAt: number;
  label?: string;
  lastPing: number;
}

class WebSocketServer {
  private server: Server | null = null;
  private clients = new Map<string, WSClient>();
  private port: number;
  private running = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(port: number = 9722) {
    this.port = port;
  }

  /** サーバー起動（HTTP→WebSocketアップグレード） */
  start(): void {
    if (this.running) return;

    this.server = createServer((req, res) => {
      // HTTPフォールバック: ヘルスチェック
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "running",
          clients: this.clients.size,
          uptime: process.uptime(),
        }));
        return;
      }
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("WebSocket接続が必要です");
    });

    this.server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
      this.handleUpgrade(req, socket);
    });

    this.server.listen(this.port, () => {
      this.running = true;
      logger.info(`[WebSocket] 起動: port ${this.port}`);

      // 生存確認（30秒ごと）
      this.pingInterval = setInterval(() => this.pingAll(), 30000);
    });

    this.server.on("error", (err: any) => {
      logger.error(`[WebSocket] サーバーエラー: ${err.message}`);
    });
  }

  /** WebSocketアップグレード処理 */
  private handleUpgrade(req: IncomingMessage, socket: any): void {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    // WebSocketハンドシェイク
    const acceptKey = this.generateAccept(key);
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n");

    socket.write(responseHeaders);

    const clientId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const client: WSClient = {
      id: clientId,
      socket,
      connectedAt: Date.now(),
      lastPing: Date.now(),
    };

    this.clients.set(clientId, client);
    logger.info(`[WebSocket] 接続: ${clientId}`);
    eventBus.publish(createEvent("system", "wsConnected", { clientId }));

    // データ受信
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      const frames = this.parseFrames(buffer);
      if (frames.length > 0) {
        buffer = Buffer.alloc(0); // 単純化: 1リクエスト=1フレーム想定
        for (const frame of frames) {
          this.handleFrame(client, frame);
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      logger.info(`[WebSocket] 切断: ${clientId}`);
      eventBus.publish(createEvent("system", "wsDisconnected", { clientId }));
    });

    socket.on("error", (err: any) => {
      logger.warn(`[WebSocket] ソケットエラー: ${clientId} — ${err.message}`);
    });

    // ウェルカムメッセージ
    this.send(client, { type: "connected", clientId, serverTime: Date.now() });
  }

  /** WebSocketフレーム解析 */
  private parseFrames(buffer: Buffer): Array<{ opcode: number; payload: Buffer }> {
    const frames: Array<{ opcode: number; payload: Buffer }> = [];
    if (buffer.length < 2) return frames;

    const opcode = buffer[0]! & 0x0f;
    const masked = (buffer[1]! & 0x80) !== 0;
    let payloadLen = buffer[1]! & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      payloadLen = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    if (masked) {
      const mask = buffer.slice(offset, offset + 4);
      offset += 4;
      const maskedPayload = buffer.slice(offset, offset + payloadLen);
      const payload = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = maskedPayload[i]! ^ mask[i % 4]!;
      }
      frames.push({ opcode, payload });
    } else {
      frames.push({ opcode, payload: buffer.slice(offset, offset + payloadLen) });
    }

    return frames;
  }

  /** フレーム処理 */
  private handleFrame(client: WSClient, frame: { opcode: number; payload: Buffer }): void {
    if (frame.opcode === 0x08) {
      // Close
      client.socket.end();
      return;
    }
    if (frame.opcode === 0x09) {
      // Ping → Pong
      this.sendRaw(client, frame.payload, 0x0a);
      client.lastPing = Date.now();
      return;
    }
    if (frame.opcode === 0x0a) {
      // Pong
      client.lastPing = Date.now();
      return;
    }
    if (frame.opcode === 0x01) {
      // Text frame
      try {
        const text = frame.payload.toString("utf-8");
        const msg = JSON.parse(text);
        this.handleMessage(client, msg);
      } catch {
        this.send(client, { type: "error", message: "Invalid JSON" });
      }
    }
  }

  /** メッセージ処理 */
  private handleMessage(client: WSClient, msg: any): void {
    switch (msg.type) {
      case "ping":
        this.send(client, { type: "pong", timestamp: Date.now() });
        break;

      case "subscribe":
        // イベントバスの特定ドメインを購読
        if (msg.domain) {
          eventBus.subscribe({
            name: `ws:${client.id}:${msg.domain}`,
            domains: [msg.domain],
            handle: (event) => {
              this.send(client, {
                type: "event",
                domain: event.domain,
                name: event.name,
                payload: event.payload,
                timestamp: event.timestamp,
              });
            },
          });
          this.send(client, { type: "subscribed", domain: msg.domain });
        }
        break;

      case "label":
        client.label = msg.label;
        break;

      default:
        // 不明なメッセージはイベントバスに中継
        eventBus.publish(createEvent("system", "wsMessage", {
          clientId: client.id,
          message: msg,
        }));
    }
  }

  /** クライアントに送信 */
  private send(client: WSClient, data: any): void {
    const text = JSON.stringify(data);
    this.sendRaw(client, Buffer.from(text, "utf-8"), 0x01);
  }

  /** 生フレーム送信 */
  private sendRaw(client: WSClient, payload: Buffer, opcode: number): void {
    try {
      const len = payload.length;
      let header: Buffer;

      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }

      client.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  /** 全クライアントにブロードキャスト */
  broadcast(data: any): void {
    const text = JSON.stringify(data);
    const payload = Buffer.from(text, "utf-8");
    for (const client of Array.from(this.clients.values())) {
      this.sendRaw(client, payload, 0x01);
    }
  }

  /** 生存確認 */
  private pingAll(): void {
    for (const client of Array.from(this.clients.values())) {
      if (Date.now() - client.lastPing > 60000) {
        // 1分応答なし → 切断
        try { client.socket.end(); } catch {}
        this.clients.delete(client.id);
        logger.info(`[WebSocket] タイムアウト切断: ${client.id}`);
      } else {
        this.sendRaw(client, Buffer.from([0x09]), 0x09); // Ping
      }
    }
  }

  /** 停止 */
  stop(): void {
    this.running = false;
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const client of Array.from(this.clients.values())) {
      try { client.socket.end(); } catch {}
    }
    this.clients.clear();
    if (this.server) this.server.close();
    logger.info("[WebSocket] 停止");
  }

  /** 接続数 */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /** クライアント一覧 */
  getClients(): Array<{ id: string; label?: string; connectedAt: number }> {
    return Array.from(this.clients.values()).map(c => ({
      id: c.id,
      label: c.label,
      connectedAt: c.connectedAt,
    }));
  }

  /** WebSocket Acceptキー生成 */
  private generateAccept(key: string): string {
    const crypto = require("crypto");
    const GUID = "258EAFA5-E914-47DA-95CA-5AB5E03F6B08";
    const hash = crypto.createHash("sha1").update(key + GUID).digest("base64");
    return hash;
  }
}

// ==================== シングルトン ====================

const WS_PORT = parseInt(process.env.WS_PORT || "9722", 10);
export const wsServer = new WebSocketServer(WS_PORT);

/**
 * メモリ更新イベントをブロードキャスト（OmniVoice WebSocketイベント由来）
 */
export function broadcastMemoryEvent(action: string, data: Record<string, unknown>): void {
  wsServer.broadcast({
    type: "memory",
    action,
    data,
    timestamp: Date.now(),
  });
}

/**
 * コスト更新イベントをブロードキャスト
 */
export function broadcastCostEvent(cost: number, currency: string): void {
  wsServer.broadcast({
    type: "cost",
    cost,
    currency,
    timestamp: Date.now(),
  });
}

/**
 * パイプラインプログレスをブロードキャスト（OmniVoice batch pipeline由来）
 */
export function broadcastProgress(
  pipelineId: string,
  stage: string,
  current: number,
  total: number,
  status: "running" | "completed" | "failed"
): void {
  wsServer.broadcast({
    type: "progress",
    pipelineId,
    stage,
    current,
    total,
    percent: total > 0 ? Math.round((current / total) * 100) : 0,
    status,
    timestamp: Date.now(),
  });
}

export { WebSocketServer, WS_PORT };

// ==================== テレメトリーブロードキャスト (v1.71) ====================

import type { TurnTrace, TelemetryReport } from "./telemetry";

let telemetryRef: any = null;

/** テレメトリーインスタンスを登録（telemetry.tsのinit時） */
export function registerTelemetryForBroadcast(telemetryInstance: any): void {
  telemetryRef = telemetryInstance;
}

/** 現在のテレメトリーを全クライアントにブロードキャスト */
export function broadcastTelemetry(): void {
  if (!telemetryRef) return;

  const report: TelemetryReport = telemetryRef.getReport();
  const failurePatterns = telemetryRef.detectFailurePatterns();

  wsServer.broadcast({
    type: "telemetry",
    report: {
      sessions: report.sessions.slice(0, 5),
      global: report.globalStats,
    },
    failures: failurePatterns.slice(0, 5),
    timestamp: Date.now(),
  });
}