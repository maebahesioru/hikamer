// ==========================================
// Aikata - リアルタイム使用量モニター (UsageMonitor)
// 出典: claude-pulse (NoobyGains/claude-pulse) パターン
// セッション/週間/コンテキスト/コスト/ピーク時間 統合監視
// ==========================================

import { logger } from "./utils/logger";
import { getCostSummary, getSessionCost } from "./cost-tracker";
import {
  renderProgressBar,
  renderStatusBar,
  ANSI,
  type StatusBarSegment,
  type ProgressbarOptions,
} from "./ansi-ui";

// ==================== ANSI ショートカット ====================

const { green, yellow, red, cyan, dim, reset, bold, white, magenta } = ANSI;

// ==================== 型定義 ====================

/** 外部から注入する使用量データ */
export interface UsageData {
  /** セッション経過時間（秒） */
  sessionElapsed: number;
  /** 今週の使用トークン数（またはAPIコール数など統一メトリック） */
  weeklyUsed: number;
  /** コンテキストウィンドウ使用率（0-100） */
  contextPct: number;
  /** 現在までの累積コスト（USD） */
  cost: number;
  /** ツール呼び出し回数 */
  toolCount: number;
  /** 使用中のモデル名 */
  modelName: string;
  /** ユーザーのプラン名 */
  planName: string;
}

/** 統計出力 */
export interface UsageStats {
  /** セッション制限に対する使用率（0-1） */
  sessionPct: number;
  /** 週間制限に対する使用率（0-1） */
  weeklyPct: number;
  /** ピーク時間帯かどうか */
  isPeak: boolean;
  /** コンテキスト圧力レベル */
  contextPressure: "normal" | "warning" | "critical";
}

// ==================== 設定 ====================

export interface UsageMonitorConfig {
  /** セッション上限（秒）、デフォルト 5h = 18000s */
  sessionLimitSeconds: number;
  /** 週間リセット間隔（秒）、デフォルト 7日 = 604800s */
  weeklyResetSeconds: number;
  /** 週間使用量上限（任意単位。設定された場合、weeklyPct = weeklyUsed / weeklyLimit） */
  weeklyLimit?: number;
  /** ピーク時間帯 開始時刻（地方時、0-23）、デフォルト 13（午後1時） */
  peakStartHour: number;
  /** ピーク時間帯 終了時刻（地方時、0-23）、デフォルト 19（午後7時） */
  peakEndHour: number;
  /** ピーク時のコスト乗数警告ラベル */
  peakMultiplierLabel: string;
  /** プログレスバー幅 */
  barWidth: number;
  /** プログレスバースタイル */
  barStyle: ProgressbarOptions["barStyle"];
  /** スピナーフレーム（ハートビート用） */
  spinnerFrames: string[];
  /** セッションID（cost-tracker連携用） */
  sessionId?: string;
}

const DEFAULT_CONFIG: UsageMonitorConfig = {
  sessionLimitSeconds: 5 * 60 * 60, // 5h
  weeklyResetSeconds: 7 * 24 * 60 * 60, // 7 days
  peakStartHour: 13,
  peakEndHour: 19,
  peakMultiplierLabel: "⚡PEAK",
  barWidth: 20,
  barStyle: "block",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  sessionId: undefined,
};

// ==================== UsageMonitor クラス ====================

export class UsageMonitor {
  private config: UsageMonitorConfig;
  private data: UsageData;
  private sessionStart: number;
  private spinnerIdx: number;
  private lastUpdate: number;
  /** 週の基準エポック（日曜 00:00 UTC に最も近いリセット点） */
  private weekAnchor: number;

  constructor(config: Partial<UsageMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStart = Date.now();
    this.spinnerIdx = 0;
    this.lastUpdate = Date.now();
    this.weekAnchor = this.computeWeekAnchor();

    this.data = {
      sessionElapsed: 0,
      weeklyUsed: 0,
      contextPct: 0,
      cost: 0,
      toolCount: 0,
      modelName: "—",
      planName: "—",
    };

    logger.info(
      `[UsageMonitor] 初期化: sessionLimit=${this.config.sessionLimitSeconds}s, ` +
      `peak=${this.config.peakStartHour}:00-${this.config.peakEndHour}:00`
    );
  }

  // ==================== 公開API ====================

