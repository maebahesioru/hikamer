// ==========================================
// Aikata - 接続監視（OpenHuman connectivity/ 由来）
// ネットワーク接続状態の監視・ポートチェック・フォールバック
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";
import * as net from "net";
import * as dns from "dns";
import { setTimeout as sleep } from "timers/promises";

// ==================== 型定義 ====================

export interface ConnectivityStatus {
  /** 全体の接続状態 */
  online: boolean;
  /** 最終確認時刻 */
  lastCheck: number;
  /** プロバイダー別の状態 */
  providers: Record<string, ProviderStatus>;
  /** 監視対象ホストの状態 */
  hosts: HostStatus[];
  /** 接続障害履歴 */
  incidents: ConnectivityIncident[];
}

export interface ProviderStatus {
  name: string;
  online: boolean;
  latencyMs: number | null;
  lastCheck: number;
  errorMessage?: string;
}

export interface HostStatus {
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number | null;
  lastCheck: number;
}

export interface ConnectivityIncident {
  timestamp: number;
  type: "provider_down" | "host_unreachable" | "network_down" | "recovered";
  detail: string;
  durationMs?: number;
}

// ==================== 監視対象のデフォルト ====================

const DEFAULT_MONITOR_HOSTS = [
  { host: "openrouter.ai", port: 443 },
  { host: "api.openai.com", port: 443 },
  { host: "api.anthropic.com", port: 443 },
  { host: "google.com", port: 443 },
];

const DEFAULT_PROVIDERS = [
  { name: "openrouter", url: "https://openrouter.ai/api/v1/auth/key" },
  { name: "openai", url: "https://api.openai.com/v1/models" },
  { name: "anthropic", url: "https://api.anthropic.com/v1/messages" },
];

const CHECK_INTERVAL_MS = 60_000; // 1分ごと
const INCIDENT_COOLDOWN_MS = 30_000; // 同一インシデントの再通知クールダウン

// ==================== 接続監視マネージャー ====================

class ConnectivityManager {
  private status: ConnectivityStatus = {
    online: false,
    lastCheck: 0,
    providers: {},
    hosts: [],
    incidents: [],
  };

  private monitorHosts: { host: string; port: number }[] = [...DEFAULT_MONITOR_HOSTS];
  private providers: { name: string; url: string }[] = [...DEFAULT_PROVIDERS];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastIncidentByKey = new Map<string, number>();
  private running = false;

  /** 初期化 */
  init(): void {
    if (this.running) return;
    this.running = true;

    // 環境変数から監視対象を設定
    this.loadConfig();

    // 初回チェック
    this.checkAll().catch((err) =>
      logger.error(`[Connectivity] initial check failed:`, err)
    );

    // 定期チェック開始
    this.intervalHandle = setInterval(() => {
      this.checkAll().catch((err) =>
        logger.error(`[Connectivity] periodic check failed:`, err)
      );
    }, CHECK_INTERVAL_MS);

    logger.info(`[Connectivity] started monitoring ${this.monitorHosts.length} hosts`);
  }

  /** 停止 */
  shutdown(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    logger.info("[Connectivity] monitoring stopped");
  }

  /** 全チェック実行 */
  async checkAll(): Promise<ConnectivityStatus> {
    const promises: Promise<void>[] = [];

    // ホストチェック
    for (const target of this.monitorHosts) {
      promises.push(this.checkHost(target.host, target.port));
    }

    // プロバイダーチェック
    for (const provider of this.providers) {
      promises.push(this.checkProvider(provider.name, provider.url));
    }

    await Promise.allSettled(promises);
    this.status.lastCheck = Date.now();

    // 全体の状態を更新
    const anyOnline = Object.values(this.status.providers).some(
      (p) => p.online
    );
    const hostOnline = this.status.hosts.some((h) => h.reachable);
    this.status.online = anyOnline || hostOnline;

    return this.status;
  }

