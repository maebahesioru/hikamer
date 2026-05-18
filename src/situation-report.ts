// ==========================================
// Aikata - 状況レポート（OpenHuman subconscious/situation_report/ 由来）
// サブコンシャス定期ティック用の状況レポートビルダー
// ==========================================

import { logger } from "./utils/logger";
import { threadManager } from "./threads";
import { connectivityManager } from "./connectivity";
import * as os from "os";
import * as path from "path";

// ==================== 型定義 ====================

export interface Reflection {
  id: string;
  content: string;
  createdAt: number;
  category: string;
  source?: string;
}

// ==================== 定数 ====================

const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_BUDGET = 2000;
const MAX_REFLECTIONS = 8;

// ==================== 状況レポートビルダー ====================

class SituationReportBuilder {
  private reflectionStore: Reflection[] = [];
  private lastTickAt = 0;

  /**
   * 状況レポートを構築
   * サブコンシャスのティックごとに呼ばれる
   */
  async buildReport(options?: {
    lastTickAt?: number;
    tokenBudget?: number;
    recentReflections?: Reflection[];
  }): Promise<string> {
    const lastTickAt = options?.lastTickAt ?? this.lastTickAt;
    const tokenBudget = options?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const recentReflections =
      options?.recentReflections ?? this.getRecentReflections();
    const charBudget = tokenBudget * CHARS_PER_TOKEN;

    const sections: string[] = [];

    // Section 1: 環境アンカー
    sections.push(this.buildEnvironmentSection());

    // Section 2: アクティブスレッド
    sections.push(this.buildThreadsSection());

    // Section 3: 接続状態
    sections.push(this.buildConnectivitySection());

    // Section 4: 保留中のタスク（ターン状態から）
    sections.push(this.buildTasksSection());

    // Section 5: 直前のリフレクション（重複防止）
    sections.push(this.buildReflectionsSection(recentReflections));

    // 全セクションを結合（トークン予算超過時は末尾をトリム）
    let report = sections.filter((s) => s.length > 0).join("\n");
    if (report.length > charBudget) {
      report = report.slice(0, charBudget) + "\n[... truncated — token budget exceeded]\n";
    }

    if (!report.trim()) {
      report = "前回のティックから状態変化はありません。\n";
    }

    this.lastTickAt = Date.now();
    return report;
  }

  /**
   * リフレクションを記録
   */
  addReflection(
    content: string,
    category: string,
    source?: string
  ): Reflection {
    const reflection: Reflection = {
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      createdAt: Date.now(),
      category,
      source,
    };

    this.reflectionStore.push(reflection);
    // 最大50件まで保持
    if (this.reflectionStore.length > 50) {
      this.reflectionStore = this.reflectionStore.slice(-50);
    }

    return reflection;
  }

  /**
   * 最近のリフレクションを取得
   */
  getRecentReflections(count = MAX_REFLECTIONS): Reflection[] {
    return this.reflectionStore.slice(-count);
  }

  /**
   * 全リフレクションを取得
   */
  getAllReflections(): Reflection[] {
    return [...this.reflectionStore];
  }

  /**
   * リフレクションをクリア
   */
  clearReflections(): void {
    this.reflectionStore = [];
  }

  // ---- 各セクションのビルド ----

