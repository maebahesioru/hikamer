// ==========================================
// Hikamer - Security Sandbox（OpenHuman security/ 由来）
// ポリシーエンジン + サンドボックス隔離 + コマンドリスク評価
// ==========================================

import { logger } from "./utils/logger";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

// ==================== 型定義 ====================

export type AutonomyLevel = "readonly" | "supervised" | "full";
export type CommandRisk = "low" | "medium" | "high";
export type ToolOperation = "read" | "act";

export interface SecurityPolicyConfig {
  autonomy: AutonomyLevel;
  workspaceDir?: string;
  workspaceOnly?: boolean;
  allowedCommands?: string[];
  forbiddenPaths?: string[];
  maxActionsPerHour?: number;
  requireApprovalForMedium?: boolean;
  blockHighRisk?: boolean;
  sandboxBackend?: "none" | "docker" | "bubblewrap";
}

// ==================== リスク評価 ====================

/** 高リスクコマンドパターン */
const HIGH_RISK_PATTERNS = [
  /^rm\s+(-rf?|--recursive)/i,
  /^mkfs/i,
  /^fdisk/,
  /^dd\s+if=/i,
  /^:\(\)\s*\{/,
  /^shutdown/,
  /^reboot/,
  /^halt/,
  /^kill\s+-9\s+1/,
  /^chmod\s+-R\s+0{3,4}\s+\//,
  /^sudo\s+rm\s+(-rf?|--recursive)/i,
  /^docker\s+system\s+prune/,
];

/** 中リスクコマンドパターン */
const MEDIUM_RISK_PATTERNS = [
  /^git\s+push\s+(-f|--force)/i,
  /^npm\s+(publish|unpublish)/i,
  /^yarn\s+publish/i,
  /^docker\s+(rmi|kill|stop)/i,
  /^sudo\s+/i,
  /^doas\s+/i,
  /^pip\s+install/i,
  /^apt\s+(install|remove|purge)/i,
  /^rm\s+(-r|-rf)/i,
  /^mv\s+\/\S+/,
];

/** コマンドのリスクレベルを評価 */
export function evaluateCommandRisk(command: string): CommandRisk {
  const trimmed = command.trim();

  // 許可リストに載っているコマンドは低リスク
  const safeCommands = ["ls", "cat", "head", "tail", "echo", "pwd", "date", "whoami", "hostname",
    "uname", "uptime", "free", "df", "ps", "top", "which", "type", "node", "python", "tsx", "npm run"];
  const base = trimmed.split(/\s+/)[0]?.toLowerCase() || "";
  if (safeCommands.includes(base)) return "low";

  // 高リスクチェック
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(trimmed)) return "high";
  }

  // 中リスクチェック
  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(trimmed)) return "medium";
  }

  // 不明なコマンドはデフォルトで中リスク
  return "medium";
}

// ==================== ポリシーエンジン ====================

export class SecurityPolicy {
  private autonomy: AutonomyLevel;
  private workspaceDir: string;
  private workspaceOnly: boolean;
  private allowedCommands: string[];
  private forbiddenPaths: string[];
  private maxActionsPerHour: number;
  private requireApprovalForMedium: boolean;
  private blockHighRisk: boolean;
  private actionTimestamps: number[] = [];
  private sandboxBackend: string;

  constructor(config: SecurityPolicyConfig) {
    this.autonomy = config.autonomy;
    this.workspaceDir = resolve(config.workspaceDir || process.cwd());
    this.workspaceOnly = config.workspaceOnly ?? true;
    this.allowedCommands = config.allowedCommands || [];
    this.forbiddenPaths = config.forbiddenPaths || [];
    this.maxActionsPerHour = config.maxActionsPerHour || 500;
    this.requireApprovalForMedium = config.requireApprovalForMedium ?? true;
    this.blockHighRisk = config.blockHighRisk ?? true;
    this.sandboxBackend = config.sandboxBackend || "none";
  }

  /** コマンド実行を検証 */
  validateCommand(command: string, approved = false): { allowed: boolean; risk: CommandRisk; reason?: string } {
    const risk = evaluateCommandRisk(command);

    // 自律性レベルチェック
    if (this.autonomy === "readonly") {
      if (risk !== "low") {
        return { allowed: false, risk, reason: "ReadOnlyモードでは読み取り以外の操作は禁止されています" };
      }
    }

    // 高リスクブロック
    if (risk === "high" && this.blockHighRisk && !approved) {
      return { allowed: false, risk, reason: "高リスクコマンドはブロックされています（承認が必要）" };
    }

    // 中リスク承認要求
    if (risk === "medium" && this.requireApprovalForMedium && !approved && this.autonomy === "supervised") {
      return { allowed: false, risk, reason: "中リスクコマンドは承認が必要です" };
    }

    // レート制限
    if (!this.checkRateLimit()) {
      return { allowed: false, risk, reason: "レート制限に達しました" };
    }

    // パス検証
    const pathArgs = this.extractPaths(command);
    for (const p of pathArgs) {
      if (!this.isPathAllowed(p)) {
        return { allowed: false, risk, reason: `パスが許可されていません: ${p}` };
      }
    }

    // アクション記録
    this.recordAction();
    return { allowed: true, risk };
  }

