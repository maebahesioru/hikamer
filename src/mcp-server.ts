// ==========================================
// Aikata - MCPサーバー機能（OpenHuman openhuman/mcp_server由来）
// Aikataの全ツールをMCPプロトコルで外部公開
// 別プロセスからMCPクライアント経由でAikataツールを呼び出せる
// ==========================================

import { toolRegistry } from "./tools/registry";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ==================== MCPサーバー ====================

class MCPServer {
  private running = false;
  private transport: "stdio" | "tcp" = "stdio";
  private port = 0;
  private server: any = null;

  // ==================== ツール定義 ====================

  /** 登録ツールからMCPツール定義を生成 */
  private getToolDefinitions(): MCPToolDefinition[] {
    const tools = toolRegistry.listAvailable();
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as Record<string, unknown>,
    }));
  }

  // ==================== リクエスト処理 ====================

  /** MCPリクエストを処理してレスポンスを返す */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const { id, method, params } = request;

    switch (method) {
      // === 初期化 ===
      case "initialize": {
        return this.jsonRpc(id, {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},       // ツール提供可能
            resources: {},   // リソース提供可能
          },
          serverInfo: {
            name: "aikata",
            version: "1.9.0",
          },
        });
      }

      // === ツール一覧 ===
      case "tools/list": {
        return this.jsonRpc(id, {
          tools: this.getToolDefinitions(),
        });
      }

      // === ツール呼び出し ===
      case "tools/call": {
        const toolName = params?.name as string;
        const arguments_ = params?.arguments as Record<string, unknown> || {};

        if (!toolName) {
          return this.jsonRpcError(id, -32602, "ツール名が必要です");
        }

        const tool = toolRegistry.get(toolName);
        if (!tool) {
          return this.jsonRpcError(id, -32602, `ツール '${toolName}' は存在しません`);
        }

        try {
          const result = await tool.execute(arguments_);
          return this.jsonRpc(id, {
            content: [
              { type: "text", text: result },
            ],
            isError: false,
          });
        } catch (e: any) {
          return this.jsonRpc(id, {
            content: [
              { type: "text", text: `[エラー] ${e.message || String(e)}` },
            ],
            isError: true,
          });
        }
      }

      // === リソース一覧 ===
      case "resources/list": {
        return this.jsonRpc(id, {
          resources: [
            {
              uri: "aikata://tools",
              name: "利用可能ツール一覧",
              description: "Aikataに登録されている全ツール",
              mimeType: "text/plain",
            },
            {
              uri: "aikata://health",
              name: "ヘルスステータス",
              description: "Aikataの健全性情報",
              mimeType: "application/json",
            },
            {
              uri: "aikata://cost",
              name: "コスト情報",
              description: "AikataのLLM使用コスト",
              mimeType: "application/json",
            },
          ],
        });
      }

      // === リソース読み取り ===
      case "resources/read": {
        const uri = params?.uri as string;
        switch (uri) {
          case "aikata://tools": {
            const toolNames = toolRegistry.list().map(t => `- ${t.name}: ${t.description}`);
            return this.jsonRpc(id, {
              contents: [{
                uri,
                mimeType: "text/plain",
                text: toolNames.join("\n"),
              }],
            });
          }
          case "aikata://health": {
            try {
              const { handleHealthCommand } = await import("./health");
              const healthText = await handleHealthCommand();
              return this.jsonRpc(id, {
                contents: [{
                  uri,
                  mimeType: "text/plain",
                  text: healthText,
                }],
              });
            } catch {
              return this.jsonRpc(id, {
                contents: [{
                  uri,
                  mimeType: "text/plain",
                  text: "ヘルス情報取得失敗",
                }],
              });
            }
          }
          case "aikata://cost": {
            const { formatCostSummary } = await import("./cost-tracker");
            return this.jsonRpc(id, {
              contents: [{
                uri,
                mimeType: "text/plain",
                text: formatCostSummary(),
              }],
            });
          }
          default:
            return this.jsonRpcError(id, -32602, `リソース '${uri}' は存在しません`);
        }
      }

      // === ping ===
      case "ping":
        return this.jsonRpc(id, {});

      default:
        return this.jsonRpcError(id, -32601, `メソッド '${method}' は未対応`);
    }
  }

  // ==================== トランスポート ====================

  /** stdioトランスポートで起動 */
  startStdio(): void {
    if (this.running) return;
    this.running = true;
    this.transport = "stdio";

    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line: string) => {
      try {
        const request: MCPRequest = JSON.parse(line);
        const response = await this.handleRequest(request);
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (e: any) {
        // parseエラー
        const errorResponse: MCPResponse = {
          jsonrpc: "2.0",
          id: null as any,
          error: { code: -32700, message: `Parse error: ${e.message}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    });

    rl.on("close", () => {
      this.running = false;
      logger.info("[MCP Server] stdioトランスポート終了");
    });

    logger.info("[MCP Server] stdioモードで起動 (JSON-RPC 2.0 over stdio)");
    eventBus.publish(createEvent("system", "mcpServerStarted", {
      transport: "stdio",
    }));
  }

  /** TCPトランスポートで起動 */
  async startTcp(port: number = 9720): Promise<void> {
    if (this.running) return;
    this.port = port;

    const net = await import("net");

    this.server = net.createServer((socket: any) => {
      let buffer = "";

      socket.on("data", async (data: Buffer) => {
        buffer += data.toString();

        // 改行区切りJSON-RPC
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const request: MCPRequest = JSON.parse(line);
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response) + "\n");
          } catch (e: any) {
            const errorResponse: MCPResponse = {
              jsonrpc: "2.0",
              id: null as any,
              error: { code: -32700, message: `Parse error: ${e.message}` },
            };
            socket.write(JSON.stringify(errorResponse) + "\n");
          }
        }
      });

      socket.on("error", (err: any) => {
        logger.error(`[MCP Server] ソケットエラー: ${err.message}`);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, () => {
        this.running = true;
        logger.info(`[MCP Server] TCPモードで起動: port ${port}`);
        eventBus.publish(createEvent("system", "mcpServerStarted", {
          transport: "tcp",
          port,
        }));
        resolve();
      });
      this.server!.on("error", (err: any) => {
        reject(err);
      });
    });
  }

  /** MCPサーバー停止 */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.transport === "tcp" && this.server) {
      try {
        this.server.close();
      } catch {}
    }

    logger.info("[MCP Server] 停止");
    eventBus.publish(createEvent("system", "mcpServerStopped", {}));
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ==================== JSON-RPCヘルパー ====================

  private jsonRpc(id: string | number, result: unknown): MCPResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private jsonRpcError(id: string | number, code: number, message: string, data?: unknown): MCPResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }
}

// ==================== シングルトン ====================

export const mcpServer = new MCPServer();

/** MCPサーバー起動（環境変数制御） */
export function startMcpServer(port?: number): void {
  const transport = process.env.MCP_TRANSPORT || "stdio";

  if (transport === "tcp") {
    const p = port || parseInt(process.env.MCP_PORT || "9720", 10);
    mcpServer.startTcp(p).catch((e: any) => {
      logger.error(`[MCP Server] TCP起動失敗: ${e.message}`);
    });
  } else {
    mcpServer.startStdio();
  }
}
