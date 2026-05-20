// ==========================================
// Hikamer - 自己診断（OpenHuman doctor/ 由来）
// システムヘルスチェック・モデルプローブ・診断レポート
// ==========================================

import { logger } from "./utils/logger";
import { threadManager } from "./threads";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export type Severity = "ok" | "warn" | "error";

export interface DiagnosticItem {
  severity: Severity;
  category: string;
  message: string;
}

export interface DoctorSummary {
  ok: number;
  warnings: number;
  errors: number;
}

export interface DoctorReport {
  items: DiagnosticItem[];
  summary: DoctorSummary;
}

export type ModelProbeOutcome = "ok" | "skipped" | "auth_or_access" | "error";

export interface ModelProbeEntry {
  provider: string;
  outcome: ModelProbeOutcome;
  message?: string;
}

export interface ModelProbeSummary {
  ok: number;
  skipped: number;
  authOrAccess: number;
  errors: number;
}

export interface ModelProbeReport {
  entries: ModelProbeEntry[];
  summary: ModelProbeSummary;
}

// ==================== 診断定数 ====================

const DAEMON_STALE_SECONDS = 30;
const SCHEDULER_STALE_SECONDS = 120;
const CHANNEL_STALE_SECONDS = 300;

const MIN_DISK_SPACE_MB = 500;
const MIN_MEMORY_MB = 256;
const MAX_CPU_LOAD = 0.9;

// ==================== 診断エンジン ====================

class Doctor {
  /**
   * フル診断を実行
   */
  runDiagnostic(): DoctorReport {
    const items: DiagnosticItem[] = [];

    this.checkSystem(items);
    this.checkWorkspace(items);
    this.checkProcess(items);
    this.checkNetwork(items);
    this.checkDatabase(items);
    this.checkConfig(items);

    const errors = items.filter((i) => i.severity === "error").length;
    const warnings = items.filter((i) => i.severity === "warn").length;
    const ok = items.filter((i) => i.severity === "ok").length;

    return {
      items,
      summary: { ok, warnings, errors },
    };
  }

  /**
   * モデルプローブを実行
   * 設定済みのプロバイダーにテストリクエストを送信
   */
  async runModelProbe(useCache = true): Promise<ModelProbeReport> {
    const targets = this.getModelTargets();
    const entries: ModelProbeEntry[] = [];

    for (const provider of targets) {
      try {
        const result = await this.probeProvider(provider);
        entries.push(result);
      } catch {
        entries.push({
          provider,
          outcome: "error",
          message: "Probe failed unexpectedly",
        });
      }
    }

    return {
      entries,
      summary: {
        ok: entries.filter((e) => e.outcome === "ok").length,
        skipped: entries.filter((e) => e.outcome === "skipped").length,
        authOrAccess: entries.filter((e) => e.outcome === "auth_or_access").length,
        errors: entries.filter((e) => e.outcome === "error").length,
      },
    };
  }

  // ---- 個別チェック ----

  private checkSystem(items: DiagnosticItem[]): void {
    // CPU負荷
    const cpus = os.cpus();
    const loadAvg = os.loadavg()[0] / cpus.length;
    if (loadAvg > MAX_CPU_LOAD) {
      items.push({
        severity: "warn",
        category: "system.cpu",
        message: `CPU負荷が高い: ${(loadAvg * 100).toFixed(0)}%`,
      });
    } else {
      items.push({
        severity: "ok",
        category: "system.cpu",
        message: `CPU負荷正常: ${(loadAvg * 100).toFixed(0)}%`,
      });
    }

    // メモリ
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    if (freeMemMb < MIN_MEMORY_MB) {
      items.push({
        severity: "error",
        category: "system.memory",
        message: `空きメモリ不足: ${freeMemMb}MB (< ${MIN_MEMORY_MB}MB)`,
      });
    } else if (freeMemMb < MIN_MEMORY_MB * 3) {
      items.push({
        severity: "warn",
        category: "system.memory",
        message: `空きメモリわずか: ${freeMemMb}MB`,
      });
    } else {
      items.push({
        severity: "ok",
        category: "system.memory",
        message: `空きメモリ: ${freeMemMb}MB`,
      });
    }

    // ホスト情報
    items.push({
      severity: "ok",
      category: "system.host",
      message: `${os.hostname()} | ${os.platform()} ${os.release()} | uptime: ${Math.floor(os.uptime() / 3600)}h`,
    });

    // Node.js
    items.push({
      severity: "ok",
      category: "system.node",
      message: `Node.js ${process.version}`,
    });
  }

