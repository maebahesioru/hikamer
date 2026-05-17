// ==========================================
// Aikata - コードサンドボックス（OpenHuman javascript + runtime_node/runtime_python由来）
// 隔離されたJS/Pythonコード実行環境
// ==========================================

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface CodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  runtime: "node" | "python" | "deno" | "vm2";
}

export interface CodeOptions {
  timeout?: number;
  memory?: string;
  env?: Record<string, string>;
  runtime?: "auto" | "node" | "python" | "deno";
}

// ==================== サンドボックス ====================

class CodeSandbox {
  private tmpDir: string;

  constructor() {
    this.tmpDir = resolve(process.env.DATA_DIR || "./data", "code-exec");
    if (!existsSync(this.tmpDir)) mkdirSync(this.tmpDir, { recursive: true });
  }

  /** コードを安全に実行 */
  async run(code: string, language: "javascript" | "typescript" | "python" = "javascript", options: CodeOptions = {}): Promise<CodeResult> {
    const timeout = options.timeout || 15000;
    const runtime = options.runtime || "auto";
    const start = Date.now();

    // 危険コードチェック
    const dangerCheck = this.checkDangerousCode(code, language);
    if (dangerCheck) {
      return {
        stdout: "",
        stderr: dangerCheck,
        exitCode: -1,
        durationMs: 0,
        runtime: "node",
      };
    }

    // ランダムファイル名
    const fileId = `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      switch (language) {
        case "javascript":
        case "typescript":
          return this.runNode(code, language, fileId, timeout, runtime);
        case "python":
          return this.runPython(code, fileId, timeout, runtime);
        default:
          return this.runNode(code, "javascript", fileId, timeout, runtime);
      }
    } finally {
      // クリーンアップ
      try { unlinkSync(resolve(this.tmpDir, `${fileId}.js`)); } catch {}
      try { unlinkSync(resolve(this.tmpDir, `${fileId}.ts`)); } catch {}
      try { unlinkSync(resolve(this.tmpDir, `${fileId}.py`)); } catch {}
    }
  }

  /** Node.js実行（子プロセス隔離） */
  private runNode(code: string, language: string, fileId: string, timeout: number, runtime: string): CodeResult {
    const ext = language === "typescript" ? ".ts" : ".js";
    const filePath = resolve(this.tmpDir, `${fileId}${ext}`);

    // 安全なラッパー
    const wrapped = `"use strict";
const _start = Date.now();
try {
  ${code}
} catch(e) {
  console.error("[RuntimeError]", e.message || e);
  process.exit(1);
}
`;

    writeFileSync(filePath, wrapped, "utf-8");

    const runner = language === "typescript" ? "npx tsx" : "node";
    const memoryLimit = runtime === "auto" ? "--max-old-space-size=128" : "";

    try {
      const result = execSync(`${runner} ${memoryLimit} "${filePath}"`, {
        timeout,
        encoding: "utf-8",
        maxBuffer: 1024 * 512,
        env: {
          ...process.env,
          AIKATA_SANDBOX: "1",
        },
      });
      return {
        stdout: result.toString().trim(),
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - (0 as any),
        runtime: "node",
      };
    } catch (e: any) {
      return {
        stdout: (e.stdout?.toString() || "").trim(),
        stderr: (e.stderr?.toString() || e.message).slice(0, 2000),
        exitCode: e.status || -1,
        durationMs: Date.now() - (0 as any),
        runtime: "node",
      };
    }
  }

  /** Python実行 */
  private runPython(code: string, fileId: string, timeout: number, runtime: string): CodeResult {
    const filePath = resolve(this.tmpDir, `${fileId}.py`);
    writeFileSync(filePath, code, "utf-8");

    const pythonCmd = execSync("which python3 2>/dev/null || which python 2>/dev/null || echo 'none'", { timeout: 2000 })
      .toString().trim();

    if (pythonCmd === "none") {
      return { stdout: "", stderr: "Python実行環境がありません", exitCode: -1, durationMs: 0, runtime: "python" };
    }

    try {
      const result = execSync(`${pythonCmd} "${filePath}"`, {
        timeout,
        encoding: "utf-8",
        maxBuffer: 1024 * 512,
      });
      return {
        stdout: result.toString().trim(),
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - (0 as any),
        runtime: "python",
      };
    } catch (e: any) {
      return {
        stdout: (e.stdout?.toString() || "").trim(),
        stderr: (e.stderr?.toString() || e.message).slice(0, 2000),
        exitCode: e.status || -1,
        durationMs: Date.now() - (0 as any),
        runtime: "python",
      };
    }
  }

  /** 危険コードチェック */
  private checkDangerousCode(code: string, language: string): string | null {
    const lower = code.toLowerCase();

    const dangerousPatterns: Array<{ pattern: RegExp; message: string }> = [
      // ファイルシステム破壊
      { pattern: /fs\.(rmSync|unlinkSync|rmdirSync)\s*\(.*['"`]\/|process\.exit\(/i, message: "破壊的なファイル操作は禁止されています" },
      // 子プロセス実行
      { pattern: /(exec|spawn|fork|execFile|execSync)\s*\(/i, message: "子プロセス生成はサンドボックスで禁止されています" },
      // ネットワーク
      { pattern: /net\.(createConnection|connect)\s*\(/i, message: "ネットワーク接続はサンドボックスで禁止されています" },
      // requireの危険なモジュール
      { pattern: /require\s*\(\s*['"`](child_process|cluster|v8|async_hooks)['"`]\)/i, message: "システムモジュールの require は制限されています" },
      // 無限ループ防止
      { pattern: /while\s*\(true\)|for\s*\(\s*;;\s*\)/i, message: "無限ループは禁止されています" },
    ];

    for (const dp of dangerousPatterns) {
      if (dp.pattern.test(lower)) {
        return `[Sandbox] ${dp.message}`;
      }
    }

    return null;
  }

  /** Denoの利用可能性チェック */
  checkRuntimes(): string[] {
    const available: string[] = ["node"];
    try { execSync("node --version", { timeout: 2000 }); } catch { return ["none"]; }
    try { if (execSync("which deno 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) available.push("deno"); } catch {}
    try { if (execSync("which python3 2>/dev/null || which python 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) available.push("python"); } catch {}
    return available;
  }
}

// ==================== シングルトン ====================

export const codeSandbox = new CodeSandbox();
