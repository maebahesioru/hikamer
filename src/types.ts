// ==========================================
// Aikata - コア型定義 (v1.1)
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
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: Message[], tools: Tool[]): Promise<LLMResponse>;
}

export interface AgentResult {
  response: string;
  iterations: number;
  toolLogs: ToolLogEntry[];
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
