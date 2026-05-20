// ==========================================
// Hikamer - プライバシーフィルター
// 出典: agentmemory (rohitg00/agentmemory) Privacy Filter
// APIキー・秘密情報・個人情報を自動マスク
// ==========================================

import { logger } from "./utils/logger";

// ==================== 機密パターン（agentmemory privacy filter由来） ====================

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
  severity: "high" | "medium" | "low";
}

const SECRET_PATTERNS: SecretPattern[] = [
  // === API Keys ===
  {
    name: "OpenAI API Key",
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: "sk-***REDACTED***",
    severity: "high",
  },
  {
    name: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9]{20,}/g,
    replacement: "sk-ant-***REDACTED***",
    severity: "high",
  },
  {
    name: "Claude API Key",
    pattern: /claude-[A-Za-z0-9]{20,}/g,
    replacement: "claude-***REDACTED***",
    severity: "high",
  },
  {
    name: "Google AI Key",
    pattern: /AIza[0-9A-Za-z\-_]{35,}/g,
    replacement: "AIza***REDACTED***",
    severity: "high",
  },
  {
    name: "HuggingFace Token",
    pattern: /hf_[A-Za-z0-9]{20,}/g,
    replacement: "hf_***REDACTED***",
    severity: "high",
  },
  {
    name: "GitHub Token",
    pattern: /gh[ps]_[A-Za-z0-9]{20,}/g,
    replacement: "gh_***REDACTED***",
    severity: "high",
  },
  {
    name: "GitLab Token",
    pattern: /glpat-[A-Za-z0-9\-_]{20,}/g,
    replacement: "glpat-***REDACTED***",
    severity: "high",
  },
  {
    name: "Discord Bot Token",
    pattern: /[A-Za-z0-9\-_]{24}\.[A-Za-z0-9\-_]{6}\.[A-Za-z0-9\-_]{27,}/g,
    replacement: "***DISCORD_TOKEN_REDACTED***",
    severity: "high",
  },
  {
    name: "Slack Token",
    pattern: /xox[bpras]-[A-Za-z0-9\-]{10,}/g,
    replacement: "xox-***REDACTED***",
    severity: "high",
  },
  {
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    replacement: "eyJ***JWT_REDACTED***",
    severity: "high",
  },
  {
    name: "AWS Access Key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "AKIA***REDACTED***",
    severity: "high",
  },
  {
    name: "Bearer Token",
    pattern: /Bearer\s+[A-Za-z0-9\-_.~+/=]{20,}/gi,
    replacement: "Bearer ***REDACTED***",
    severity: "high",
  },

  // === Generic Secrets ===
  {
    name: "Generic API Key (env style)",
    pattern: /(?:API[_-]?KEY|APY[_-]?KEY|SECRET[_-]?KEY|ACCESS[_-]?KEY)=['"]?[A-Za-z0-9\-_.]{16,}/gi,
    replacement: "$1=***REDACTED***",
    severity: "high",
  },
  {
    name: "Password field",
    pattern: /(?:password|passwd|pwd|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9!@#$%^&*()_+\-={}[\]|;:',.<>?/`~]{8,}/gi,
    replacement: "$1: ***REDACTED***",
    severity: "high",
  },

  // === Connection Strings ===
  {
    name: "MongoDB URI",
    pattern: /mongodb(?:\+srv)?:\/\/[^@\s]+@/g,
    replacement: "mongodb://***REDACTED***@",
    severity: "high",
  },
  {
    name: "PostgreSQL URI",
    pattern: /postgres(?:ql)?:\/\/[^@\s]+@/g,
    replacement: "postgres://***REDACTED***@",
    severity: "high",
  },
  {
    name: "MySQL URI",
    pattern: /mysql:\/\/[^@\s]+@/g,
    replacement: "mysql://***REDACTED***@",
    severity: "high",
  },
  {
    name: "Redis URI",
    pattern: /redis:\/\/[^@\s]+@/g,
    replacement: "redis://***REDACTED***@",
    severity: "high",
  },

  // === Personal Info ===
  {
    name: "Email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "***EMAIL_REDACTED***",
    severity: "medium",
  },
  {
    name: "Phone number (JP)",
    pattern: /(?:0[789]0|080|090|070|050)[-\s]?\d{4}[-\s]?\d{4}/g,
    replacement: "***PHONE_REDACTED***",
    severity: "medium",
  },
  {
    name: "IPv4 Address",
    pattern: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "***IP_REDACTED***",
    severity: "medium",
  },
  {
    name: "Private key PEM",
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: "***PRIVATE_KEY_REDACTED***",
    severity: "high",
  },

  // === Security Tags ===
  {
    name: "agentmemory <private> tag",
    pattern: /<private>[\s\S]*?<\/private>/g,
    replacement: "***PRIVATE_CONTENT_REDACTED***",
    severity: "high",
  },
];

// ==================== フィルター ====================

export interface FilterResult {
  /** フィルタリング後のテキスト */
  sanitized: string;
  /** 検出された機密情報の件数 */
  redactedCount: number;
  /** 何が赤actedされたか（重要度別） */
  bySeverity: { high: number; medium: number; low: number };
  /** 詳細ログ（デバッグ用） */
  details: Array<{ name: string; severity: string }>;
}

/**
 * テキストから機密情報をマスク（agentmemory privacy filter相当）
 */
export function filterSecrets(text: string): FilterResult {
  let sanitized = text;
  const details: Array<{ name: string; severity: string }> = [];
  const bySeverity = { high: 0, medium: 0, low: 0 };

  for (const rule of SECRET_PATTERNS) {
    const matches = sanitized.match(rule.pattern);
    if (matches) {
      sanitized = sanitized.replace(rule.pattern, rule.replacement);
      bySeverity[rule.severity]++;
      details.push({ name: rule.name, severity: rule.severity });
    }
  }

  return {
    sanitized,
    redactedCount: details.length,
    bySeverity,
    details,
  };
}

/**
 * 安全なメモリ観察用テキストを生成
 * observeMemoryに渡す前にこれを通す
 */
export function safeObservation(text: string, context?: string): string {
  let result = text;

  // <private>タグで囲まれた部分を削除
  result = result.replace(/<private>[\s\S]*?<\/private>/g, "***PRIVATE***");

  // 機密情報をマスク
  const filtered = filterSecrets(result);
  if (filtered.redactedCount > 0) {
    logger.debug(`[PrivacyFilter] ${filtered.redactedCount}件の機密情報をマスク (high:${filtered.bySeverity.high})`);
  }

  return filtered.sanitized;
}

/**
 * 特定のテキストが安全かチェック
 */
export function isSafe(text: string): { safe: boolean; reason?: string } {
  const filtered = filterSecrets(text);
  if (filtered.bySeverity.high > 0) {
    const reasons = filtered.details
      .filter(d => d.severity === "high")
      .map(d => d.name);
    return { safe: false, reason: `機密情報含む: ${reasons.join(", ")}` };
  }
  return { safe: true };
}