  private checkWorkspace(items: DiagnosticItem[]): void {
    const workspacePath = process.env.AIKATA_WORKSPACE || process.cwd();

    // ディレクトリ存在確認
    if (!fs.existsSync(workspacePath)) {
      items.push({
        severity: "error",
        category: "workspace.exists",
        message: `ワークスペースが存在しません: ${workspacePath}`,
      });
      return;
    }

    items.push({
      severity: "ok",
      category: "workspace.exists",
      message: `ワークスペース: ${workspacePath}`,
    });

    // 書き込み権限
    try {
      const testFile = path.join(workspacePath, ".doctor-test");
      fs.writeFileSync(testFile, "ok");
      fs.unlinkSync(testFile);
      items.push({
        severity: "ok",
        category: "workspace.writable",
        message: "書き込み可能",
      });
    } catch {
      items.push({
        severity: "error",
        category: "workspace.writable",
        message: "書き込み権限なし",
      });
    }

    // ディスク容量
    try {
      const stats = fs.statfsSync(workspacePath);
      const freeMb = Math.round((stats.bfree * stats.bsize) / 1024 / 1024);
      if (freeMb < MIN_DISK_SPACE_MB) {
        items.push({
          severity: "error",
          category: "workspace.disk",
          message: `ディスク空き容量不足: ${freeMb}MB`,
        });
      } else {
        items.push({
          severity: "ok",
          category: "workspace.disk",
          message: `ディスク空き: ${freeMb}MB`,
        });
      }
    } catch {
      // statfsが使えない環境（Windows等）
      items.push({
        severity: "warn",
        category: "workspace.disk",
        message: "ディスク容量の確認に失敗",
      });
    }
  }

  private checkProcess(items: DiagnosticItem[]): void {
    const pid = process.pid;
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    items.push({
      severity: "ok",
      category: "process.pid",
      message: `PID: ${pid}`,
    });

    items.push({
      severity: "ok",
      category: "process.uptime",
      message: `稼働時間: ${Math.floor(uptime / 60)}分`,
    });

    const rssMb = Math.round(memoryUsage.rss / 1024 / 1024);
    const heapMb = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(memoryUsage.heapTotal / 1024 / 1024);

    if (heapMb > heapTotalMb * 0.9) {
      items.push({
        severity: "warn",
        category: "process.heap",
        message: `ヒープ使用率高: ${heapMb}/${heapTotalMb}MB`,
      });
    } else {
      items.push({
        severity: "ok",
        category: "process.heap",
        message: `ヒープ: ${heapMb}/${heapTotalMb}MB (RSS: ${rssMb}MB)`,
      });
    }
  }

