// ==========================================
// Hikamer - スケジューラー拡張（Hermes Agent cron v2由来）
// 複雑なスケジュール表現・リマインダー・定期タスク強化
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type ScheduleType = "once" | "daily" | "weekly" | "monthly" | "cron" | "interval" | "weekday";

export interface ScheduledTask {
  id: string;
  name: string;
  type: ScheduleType;
  /** cron式 or 間隔ms or "HH:MM" or "Mon 10:00" */
  schedule: string;
  action: () => Promise<string>;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  maxRuns?: number;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  tags: string[];
}

// ==================== スケジューラー拡張 ====================

class SchedulerV2 {
  private tasks: ScheduledTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;

    // 毎秒チェック
    this.timer = setInterval(() => this.tick(), 1000);
    logger.info(`[SchedulerV2] 起動 (${this.tasks.length}タスク)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** タスク追加 */
  add(task: Omit<ScheduledTask, "id" | "runCount" | "createdAt" | "lastRun" | "nextRun">): ScheduledTask {
    const t: ScheduledTask = {
      ...task,
      id: `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      runCount: 0,
      createdAt: Date.now(),
    };

    t.nextRun = this.calculateNextRun(t);
    this.tasks.push(t);
    this.tasks.sort((a, b) => (a.nextRun || Infinity) - (b.nextRun || Infinity));
    logger.info(`[SchedulerV2] 追加: "${t.name}" (${t.type}: ${t.schedule})`);
    return t;
  }

  /** タスク削除 */
  remove(id: string): boolean {
    const idx = this.tasks.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    return true;
  }

  /** タスク一覧 */
  list(): ScheduledTask[] {
    return [...this.tasks];
  }

  /** 毎秒のチェック */
  private tick(): void {
    const now = Date.now();

    for (const task of this.tasks) {
      if (!task.enabled) continue;
      if (task.maxRuns && task.runCount >= task.maxRuns) continue;
      if (!task.nextRun || task.nextRun > now) continue;

      // 実行
      this.executeTask(task);
    }
  }

  /** タスク実行 */
  private async executeTask(task: ScheduledTask): Promise<void> {
    const start = Date.now();
    logger.info(`[SchedulerV2] 実行: "${task.name}"`);

    try {
      const result = await task.action();
      task.runCount++;
      task.lastRun = Date.now();
      task.nextRun = this.calculateNextRun(task);

      logger.info(`[SchedulerV2] 完了: "${task.name}" (${Date.now() - start}ms)`);
      eventBus.publish(createEvent("cron", "taskCompleted", {
        id: task.id, name: task.name, result: result.slice(0, 200), duration: Date.now() - start,
      }));
    } catch (e: any) {
      task.runCount++;
      task.lastRun = Date.now();
      task.nextRun = this.calculateNextRun(task);

      logger.error(`[SchedulerV2] 失敗: "${task.name}" — ${e.message}`);
      eventBus.publish(createEvent("error", "taskFailed", { id: task.id, name: task.name, error: e.message }));
    }
  }

  /** 次回実行時刻計算 */
  private calculateNextRun(task: ScheduledTask): number | undefined {
    if (task.maxRuns && task.runCount >= task.maxRuns) return undefined;

    const now = Date.now();

    switch (task.type) {
      case "once":
        return task.maxRuns && task.runCount > 0 ? undefined : this.parseAbsolute(task.schedule);

      case "interval": {
        const ms = parseInt(task.schedule, 10);
        return isNaN(ms) ? now + 60000 : now + ms;
      }

      case "daily": {
        // "10:30" 形式
        const [h, m] = task.schedule.split(":").map(Number);
        if (h === undefined || m === undefined) return now + 86400000;

        const next = new Date();
        next.setHours(h, m, 0, 0);
        if (next.getTime() <= now) next.setDate(next.getDate() + 1);
        return next.getTime();
      }

      case "weekday": {
        // "Mon 10:00" 形式
        const parts = task.schedule.split(" ");
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const targetDay = dayNames.indexOf(parts[0] || "");
        const [h2, m2] = (parts[1] || "09:00").split(":").map(Number);

        if (targetDay === -1 || h2 === undefined || m2 === undefined) return now + 86400000;

        const next2 = new Date();
        next2.setHours(h2, m2, 0, 0);
        while (next2.getDay() !== targetDay || next2.getTime() <= now) {
          next2.setDate(next2.getDate() + 1);
        }
        return next2.getTime();
      }

      case "cron": {
        // 簡易cron: "*/5 * * * *"
        return this.parseCron(task.schedule, now);
      }

      default:
        return now + 60000;
    }
  }

  private parseAbsolute(schedule: string): number {
    const ts = Date.parse(schedule);
    return isNaN(ts) ? Date.now() + 3600000 : ts;
  }

  /** 簡易cronパーサー */
  private parseCron(expr: string, from: number): number {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return from + 60000;

    const now = new Date(from);
    let candidate = new Date(from);

    // 分
    const minute = this.parseCronField(parts[0]!, 0, 59, now.getMinutes());

    // 時
    candidate.setMinutes(candidate.getMinutes() + 1);
    candidate.setSeconds(0, 0);

    return candidate.getTime();
  }

  private parseCronField(field: string, min: number, max: number, current: number): number[] {
    if (field === "*") {
      const values: number[] = [];
      for (let i = min; i <= max; i++) values.push(i);
      return values;
    }
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step)) return [current];
      const values: number[] = [];
      for (let i = min; i <= max; i += step) values.push(i);
      return values;
    }
    const val = parseInt(field, 10);
    return isNaN(val) ? [current] : [val];
  }

  /** フォーマット */
  formatTasks(): string {
    if (this.tasks.length === 0) return "⏰ スケジュールされたタスクはありません。";

    return [
      "⏰ **スケジュール一覧**",
      "",
      ...this.tasks.map(t => {
        const icon = t.enabled ? "✅" : "❌";
        const next = t.nextRun ? new Date(t.nextRun).toLocaleString("ja-JP") : "なし";
        const runs = t.maxRuns ? `${t.runCount}/${t.maxRuns}` : `${t.runCount}回`;
        const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
        return `${icon} **${t.name}**${tags}\n` +
          `   種類: ${t.type} | スケジュール: \`${t.schedule}\`\n` +
          `   次回: ${next} | 実行: ${runs}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

export const schedulerV2 = new SchedulerV2();
