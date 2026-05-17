// ==========================================
// Aikata - Webhook受信サーバー（OpenHuman由来）
// 外部サービスからのHTTP POSTを受け付け
// ==========================================

import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 設定 ====================

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "") || 9721;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";

// ==================== シークレット検証 ====================

function verifySignature(body: string, signature: string | null, secret: string): boolean {
  if (!secret) return true; // シークレット未設定→検証スキップ
  if (!signature) return false;
  // HMAC-SHA256
  const crypto = require("crypto");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ==================== サーバー ====================

let server: ReturnType<typeof createServer> | null = null;

export function startWebhookServer(): void {
  if (server) return;

  const secret = process.env.WEBHOOK_SECRET || "";

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Signature");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // パスチェック
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (!url.pathname.startsWith(WEBHOOK_PATH)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // ボディ収集
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const signature = req.headers["x-webhook-signature"] as string || null;

      // シグネチャ検証
      if (secret && !verifySignature(body, signature, secret)) {
        logger.warn("Webhook: 署名検証失敗");
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      // イベント発行
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { raw: body };
      }

      const source = url.pathname.slice(WEBHOOK_PATH.length + 1) || "default";

      eventBus.publish(createEvent("system", "webhook", {
        source,
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        payload,
        timestamp: Date.now(),
      }));

      logger.info(`Webhook受信: ${source} (${body.length}B)`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, source }));
    });

    req.on("error", (err) => {
      logger.error(`Webhook受信エラー: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });

  server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
    logger.info(`Webhookサーバー起動: http://0.0.0.0:${WEBHOOK_PORT}${WEBHOOK_PATH}`);
  });
}

export function stopWebhookServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info("Webhookサーバー停止");
  }
}
