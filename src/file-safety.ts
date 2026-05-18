// ==========================================
// Aikata - ファイルセーフティ（Hermes Agent file_safety.py 由来）
// ファイル読み書きの安全チェック・危険操作の防止
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface SafetyCheckResult {
  safe: boolean;
  risk: "none" | "low" | "medium" | "high" | "critical";
  reason: string;
  suggestions: string[];
  details?: {
    fileExists?: boolean;
    fileSize?: number;
    isSymlink?: boolean;
    isBinary?: boolean;
    permissions?: string;
    owner?: string;
    containingDir?: string;
  };
}

export type FileOperation = "read" | "write" | "delete" | "rename" | "execute";

export interface FilePolicy {
  name: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  operation: FileOperation | "*";
  /** パターンマッチ（ファイルパスに対して） */
  pattern: RegExp;
  /** 違反時のアクション */
  action: "warn" | "block" | "allow";
}

export interface SafeWriteOptions {
  /** 最大ファイルサイズ（バイト） */
  maxSize?: number;
  /** 許可する拡張子 */
  allowedExtensions?: string[];
  /** 禁止する拡張子 */
  forbiddenExtensions?: string[];
  /** 上書きを許可 */
  allowOverwrite?: boolean;
  /** バイナリ書き込みを許可 */
  allowBinary?: boolean;
}

// ==================== 安全チェッカー ====================

class FileSafetyChecker {
  private policies: FilePolicy[] = [];
  private blockedOperations = 0;
  private warnedOperations = 0;

  // デフォルト設定
  private defaultOptions: SafeWriteOptions = {
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedExtensions: [],      // 無制限
    forbiddenExtensions: [".exe", ".dll", ".so", ".dylib", ".bin", ".scr"],
    allowOverwrite: true,
    allowBinary: false,
  };

  // 危険なディレクトリ
  private DANGEROUS_DIRS = [
    /^\/etc\//,
    /^\/sys\//,
    /^\/proc\//,
    /^\/dev\//,
    /^\/boot\//,
    /^\/root\//,
    /^\/\.git\//,
  ];

  // セーフディレクトリ（書き込み許可）
  private SAFE_DIRS = [
    /^\/home\//,
    /^\/tmp\//,
    /^\/var\/tmp\//,
    /^\/mnt\//,
    /^\.\//,
    /^\.\.\//,
    /^\/root\/Desktop\//,
  ];

  init(): void {
    this.loadDefaultPolicies();
    logger.info(`[FileSafety] initialized with ${this.policies.length} policies`);
  }

