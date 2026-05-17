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
          buildSystemPrompt(),
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
