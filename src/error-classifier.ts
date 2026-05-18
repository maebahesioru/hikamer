// ==========================================
// Aikata - API Error Classifier（Hermes Agent error_classifier.py 完全移植）
// 25カテゴリのAPIエラー分類＋リカバリー戦略
// ==========================================

import { logger } from "./utils/logger";

// ==================== エラー分類 ====================

export type FailoverReason =
  | "auth" | "auth_permanent"
  | "billing" | "rate_limit"
  | "overloaded" | "server_error"
  | "timeout"
  | "context_overflow" | "payload_too_large" | "image_too_large"
  | "model_not_found" | "provider_policy_blocked"
  | "format_error"
  | "thinking_signature" | "long_context_tier"
  | "oauth_long_context_beta_forbidden" | "llama_cpp_grammar_pattern"
  | "unknown";

export interface ClassifiedError {
  reason: FailoverReason;
  statusCode?: number;
  provider?: string;
  model?: string;
  message: string;
  retryable: boolean;
  shouldCompress: boolean;
  shouldRotateCredential: boolean;
  shouldFallback: boolean;
}

// ==================== パターン定義 ====================

const BILLING_PATTERNS = [
  "insufficient credits", "insufficient_quota", "insufficient balance",
  "credit balance", "credits have been exhausted", "top up your credits",
  "payment required", "billing hard limit", "exceeded your current quota",
  "account is deactivated", "plan does not include",
];

const RATE_LIMIT_PATTERNS = [
  "rate limit", "rate_limit", "too many requests", "throttled",
  "requests per minute", "tokens per minute", "requests per day",
  "try again in", "please retry after", "resource_exhausted",
  "rate increased too quickly", "throttlingexception",
  "too many concurrent requests", "servicequotaexceededexception",
];

const USAGE_LIMIT_PATTERNS = ["usage limit", "quota", "limit exceeded", "key limit exceeded"];
const USAGE_LIMIT_TRANSIENT_SIGNALS = ["try again", "retry", "resets at", "reset in", "wait", "requests remaining", "periodic", "window"];

const PAYLOAD_TOO_LARGE_PATTERNS = ["request entity too large", "payload too large", "error code: 413"];
const IMAGE_TOO_LARGE_PATTERNS = ["image exceeds", "image too large", "image_too_large", "image size exceeds"];

const CONTEXT_OVERFLOW_PATTERNS = [
  "context length", "context size", "maximum context", "token limit",
  "too many tokens", "reduce the length", "exceeds the limit",
  "context window", "prompt is too long", "prompt exceeds max length",
  "max_tokens", "maximum number of tokens", "exceeds the max_model_len",
  "max_model_len", "prompt length", "input is too long",
  "maximum model length", "context length exceeded",
  "truncating input", "slot context", "n_ctx_slot",
  "超过最大长度", "上下文长度",
  "max input token", "input token",
  "exceeds the maximum number of input tokens",
];

const MODEL_NOT_FOUND_PATTERNS = [
  "is not a valid model", "invalid model", "model not found",
  "model_not_found", "does not exist", "no such model",
  "unknown model", "unsupported model",
];

const PROVIDER_POLICY_BLOCKED_PATTERNS = [
  "no endpoints available matching your guardrail",
  "no endpoints available matching your data policy",
  "no endpoints found matching your data policy",
];

const AUTH_PATTERNS = [
  "invalid api key", "invalid_api_key", "authentication",
  "unauthorized", "forbidden", "invalid token", "token expired",
  "token revoked", "access denied",
];

const TIMEOUT_MESSAGE_PATTERNS = [
  "timed out", "turn timed out", "request timed out",
  "deadline exceeded", "operation timed out", "upstream timed out",
];

const TRANSPORT_ERROR_TYPES = new Set([
  "readtimeout", "connecttimeout", "pooltimeout",
  "connecterror", "remoteprotocolerror",
  "connectionerror", "connectionreseterror",
  "connectionabortederror", "brokenerror",
  "timeouterror", "readerror",
  "serverdisconnectederror",
]);

const SERVER_DISCONNECT_PATTERNS = [
  "server disconnected", "peer closed connection",
  "connection reset by peer", "connection was closed",
  "network connection lost", "unexpected eof", "incomplete chunked read",
];

