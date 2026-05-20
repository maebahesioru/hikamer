// ==========================================
// Hikamer - Plugin Agent Architecture（roborev internal/agent/ 由来）
// エージェントインターフェース + レジストリ + フォールバックチェーン
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type ReasoningLevel = "maximum" | "thorough" | "medium" | "standard" | "fast";

export interface AgentConfig {
  model?: string;
  provider?: string;
  reasoning?: ReasoningLevel;
  agentic?: boolean;
  timeoutMs?: number;
}

export interface AgentContext {
  repoPath?: string;
  commitSHA?: string;
  prompt: string;
  config: AgentConfig;
}

export interface AgentResult {
  text: string;
  model: string;
  provider: string;
  reasoning?: ReasoningLevel;
  durationMs: number;
  tokensUsed?: number;
}

/** エージェントプラグインインターフェース */
export interface AgentPlugin {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedReasoning: ReasoningLevel[];

  /** レビュー実行 */
  review(ctx: AgentContext, output?: (chunk: string) => void): Promise<AgentResult>;

  /** エージェント実行（変更を伴う） */
  execute(ctx: AgentContext, output?: (chunk: string) => void): Promise<AgentResult>;

  /** 利用可能かチェック */
  isAvailable(): Promise<boolean>;

  /** エージェントのCLIコマンドライン（デバッグ用） */
  commandLine(ctx: AgentContext): string;

  /** 設定を適用 */
  withConfig(config: Partial<AgentConfig>): AgentPlugin;
}

// ==================== レジストリ ====================

class AgentRegistry {
  private agents = new Map<string, AgentPlugin>();
  private aliases = new Map<string, string>();

  /** エージェントを登録 */
  register(agent: AgentPlugin, ...aliases: string[]): void {
    this.agents.set(agent.name, agent);
    for (const alias of aliases) {
      this.aliases.set(alias, agent.name);
    }
    logger.info(`[AgentRegistry] 登録: ${agent.name} (${agent.displayName})`);
  }

  /** エージェントを取得 */
  get(name: string): AgentPlugin | undefined {
    const resolved = this.aliases.get(name) || name;
    return this.agents.get(resolved);
  }

  /** 優先順位付きフォールバックチェーンで取得 */
  async getAvailable(preferred?: string, ...backups: string[]): Promise<AgentPlugin | null> {
    const candidates = [preferred, ...backups, ...this.agents.keys()].filter(Boolean) as string[];

    for (const name of candidates) {
      const agent = this.get(name);
      if (!agent) continue;
      try {
        if (await agent.isAvailable()) return agent;
      } catch { continue; }
    }
    return null;
  }

  /** 全エージェント一覧 */
  list(): AgentPlugin[] {
    return Array.from(this.agents.values());
  }

  /** 利用可能なエージェント一覧 */
  async listAvailable(): Promise<AgentPlugin[]> {
    const available: AgentPlugin[] = [];
    for (const agent of this.agents.values()) {
      try {
        if (await agent.isAvailable()) available.push(agent);
      } catch { continue; }
    }
    return available;
  }

  formatStatus(): string {
    const lines: string[] = ["🤖 **Agent Plugin Registry**"];
    for (const agent of this.agents.values()) {
      lines.push(`  • **${agent.name}**: ${agent.displayName}`);
      lines.push(`    理由付け: ${agent.supportedReasoning.join(", ")}`);
    }
    lines.push(`  エイリアス: ${this.aliases.size}`);
    return lines.join("\n");
  }
}

export const agentRegistry = new AgentRegistry();

// ==================== 組み込みエージェント実装 ====================

/** 汎用ACPエージェント（ACPI準拠CLIをラップ） */
export class AcpAgent implements AgentPlugin {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedReasoning: ReasoningLevel[];
  private command: string;
  private args: string[];
  private config: AgentConfig;

  constructor(opts: {
    name: string;
    displayName: string;
    description: string;
    command: string;
    args?: string[];
    supportedReasoning?: ReasoningLevel[];
  }) {
    this.name = opts.name;
    this.displayName = opts.displayName;
    this.description = opts.description;
    this.command = opts.command;
    this.args = opts.args || [];
    this.supportedReasoning = opts.supportedReasoning || ["standard", "fast"];
    this.config = {};
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = require("child_process");
      execSync(`${this.command} --version 2>/dev/null || ${this.command} -v 2>/dev/null || ${this.command} version 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch { return false; }
  }

  async review(ctx: AgentContext, output?: (chunk: string) => void): Promise<AgentResult> {
    return this.run(ctx, "review", output);
  }

  async execute(ctx: AgentContext, output?: (chunk: string) => void): Promise<AgentResult> {
    return this.run(ctx, "execute", output);
  }

  commandLine(ctx: AgentContext): string {
    const args = this.buildArgs(ctx, "");
    return `${this.command} ${args.join(" ")}`;
  }

  withConfig(config: Partial<AgentConfig>): AgentPlugin {
    const clone = Object.create(this) as AcpAgent;
    clone.config = { ...this.config, ...config };
    return clone;
  }

  private async run(ctx: AgentContext, mode: string, output?: (chunk: string) => void): Promise<AgentResult> {
    const start = Date.now();
    const args = this.buildArgs(ctx, mode);

    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process");
      const proc = spawn(this.command, args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        output?.(text);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code: number) => {
        const durationMs = Date.now() - start;
        resolve({
          text: stdout,
          model: this.config.model || this.name,
          provider: this.name,
          reasoning: this.config.reasoning,
          durationMs,
        });
      });

      proc.on("error", reject);

      proc.stdin.write(ctx.prompt);
      proc.stdin.end();
    });
  }

  private buildArgs(ctx: AgentContext, mode: string): string[] {
    const args = [...this.args];
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.reasoning && this.config.reasoning !== "standard") {
      args.push("--reasoning", this.config.reasoning);
    }
    if (mode === "review") args.push("--review");
    if (ctx.repoPath) args.push("--repo", ctx.repoPath);
    return args;
  }
}
