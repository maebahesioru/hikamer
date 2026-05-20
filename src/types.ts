// ==========================================
// Hikamer - コア型定義 (v1.2 - streaming + reasoning)
// ==========================================

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek V4など推論モデルの思考過程 */
  reasoning_content?: string;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  finishReason: string;
  /** 推論テキスト（DeepSeek V4等） */
  reasoning_content?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
}

/** ストリーミングチャンク */
export interface LLMChunk {
  content_delta: string;
  reasoning_delta: string;
  tool_calls: ToolCall[] | null;
  finishReason: string | null;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** 拡張ツール記述子（自己登録・可用性・絵文字対応） */
export interface ToolDescriptor extends Tool {
  /** ツール表示絵文字（formatToolで使用） */
  emoji: string;
  /** 所有者カテゴリ */
  owner: "core" | "plugin" | "mcp";
  /** 可用性条件（省略時は常に利用可能） */
  availability?: {
    /** 有効にするのに必要な環境変数 */
    requiresEnv?: string[];
    /** 追加の条件チェック関数（trueなら利用可能） */
    checkFn?: () => boolean;
  };
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: Message[], tools: Tool[]): Promise<LLMResponse>;
  /** ストリーミング対応 */
  chatStream?(messages: Message[], tools: Tool[]): AsyncGenerator<LLMChunk>;
}

export interface AgentResult {
  response: string;
  iterations: number;
  toolLogs: ToolLogEntry[];
  /** 全推論テキスト（蓄積） */
  reasoning?: string;
  /** スレッドタイトル */
  threadTitle?: string;
}

export interface ToolLogEntry {
  tool_name: string;
  args: Record<string, unknown>;
  result: string;
  duration_ms: number;
  success: boolean;
  error?: string;
}

export interface MessageRow {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
}

/** プラットフォーム種別 */
export type Platform = "discord" | "telegram" | "cli";

/** ストリーミング設定 */
export interface StreamConfig {
  enabled: boolean;
}

// ==================== 構造化ツールエラー ====================

/** ツール実行時の構造化エラー。LLMにリッチなエラー情報を渡す */
export class ToolError extends Error {
  retryable: boolean;
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, options?: { retryable?: boolean; code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "ToolError";
    this.retryable = options?.retryable ?? false;
    this.code = options?.code ?? "TOOL_ERROR";
    this.details = options?.details;
  }

  toToolResult(): string {
    const parts = [`[エラー] ${this.message}`];
    if (this.code) parts.push(`コード: ${this.code}`);
    if (this.retryable) parts.push(`(再試行可能)`);
    return parts.join(" | ");
  }
}
