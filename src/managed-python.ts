// ==========================================
// Hikamer - Managed Python Runtime（OpenHuman runtime_python/ 由来）
// Python実行環境の自動検出・ダウンロード・起動管理
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { resolve, dirname } from "path";
import { execSync, spawn } from "child_process";
import https from "https";
import http from "http";
import { URL } from "url";

// ==================== 型定義 ====================

export interface PythonVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface PythonBootstrapConfig {
  enabled: boolean;
  preferSystem: boolean;
  minimumVersion: string;
  managedReleaseTag: string;
  cacheDir: string;
}

export interface PythonLaunchSpec {
  scriptPath: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  unbuffered?: boolean;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: PythonBootstrapConfig = {
  enabled: true,
  preferSystem: true,
  minimumVersion: "3.10.0",
  managedReleaseTag: "20250112",
  cacheDir: "./data/python-runtime",
};

// ==================== Pythonランタイム管理 ====================

class PythonRuntimeManager {
  private config: PythonBootstrapConfig = { ...DEFAULT_CONFIG };
  private pythonPath: string | null = null;
  private version: PythonVersion | null = null;
  private resolved = false;

  /** 設定更新 */
  configure(cfg: Partial<PythonBootstrapConfig>): void {
    this.config = { ...this.config, ...cfg };
    this.resolved = false; // 再解決が必要
  }

  /** Python実行環境を解決（システム優先→マネージド） */
  async resolve(): Promise<{ path: string; version: PythonVersion }> {
    if (this.resolved && this.pythonPath && this.version) {
      return { path: this.pythonPath, version: this.version };
    }

    // 1. システムPythonを試す
    if (this.config.preferSystem) {
      const system = this.detectSystemPython();
      if (system) {
        this.pythonPath = system.path;
        this.version = system.version;
        this.resolved = true;
        logger.info(`[Python] システムPython使用: ${this.pythonPath} (v${this.version.major}.${this.version.minor}.${this.version.patch})`);
        return { path: this.pythonPath, version: this.version };
      }
    }

    // 2. マネージド配布を試す
    const managed = await this.resolveManagedPython();
    if (managed) {
      this.pythonPath = managed.path;
      this.version = managed.version;
      this.resolved = true;
      logger.info(`[Python] マネージドPython使用: ${this.pythonPath} (v${this.version.major}.${this.version.minor}.${this.version.patch})`);
      return { path: this.pythonPath, version: this.version };
    }

    throw new Error("Python runtime not found (checked system and managed distributions)");
  }

  /** Pythonスクリプトを実行（stdio MCP向け） */
  async spawnProcess(spec: PythonLaunchSpec): Promise<import("child_process").ChildProcess> {
    const { path } = await this.resolve();

    const args = spec.unbuffered !== false ? ["-u", spec.scriptPath, ...spec.args] : [spec.scriptPath, ...spec.args];

    const proc = spawn(path, args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return proc;
  }

  /** インラインPythonコードを実行 */
  async runCode(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { path } = await this.resolve();

    return new Promise((resolvePromise, reject) => {
      const proc = spawn(path, ["-u", "-c", code], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (exitCode) => {
        resolvePromise({ stdout, stderr, exitCode: exitCode ?? -1 });
      });
      proc.on("error", reject);
    });
  }

  // ==================== システム検出 ====================

  /** システムPythonを検出 */
  private detectSystemPython(): { path: string; version: PythonVersion } | null {
    const candidates = ["python3.12", "python3.11", "python3.10", "python3", "python"];
    const minVer = this.parseVersion(this.config.minimumVersion);

    for (const cmd of candidates) {
      try {
        const out = execSync(`${cmd} --version 2>&1`, { timeout: 5000, encoding: "utf-8" }).trim();
        // "Python 3.12.1" 形式
        const match = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
        if (!match) continue;

        const ver: PythonVersion = {
          major: parseInt(match[1]!),
          minor: parseInt(match[2]!),
          patch: parseInt(match[3]!),
        };

        if (this.isVersionAtLeast(ver, minVer)) {
          // 実行可能チェック
          try {
            execSync(`test -x "$(which ${cmd})"`, { timeout: 2000 });
          } catch {
            continue;
          }

          const whichOut = execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
          return { path: whichOut, version: ver };
        }
      } catch { continue; }
    }

    return null;
  }

  // ==================== マネージド配布 ====================

  /** マネージドPython配布を解決 */
  private async resolveManagedPython(): Promise<{ path: string; version: PythonVersion } | null> {
    const cacheDir = resolve(this.config.cacheDir);

    // キャッシュチェック
    const pythonBinary = this.findPythonBinary(cacheDir);
    if (pythonBinary) {
      const ver = this.probeVersion(pythonBinary);
      if (ver && this.isVersionAtLeast(ver, this.parseVersion(this.config.minimumVersion))) {
        return { path: pythonBinary, version: ver };
      }
    }

    // ダウンロード（非同期）
    if (this.config.enabled) {
      try {
        await this.downloadManagedPython(cacheDir);
        const binary = this.findPythonBinary(cacheDir);
        if (binary) {
          const ver = this.probeVersion(binary);
          if (ver) return { path: binary, version: ver };
        }
      } catch (e) {
        logger.warn(`[Python] マネージド配布のダウンロードに失敗: ${e}`);
      }
    }

    return null;
  }

  /** キャッシュディレクトリからPythonバイナリを検索 */
  private findPythonBinary(cacheDir: string): string | null {
    if (!existsSync(cacheDir)) return null;

    const candidates = [
      resolve(cacheDir, "python/bin/python3"),
      resolve(cacheDir, "python/bin/python"),
      resolve(cacheDir, "python3"),
      resolve(cacheDir, "python"),
    ];

    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
    return null;
  }

  /** Pythonバイナリのバージョンをプローブ */
  private probeVersion(pythonPath: string): PythonVersion | null {
    try {
      const out = execSync(`"${pythonPath}" --version 2>&1`, { timeout: 5000, encoding: "utf-8" }).trim();
      const match = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        return { major: parseInt(match[1]!), minor: parseInt(match[2]!), patch: parseInt(match[3]!) };
      }
    } catch { /* ignore */ }
    return null;
  }

