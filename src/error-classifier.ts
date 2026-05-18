// ==========================================
// Aikata - エラー分類器（Hermes Agent error_classifier.py 由来）
// APIエラーの構造化分類・リカバリー戦略決定
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

/** フェイルオーバー理由 */
export enum FailoverReason {
  Auth = "auth",
  AuthPermanent = "auth_permanent",
  Billing = "billing",
  RateLimit = "rate_limit",
  Overloaded = "overloaded",
  ServerError = "server_error",
  Timeout = "timeout",
  ContextOverflow = "context_overflow",
  PayloadTooLarge = "payload_too_large",
  ImageTooLarge = "image_too_large",
  ModelNotFound = "model_not_found",
  ProviderPolicyBlocked = "provider_policy_blocked",
  FormatError = "format_error",
  LlamaCppGrammar = "llama_cpp_grammar_pattern",
  Unknown = "unknown",
}

/** 分類結果 */
export interface ClassifiedError {
  reason: FailoverReason;
  statusCode: number | null;
  provider: string;
  model: string;
  message: string;
  errorContext: Record<string, unknown>;
  retryable: boolean;
  shouldCompress: boolean;
  shouldRotateCredential: boolean;
  shouldFallback: boolean;
  isAuth: boolean;
}

// ==================== パターン ====================

const BILLING_PATTERNS = [
  "insufficient credits",
  "insufficient_quota",
  "insufficient balance",
  "credit balance",
  "credits have been exhausted",
  "top up your credits",
  "payment required",
  "billing hard limit",
  "exceeded your current quota",
  "account is deactivated",
  "plan does not include",
];

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "throttled",
  "requests per minute",
  "tokens per minute",
  "try again in",
  "please retry after",
  "resource_exhausted",
  "throttlingexception",
  "too many concurrent",
];

const USAGE_LIMIT_PATTERNS = [
  "usage limit",
  "quota",
  "limit exceeded",
  "key limit exceeded",
];

const USAGE_LIMIT_TRANSIENT_SIGNALS = [
  "try again",
  "retry",
  "resets at",
  "reset in",
  "wait",
  "requests remaining",
  "periodic",
  "window",
];

const CONTEXT_OVERFLOW_PATTERNS = [
  "context length",
  "context size",
  "maximum context",
  "token limit",
  "too many tokens",
  "reduce the length",
  "exceeds the limit",
  "context window",
  "prompt is too long",
  "prompt exceeds max length",
  "max_tokens",
  "maximum number of tokens",
  "max_model_len",
  "input is too long",
  "maximum model length",
  "context length exceeded",
  "超过最大长度",
  "上下文长度",
  "exceeds the maximum number of input tokens",
];

const MODEL_NOT_FOUND_PATTERNS = [
  "is not a valid model",
  "invalid model",
  "model not found",
  "model_not_found",
  "does not exist",
  "no such model",
  "unknown model",
  "unsupported model",
];

const PROVIDER_POLICY_BLOCKED_PATTERNS = [
  "no endpoints available matching your guardrail",
  "no endpoints available matching your data policy",
];

const AUTH_PATTERNS = [
  "invalid api key",
  "invalid_api_key",
  "authentication",
  "unauthorized",
  "forbidden",
  "invalid token",
  "token expired",
  "token revoked",
  "access denied",
];

const TIMEOUT_MESSAGE_PATTERNS = [
  "timed out",
  "turn timed out",
  "request timed out",
  "deadline exceeded",
  "operation timed out",
  "upstream timed out",
];

const IMAGE_TOO_LARGE_PATTERNS = [
  "image exceeds",
  "image too large",
  "image_too_large",
  "image size exceeds",
];

const TRANSPORT_ERROR_TYPES = new Set([
  "ReadTimeout", "ConnectTimeout", "PoolTimeout",
  "ConnectError", "RemoteProtocolError",
  "ConnectionError", "ConnectionResetError",
  "ConnectionAbortedError", "BrokenPipeError",
  "TimeoutError", "ReadError",
  "ServerDisconnectedError",
  "SSLError", "SSLEOFError",
  "APIConnectionError", "APITimeoutError",
]);

