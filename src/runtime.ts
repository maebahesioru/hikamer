// ==========================================
// Hikamer - ランタイム管理（OpenHuman runtime_node/ 由来）
// Node.js/Pythonランタイム検出・依存関係管理
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface RuntimeInfo {
  name: string;
  version: string;
  path: string;
  available: boolean;
}

export interface PackageInfo {
  name: string;
  version: string;
  installed: boolean;
  type: "npm" | "pip";
}

export interface DependencyCheck {
  packageName: string;
  installed: boolean;
  version: string | null;
  required: string;
  satisfied: boolean;
}

// ==================== ランタイムマネージャー ====================

class RuntimeManager {
  private initialized = false;
  private cachedRuntimes: RuntimeInfo[] | null = null;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Runtime] manager initialized");
  }

  /** 利用可能なランタイムを検出 */
  detectRuntimes(): RuntimeInfo[] {
    if (this.cachedRuntimes) return this.cachedRuntimes;

    const runtimes: RuntimeInfo[] = [];
    const checks = [
      { name: "Node.js", cmd: "node --version", bin: "node" },
      { name: "npm", cmd: "npm --version", bin: "npm" },
      { name: "Python 3", cmd: "python3 --version", bin: "python3" },
      { name: "Python", cmd: "python --version", bin: "python" },
      { name: "pip3", cmd: "pip3 --version", bin: "pip3" },
      { name: "TypeScript", cmd: "npx tsc --version", bin: "tsc" },
      { name: "Git", cmd: "git --version", bin: "git" },
    ];

    for (const check of checks) {
      try {
        const version = execSync(check.cmd, { timeout: 5000 })
          .toString()
          .trim();
        const binPath = execSync(`which ${check.bin} 2>/dev/null || where ${check.bin} 2>/dev/null`, { timeout: 3000 })
          .toString()
          .trim();
        runtimes.push({
          name: check.name,
          version: version.replace(/^[vV]/, ""),
          path: binPath || check.bin,
          available: true,
        });
      } catch {
        runtimes.push({
          name: check.name,
          version: "unavailable",
          path: "",
          available: false,
        });
      }
    }

    this.cachedRuntimes = runtimes;
    return runtimes;
  }

  /** npmパッケージのインストール状態を確認 */
  checkNpmPackage(packageName: string): PackageInfo {
    try {
      const version = execSync(
        `npm list ${packageName} --depth=0 2>/dev/null | grep ${packageName} | head -1`,
        { timeout: 5000 }
      )
        .toString()
        .trim();
      const match = version.match(/@(\d+\.\d+\.\d+)/);
      return {
        name: packageName,
        version: match?.[1] ?? "unknown",
        installed: true,
        type: "npm",
      };
    } catch {
      return {
        name: packageName,
        version: "not installed",
        installed: false,
        type: "npm",
      };
    }
  }

  /** npmパッケージをインストール */
  async installNpmPackage(
    packageName: string,
    global?: boolean
  ): Promise<boolean> {
    try {
      const flag = global ? "-g" : "--save";
      execSync(`npm install ${flag} ${packageName} 2>/dev/null`, {
        timeout: 60000,
      });
      logger.info(`[Runtime] installed npm package: ${packageName}`);
      return true;
    } catch (err) {
      logger.error(`[Runtime] npm install failed for ${packageName}:`, err);
      return false;
    }
  }

  /** pipパッケージのインストール状態を確認 */
  checkPipPackage(packageName: string): PackageInfo {
    try {
      const version = execSync(
        `pip3 show ${packageName} 2>/dev/null | grep Version | head -1`,
        { timeout: 5000 }
      )
        .toString()
        .trim();
      const match = version.match(/Version:\s*(.+)/);
      return {
        name: packageName,
        version: match?.[1] ?? "unknown",
        installed: true,
        type: "pip",
      };
    } catch {
      return {
        name: packageName,
        version: "not installed",
        installed: false,
        type: "pip",
      };
    }
  }

  /** package.jsonの依存関係をチェック */
  checkProjectDependencies(projectPath?: string): DependencyCheck[] {
    const dir = projectPath ?? process.cwd();
    const pkgPath = path.join(dir, "package.json");

    if (!fs.existsSync(pkgPath)) return [];

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      return Object.entries(allDeps).map(([name, version]) => {
        const info = this.checkNpmPackage(name);
        return {
          packageName: name,
          installed: info.installed,
          version: info.installed ? info.version : null,
          required: version,
          satisfied: info.installed,
        };
      });
    } catch {
      return [];
    }
  }

  /** ランタイム一覧をクリア（キャッシュリセット） */
  clearCache(): void {
    this.cachedRuntimes = null;
  }

  formatStatus(): string {
    const runtimes = this.detectRuntimes();
    return (
      `⚡ **ランタイム一覧**\n\n` +
      runtimes
        .map(
          (r) =>
            `${r.available ? "✅" : "❌"} **${r.name}**: ${r.version}` +
            (r.available ? ` (${r.path})` : "")
        )
        .join("\n")
    );
  }
}

// ==================== シングルトン ====================

export const runtimeManager = new RuntimeManager();

export default RuntimeManager;
