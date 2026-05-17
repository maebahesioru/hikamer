// ==========================================
// Aikata - RESTful HTTP APIサーバー（OpenHuman service/api層由来）
// 外部からのHTTP経由操作エンドポイント
// ==========================================

import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger } from "./utils/logger";
import { toolRegistry } from "./tools/registry";

// ==================== 型定義 ====================

interface APIResponse {
  success: boolean;
  data?: any;
  error?: string;
  timestamp?: string;
}

type RouteHandler = (req: IncomingMessage, body: any, params: Record<string, string>) => Promise<APIResponse>;

interface Route {
  method: string;
  path: RegExp;
  handler: RouteHandler;
  paramNames: string[];
}

// ==================== APIサーバー ====================

class RESTServer {
  private server: any = null;
  private port: number;
  private running = false;
  private routes: Route[] = [];
  private apiKey: string;

  constructor(port: number = 9723) {
    this.port = port;
    this.apiKey = process.env.API_KEY || process.env.REST_API_KEY || "";

    // 組み込みルート
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // ヘルスチェック
    this.get("/health", async () => ({
      success: true,
      data: { status: "running", uptime: process.uptime(), pid: process.pid, version: "1.14" },
    }));

    // ツール一覧
    this.get("/tools", async () => ({
      success: true,
      data: { tools: toolRegistry.list().map(t => ({ name: t.name, description: t.description })) },
    }));

    // ツール実行
    this.post("/tools/:name", async (req, body, params) => {
      const toolName = params.name!;
      const tool = toolRegistry.get(toolName);
      if (!tool) return { success: false, error: `ツール '${toolName}' は存在しません` };

      try {
        const result = await tool.execute(body?.args || {});
        return { success: true, data: { result } };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    // コスト
    this.get("/cost", async () => {
      const { formatCostSummary, getCostSummary } = await import("./cost-tracker");
      return { success: true, data: getCostSummary() };
    });

    // ヘルス詳細
    this.get("/health/detail", async () => {
      const { runHealthCheck } = await import("./health");
      const health = await runHealthCheck();
      return { success: true, data: health };
    });

    // バージョン
    this.get("/version", async () => ({
      success: true,
      data: { version: "1.14", uptime: process.uptime(), node: process.version, platform: process.platform },
    }));

    // メッセージ送信
    this.post("/message", async (req, body) => {
      if (!body?.text) return { success: false, error: "text が必要です" };
      // メッセージはログに記録（実際の送信はプラットフォーム依存）
      logger.info(`[REST] メッセージ受信: ${body.text.slice(0, 100)}`);
      return { success: true, data: { received: true, length: body.text.length } };
    });
  }

  // ==================== ルート登録ヘルパー ====================

  private get(path: string, handler: RouteHandler): void {
    this.addRoute("GET", path, handler);
  }

  private post(path: string, handler: RouteHandler): void {
    this.addRoute("POST", path, handler);
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      path: new RegExp(`^${regexStr}$`),
      handler,
      paramNames,
    });
  }

  // ==================== リクエスト処理 ====================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // APIキー認証
    if (this.apiKey) {
      const authHeader = req.headers["authorization"] || "";
      const apiKey = authHeader.replace(/^Bearer\s+/i, "");
      if (apiKey !== this.apiKey && req.url !== "/health") {
        this.sendJSON(res, 401, { success: false, error: "認証エラー" });
        return;
      }
    }

    // ルートマッチング
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    for (const route of this.routes) {
      const match = pathname.match(route.path);
      if (match && req.method === route.method) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => { params[name] = match![i + 1]!; });

        // ボディ読み取り
        const body = await this.readBody(req);

        try {
          const result = await route.handler(req, body, params);
          this.sendJSON(res, result.success ? 200 : 400, result);
        } catch (e: any) {
          this.sendJSON(res, 500, { success: false, error: e.message, timestamp: new Date().toISOString() });
        }
        return;
      }
    }

    this.sendJSON(res, 404, { success: false, error: "Not Found", timestamp: new Date().toISOString() });
  }

  private readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      if (req.method === "GET") return resolve(null);

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString();
          resolve(body ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  private sendJSON(res: ServerResponse, status: number, data: APIResponse): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }

  // ==================== 起動/停止 ====================

  start(): void {
    if (this.running) return;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res).catch((e) => {
        this.sendJSON(res, 500, { success: false, error: e.message, timestamp: new Date().toISOString() });
      });
    });

    this.server.listen(this.port, () => {
      this.running = true;
      logger.info(`[REST API] 起動: port ${this.port}${this.apiKey ? " (認証あり)" : " (認証なし)"}`);
    });

    this.server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        logger.warn(`[REST API] ポート${this.port}使用中。スキップ。`);
      } else {
        logger.error(`[REST API] エラー: ${err.message}`);
      }
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.running = false;
      logger.info("[REST API] 停止");
    }
  }
}

// ==================== シングルトン ====================

const API_PORT = parseInt(process.env.REST_API_PORT || "9723", 10);
export const restServer = new RESTServer(API_PORT);