const SSL_TRANSIENT_PATTERNS = [
  "bad record mac",
  "ssl alert",
  "tls alert",
  "ssl handshake failure",
  "bad_record_mac",
  "ssl_alert",
  "tls_alert",
  "[ssl:",
];

// ==================== エラー分類エンジン ====================

class ErrorClassifier {
  private stats = {
    totalClassified: 0,
    byReason: new Map<FailoverReason, number>(),
    recentErrors: [] as ClassifiedError[],
  };

  /** エラーを分類 */
  classify(
    error: Error | string,
    options?: {
      provider?: string;
      model?: string;
      statusCode?: number;
      approxTokens?: number;
      contextLength?: number;
      numMessages?: number;
    }
  ): ClassifiedError {
    this.stats.totalClassified++;

    const errorMsg =
      typeof error === "string" ? error : (error.message ?? String(error));
    const errorType = typeof error === "string" ? "" : error.constructor.name;
    const errorMsgLower = errorMsg.toLowerCase();

    const statusCode = options?.statusCode ?? null;
    const provider = options?.provider ?? "unknown";
    const model = options?.model ?? "unknown";
    const approxTokens = options?.approxTokens ?? 0;
    const contextLength = options?.contextLength ?? 200000;
    const numMessages = options?.numMessages ?? 0;

    const result = (reason: FailoverReason, overrides?: Partial<ClassifiedError>): ClassifiedError => {
      const defaults: ClassifiedError = {
        reason,
        statusCode,
        provider,
        model,
        message: errorMsg.slice(0, 500),
        errorContext: {},
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        isAuth: false,
      };

      if (reason === FailoverReason.Auth || reason === FailoverReason.AuthPermanent) {
        defaults.isAuth = true;
      }

      const classified = { ...defaults, ...overrides };
      this.recordStats(classified);
      return classified;
    };

    // ── 1. HTTPステータスコード分類 ──

    if (statusCode !== null) {
      return this.classifyByStatus(
        statusCode, errorMsgLower, provider, model,
        approxTokens, contextLength, numMessages, result
      );
    }

    // ── 2. メッセージパターンマッチ ──

    return this.classifyByMessage(
      errorMsgLower, errorType,
      approxTokens, contextLength, result
    );
  }

  /** 直近のエラーを取得 */
  getRecentErrors(count = 10): ClassifiedError[] {
    return this.stats.recentErrors.slice(-count);
  }

  /** 統計を取得 */
  getStats() {
    return {
      totalClassified: this.stats.totalClassified,
      byReason: new Map(this.stats.byReason),
    };
  }

  /** 統計をリセット */
  resetStats(): void {
    this.stats.totalClassified = 0;
    this.stats.byReason.clear();
    this.stats.recentErrors = [];
  }

  // ---- ステータスコード分類 ----

