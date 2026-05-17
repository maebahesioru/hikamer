// ==========================================
// Aikata - MCPクライアント（JSON-RPC直実装）
// stdio/HTTP MCPサーバーに接続→ツール動的発見→toolRegistry登録
// ==========================================

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { logger } from "../utils/logger";
import { toolRegistry } from "./registry";

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

class McpConnection {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private _url: string | null = null;
  private closed = false;

  get name(): string { return this._name; }
  constructor(private _name: string) {}

  async connect(config: McpServerConfig): Promise<void> {
    if (config.command) {
      return this.connectStdio(config.command, config.args || []);
    }
    if (config.url) {
      this._url = config.url;
      return; // HTTPはcall時に接続
    }
    throw new Error("command か url が必要");
  }

  private async connectStdio(command: string, args: string[]): Promise<void> {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {}
    });

    this.proc.on("exit", () => {
      this.closed = true;
      this.pending.forEach((p) => p.reject(new Error("MCPサーバーが切断されました")));
      this.pending.clear();
    });
    this.proc.stderr?.on("data", (d) => {
      logger.debug(`[MCP/${this._name} stderr] ${d.toString().trim()}`);
    });

    // Initialize
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "aikata", version: "1.0.0" },
    });
  }

  async request(method: string, params?: any): Promise<any> {
    if (this._url) {
      return this.requestHttp(method, params);
    }
    if (!this.proc || !this.rl) throw new Error("未接続");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  private async requestHttp(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(this._url!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    });

    const json = await res.json() as JsonRpcResponse;
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request("tools/list");
    return (result?.tools || []) as McpToolInfo[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.content) {
      return result.content
        .map((c: any) => c.text || JSON.stringify(c))
        .join("\n");
    }
    return JSON.stringify(result || {});
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
    this.pending.forEach((p) => p.reject(new Error("Closed")));
    this.pending.clear();
  }
}

const connections = new Map<string, McpConnection>();

/** MCPサーバーに接続し、ツールを自動登録 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  if (connections.has(config.name)) {
    return [`${config.name}: 既に接続済み`];
  }

  const conn = new McpConnection(config.name);
  try {
    await conn.connect(config);
    connections.set(config.name, conn);

    const tools = await conn.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const toolName = `mcp_${config.name}_${tool.name}`;
      toolRegistry.register({
        name: toolName,
        emoji: "🔌",
        owner: "mcp",
        description: `[MCP/${config.name}] ${tool.description || tool.name}`,
        parameters: {
          type: "object",
          properties: (tool.inputSchema?.properties || {}) as Record<string, unknown>,
          required: (tool.inputSchema?.required || []) as string[],
        },
        async execute(args) {
          const c = connections.get(config.name);
          if (!c) return `[エラー] MCPサーバー '${config.name}' が切断されました`;
          return c.callTool(tool.name, args);
        },
      });

      registered.push(toolName);
    }

    logger.info(`MCP接続: ${config.name} (${registered.length}ツール)`);
    return registered;
  } catch (e: any) {
    connections.delete(config.name);
    logger.error(`MCP接続失敗: ${config.name} — ${e.message}`);
    return [`${config.name}: 接続失敗 — ${e.message}`];
  }
}

/** MCPサーバー切断 */
export async function disconnectMcpServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (conn) {
    await conn.close();
    connections.delete(name);
    logger.info(`MCP切断: ${name}`);
  }
}

/** 起動時に全MCPサーバーに自動接続（.envのMCP_SERVERSで設定） */
export async function connectAllMcpServers(): Promise<void> {
  const serversStr = process.env.MCP_SERVERS;
  if (!serversStr) {
    logger.info("MCP_SERVERS未設定 → MCPサーバー接続スキップ");
    return;
  }

  const servers: McpServerConfig[] = JSON.parse(serversStr);
  for (const s of servers) {
    await connectMcpServer(s);
  }
}