  private checkNetwork(items: DiagnosticItem[]): void {
    // ネットワークインターフェース
    const nets = os.networkInterfaces();
    const addresses: string[] = [];
    for (const [name, netList] of Object.entries(nets)) {
      if (!netList) continue;
      for (const net of netList) {
        if (net.family === "IPv4" && !net.internal) {
          addresses.push(`${name}: ${net.address}`);
        }
      }
    }

    if (addresses.length === 0) {
      items.push({
        severity: "warn",
        category: "network.interfaces",
        message: "外部ネットワークインターフェースが見つかりません",
      });
    } else {
      items.push({
        severity: "ok",
        category: "network.interfaces",
        message: addresses.join(", "),
      });
    }

    // ポートチェック（環境変数で指定されたポート）
    const portsToCheck = [
      { name: "HTTP API", port: parseInt(process.env.AIKATA_HTTP_PORT || "9721", 10) },
      { name: "WebSocket", port: parseInt(process.env.AIKATA_WS_PORT || "9722", 10) },
    ];

    for (const { name, port } of portsToCheck) {
      if (this.isPortInUse(port)) {
        items.push({
          severity: "ok",
          category: `network.port.${name}`,
          message: `${name} ポート ${port} 使用中`,
        });
      } else {
        items.push({
          severity: "warn",
          category: `network.port.${name}`,
          message: `${name} ポート ${port} 未使用`,
        });
      }
    }
  }