  private classifyByStatus(
    statusCode: number,
    msg: string,
    provider: string,
    model: string,
    approxTokens: number,
    contextLength: number,
    numMessages: number,
    result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError
  ): ClassifiedError {
    if (statusCode === 401) {
      return result(FailoverReason.Auth, {
        retryable: false,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    if (statusCode === 403) {
      if (msg.includes("key limit exceeded") || msg.includes("spending limit")) {
        return result(FailoverReason.Billing, {
          retryable: false,
          shouldRotateCredential: true,
          shouldFallback: true,
        });
      }
      return result(FailoverReason.Auth, {
        retryable: false,
        shouldFallback: true,
      });
    }

    if (statusCode === 402) {
      return this.classify402(msg, result);
    }

    if (statusCode === 404) {
      if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => msg.includes(p))) {
        return result(FailoverReason.ProviderPolicyBlocked, {
          retryable: false,
          shouldFallback: false,
        });
      }
      if (MODEL_NOT_FOUND_PATTERNS.some((p) => msg.includes(p))) {
        return result(FailoverReason.ModelNotFound, {
          retryable: false,
          shouldFallback: true,
        });
      }
      return result(FailoverReason.Unknown, { retryable: true });
    }

    if (statusCode === 413) {
      return result(FailoverReason.PayloadTooLarge, {
        retryable: true,
        shouldCompress: true,
      });
    }

    if (statusCode === 429) {
      return result(FailoverReason.RateLimit, {
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    if (statusCode === 400) {
      return this.classify400(msg, approxTokens, contextLength, numMessages, result);
    }

    if (statusCode === 500 || statusCode === 502) {
      return result(FailoverReason.ServerError, { retryable: true });
    }

    if (statusCode === 503 || statusCode === 529) {
      return result(FailoverReason.Overloaded, { retryable: true });
    }

    if (statusCode >= 400 && statusCode < 500) {
      return result(FailoverReason.FormatError, {
        retryable: false,
        shouldFallback: true,
      });
    }

    if (statusCode >= 500 && statusCode < 600) {
      return result(FailoverReason.ServerError, { retryable: true });
    }

    return result(FailoverReason.Unknown, { retryable: true });
  }

  // ---- 402 分類 ----

  private classify402(
    msg: string,
    result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError
  ): ClassifiedError {
    const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => msg.includes(p));
    const hasTransient = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => msg.includes(p));

    if (hasUsageLimit && hasTransient) {
      return result(FailoverReason.RateLimit, {
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    return result(FailoverReason.Billing, {
      retryable: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    });
  }

  // ---- 400 分類 ----

  private classify400(
    msg: string,
    approxTokens: number,
    contextLength: number,
    numMessages: number,
    result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError
  ): ClassifiedError {
    // Image too large (Anthropic 5MB per-image check)
    if (IMAGE_TOO_LARGE_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ImageTooLarge, { retryable: true });
    }

    // Context overflow
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ContextOverflow, {
        retryable: true,
        shouldCompress: true,
      });
    }

    // Model not found as 400
    if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ProviderPolicyBlocked, {
        retryable: false,
        shouldFallback: false,
      });
    }
    if (MODEL_NOT_FOUND_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ModelNotFound, {
        retryable: false,
        shouldFallback: true,
      });
    }