  /** ファイル操作を検証 */
  validateFileOperation(operation: ToolOperation, path: string): { allowed: boolean; reason?: string } {
    if (operation === "write" && !this.isPathAllowed(path)) {
      return { allowed: false, reason: `書き込みパスが許可されていません: ${path}` };
    }
    return { allowed: true };
  }

  /** レート制限チェック */
  private checkRateLimit(): boolean {
    const now = Date.now();
    const cutoff = now - 3600000; // 1時間前
    this.actionTimestamps = this.actionTimestamps.filter((t) => t > cutoff);
    return this.actionTimestamps.length < this.maxActionsPerHour;
  }

  private recordAction(): void {
    this.actionTimestamps.push(Date.now());
  }

  /** パスが許可されているか */
  private isPathAllowed(path: string): boolean {
    if (!this.workspaceOnly) return true;

    const resolved = resolve(path);
    const ws = resolve(this.workspaceDir);

    // ワークスペース内なら許可
    if (resolved.startsWith(ws + "/") || resolved === ws) return true;

    // /tmp は許可
    if (resolved.startsWith("/tmp/") || resolved === "/tmp") return true;

    // 禁止パス
    for (const forbidden of this.forbiddenPaths) {
      if (resolved.startsWith(resolve(forbidden))) return false;
    }

    // ワークスペース外のシステムファイルは拒否
    if (resolved.startsWith("/etc/") || resolved.startsWith("/usr/") || resolved.startsWith("/bin/") || resolved.startsWith("/boot/")) {
      return false;
    }

    return false;
  }

  /** コマンドからパス引数を抽出 */
  private extractPaths(command: string): string[] {
    const paths: string[] = [];
    const tokens = command.split(/\s+/);
    for (const token of tokens) {
      if (token.startsWith("/") || token.startsWith("./") || token.startsWith("~/")) {
        paths.push(token);
      }
    }
    return paths;
  }

  /** ポリシー状態をフォーマット */
  formatPolicy(): string {
    const autonomyIcon: Record<AutonomyLevel, string> = {
      readonly: "🔒", supervised: "🔐", full: "🔓",
    };
    return [
      `${autonomyIcon[this.autonomy] ?? "🔐"} **Security Policy**`,
      `  自律性: ${this.autonomy}`,
      `  ワークスペース制限: ${this.workspaceOnly ? "ON" : "OFF"}`,
      `  高リスクブロック: ${this.blockHighRisk ? "ON" : "OFF"}`,
      `  中リスク承認: ${this.requireApprovalForMedium ? "ON" : "OFF"}`,
      `  サンドボックス: ${this.sandboxBackend}`,
      `  レート制限: ${this.maxActionsPerHour}/h`,
      `  アクション: ${this.actionTimestamps.length} (直近1h)`,
    ].join("\n");
  }
}

// ==================== サンドボックス ====================

export interface ISandbox {
  readonly name: string;
  isAvailable(): boolean;
  wrapCommand(command: string): string;
}

/** サンドボックスなし */
export class NoopSandbox implements ISandbox {
  readonly name = "none";
  isAvailable(): boolean { return true; }
  wrapCommand(command: string): string { return command; }
}

/** Dockerサンドボックス */
export class DockerSandbox implements ISandbox {
  readonly name = "docker";
  private image: string;

  constructor(image = "node:20-slim") {
    this.image = image;
  }

  isAvailable(): boolean {
    try {
      execSync("docker info 2>/dev/null", { timeout: 3000 });
      return true;
    } catch { return false; }
  }

  wrapCommand(command: string): string {
    return `docker run --rm --memory 512m --cpus 1.0 --network none -v "${process.cwd()}:/workspace" -w /workspace ${this.image} sh -c "${command.replace(/"/g, '\\"')}"`;
  }
}

/** Bubblewrapサンドボックス */
export class BubblewrapSandbox implements ISandbox {
  readonly name = "bubblewrap";

  isAvailable(): boolean {
    try {
      execSync("bwrap --version 2>/dev/null", { timeout: 3000 });
      return true;
    } catch { return false; }
  }

  wrapCommand(command: string): string {
    return `bwrap --ro-bind /usr /usr --dev /dev --proc /proc --bind /tmp /tmp --bind "${process.cwd()}" "${process.cwd()}" --unshare-all --die-with-parent sh -c "${command.replace(/"/g, '\\"')}"`;
  }
}

/** 自動検出でサンドボックスを作成 */
export function createSandbox(preferred?: string): ISandbox {
  if (preferred === "docker") {
    const d = new DockerSandbox();
    if (d.isAvailable()) { logger.info("[Sandbox] Docker有効"); return d; }
  }
  if (preferred === "bubblewrap") {
    const b = new BubblewrapSandbox();
    if (b.isAvailable()) { logger.info("[Sandbox] Bubblewrap有効"); return b; }
  }

  // 自動検出
  const b = new BubblewrapSandbox();
  if (b.isAvailable()) { logger.info("[Sandbox] 自動検出: Bubblewrap"); return b; }

  const d = new DockerSandbox();
  if (d.isAvailable()) { logger.info("[Sandbox] 自動検出: Docker"); return d; }

  logger.info("[Sandbox] サンドボックスなし");
  return new NoopSandbox();
}

// ==================== デフォルトポリシー ====================

export const defaultPolicy = new SecurityPolicy({
  autonomy: "supervised",
  workspaceOnly: true,
  requireApprovalForMedium: true,
  blockHighRisk: true,
});

export const defaultSandbox = createSandbox();
