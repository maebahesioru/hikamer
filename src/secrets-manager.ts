// ==========================================
// Hikamer - Secrets Management（OpenClaw secrets/ 由来）
// SecretRef解決（env/file/execプロバイダ）+ 監査・検証
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";

// ==================== 型定義 ====================

export type SecretRefSource = "env" | "file" | "exec";

export interface SecretRef {
  source: SecretRefSource;
  id: string;
  provider?: string;
}

export interface SecretProviderConfig {
  env?: { allowlist?: string[] };
  file?: { path?: string; mode?: "json" | "singleValue"; timeout?: number };
  exec?: { command?: string; args?: string[]; timeout?: number };
}

export interface SecretsConfig {
  providers?: Record<string, SecretProviderConfig>;
  resolution?: { concurrency?: number; cacheTtlMs?: number };
}

export type AuditSeverity = "info" | "warning" | "critical";

export interface AuditFinding {
  severity: AuditSeverity;
  category: string;
  message: string;
  path?: string;
  detail?: string;
}

// ==================== SecretRef 解決 ====================

const LEGACY_ENV_PREFIX = "secretref-env:";
const SECRET_CACHE = new Map<string, { value: string; expiresAt: number }>();
let cacheTtlMs = 60000; // 1分

/** SecretRefを解決 */
export function resolveSecretRef(ref: SecretRef, providers?: Record<string, SecretProviderConfig>): string | null {
  const cacheKey = `${ref.source}:${ref.id}`;
  const cached = SECRET_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: string | null = null;

  switch (ref.source) {
    case "env":
      value = process.env[ref.id] || null;
      break;
    case "file": {
      const path = resolve(ref.id);
      if (!existsSync(path)) return null;
      try {
        const raw = readFileSync(path, "utf-8").trim();
        // JSONファイルならref.id自体は使わずに中身を読む（単一値モード）
        if (raw.startsWith("{")) {
          const json = JSON.parse(raw);
          value = String(json[ref.provider || Object.keys(json)[0] || ""] || raw);
        } else {
          value = raw;
        }
      } catch {
        value = null;
      }
      break;
    }
    case "exec": {
      try {
        const parts = ref.id.split(/\s+/);
        const cmd = parts[0]!;
        const args = parts.slice(1);
        const timeout = (providers?.exec as any)?.timeout || 10000;
        const out = execSync(`${cmd} ${args.join(" ")}`, {
          timeout,
          stdio: "pipe",
          encoding: "utf-8",
        }).toString().trim();
        value = out;
      } catch {
        value = null;
      }
      break;
    }
  }

  if (value !== null) {
    SECRET_CACHE.set(cacheKey, { value, expiresAt: Date.now() + cacheTtlMs });
  }

  return value;
}

/** SecretRefテキスト（secretref-env:VARやsecretref-file:/path）をパース */
export function parseSecretRef(input: string): SecretRef | null {
  const trimmed = input.trim();

  // レガシー形式: secretref-env:VAR
  if (trimmed.startsWith(LEGACY_ENV_PREFIX)) {
    return { source: "env", id: trimmed.slice(LEGACY_ENV_PREFIX.length).trim() };
  }

  // ${VAR} 形式
  const varMatch = trimmed.match(/^\$\{(\w+)\}$/);
  if (varMatch) return { source: "env", id: varMatch[1]! };

  // $VAR 形式
  const dollarMatch = trimmed.match(/^\$(\w+)$/);
  if (dollarMatch) return { source: "env", id: dollarMatch[1]! };

  // file:/path 形式
  if (trimmed.startsWith("file:")) return { source: "file", id: trimmed.slice(5) };

  // exec:command 形式
  if (trimmed.startsWith("exec:")) return { source: "exec", id: trimmed.slice(5) };

  return null;
}

/** 文字列内のSecretRefパターンを検出・解決 */
export function resolveSecretInputs(input: string): string {
  // ${VAR} を解決
  let result = input.replace(/\$\{(\w+)\}/g, (_, name) => {
    const ref = parseSecretRef(`\${${name}}`);
    if (!ref) return `\${${name}}`;
    return resolveSecretRef(ref) || `\${${name}}`;
  });

  // legacy secretref-env: を解決
  result = result.replace(/secretref-env:(\w+)/g, (_, name) => {
    const ref = parseSecretRef(`secretref-env:${name}`);
    if (!ref) return `secretref-env:${name}`;
    return resolveSecretRef(ref) || `secretref-env:${name}`;
  });

  return result;
}

/** キャッシュクリア */
export function clearSecretCache(): void {
  SECRET_CACHE.clear();
  logger.info("[Secrets] キャッシュクリア");
}

export function setCacheTtl(ms: number): void {
  cacheTtlMs = ms;
}

// ==================== 監査 ====================

/** 設定内の機密情報をスキャン */
export function auditSecrets(config: Record<string, unknown>): AuditFinding[] {
  const findings: AuditFinding[] = [];

  function walk(obj: unknown, path: string): void {
    if (typeof obj === "string") {
      // APIキーのようなパターンを検出
      if (/(sk-|api.?key|token|secret|password)/i.test(path)) {
        const ref = parseSecretRef(obj);
        if (!ref) {
          findings.push({
            severity: obj.length > 20 ? "critical" : "warning",
            category: "plaintext",
            message: `機密情報が平文で保存されています`,
            path,
            detail: `${path} = ${obj.slice(0, 4)}...${obj.slice(-4)}`,
          });
        } else {
          // SecretRefとして参照されている→解決試行
          const resolved = resolveSecretRef(ref);
          if (resolved === null) {
            findings.push({
              severity: "warning",
              category: "ref_unresolved",
              message: `SecretRefが解決できません`,
              path,
              detail: `${path} -> ${ref.source}:${ref.id}`,
            });
          }
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (obj && typeof obj === "object") {
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        walk(val, `${path}.${key}`);
      }
    }
  }

  walk(config, "config");
  return findings;
}

/** 監査レポートをフォーマット */
export function formatAuditReport(findings: AuditFinding[]): string {
  if (findings.length === 0) return "🔒 **機密情報監査**: 問題は見つかりませんでした。";

  const lines: string[] = ["🔒 **機密情報監査レポート**"];
  for (const f of findings) {
    const icon = f.severity === "critical" ? "🚨" : f.severity === "warning" ? "⚠️" : "ℹ️";
    lines.push(`${icon} **${f.category}**: ${f.message}`);
    if (f.path) lines.push(`  場所: ${f.path}`);
    if (f.detail) lines.push(`  詳細: ${f.detail}`);
  }
  return lines.join("\n");
}

// ==================== プロバイダ管理 ====================

const envAllowlist = new Set<string>();

export function setEnvAllowlist(vars: string[]): void {
  vars.forEach((v) => envAllowlist.add(v));
}

export function isEnvAllowed(varName: string): boolean {
  if (envAllowlist.size === 0) return true; // no restrictions
  return envAllowlist.has(varName);
}

export function getEnvAllowlist(): string[] {
  return Array.from(envAllowlist);
}

// ==================== コマンド ====================

export function formatSecretsStatus(): string {
  return [
    "🔐 **Secrets Management**",
    `  キャッシュ: ${SECRET_CACHE.size}エントリ (TTL: ${cacheTtlMs / 1000}秒)`,
    `  環境変数許可リスト: ${envAllowlist.size > 0 ? `${envAllowlist.size}件` : "制限なし"}`,
    `  サポート: env / file / exec`,
  ].join("\n");
}