  /** マネージドPythonをダウンロード（astral-sh/python-build-standalone） */
  private async downloadManagedPython(cacheDir: string): Promise<void> {
    const platform = this.detectPlatform();
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${this.config.managedReleaseTag}/cpython-${platform}-install_only.tar.gz`;

    logger.info(`[Python] マネージド配布をダウンロード: ${url}`);

    mkdirSync(cacheDir, { recursive: true });

    // ダウンロード＋展開
    await this.downloadAndExtract(url, cacheDir);
    logger.info(`[Python] マネージド配布インストール完了: ${cacheDir}`);
  }

  /** tar.gzをダウンロードして展開 */
  private async downloadAndExtract(url: string, destDir: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      https.get(url, { timeout: 120000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        // パイプ経由でtar展開（可能な限りストリーム）
        const tarProcess = spawn("tar", ["-xzf", "-", "-C", destDir, "--strip-components=1"], {
          stdio: ["pipe", "inherit", "pipe"],
        });

        res.pipe(tarProcess.stdin!);

        tarProcess.on("close", (code) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`tar extraction failed with code ${code}`));
        });

        tarProcess.stderr?.on("data", (data: Buffer) => {
          logger.debug(`[Python] tar: ${data.toString().trim()}`);
        });
      }).on("error", reject);
    });
  }

  /** プラットフォーム検出 */
  private detectPlatform(): string {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
    if (os === "windows") return `${arch}-pc-windows-msvc`;
    if (os === "apple-darwin") return `${arch}-apple-darwin`;
    return `${arch}-unknown-linux-gnu`;
  }

  // ==================== ユーティリティ ====================

  private parseVersion(version: string): PythonVersion {
    const parts = version.split(".");
    return {
      major: parseInt(parts[0]!) || 0,
      minor: parseInt(parts[1]!) || 0,
      patch: parseInt(parts[2]!) || 0,
    };
  }

  private isVersionAtLeast(v: PythonVersion, min: PythonVersion): boolean {
    if (v.major !== min.major) return v.major > min.major;
    if (v.minor !== min.minor) return v.minor > min.minor;
    return v.patch >= min.patch;
  }

  /** 状態 */
  getStatus(): string {
    return [
      "🐍 **Python Runtime Manager**",
      `  状態: ${this.resolved ? "✅ 解決済み" : "⏳ 未解決"}`,
      this.pythonPath ? `  パス: ${this.pythonPath}` : "",
      this.version ? `  バージョン: ${this.version.major}.${this.version.minor}.${this.version.patch}` : "",
      `  設定: ${this.config.preferSystem ? "システム優先" : "マネージド優先"}`,
      `  最小バージョン: ${this.config.minimumVersion}`,
      `  キャッシュ: ${resolve(this.config.cacheDir)}`,
    ].filter(Boolean).join("\n");
  }

  /** リセット */
  reset(): void {
    this.pythonPath = null;
    this.version = null;
    this.resolved = false;
  }
}

export const pythonRuntime = new PythonRuntimeManager();
