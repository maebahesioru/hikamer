// ==========================================
// Aikata - Cronスケジューラー
// ==========================================

import * as cron from "node-cron";
import { getEnabledCronJobs, updateCronJobLastRun } from "./repo";
import { agentLoop } from "./agent";
import { buildSystemPrompt } from "./system-prompt";
import { logger } from "./utils/logger";
import type { LLMProvider } from "./types";

export interface SchedulerDeps {
  provider: LLMProvider;
  deliver: (platform: string, chatId: string, message: string) => Promise<void>;
}

const activeJobs = new Map<string, cron.ScheduledTask>();

export function startScheduler(deps: SchedulerDeps): void {
  refreshJobs(deps);
  // 毎分ジョブ一覧をリフレッシュ
  cron.schedule("* * * * *", () => {
    refreshJobs(deps);
  });

  logger.info("スケジューラー起動 (毎分リフレッシュ)");
}

function refreshJobs(deps: SchedulerDeps): void {
  const jobs = getEnabledCronJobs();
  const currentIds = new Set(jobs.map(j => j.id));

  // 削除されたジョブを停止
  for (const id of Array.from(activeJobs.keys())) {
    if (!currentIds.has(id)) {
      activeJobs.get(id)?.stop();
      activeJobs.delete(id);
      logger.debug(`Cron停止: ${id}`);
    }
  }

  // 新規ジョブを登録
  for (const job of jobs) {
    if (activeJobs.has(job.id)) continue;

    if (!cron.validate(job.cron_expr)) {
      logger.warn(`無効なcron式: ${job.id} "${job.cron_expr}"`);
      continue;
    }

    const task = cron.schedule(job.cron_expr, async () => {
      logger.info(`Cron実行: ${job.id} "${job.label || job.prompt.slice(0, 30)}"`);

      try {
        const result = await agentLoop(
          deps.provider,
          await buildSystemPrompt(),
          job.prompt,
          job.conversation_id
        );

        updateCronJobLastRun(job.id);
        await deps.deliver(job.platform, job.chat_id, result.response);
        logger.info(`Cron完了: ${job.id} (${result.iterations}反復)`);
      } catch (e: any) {
        logger.error(`Cron失敗: ${job.id} - ${e.message}`);
      }
    });

    activeJobs.set(job.id, task);
    logger.debug(`Cron登録: ${job.id} "${job.cron_expr}" → "${job.prompt.slice(0, 40)}"`);
  }
}

export function stopScheduler(): void {
  for (const [, task] of Array.from(activeJobs.entries())) {
    task.stop();
  }
  activeJobs.clear();
  logger.info("スケジューラー停止");
}

// ==================== バッチパイプラインプログレス（OmniVoice由来） ====================

interface PipelineStage {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

interface PipelineRun {
  id: string;
  label: string;
  stages: PipelineStage[];
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  totalStages: number;
  completedStages: number;
}

class PipelineManager {
  private pipelines = new Map<string, PipelineRun>();
  private nextId = 1;

  /**
   * パイプラインを開始
   */
  start(label: string, stageNames: string[]): string {
    const id = `pipe-${this.nextId++}`;
    const pipeline: PipelineRun = {
      id,
      label,
      stages: stageNames.map(name => ({ name, status: "pending" })),
      createdAt: Date.now(),
      status: "running",
      totalStages: stageNames.length,
      completedStages: 0,
    };
    this.pipelines.set(id, pipeline);
    logger.info(`[Pipeline] 開始: ${id} "${label}" (${stageNames.length}段階)`);
    return id;
  }

  /**
   * ステージを開始
   */
  startStage(pipelineId: string, stageIndex: number): boolean {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return false;
    const stage = pipeline.stages[stageIndex];
    if (!stage) return false;
    stage.status = "running";
    stage.startedAt = Date.now();
    return true;
  }

  /**
   * ステージを完了
   */
  completeStage(pipelineId: string, stageIndex: number, result?: string): boolean {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return false;
    const stage = pipeline.stages[stageIndex];
    if (!stage) return false;
    stage.status = "completed";
    stage.completedAt = Date.now();
    stage.result = result;
    pipeline.completedStages = pipeline.stages.filter(s => s.status === "completed").length;
    return true;
  }

  /**
   * ステージを失敗
   */
  failStage(pipelineId: string, stageIndex: number, error: string): boolean {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return false;
    const stage = pipeline.stages[stageIndex];
    if (!stage) return false;
    stage.status = "failed";
    stage.completedAt = Date.now();
    stage.error = error;
    pipeline.status = "failed";
    pipeline.completedAt = Date.now();
    logger.warn(`[Pipeline] 失敗: ${pipelineId} stage ${stageIndex}: ${error}`);
    return true;
  }

  /**
   * パイプラインを完了
   */
  complete(pipelineId: string): boolean {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return false;
    pipeline.status = "completed";
    pipeline.completedAt = Date.now();
    logger.info(`[Pipeline] 完了: ${pipelineId} "${pipeline.label}"`);
    return true;
  }

  /**
   * 進行状況をフォーマット
   */
  formatProgress(pipelineId: string): string {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return "パイプラインが見つかりません";

    const pct = pipeline.totalStages > 0
      ? Math.round((pipeline.completedStages / pipeline.totalStages) * 100)
      : 0;
    const emoji = pipeline.status === "completed" ? "✅" : pipeline.status === "failed" ? "❌" : "🔄";

    const lines = [`${emoji} **${pipeline.label}** (${pct}%)`];
    const barWidth = 15;
    const filled = Math.round((pipeline.completedStages / pipeline.totalStages) * barWidth);
    const empty = barWidth - filled;
    lines.push(`[${"█".repeat(filled)}${"░".repeat(empty)}]`);

    for (let i = 0; i < pipeline.stages.length; i++) {
      const s = pipeline.stages[i]!;
      const statusEmoji = s.status === "completed" ? "✅" : s.status === "running" ? "🔄" : s.status === "failed" ? "❌" : "⏳";
      const elapsed = s.startedAt ? ` (${((Date.now() - s.startedAt) / 1000).toFixed(0)}s)` : "";
      lines.push(`${statusEmoji} Stage ${i + 1}: ${s.name}${elapsed}`);
    }

    return lines.join("\n");
  }
}

export const pipelineManager = new PipelineManager();
