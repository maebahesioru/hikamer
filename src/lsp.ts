// ==========================================
// Aikata - LSP統合（Hermes Agent agent/lsp/ 由来）
// Language Server Protocolクライアント
// コード補完・診断・定義ジャンプ
// ==========================================

import { logger } from "./utils/logger";
import { execSync, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface LSPServer {
  name: string;
  language: string;
  command: string;
  args: string[];
  running: boolean;
  process?: ChildProcess;
}

export interface LSPDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  code?: string;
}

export interface LSPCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
}

// ==================== LSPマネージャー ====================

class LSPManager {
  private servers: LSPServer[] = [];
  private diagnostics: Map<string, LSPDiagnostic[]> = new Map();
  private initialized = false;

  // 対応言語とサーバー
  private readonly SERVER_CONFIGS: Array<{ name: string; language: string; command: string; args: string[] }> = [
    { name: "TypeScript", language: "typescript", command: "npx", args: ["typescript-language-server", "--stdio"] },
    { name: "Python", language: "python", command: "pylsp", args: [] },
    { name: "Rust", language: "rust", command: "rust-analyzer", args: [] },
    { name: "JSON", language: "json", command: "npx", args: ["vscode-json-languageserver", "--stdio"] },
    { name: "YAML", language: "yaml", command: "npx", args: ["yaml-language-server", "--stdio"] },
  ];

  init(): void {
    if (this.initialized) return;
    this.discoverServers();
    this.initialized = true;
    logger.info(`[LSP] initialized: ${this.servers.length} servers`);
  }

  /** 利用可能なLSPサーバーを検出 */
  discoverServers(): void {
    for (const config of this.SERVER_CONFIGS) {
      try {
        execSync(`which ${config.command.split(" ")[0]!} 2>/dev/null || npx ${config.args[0]} --version 2>/dev/null`, { timeout: 5000 });
        this.servers.push({
          ...config,
          running: false,
        });
      } catch {
        // サーバーが利用不可
      }
    }
  }

  /** サーバーを起動 */
  async startServer(language: string): Promise<boolean> {
    const config = this.servers.find((s) => s.language === language);
    if (!config) return false;
    if (config.running) return true;

    try {
      const proc = spawn(config.command, config.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      config.process = proc;
      config.running = true;

      // 初期化
      this.sendInitialize(proc, language);

      logger.info(`[LSP] started ${config.name} server`);
      return true;
    } catch (err) {
      logger.error(`[LSP] failed to start ${config.name}:`, err);
      return false;
    }
  }

  /** ファイルの診断を取得 */
  async getDiagnostics(filePath: string): Promise<LSPDiagnostic[]> {
    const ext = path.extname(filePath).replace(".", "");
    const lang = this.languageFromExt(ext);

    if (!lang || !await this.startServer(lang)) return [];

    const cached = this.diagnostics.get(filePath);
    if (cached) return cached;

    // LSPサーバーとの通信はstdioベース
    // 実運用ではJSON-RPCメッセージをやり取り
    return [];
  }

  /** 補完候補を取得 */
  async getCompletions(
    filePath: string,
    line: number,
    column: number
  ): Promise<LSPCompletionItem[]> {
    const ext = path.extname(filePath).replace(".", "");
    const lang = this.languageFromExt(ext);

    if (!lang) return [];
    await this.startServer(lang);

    // 実際の補完はJSON-RPC経由
    return [];
  }

  /** サーバー一覧 */
  listServers(): LSPServer[] {
    return this.servers.map((s) => ({
      name: s.name,
      language: s.language,
      command: s.command,
      args: s.args,
      running: s.running,
    }));
  }

  /** 全サーバー停止 */
  stopAll(): void {
    for (const server of this.servers) {
      if (server.process) {
        server.process.kill();
        server.running = false;
      }
    }
  }

  // ---- 内部 ----

  private sendInitialize(proc: ChildProcess, language: string): void {
    // JSON-RPC initialize request
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: `file://${process.cwd()}`,
        capabilities: {
          textDocument: {
            completion: { completionItem: { snippetSupport: true } },
            diagnostic: {},
          },
        },
      },
    });

    const header = `Content-Length: ${Buffer.byteLength(initMsg, "utf-8")}\r\n\r\n`;
    proc.stdin?.write(header + initMsg);
  }

  private languageFromExt(ext: string): string | null {
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript",
      js: "typescript", jsx: "typescript",
      py: "python", rs: "rust",
      json: "json", yaml: "yaml", yml: "yaml",
    };
    return map[ext] ?? null;
  }

  formatStatus(): string {
    const servers = this.listServers();
    return (
      `🔧 **LSPサーバー (${servers.length})**\n\n` +
      (servers.length > 0
        ? servers
            .map(
              (s) =>
                `${s.running ? "🟢" : "⚪"} **${s.name}** (${s.language})\n` +
                `   実行: ${s.command} ${s.args.join(" ")}`
            )
            .join("\n\n")
        : "利用可能なLSPサーバーはありません\n\n" +
          "インストール: npm install -g typescript-language-server")
    );
  }
}

// ==================== シングルトン ====================

export const lspManager = new LSPManager();

export default LSPManager;