// ==================== 分類パイプライン ====================

export function classifyApiError(
  error: Error,
  provider = "",
  model = "",
  approxTokens = 0,
  contextLength = 200000,
  numMessages = 0,
): ClassifiedError {
  const statusCode = extractStatusCode(error);
  const errorMsg = (error.message || "").toLowerCase();
  const errorType = error.constructor.name.toLowerCase();

  // ヘルパー
  const result = (reason: FailoverReason, overrides: Partial<ClassifiedError> = {}): ClassifiedError => ({
    reason,
    statusCode,
    provider,
    model,
    message: error.message.slice(0, 500),
    retryable: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
    ...overrides,
  });

  // 1. プロバイダ固有パターン
  if (statusCode === 400 && errorMsg.includes("signature") && errorMsg.includes("thinking")) {
    return result("thinking_signature", { retryable: true });
  }
  if (statusCode === 429 && errorMsg.includes("extra usage") && errorMsg.includes("long context")) {
    return result("long_context_tier", { retryable: true, shouldCompress: true });
  }
  if (statusCode === 400 && errorMsg.includes("long context beta") && errorMsg.includes("not yet available")) {
    return result("oauth_long_context_beta_forbidden", { retryable: true });
  }
  if (statusCode === 400 && (errorMsg.includes("error parsing grammar") || errorMsg.includes("json-schema-to-grammar"))) {
    return result("llama_cpp_grammar_pattern", { retryable: true });
  }

  // 2. HTTPステータスコード分類
  if (statusCode !== undefined) {
    const statusResult = classifyByStatus(statusCode, errorMsg, result);
    if (statusResult) return statusResult;
  }

  // 3. メッセージパターン分類
  const msgResult = classifyByMessage(errorMsg, errorType, approxTokens, contextLength, result);
  if (msgResult) return msgResult;

  // 4. SSL/TLS一時エラー
  if (/(bad record mac|ssl alert|tls alert|ssl handshake failure|tlsv1 alert)/i.test(errorMsg)) {
    return result("timeout");
  }

  // 5. サーバーディスコネクト＋大規模セッション
  const isDisconnect = SERVER_DISCONNECT_PATTERNS.some((p) => errorMsg.includes(p));
  if (isDisconnect) {
    const isLarge = approxTokens > contextLength * 0.6 ||
      (contextLength <= 256000 && (approxTokens > 120000 || numMessages > 200));
    if (isLarge) return result("context_overflow", { retryable: true, shouldCompress: true });
    return result("timeout");
  }

  // 6. トランスポートエラー
  if (TRANSPORT_ERROR_TYPES.has(errorType)) {
    return result("timeout");
  }

  // 7. フォールバック
  return result("unknown");
}

// ==================== ステータスコード分類 ====================

function classifyByStatus(
  statusCode: number,
  errorMsg: string,
  result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError,
): ClassifiedError | null {
  switch (statusCode) {
    case 401:
      return result("auth", { retryable: false, shouldRotateCredential: true, shouldFallback: true });

    case 403:
      if (errorMsg.includes("key limit exceeded") || errorMsg.includes("spending limit")) {
        return result("billing", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
      }
      return result("auth", { retryable: false, shouldFallback: true });

    case 402: {
      const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => errorMsg.includes(p));
      const hasTransient = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => errorMsg.includes(p));
      if (hasUsageLimit && hasTransient) {
        return result("rate_limit", { shouldRotateCredential: true, shouldFallback: true });
      }
      return result("billing", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
    }

    case 404: {
      if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => errorMsg.includes(p))) {
        return result("provider_policy_blocked", { retryable: false, shouldFallback: false });
      }
      if (MODEL_NOT_FOUND_PATTERNS.some((p) => errorMsg.includes(p))) {
        return result("model_not_found", { retryable: false, shouldFallback: true });
      }
      return result("unknown", { retryable: true });
    }

    case 413:
      return result("payload_too_large", { retryable: true, shouldCompress: true });

    case 429:
      return result("rate_limit", { shouldRotateCredential: true, shouldFallback: true });

    case 400:
      return classify400(errorMsg, result);

    case 500:
    case 502:
      return result("server_error");

    case 503:
    case 529:
      return result("overloaded");

    default:
      if (statusCode >= 400 && statusCode < 500) {
        return result("format_error", { retryable: false, shouldFallback: true });
      }
      if (statusCode >= 500 && statusCode < 600) {
        return result("server_error");
      }
      return null;
  }
}