    // Rate limit / billing as 400
    if (RATE_LIMIT_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.RateLimit, {
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }
    if (BILLING_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.Billing, {
        retryable: false,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    // Generic 400 + large session → probable context overflow
    const isLarge = approxTokens > contextLength * 0.4 ||
      (contextLength <= 256000 && (approxTokens > 80000 || numMessages > 80));

    if (isLarge) {
      return result(FailoverReason.ContextOverflow, {
        retryable: true,
        shouldCompress: true,
      });
    }

    return result(FailoverReason.FormatError, {
      retryable: false,
      shouldFallback: true,
    });
  }

  // ---- メッセージパターン分類 ----

  private classifyByMessage(
    msg: string,
    errorType: string,
    approxTokens: number,
    contextLength: number,
    result: (reason: FailoverReason, overrides?: Partial<ClassifiedError>) => ClassifiedError
  ): ClassifiedError {
    // SSL/TLS transient errors
    if (SSL_TRANSIENT_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.Timeout, { retryable: true });
    }

    // Usage limit disambiguation
    const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => msg.includes(p));
    if (hasUsageLimit) {
      const hasTransient = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => msg.includes(p));
      if (hasTransient) {
        return result(FailoverReason.RateLimit, {
          retryable: true,
          shouldRotateCredential: true,
          shouldFallback: true,
        });
      }
      return result(FailoverReason.Billing, {
        retryable: false,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    // Billing
    if (BILLING_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.Billing, {
        retryable: false,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    // Rate limit
    if (RATE_LIMIT_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.RateLimit, {
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    // Context overflow
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ContextOverflow, {
        retryable: true,
        shouldCompress: true,
      });
    }

    // Auth
    if (AUTH_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.Auth, {
        retryable: false,
        shouldRotateCredential: true,
        shouldFallback: true,
      });
    }

    // Provider policy block
    if (PROVIDER_POLICY_BLOCKED_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ProviderPolicyBlocked, {
        retryable: false,
        shouldFallback: false,
      });
    }

    // Model not found
    if (MODEL_NOT_FOUND_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.ModelNotFound, {
        retryable: false,
        shouldFallback: true,
      });
    }

    // Timeout
    if (TIMEOUT_MESSAGE_PATTERNS.some((p) => msg.includes(p))) {
      return result(FailoverReason.Timeout, { retryable: true });
    }

    // Transport error by type
    if (TRANSPORT_ERROR_TYPES.has(errorType)) {
      return result(FailoverReason.Timeout, { retryable: true });
    }

    // Fallback
    return result(FailoverReason.Unknown, { retryable: true });
  }

  private recordStats(classified: ClassifiedError): void {
    const count = this.stats.byReason.get(classified.reason) ?? 0;
    this.stats.byReason.set(classified.reason, count + 1);
    this.stats.recentErrors.push(classified);
    if (this.stats.recentErrors.length > 100) {
      this.stats.recentErrors.shift();
    }
  }

  /** 分類結果を人間可読な文字列に */
  formatResult(classified: ClassifiedError): string {
    const icon =
      classified.reason === FailoverReason.Auth ? "🔑" :
      classified.reason === FailoverReason.Billing ? "💰" :
      classified.reason === FailoverReason.RateLimit ? "⏳" :
      classified.reason === FailoverReason.Timeout ? "⌛" :
      classified.reason === FailoverReason.ContextOverflow ? "📦" :
      classified.reason === FailoverReason.ModelNotFound ? "🔍" :
      classified.reason === FailoverReason.ServerError ? "🔴" :
      classified.reason === FailoverReason.Overloaded ? "⚠️" :
      "❓";

    const retryability = classified.retryable ? "🔄 リトライ可" : "⛔ リトライ不可";

    return (
      `${icon} **${classified.reason}** (${classified.statusCode ?? "?"})` +
      `\n   ${classified.message.slice(0, 150)}` +
      `\n   ${retryability}` +
      (classified.shouldCompress ? " | 📉 圧縮推奨" : "") +
      (classified.shouldRotateCredential ? " | 🔄 認証情報ローテート" : "") +
      (classified.shouldFallback ? " | 🔁 フォールバック推奨" : "")
    );
  }
}

// ==================== シングルトン ====================

export const errorClassifier = new ErrorClassifier();

// ==================== システムコマンド ====================

export function getErrorCommands(): Record<string, (args: string[]) => string> {
  return {
    "/errors": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "recent":
        case "log": {
          const errors = errorClassifier.getRecentErrors(10);
          if (errors.length === 0) return "📭 直近のエラーはありません";
          return (
            `🚨 **直近のエラー (${errors.length}件)**\n\n` +
            errors.map((e, i) => `${i + 1}. ${errorClassifier.formatResult(e)}`).join("\n\n")
          );
        }

        case "stats": {
          const stats = errorClassifier.getStats();
          if (stats.totalClassified === 0) return "📭 分類統計はまだありません";
          return (
            `📊 **エラー分類統計**\n` +
            `総分類数: ${stats.totalClassified}\n\n` +
            [...stats.byReason.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `- ${reason}: ${count}回`)
              .join("\n")
          );
        }

        case "reset": {
          errorClassifier.resetStats();
          return "🧹 エラー統計をリセットしました";
        }

        case "test": {
          const testError = args.slice(1).join(" ");
          if (!testError) return "⚠️ テストエラーメッセージが必要です";
          const classified = errorClassifier.classify(testError);
          return errorClassifier.formatResult(classified);
        }

        default:
          return (
            `🚨 **エラー分類コマンド**\n` +
            `/errors recent — 直近のエラー\n` +
            `/errors stats — 分類統計\n` +
            `/errors reset — 統計リセット\n` +
            `/errors test <msg> — テスト分類`
          );
      }
    },
  };
}

export default ErrorClassifier;
