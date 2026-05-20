// ==========================================
// Aikata - Daily Diary / Learning Journal (v1.73)
// 前日の学習内容を「日記」として自動出力
// telemetry + memory-pipeline のデータを活用
// ==========================================

import { logger } from "./utils/logger";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { telemetry } from "./telemetry";
import { getDefaultPipeline } from "./memory-pipeline";

// ==================== 型定義 ====================

export interface DiaryEntry {
  date: string;           // YYYY-MM-DD
  summary: string;        // 1行サマリー
  highlights: string[];   // ハイライト
  toolsUsed: { name: string; count: number }[];
  sessionsCount: number;
  totalTurns: number;
  successRate: number;
  totalCost: number;
  learnings: string[];    // 学んだこと
  errors: string[];       // 遭遇したエラー
  generatedAt: number;
}

// ==================== 日記ジェネレーター ====================

const DIARY_DIR = resolve(process.env.DATA_DIR || "./data", "diary");

class DiaryGenerator {
  /**
   * 前日の日記を生成
   */
  generate(dateStr?: string): DiaryEntry {
    const targetDate = dateStr || this.yesterday();
    const today = new Date();
    const yesterdayStart = new Date(targetDate + "T00:00:00+09:00").getTime();
    const yesterdayEnd = new Date(targetDate + "T23:59:59+09:00").getTime();

    // テレメトリーから昨日のセッションを抽出
    const report = telemetry.getReport();
    const yesterdaySessions = report.sessions.filter(s =>
      s.lastActivity >= yesterdayStart && s.lastActivity <= yesterdayEnd
    );

    // メモリパイプラインから昨日の学習を抽出
    const pipeline = getDefaultPipeline();
    const allMemories = pipeline.getAllEntries();
    const yesterdayMemories = allMemories.filter(m =>
      m.createdAt >= yesterdayStart && m.createdAt <= yesterdayEnd
    );

    // ツール使用集計
    const toolCounts = new Map<string, number>();
    for (const s of yesterdaySessions) {
      for (const t of s.topTools) {
        toolCounts.set(t.name, (toolCounts.get(t.name) || 0) + t.count);
      }
    }

    // 統計
    const totalTurns = yesterdaySessions.reduce((s, ss) => s + ss.totalTurns, 0);
    const totalCost = yesterdaySessions.reduce((s, ss) => s + ss.totalCost, 0);
    const successCount = yesterdaySessions.reduce((s, ss) => s + (ss.successRate / 100) * ss.totalTurns, 0);
    const successRate = totalTurns > 0 ? (successCount / totalTurns) * 100 : 0;

    // ハイライト生成
    const highlights: string[] = [];
    if (yesterdaySessions.length > 0) {
      highlights.push(`${yesterdaySessions.length}セッション、${totalTurns}ターン実行`);
    }
    if (yesterdayMemories.length > 0) {
      highlights.push(`${yesterdayMemories.length}件の新しい記憶を獲得`);
    }
    if (totalCost > 0) {
      highlights.push(`API費用: $${totalCost.toFixed(4)}`);
    }

    // 学習抽出
    const learnings = yesterdayMemories
      .filter(m => m.contentCategory === "static" || m.importance >= 0.5)
      .slice(0, 10)
      .map(m => m.summary || m.text.slice(0, 100));

    // エラー抽出
    const errors = yesterdaySessions
      .flatMap(s => s.topErrors)
      .slice(0, 5)
      .map(e => e.message);

    // サマリー生成
    const activityLevel = totalTurns > 50 ? "活発" : totalTurns > 10 ? "通常" : totalTurns > 0 ? "低調" : "休眠";
    const summary = `${targetDate}: ${activityLevel}（${yesterdaySessions.length}セッション, ${totalTurns}ターン, 成功率${successRate.toFixed(0)}%）`;

    const entry: DiaryEntry = {
      date: targetDate,
      summary,
      highlights,
      toolsUsed: [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count })),
      sessionsCount: yesterdaySessions.length,
      totalTurns,
      successRate,
      totalCost,
      learnings,
      errors,
      generatedAt: Date.now(),
    };

    // 保存
    this.save(entry);
    logger.info(`[Diary] ${targetDate} の日記を生成: ${summary}`);

    return entry;
  }

  /**
   * 直近N日分の日記を取得
   */
  getRecent(days: number = 7): DiaryEntry[] {
    const entries: DiaryEntry[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i - 1); // 昨日から遡る
      const dateStr = d.toISOString().slice(0, 10);
      const entry = this.load(dateStr);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  /**
   * 週間サマリーを生成
   */
  getWeeklySummary(): string {
    const entries = this.getRecent(7);
    if (entries.length === 0) return "📭 今週の日記はまだありません。";

    const totalTurns = entries.reduce((s, e) => s + e.totalTurns, 0);
    const totalCost = entries.reduce((s, e) => s + e.totalCost, 0);
    const totalSessions = entries.reduce((s, e) => s + e.sessionsCount, 0);
    const totalLearnings = entries.reduce((s, e) => s + e.learnings.length, 0);
    const avgSuccess = entries.length > 0
      ? entries.reduce((s, e) => s + e.successRate, 0) / entries.length
      : 0;

    // 全ツール集計
    const toolMap = new Map<string, number>();
    for (const e of entries) {
      for (const t of e.toolsUsed) {
        toolMap.set(t.name, (toolMap.get(t.name) || 0) + t.count);
      }
    }

    const topTools = [...toolMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return [
      `📓 **週間レポート** (${entries[entries.length - 1]?.date} 〜 ${entries[0]?.date})`,
      ``,
      `📊 **統計**`,
      `セッション: ${totalSessions} | ターン: ${totalTurns} | 成功率: ${avgSuccess.toFixed(0)}%`,
      `コスト: $${totalCost.toFixed(4)} | 学習: ${totalLearnings}件`,
      ``,
      `🔧 **よく使ったツール**`,
      ...topTools.map(t => `  • ${t.name} ×${t.count}`),
      ``,
      `📝 **日別サマリー**`,
      ...entries.map(e => `  ${e.date}: ${e.summary}`),
    ].join("\n");
  }

  formatDiary(entry: DiaryEntry): string {
    const lines: string[] = [
      `📓 **Aikata日記** — ${entry.date}`,
      ``,
      `📊 ${entry.summary}`,
      ``,
    ];

    if (entry.highlights.length > 0) {
      lines.push(`**✨ ハイライト**`);
      for (const h of entry.highlights) lines.push(`  • ${h}`);
      lines.push("");
    }

    if (entry.toolsUsed.length > 0) {
      lines.push(`**🔧 使用ツール**`);
      for (const t of entry.toolsUsed.slice(0, 5)) {
        lines.push(`  • ${t.name} ×${t.count}`);
      }
      lines.push("");
    }

    if (entry.learnings.length > 0) {
      lines.push(`**🧠 学んだこと**`);
      for (const l of entry.learnings.slice(0, 5)) {
        lines.push(`  • ${l}`);
      }
      lines.push("");
    }

    if (entry.errors.length > 0) {
      lines.push(`**⚠️ 遭遇したエラー**`);
      for (const e of entry.errors.slice(0, 3)) {
        lines.push(`  • ${e}`);
      }
      lines.push("");
    }

    lines.push(`💰 コスト: $${entry.totalCost.toFixed(4)}`);
    lines.push(`📅 生成: ${new Date(entry.generatedAt).toLocaleString("ja-JP")}`);

    return lines.join("\n");
  }

  formatRecent(entries: DiaryEntry[]): string {
    if (entries.length === 0) return "📭 日記がありません。活動があれば自動生成されます。";

    const lines: string[] = ["📓 **最近の日記**", ""];
    for (const e of entries.slice(0, 7)) {
      const icon = e.totalTurns > 50 ? "🔥" : e.totalTurns > 10 ? "📝" : e.totalTurns > 0 ? "📄" : "💤";
      lines.push(`${icon} **${e.date}**: ${e.sessionsCount}セッション, ${e.totalTurns}ターン, 成功率${e.successRate.toFixed(0)}%`);
    }

    lines.push("", "`/diary <date>` で詳細表示");
    return lines.join("\n");
  }

  // ========== 永続化 ==========

  private save(entry: DiaryEntry): void {
    try {
      if (!existsSync(DIARY_DIR)) mkdirSync(DIARY_DIR, { recursive: true });
      const path = join(DIARY_DIR, `${entry.date}.json`);
      writeFileSync(path, JSON.stringify(entry, null, 2), "utf-8");
    } catch {}
  }

  private load(dateStr: string): DiaryEntry | null {
    try {
      const path = join(DIARY_DIR, `${dateStr}.json`);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  private yesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}

// ==================== シングルトン ====================

export const diary = new DiaryGenerator();
export default DiaryGenerator;