function classify400(
  errorMsg: string,
  result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError,
): ClassifiedError | null {
  if (IMAGE_TOO_LARGE_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("image_too_large");
  }
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("context_overflow", { shouldCompress: true });
  }
  if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("provider_policy_blocked", { retryable: false, shouldFallback: false });
  }
  if (MODEL_NOT_FOUND_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("model_not_found", { retryable: false, shouldFallback: true });
  }
  if (RATE_LIMIT_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("rate_limit", { shouldRotateCredential: true, shouldFallback: true });
  }
  if (BILLING_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("billing", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
  }
  return result("format_error", { retryable: false, shouldFallback: true });
}

// ==================== メッセージパターン分類 ====================

function classifyByMessage(
  errorMsg: string,
  _errorType: string,
  approxTokens: number,
  contextLength: number,
  result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError,
): ClassifiedError | null {
  if (PAYLOAD_TOO_LARGE_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("payload_too_large", { shouldCompress: true });
  }
  if (IMAGE_TOO_LARGE_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("image_too_large");
  }

  const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => errorMsg.includes(p));
  if (hasUsageLimit) {
    const hasTransient = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => errorMsg.includes(p));
    if (hasTransient) {
      return result("rate_limit", { shouldRotateCredential: true, shouldFallback: true });
    }
    return result("billing", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
  }

  if (BILLING_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("billing", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
  }
  if (RATE_LIMIT_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("rate_limit", { shouldRotateCredential: true, shouldFallback: true });
  }
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("context_overflow", { shouldCompress: true });
  }
  if (AUTH_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("auth", { retryable: false, shouldRotateCredential: true, shouldFallback: true });
  }
  if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("provider_policy_blocked", { retryable: false, shouldFallback: false });
  }
  if (MODEL_NOT_FOUND_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("model_not_found", { retryable: false, shouldFallback: true });
  }
  if (TIMEOUT_MESSAGE_PATTERNS.some((p) => errorMsg.includes(p))) {
    return result("timeout");
  }

  return null;
}

// ==================== ヘルパー ====================

function extractStatusCode(error: Error): number | undefined {
  const err = error as any;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.status === "number" && err.status >= 100 && err.status < 600) return err.status;
  if (err.response && typeof err.response.status === "number") return err.response.status;
  return undefined;
}

export function formatClassifiedError(ce: ClassifiedError): string {
  const icons: Record<FailoverReason, string> = {
    auth: "🔑", auth_permanent: "🔒", billing: "💰", rate_limit: "⏱️",
    overloaded: "🔥", server_error: "💥", timeout: "⏰",
    context_overflow: "📏", payload_too_large: "📦", image_too_large: "🖼️",
    model_not_found: "🔍", provider_policy_blocked: "🚫",
    format_error: "❓", thinking_signature: "🧠",
    long_context_tier: "📈", oauth_long_context_beta_forbidden: "🔐",
    llama_cpp_grammar_pattern: "📝", unknown: "❔",
  };

  return [
    `${icons[ce.reason]} **API Error**`,
    `  理由: ${ce.reason}`,
    ce.statusCode ? `  ステータス: ${ce.statusCode}` : "",
    ce.provider ? `  プロバイダ: ${ce.provider}` : "",
    ce.model ? `  モデル: ${ce.model}` : "",
    `  メッセージ: ${ce.message.slice(0, 200)}`,
    `  リカバリー: ${ce.retryable ? "🔄 リトライ可" : "⛔ リトライ不可"}${ce.shouldCompress ? " 📦 圧縮必要" : ""}${ce.shouldRotateCredential ? " 🔄 認証情報ローテート" : ""}${ce.shouldFallback ? " ⬇️ フォールバック" : ""}`,
  ].filter(Boolean).join("\n");
}