  private buildEnvironmentSection(): string {
    const hostname = os.hostname();
    const platform = os.platform();
    const release = os.release();
    const uptime = Math.floor(os.uptime() / 3600);
    const cpus = os.cpus().length;
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const loadAvg = os.loadavg()[0].toFixed(2);
    const now = new Date().toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
    });

    const workspacePath =
      process.env.AIKATA_WORKSPACE || process.cwd();

    return (
      `## 環境\n\n` +
      `ワークスペース: ${workspacePath}\n` +
      `ホスト: ${hostname} | OS: ${platform} ${release}\n` +
      `CPU: ${cpus}コア | 負荷: ${loadAvg}\n` +
      `メモリ: ${freeMem}/${totalMem}MB 空き\n` +
      `稼働時間: ${uptime}時間\n` +
      `現在時刻: ${now}\n`
    );
  }

  private buildThreadsSection(): string {
    const threads = threadManager.listThreads();
    if (threads.count === 0) return "";

    const lines: string[] = ["## アクティブスレッド\n"];

    // 最新5件のみ
    for (const t of threads.threads.slice(0, 5)) {
      lines.push(
        `- **${t.title}** (${t.messageCount}msg)` +
          (t.isActive ? "" : " [非アクティブ]")
      );
    }

    if (threads.count > 5) {
      lines.push(`- ...他${threads.count - 5}スレッド`);
    }

    lines.push("");
    return lines.join("\n");
  }

  private buildConnectivitySection(): string {
    const status = connectivityManager.getStatus();
    if (!status.online && status.lastCheck === 0) return "";

    const lines: string[] = ["## 接続状態\n"];

    lines.push(
      `${status.online ? "✅ オンライン" : "❌ オフライン"}`
    );

    const downProviders = Object.values(status.providers).filter(
      (p) => !p.online
    );
    if (downProviders.length > 0) {
      lines.push(
        `⚠️ 応答なしプロバイダー: ${downProviders.map((p) => p.name).join(", ")}`
      );
    }

    const unreachableHosts = status.hosts.filter((h) => !h.reachable);
    if (unreachableHosts.length > 0) {
      lines.push(
        `⚠️ 到達不能ホスト: ${unreachableHosts.map((h) => `${h.host}:${h.port}`).join(", ")}`
      );
    }

    // 直近のインシデント
    const recentIncidents = connectivityManager
      .getRecentIncidents(3)
      .filter((i) => i.type !== "recovered");
    if (recentIncidents.length > 0) {
      lines.push("");
      lines.push("**直近の障害:**");
      for (const inc of recentIncidents) {
        lines.push(
          `- [${new Date(inc.timestamp).toLocaleTimeString("ja-JP")}] ${inc.detail}`
        );
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  private buildTasksSection(): string {
    const turnStates = threadManager.listTurnStates(10);
    if (turnStates.count === 0) return "";

    const lines: string[] = ["## 実行中のターン\n"];

    for (const state of turnStates.turnStates) {
      const thread = threadManager.getThread(state.threadId);
      const title = thread?.title ?? state.threadId.slice(0, 16);
      const icon =
        state.status === "running"
          ? "▶️"
          : state.status === "interrupted"
            ? "⚠️"
            : "✅";
      lines.push(
        `${icon} **${title}** (${state.iterationCount}回目, ` +
          `${Math.round((Date.now() - state.turnStartedAt) / 1000)}秒経過)`
      );
    }

    lines.push("");
    return lines.join("\n");
  }

  private buildReflectionsSection(reflections: Reflection[]): string {
    if (reflections.length === 0) return "";

    const lines: string[] = ["## 直近のリフレクション\n"];

    for (const ref of reflections) {
      lines.push(
        `- [${ref.category}] ${ref.content.slice(0, 200)}` +
          (ref.content.length > 200 ? "..." : "")
      );
    }

    lines.push("");
    return lines.join("\n");
  }

}

// ==================== シングルトン ====================

export const situationReport = new SituationReportBuilder();

// ==================== システムコマンド ====================

export function getSituationCommands(): Record<
  string,
  (args: string[]) => string | Promise<string>
> {
  return {
    "/situation": async (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "report":
        case "now": {
          const report = await situationReport.buildReport();
          return `📋 **現在の状況レポート**\n\n${report}`;
        }

        case "reflections":
        case "refs": {
          const refs = situationReport.getAllReflections();
          if (refs.length === 0) return "📭 リフレクションはありません";
          return (
            `💭 **リフレクション一覧 (${refs.length})**\n\n` +
            refs
              .slice()
              .reverse()
              .slice(0, 20)
              .map(
                (r, i) =>
                  `${i + 1}. [${r.category}] ${r.content.slice(0, 150)}` +
                  (r.content.length > 150 ? "..." : "") +
                  `\n   🕐 ${new Date(r.createdAt).toLocaleString("ja-JP")}` +
                  (r.source ? ` | 📍 ${r.source}` : "")
              )
              .join("\n\n")
          );
        }

        case "clear": {
          situationReport.clearReflections();
          return "🧹 リフレクションをクリアしました";
        }

        default:
          return (
            `📋 **状況レポートコマンド**\n` +
            `/situation now — 現在の状況レポート\n` +
            `/situation reflections — リフレクション一覧\n` +
            `/situation clear — リフレクションクリア`
          );
      }
    },
  };
}

export default SituationReportBuilder;