  /** ファイル書き込みの安全性チェック */
  checkWrite(filePath: string, options?: Partial<SafeWriteOptions>): SafetyCheckResult {
    const opts = { ...this.defaultOptions, ...options };
    const absolutePath = path.resolve(filePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const dir = path.dirname(absolutePath);
    const basename = path.basename(absolutePath);

    // 危険な拡張子
    if (opts.forbiddenExtensions && opts.forbiddenExtensions.includes(ext)) {
      return this.blockResult(
        `禁止された拡張子: ${ext}`,
        [`拡張子 ${ext} のファイル書き込みは許可されていません`]
      );
    }

    // 許可された拡張子チェック
    if (
      opts.allowedExtensions &&
      opts.allowedExtensions.length > 0 &&
      !opts.allowedExtensions.includes(ext)
    ) {
      return this.blockResult(
        `許可されていない拡張子: ${ext}`,
        [`許可されている拡張子: ${opts.allowedExtensions.join(", ")}`]
      );
    }

    // 危険なディレクトリへの書き込み
    for (const pattern of this.DANGEROUS_DIRS) {
      if (pattern.test(absolutePath)) {
        return this.blockResult(
          `危険なディレクトリへの書き込み: ${pattern}`,
          [`システムディレクトリへの書き込みは許可されていません`]
        );
      }
    }

    // ファイルサイズチェック
    if (fs.existsSync(absolutePath)) {
      const stat = fs.statSync(absolutePath);
      if (stat.size > opts.maxSize!) {
        return this.blockResult(
          `ファイルサイズ超過: ${(stat.size / 1024 / 1024).toFixed(1)}MB > ${(opts.maxSize! / 1024 / 1024).toFixed(0)}MB`,
          [`最大ファイルサイズ: ${(opts.maxSize! / 1024 / 1024).toFixed(0)}MB`]
        );
      }
    }

    // ポリシーチェック
    for (const policy of this.policies) {
      if (policy.operation !== "write" && policy.operation !== "*") continue;
      if (policy.pattern.test(absolutePath)) {
        if (policy.action === "block") {
          this.blockedOperations++;
          return this.blockResult(
            `ポリシー違反: ${policy.name}`,
            [`${policy.description}`]
          );
        }
        if (policy.action === "warn") {
          this.warnedOperations++;
          return this.warnResult(
            `ポリシー警告: ${policy.name} - ${policy.description}`
          );
        }
      }
    }

    return this.okResult(absolutePath);
  }

  /** ファイル読み込みの安全性チェック */
  checkRead(filePath: string): SafetyCheckResult {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return {
        safe: false,
        risk: "low",
        reason: "ファイルが存在しません",
        suggestions: ["ファイルパスを確認してください"],
      };
    }

    const stat = fs.statSync(absolutePath);

    // シンボリックリンクチェック
    if (stat.isSymbolicLink()) {
      const realPath = fs.readlinkSync(absolutePath);
      // リンク先が危険なディレクトリかをチェック
      for (const pattern of this.DANGEROUS_DIRS) {
        if (pattern.test(realPath)) {
          return this.blockResult(
            `シンボリックリンクが危険なパスを指しています: ${realPath}`,
            ["シンボリックリンクのリンク先を確認してください"]
          );
        }
      }
      return this.warnResult(`シンボリックリンク: ${absolutePath} → ${realPath}`);
    }

    // ファイルサイズチェック
    if (stat.size > 100 * 1024 * 1024) {
      return this.warnResult(`ファイルが大きいです: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }

    // ポリシーチェック
    for (const policy of this.policies) {
      if (policy.operation !== "read" && policy.operation !== "*") continue;
      if (policy.pattern.test(absolutePath)) {
        if (policy.action === "block") {
          this.blockedOperations++;
          return this.blockResult(`ポリシー違反: ${policy.name}`, [`${policy.description}`]);
        }
        if (policy.action === "warn") {
          this.warnedOperations++;
          return this.warnResult(`ポリシー警告: ${policy.name} - ${policy.description}`);
        }
      }
    }

    return this.okResult(absolutePath);
  }

  /** 削除の安全性チェック */
  checkDelete(filePath: string): SafetyCheckResult {
    const absolutePath = path.resolve(filePath);

    // .gitディレクトリ内の削除は警告
    if (absolutePath.includes(".git")) {
      return this.warnResult(".gitディレクトリ内のファイル削除");
    }

    // 危険なパス
    for (const pattern of this.DANGEROUS_DIRS) {
      if (pattern.test(absolutePath)) {
        return this.blockResult(
          `危険なパスの削除: ${pattern}`,
          ["システムファイルの削除は許可されていません"]
        );
      }
    }

    return this.okResult(absolutePath);
  }

  /** パスが安全な作業ディレクトリ内かをチェック */
  isInSafeDir(filePath: string, allowedDirs?: string[]): boolean {
    const absolutePath = path.resolve(filePath);
    const dirs = allowedDirs ?? [
      process.cwd(),
      process.env.HOME || "/root",
      "/tmp",
      "/var/tmp",
    ];

    for (const safeDir of dirs) {
      if (absolutePath.startsWith(path.resolve(safeDir))) {
        return true;
      }
    }

    return false;
  }

  /** ファイルがバイナリかチェック */
  isBinaryFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      const buffer = fs.readFileSync(filePath, { flag: "r" });
      // 先頭8KBをチェック
      const sample = buffer.slice(0, 8192);
      // NULLバイトが含まれていればバイナリとみなす
      return sample.includes(0);
    } catch {
      return false;
    }
  }

  /** ポリシーを追加 */
  addPolicy(policy: FilePolicy): void {
    this.policies.push(policy);
  }

  /** 禁止拡張子を設定 */
  setForbiddenExtensions(exts: string[]): void {
    this.defaultOptions.forbiddenExtensions = exts;
  }

  /** 許可拡張子を設定 */
  setAllowedExtensions(exts: string[]): void {
    this.defaultOptions.allowedExtensions = exts;
  }

  /** 統計を取得 */
  getStats() {
    return {
      blockedOperations: this.blockedOperations,
      warnedOperations: this.warnedOperations,
      activePolicies: this.policies.length,
    };
  }

  // ---- 内部 ----

  private loadDefaultPolicies(): void {
    this.addPolicy({
      name: "block-env-files",
      description: ".envファイルへのアクセスをブロック",
      risk: "high",
      operation: "read",
      pattern: /\.env$/,
      action: "warn",
    });

    this.addPolicy({
      name: "block-key-files",
      description: "秘密鍵ファイルへのアクセスをブロック",
      risk: "critical",
      operation: "read",
      pattern: /(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|private)\.(?:pem|key|ppk)$/,
      action: "warn",
    });

    this.addPolicy({
      name: "block-system-config",
      description: "システム設定ファイルへの書き込みをブロック",
      risk: "critical",
      operation: "write",
      pattern: /^\/(?:etc|sys|proc|boot|dev)\//,
      action: "block",
    });
  }

  private okResult(filePath: string): SafetyCheckResult {
    const details: SafetyCheckResult["details"] = {};
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        details.fileExists = true;
        details.fileSize = stat.size;
        details.isSymlink = stat.isSymbolicLink();
      } else {
        details.fileExists = false;
      }
      details.containingDir = path.dirname(filePath);
    } catch {
      // ignore
    }

    return {
      safe: true,
      risk: "none",
      reason: "安全確認完了",
      suggestions: [],
      details,
    };
  }

  private warnResult(reason: string): SafetyCheckResult {
    return {
      safe: true,
      risk: "low",
      reason,
      suggestions: ["注意して続行してください"],
    };
  }

  private blockResult(reason: string, suggestions: string[]): SafetyCheckResult {
    return {
      safe: false,
      risk: "high",
      reason,
      suggestions,
    };
  }

  formatResult(result: SafetyCheckResult): string {
    const icon = result.safe ? (result.risk === "none" ? "✅" : "⚠️") : "🚫";
    return (
      `${icon} **ファイルセーフティ**\n` +
      `リスク: ${result.risk}\n` +
      `理由: ${result.reason}\n` +
      (result.suggestions.length > 0
        ? `\n**提案**\n${result.suggestions.map((s) => `- ${s}`).join("\n")}`
        : "") +
      (result.details?.containingDir
        ? `\n\n📁 ${result.details.containingDir}`
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const fileSafety = new FileSafetyChecker();

// ==================== システムコマンド ====================

export function getFileSafetyCommands(): Record<string, (args: string[]) => string> {
  return {
    "/safety": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "check":
        case "check-write": {
          const filePath = args[1];
          if (!filePath) return "⚠️ ファイルパスが必要です";
          const result = fileSafety.checkWrite(filePath);
          return fileSafety.formatResult(result);
        }

        case "check-read": {
          const filePath = args[1];
          if (!filePath) return "⚠️ ファイルパスが必要です";
          const result = fileSafety.checkRead(filePath);
          return fileSafety.formatResult(result);
        }

        case "stats": {
          const stats = fileSafety.getStats();
          return (
            `🛡️ **ファイルセーフティ統計**\n` +
            `ブロック: ${stats.blockedOperations}\n` +
            `警告: ${stats.warnedOperations}\n` +
            `ポリシー数: ${stats.activePolicies}`
          );
        }

        default:
          return (
            `🛡️ **ファイルセーフティコマンド**\n` +
            `/safety check-write <path> — 書き込み確認\n` +
            `/safety check-read <path> — 読み込み確認\n` +
            `/safety stats — 統計`
          );
      }
    },
  };
}

export default FileSafetyChecker;