  private checkDatabase(items: DiagnosticItem[]): void {
    try {
      // DBファイルの存在確認
      const dbPath = path.join(
        process.env.AIKATA_WORKSPACE || process.cwd(),
        "hikamer.db"
      );

      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
        items.push({
          severity: "ok",
          category: "database.file",
          message: `DBファイル: ${sizeMb}MB`,
        });
      } else {
        items.push({
          severity: "ok",
          category: "database.file",
          message: "DBはメモリ上にあります",
        });
      }

      // スレッド数
      const threads = threadManager.listThreads();
      items.push({
        severity: "ok",
        category: "database.threads",
        message: `スレッド数: ${threads.count}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      items.push({
        severity: "error",
        category: "database.error",
        message: `DBエラー: ${msg}`,
      });
    }
  }

  private checkConfig(items: DiagnosticItem[]): void {
    // 重要な環境変数のチェック
    const criticalEnvVars = [
      { name: "AIKATA_LLM_API_KEY", optional: true },
      { name: "OPENROUTER_API_KEY", optional: true },
      { name: "OPENAI_API_KEY", optional: true },
      { name: "ANTHROPIC_API_KEY", optional: true },
    ];

    const configured = criticalEnvVars.filter((v) => process.env[v.name]);
    const missing = criticalEnvVars.filter(
      (v) => !process.env[v.name] && !v.optional
    );

    if (configured.length > 0) {
      items.push({
        severity: "ok",
        category: "config.api_keys",
        message: `${configured.length}個のAPIキーが設定済み`,
      });
    } else {
      items.push({
        severity: "warn",
        category: "config.api_keys",
        message: "APIキーが設定されていません",
      });
    }

    // 環境変数のバリデーション
    if (process.env.NODE_ENV === "production") {
      items.push({
        severity: "ok",
        category: "config.env",
        message: "本番モード",
      });
    } else {
      items.push({
        severity: "warn",
        category: "config.env",
        message: `開発モード (NODE_ENV=${process.env.NODE_ENV || "未設定"})`,
      });
    }
  }

  // ---- モデルプローブ ----

  private getModelTargets(): string[] {
    const targets: string[] = [];

    if (process.env.AIKATA_LLM_ENDPOINT || process.env.OPENROUTER_API_KEY) {
      targets.push("openrouter");
    }
    if (process.env.OPENAI_API_KEY) {
      targets.push("openai");
    }
    if (process.env.ANTHROPIC_API_KEY) {
      targets.push("anthropic");
    }
    if (process.env.AIKATA_LOCAL_ENDPOINT) {
      targets.push("local");
    }

    // 最低1つはダミーを追加（環境がない場合のテスト用）
    if (targets.length === 0) {
      targets.push("(none configured)");
    }

    return targets;
  }

  private async probeProvider(
    provider: string
  ): Promise<ModelProbeEntry> {
    switch (provider) {
      case "openrouter": {
        const endpoint =
          process.env.AIKATA_LLM_ENDPOINT ||
          "https://openrouter.ai/api/v1/chat/completions";
        const apiKey =
          process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
          return {
            provider,
            outcome: "skipped",
            message: "APIキー未設定",
          };
        }

        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "deepseek/deepseek-v4-flash",
              messages: [
                { role: "user", content: "Respond with just 'ok'" },
              ],
              max_tokens: 10,
            }),
            signal: AbortSignal.timeout(10000),
          });

          if (res.ok) {
            return {
              provider: "openrouter",
              outcome: "ok",
              message: "応答正常",
            };
          } else if (res.status === 401 || res.status === 403) {
            return {
              provider: "openrouter",
              outcome: "auth_or_access",
              message: `認証エラー (HTTP ${res.status})`,
            };
          } else {
            return {
              provider: "openrouter",
              outcome: "error",
              message: `HTTP ${res.status}: ${res.statusText}`,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            provider: "openrouter",
            outcome: "error",
            message: msg.slice(0, 100),
          };
        }
      }

      case "(none configured)":
        return {
          provider: "(none configured)",
          outcome: "skipped",
          message: "プロバイダー未設定",
        };

      default:
        return {
          provider,
          outcome: "skipped",
          message: "プローブ未実装",
        };
    }
  }

  // ---- ヘルパー ----

  private isPortInUse(port: number): boolean {
    try {
      const net = require("net") as typeof import("net");
      const server = net.createServer();
      return new Promise<boolean>((resolve) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") resolve(true);
          else resolve(false);
        });
        server.once("listening", () => {
          server.close();
          resolve(false);
        });
        server.listen(port, "127.0.0.1");
      });
    } catch {
      return false;
    }
  }
}

// ==================== シングルトン ====================

export const doctor = new Doctor();

// ==================== システムコマンド ====================

export function getDoctorCommands(): Record<
  string,
  (args: string[]) => string | Promise<string>
> {
  return {
    "/doctor": async (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "run":
        case "check": {
          const report = doctor.runDiagnostic();
          const lines: string[] = [
            `🏥 **診断レポート**\n`,
            `サマリー: ✅${report.summary.ok} ⚠${report.summary.warnings} ❌${report.summary.errors}\n`,
          ];

          for (const item of report.items) {
            const icon =
              item.severity === "ok"
                ? "✅"
                : item.severity === "warn"
                  ? "⚠️"
                  : "❌";
            lines.push(`${icon} **${item.category}**: ${item.message}`);
          }

          return lines.join("\n");
        }

        case "models":
        case "probe": {
          const report = await doctor.runModelProbe();
          return (
            `🤖 **モデルプローブ結果**\n\n` +
            `サマリー: ✅${report.summary.ok} ⏭${report.summary.skipped} 🔒${report.summary.authOrAccess} ❌${report.summary.errors}\n\n` +
            report.entries
              .map((e) => {
                const icon =
                  e.outcome === "ok"
                    ? "✅"
                    : e.outcome === "skipped"
                      ? "⏭️"
                      : e.outcome === "auth_or_access"
                        ? "🔒"
                        : "❌";
                return `${icon} **${e.provider}**: ${e.message || e.outcome}`;
              })
              .join("\n")
          );
        }

        case "quick":
        case "summary": {
          const report = doctor.runDiagnostic();
          const status =
            report.summary.errors > 0
              ? "❌ 異常あり"
              : report.summary.warnings > 0
                ? "⚠️ 警告あり"
                : "✅ 正常";
          return (
            `🏥 **クイック診断**\n` +
            `ステータス: ${status}\n` +
            `✅ ${report.summary.ok} | ⚠️ ${report.summary.warnings} | ❌ ${report.summary.errors}`
          );
        }

        default:
          return (
            `🏥 **診断コマンド**\n` +
            `/doctor check — フル診断実行\n` +
            `/doctor probe — モデルプローブ\n` +
            `/doctor summary — クイック診断`
          );
      }
    },
  };
}

export default Doctor;