  /**
   * 最新の使用量データで内部状態を更新する。
   * 外部から定期的（例: 各LLM呼び出し後、または毎秒のタイマー）に呼び出す。
   */
  update(data: UsageData): void {
    this.data = { ...data };
    this.lastUpdate = Date.now();

    // 週アンカーの再計算（日付が変わった場合に備える）
    const newAnchor = this.computeWeekAnchor();
    if (newAnchor !== this.weekAnchor) {
      this.weekAnchor = newAnchor;
      logger.debug("[UsageMonitor] 週アンカー再計算（リセット検出）");
    }
  }

  /**
   * 現在の使用量統計を返す。
   */
  getStats(): UsageStats {
    const sessionPct = this.getSessionPct();
    const weeklyPct = this.getWeeklyPct();
    const isPeak = this.isPeakHours();
    const contextPressure = this.getContextPressure();

    return { sessionPct, weeklyPct, isPeak, contextPressure };
  }

  /**
   * ANSI色付きの1行ステータスラインを生成する。
   * claude-pulse スタイルのカラーコード進行バー + マルチセグメントステータス。
   */
  render(): string {
    this.spinnerIdx = (this.spinnerIdx + 1) % this.config.spinnerFrames.length;
    const stats = this.getStats();

    // --- セッションバー ---
    const sessionBar = renderProgressBar(
      Math.floor(this.data.sessionElapsed),
      this.config.sessionLimitSeconds,
      undefined, // label handled in segment
      {
        width: this.config.barWidth,
        barStyle: this.config.barStyle,
        showPercent: true,
        showLabel: false,
      }
    );

    // --- 週間バー ---
    const weeklyBar = this.config.weeklyLimit
      ? renderProgressBar(
          this.data.weeklyUsed,
          this.config.weeklyLimit,
          undefined,
          {
            width: this.config.barWidth,
            barStyle: this.config.barStyle,
            showPercent: true,
            showLabel: false,
          }
        )
      : `${dim}no limit${reset}`;

    // --- コンテキスト圧力 ---
    const ctxColor =
      stats.contextPressure === "critical"
        ? red
        : stats.contextPressure === "warning"
          ? yellow
          : green;
    const ctxIcon =
      stats.contextPressure === "critical"
        ? "🔴"
        : stats.contextPressure === "warning"
          ? "🟡"
          : "🟢";
    const ctxStr = `${ctxColor}${ctxIcon} ${this.data.contextPct.toFixed(0)}%${reset}`;

    // --- コスト ---
    const costStr = `${bold}$${this.data.cost.toFixed(4)}${reset}`;

    // --- ツールカウント + スピナー ---
    const spinner = this.config.spinnerFrames[this.spinnerIdx];
    const toolStr = `${spinner} ${cyan}${this.data.toolCount}${reset} tools`;

    // --- 経過時間 ---
    const elapsed = this.formatElapsed(this.data.sessionElapsed);
    const elapsedColor =
      stats.sessionPct > 0.8 ? red : stats.sessionPct > 0.5 ? yellow : green;
    const timeStr = `${elapsedColor}${elapsed}${reset}`;

    // --- ピークインジケーター ---
    const peakStr = stats.isPeak
      ? `${yellow}${bold}${this.config.peakMultiplierLabel}${reset}`
      : `${dim}off-peak${reset}`;

    // --- モデル + プラン ---
    const planStr = `${dim}${this.data.planName}${reset}`;
    const modelStr = `${magenta}${this.data.modelName}${reset}`;

    // ステータスバーセグメントを組み立て
    const segments: StatusBarSegment[] = [
      { label: "SES", value: sessionBar, priority: 10 },
      { label: "WK", value: weeklyBar, priority: 20 },
      { label: "CTX", value: ctxStr, priority: 30 },
      { label: "", value: costStr, priority: 40 },
      { label: "", value: toolStr, priority: 50 },
      { label: "", value: timeStr, priority: 60 },
      { label: "", value: peakStr, priority: 70 },
      { label: "", value: modelStr, priority: 80 },
      { label: "", value: planStr, priority: 90 },
    ];

    return renderStatusBar(segments, " │ ");
  }

  /**
   * セッションIDを設定（cost-tracker連携用）
   */
  setSessionId(sessionId: string): void {
    this.config.sessionId = sessionId;
  }

