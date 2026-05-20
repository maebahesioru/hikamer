// ==========================================
// Hikamer - 構造化ロガー v2（Hermes Agent由来）
// Rotatingファイルハンドラ + エラーログ分離 + リダクション
// ==========================================

import { writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { resolve, dirname } from "path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

const DATA_DIR = process.env.DATA_DIR || "./data";
const LOG_DIR = resolve(DATA_DIR, "logs");

// ==================== ログローテーション ====================

class RotatingFileHandler {
  private path: string;
  private maxBytes: number;
  private backupCount: number;

  constructor(filename: string, maxBytes = 5 * 1024 * 1024, backupCount = 3) {
    this.path = resolve(LOG_DIR, filename);
    this.maxBytes = maxBytes;
    this.backupCount = backupCount;
    ensureDir(LOG_DIR);
  }

  write(text: string): void {
    this.rotateIfNeeded();
    try {
      appendFileSync(this.path, text, "utf-8");
    } catch {
      // ログ書き込み失敗は無視
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    try {
      const stat = require("fs").statSync(this.path);
      if (stat.size < this.maxBytes) return;
    } catch { return; }

    // 古いバックアップを削除
    const last = `${this.path}.${this.backupCount}`;
    if (existsSync(last)) {
      try { renameSync(last, last + ".old"); } catch { /* ignore */ }
    }

    // シフト
    for (let i = this.backupCount - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      const to = `${this.path}.${i + 1}`;
      if (existsSync(from)) {
        try { renameSync(from, to); } catch { /* ignore */ }
      }
    }

    // 現在のログを .1 に
    try { renameSync(this.path, `${this.path}.1`); } catch { /* ignore */ }
  }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ==================== 機密情報リダクション ====================

const SECRET_PATTERNS = [
  /(api[_-]?key["']?\s*[:=]\s*["']?)(sk-[a-zA-Z0-9]{20,})(["']?)/gi,
  /(bearer\s+)([a-zA-Z0-9\-._~+/]{20,})/gi,
  /(Authorization["']?\s*[:=]\s*["']?Bearer\s+)([a-zA-Z0-9\-._~+/]{5,})(["']?)/gi,
  /(token["']?\s*[:=]\s*["']?)([a-zA-Z0-9\-._~+/]{20,})(["']?)/gi,
  /(password["']?\s*[:=]\s*["']?)([^"'\s]{4,})(["']?)/gi,
  /(secret["']?\s*[:=]\s*["']?)([^"'\s]{4,})(["']?)/gi,
];

function redact(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "$1[REDACTED]$3");
  }
  return result;
}

// ==================== 設定 ====================

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const ENABLE_FILE_LOG = process.env.ENABLE_FILE_LOG !== "false";

// ファイルハンドラ初期化
let agentLog: RotatingFileHandler | null = null;
let errorsLog: RotatingFileHandler | null = null;

if (ENABLE_FILE_LOG) {
  ensureDir(LOG_DIR);
  agentLog = new RotatingFileHandler("agent.log", 5 * 1024 * 1024, 3);
  errorsLog = new RotatingFileHandler("errors.log", 2 * 1024 * 1024, 2);
}

// ==================== コアロガー ====================

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function format(level: LogLevel, msg: string): string {
  const prefix = { debug: "  ", info: "📌", warn: "⚠️", error: "💀" }[level];
  return `${prefix} [${timestamp()}] ${msg}`;
}

function write(level: LogLevel, msg: string): void {
  if (!shouldLog(level)) return;

  const formatted = format(level, msg);
  const line = `${formatted}\n`;
  const redacted = redact(line);

  // 標準エラー出力
  process.stderr.write(redacted);

  // ファイル出力
  if (agentLog) agentLog.write(redacted);
  if (errorsLog && level === "error") errorsLog.write(redacted);
}

// ==================== 公開API ====================

export const logger = {
  debug(msg: string) { write("debug", msg); },
  info(msg: string) { write("info", msg); },
  warn(msg: string) { write("warn", msg); },
  error(msg: string) { write("error", msg); },

  tool(name: string, args: Record<string, unknown>) {
    if (shouldLog("debug")) {
      const argsStr = JSON.stringify(args);
      const truncated = argsStr.length > 100 ? argsStr.slice(0, 100) + "…" : argsStr;
      write("debug", `🔧 ${name}(${truncated})`);
    }
  },

  iteration(n: number) {
    if (shouldLog("debug")) {
      write("debug", `🔄 反復 #${n}`);
    }
  },
};

/** ログディレクトリパスを取得 */
export function getLogDir(): string {
  return LOG_DIR;
}