  /** 単一ホストをチェック */
  async checkHost(host: string, port: number): Promise<void> {
    const start = Date.now();
    let reachable = false;
    let latencyMs: number | null = null;

    try {
      await this.tcpProbe(host, port, 5000);
      reachable = true;
      latencyMs = Date.now() - start;
    } catch {
      reachable = false;
      latencyMs = null;
    }

    const existingIdx = this.status.hosts.findIndex(
      (h) => h.host === host && h.port === port
    );
    const entry: HostStatus = {
      host,
      port,
      reachable,
      latencyMs,
      lastCheck: Date.now(),
    };

    if (existingIdx >= 0) {
      const prev = this.status.hosts[existingIdx]!;
      this.status.hosts[existingIdx] = entry;

      // 状態変化を検知
      if (prev.reachable && !reachable) {
        this.recordIncident("host_unreachable", `${host}:${port} に到達不能`);
      } else if (!prev.reachable && reachable) {
        this.recordIncident("recovered", `${host}:${port} 復旧`);
      }
    } else {
      this.status.hosts.push(entry);
    }
  }

  /** プロバイダーをチェック */
  async checkProvider(name: string, url: string): Promise<void> {
    const start = Date.now();

    if (!this.status.providers[name]) {
      this.status.providers[name] = {
        name,
        online: false,
        latencyMs: null,
        lastCheck: 0,
      };
    }

    const prev = this.status.providers[name]!;
    let online = false;
    let latencyMs: number | null = null;
    let errorMessage: string | undefined;

    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
      });
      online = res.ok || res.status < 500;
      latencyMs = Date.now() - start;
    } catch (err) {
      online = false;
      latencyMs = null;
      errorMessage = err instanceof Error ? err.message.slice(0, 100) : String(err);
    }

    this.status.providers[name] = {
      name,
      online,
      latencyMs,
      lastCheck: Date.now(),
      errorMessage,
    };

    // 状態変化を検知
    if (prev.online && !online) {
      this.recordIncident(
        "provider_down",
        `${name} が応答なし${errorMessage ? `: ${errorMessage}` : ""}`
      );
    } else if (!prev.online && online) {
      this.recordIncident("recovered", `${name} 復旧`);
    }
  }

  /** TCPプローブ（タイムアウト付き） */
  private tcpProbe(
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let resolved = false;

      socket.setTimeout(timeoutMs);

      socket.once("connect", () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve();
        }
      });

      socket.once("timeout", () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          reject(new Error("timeout"));
        }
      });

      socket.once("error", (err) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          reject(err);
        }
      });

      socket.connect(port, host);
    });
  }

  /** インシデントを記録（クールダウン付き） */
  private recordIncident(type: ConnectivityIncident["type"], detail: string): void {
    const key = `${type}:${detail.slice(0, 50)}`;
    const last = this.lastIncidentByKey.get(key) ?? 0;
    const now = Date.now();

    if (now - last < INCIDENT_COOLDOWN_MS) return;

    this.lastIncidentByKey.set(key, now);

    const incident: ConnectivityIncident = {
      timestamp: now,
      type,
      detail,
    };

    this.status.incidents.push(incident);
    // 最大50件まで保持
    if (this.status.incidents.length > 50) {
      this.status.incidents = this.status.incidents.slice(-50);
    }

    // イベント発火
    const severity = type === "recovered" ? "info" : "warn";
    logger[severity](
      `[Connectivity] ${type}: ${detail}`
    );

    eventBus.emit(
      createEvent("connectivity:incident", {
        type,
        detail,
        timestamp: now,
      })
    );
  }

  /** 設定を環境変数から読み込み */
  private loadConfig(): void {
    // カスタムホスト
    const customHosts = process.env.AIKATA_MONITOR_HOSTS;
    if (customHosts) {
      try {
        const parsed = JSON.parse(customHosts) as { host: string; port: number }[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.monitorHosts = parsed;
        }
      } catch {
        logger.warn("[Connectivity] invalid AIKATA_MONITOR_HOSTS format");
      }
    }

    // カスタムプロバイダー
    const customProviders = process.env.AIKATA_MONITOR_PROVIDERS;
    if (customProviders) {
      try {
        const parsed = JSON.parse(customProviders) as { name: string; url: string }[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.providers = parsed;
        }
      } catch {
        logger.warn("[Connectivity] invalid AIKATA_MONITOR_PROVIDERS format");
      }
    }
  }

  /** 現在の状態を取得 */
  getStatus(): ConnectivityStatus {
    return { ...this.status };
  }

  /** 最終インシデントを取得 */
  getRecentIncidents(count = 10): ConnectivityIncident[] {
    return this.status.incidents.slice(-count);
  }

  /** 監視対象を追加 */
  addHost(host: string, port: number): void {
    if (!this.monitorHosts.find((h) => h.host === host && h.port === port)) {
      this.monitorHosts.push({ host, port });
      this.checkHost(host, port).catch(() => {});
    }
  }

  /** 監視対象を削除 */
  removeHost(host: string, port: number): void {
    this.monitorHosts = this.monitorHosts.filter(
      (h) => !(h.host === host && h.port === port)
    );
    this.status.hosts = this.status.hosts.filter(
      (h) => !(h.host === host && h.port === port)
    );
  }

  /** ポート使用中チェック（同期的） */
  isPortInUse(port: number): boolean {
    try {
      const server = net.createServer();
      server.unref();
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

export const connectivityManager = new ConnectivityManager();

// ==================== システムコマンド ====================

export function getConnectivityCommands(): Record<
  string,
  (args: string[]) => string | Promise<string>
> {
  return {
    "/connectivity": async (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "check":
        case "status": {
          const status = await connectivityManager.checkAll();
          const lines: string[] = [
            `🌐 **接続状態**\n`,
            `全体: ${status.online ? "✅ オンライン" : "❌ オフライン"}`,
            `最終確認: ${new Date(status.lastCheck).toLocaleString("ja-JP")}\n`,
          ];

          // プロバイダー
          const providers = Object.values(status.providers);
          if (providers.length > 0) {
            lines.push(`**プロバイダー (${providers.length})**`);
            for (const p of providers) {
              lines.push(
                `${p.online ? "✅" : "❌"} ${p.name}` +
                  (p.latencyMs !== null ? ` (${p.latencyMs}ms)` : "") +
                  (p.errorMessage ? `: ${p.errorMessage}` : "")
              );
            }
            lines.push("");
          }

          // ホスト
          if (status.hosts.length > 0) {
            lines.push(`**ホスト (${status.hosts.length})**`);
            for (const h of status.hosts) {
              lines.push(
                `${h.reachable ? "✅" : "❌"} ${h.host}:${h.port}` +
                  (h.latencyMs !== null ? ` (${h.latencyMs}ms)` : "")
              );
            }
          }

          return lines.join("\n");
        }

        case "incidents": {
          const incidents = connectivityManager.getRecentIncidents(10);
          if (incidents.length === 0) return "📭 インシデント履歴はありません";
          return (
            `🚨 **直近のインシデント (${incidents.length}件)**\n\n` +
            incidents
              .map((inc) => {
                const icon =
                  inc.type === "recovered"
                    ? "✅"
                    : inc.type === "provider_down"
                      ? "🔴"
                      : inc.type === "host_unreachable"
                        ? "⚠️"
                        : "❓";
                return (
                  `${icon} [${new Date(inc.timestamp).toLocaleTimeString("ja-JP")}] ` +
                  `${inc.detail}` +
                  (inc.durationMs
                    ? ` (${(inc.durationMs / 1000).toFixed(1)}秒)`
                    : "")
                );
              })
              .join("\n")
          );
        }

        case "add": {
          const host = args[1];
          const port = parseInt(args[2] ?? "443", 10);
          if (!host) return "⚠️ ホスト名が必要です";
          connectivityManager.addHost(host, port);
          return `✅ ${host}:${port} を監視対象に追加しました`;
        }

        case "remove": {
          const host = args[1];
          const port = parseInt(args[2] ?? "443", 10);
          if (!host) return "⚠️ ホスト名が必要です";
          connectivityManager.removeHost(host, port);
          return `✅ ${host}:${port} を監視対象から削除しました`;
        }

        default:
          return (
            `🌐 **接続監視コマンド**\n` +
            `/connectivity status — 現在の接続状態\n` +
            `/connectivity incidents — 直近のインシデント\n` +
            `/connectivity add <host> [port] — 監視対象追加\n` +
            `/connectivity remove <host> [port] — 監視対象削除`
          );
      }
    },
  };
}

export default ConnectivityManager;