  /**
   * 設定を動的に更新
   */
  updateConfig(patch: Partial<UsageMonitorConfig>): void {
    this.config = { ...this.config, ...patch };
    logger.debug(`[UsageMonitor] 設定更新: ${JSON.stringify(Object.keys(patch))}`);
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): Readonly<UsageMonitorConfig> {
    return this.config;
  }

  /**
   * セッション開始からの経過時間をリセット
   */
  resetSession(): void {
    this.sessionStart = Date.now();
    this.data.toolCount = 0;
    logger.info("[UsageMonitor] セッションリセット");
  }

  // ==================== 内部ヘルパー ====================

  /** セッション制限に対する使用率（0-1） */
  private getSessionPct(): number {
    return Math.min(
      this.data.sessionElapsed / this.config.sessionLimitSeconds,
      1.0
    );
  }

  /** 週間制限に対する使用率（0-1） */
  private getWeeklyPct(): number {
    if (!this.config.weeklyLimit || this.config.weeklyLimit <= 0) return 0;
    return Math.min(this.data.weeklyUsed / this.config.weeklyLimit, 1.0);
  }

  /** ピーク時間帯判定（地方時） */
  private isPeakHours(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const { peakStartHour, peakEndHour } = this.config;

    if (peakStartHour <= peakEndHour) {
      return hour >= peakStartHour && hour < peakEndHour;
    }
    // 日をまたぐピーク時間帯（例: 22時〜翌6時）
    return hour >= peakStartHour || hour < peakEndHour;
  }

  /** コンテキスト圧力レベル */
  private getContextPressure(): "normal" | "warning" | "critical" {
    if (this.data.contextPct >= 90) return "critical";
    if (this.data.contextPct >= 70) return "warning";
    return "normal";
  }

  /** 週のアンカーエポックを計算（直近の日曜 00:00 UTC） */
  private computeWeekAnchor(): number {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun
    const msSinceSunday =
      dayOfWeek * 86400000 +
      now.getUTCHours() * 3600000 +
      now.getUTCMinutes() * 60000 +
      now.getUTCSeconds() * 1000 +
      now.getUTCMilliseconds();
    return now.getTime() - msSinceSunday;
  }

  /** 秒数を読みやすい形式に（例: "2h34m"） */
  private formatElapsed(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
    if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
    return `${s}s`;
  }
}

// ==================== シングルトン ====================

/** グローバル使用量モニターインスタンス */
export const usageMonitor = new UsageMonitor();

// ==================== コストトラッカー連携ヘルパー ====================

/**
 * コストトラッカーから現在のセッションコストを取得し、
 * UsageData.cost に設定するためのヘルパー。
 *
 * 使用例:
 *   const costData = getCostSummary();
 *   usageMonitor.update({
 *     ...currentData,
 *     cost: costData.totalCost,
 *   });
 */
export function getCurrentCostFromTracker(sessionId?: string): number {
  if (sessionId) {
    const session = getSessionCost(sessionId);
    return session?.totalCost ?? 0;
  }
  return getCostSummary().totalCost;
}

/**
 * cost-tracker の全サマリ情報を整形して表示用文字列として返す。
 * UsageMonitor.render() とは独立して使える詳細表示。
 */
export function formatUsageSummary(
  monitor: UsageMonitor,
  sessionId?: string
): string {
  const stats = monitor.getStats();
  const cost = getCurrentCostFromTracker(sessionId);
  const config = monitor.getConfig();

  const lines: string[] = [
    `${bold}📊 Aikata 使用量サマリ${reset}`,
    "",
    `🕐 セッション: ${(stats.sessionPct * 100).toFixed(1)}% ` +
      `(${Math.floor(config.sessionLimitSeconds / 3600)}h 上限)`,
    `📅 週間: ${(stats.weeklyPct * 100).toFixed(1)}%` +
      (config.weeklyLimit ? ` (上限 ${config.weeklyLimit.toLocaleString()})` : ""),
    `🧠 コンテキスト: ${stats.contextPressure} ` +
      `(${monitor["data"].contextPct.toFixed(0)}%)`,
    `💰 累積コスト: $${cost.toFixed(4)}`,
    `⚡ ピーク時間: ${stats.isPeak ? "YES ⚠️" : "no"}` +
      ` (${config.peakStartHour}:00-${config.peakEndHour}:00)`,
  ];

  return lines.join("\n");
}
