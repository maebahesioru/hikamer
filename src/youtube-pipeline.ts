// ==========================================
// Aikata - YouTube自動化パイプライン
// 出典: darkzOGx/youtube-automation-agent
// 動画生成の6ステージパイプライン
// ==========================================

import { logger } from "./utils/logger";

// ==================== パイプライン ====================

export interface YouTubePipelineStage {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  result?: string;
  artifactPath?: string;
}

export interface YouTubeVideoConfig {
  topic: string;
  style: "tutorial" | "review" | "explainer" | "news";
  durationMinutes: number;
  language: string;
  useAI: boolean;
  model?: string;
}

export class YouTubePipeline {
  private stages: YouTubePipelineStage[] = [];

  /**
   * パイプライン全体を定義（YouTube Agentの6ステージ）
   * 1. Research → 2. Script → 3. Voice → 4. Visual → 5. Edit → 6. Upload
   */
  constructor() {
    this.stages = [
      { name: "Research", status: "pending" },
      { name: "Script", status: "pending" },
      { name: "Voice", status: "pending" },
      { name: "Visual", status: "pending" },
      { name: "Edit", status: "pending" },
      { name: "Upload", status: "pending" },
    ];
  }

  /** ステージを開始 */
  startStage(index: number): void {
    const stage = this.stages[index];
    if (stage) {
      stage.status = "running";
      stage.startedAt = Date.now();
    }
  }

  /** ステージを完了 */
  completeStage(index: number, result: string, artifactPath?: string): void {
    const stage = this.stages[index];
    if (stage) {
      stage.status = "completed";
      stage.completedAt = Date.now();
      stage.result = result;
      stage.artifactPath = artifactPath;
    }
  }

  /** ステージを失敗 */
  failStage(index: number, error: string): void {
    const stage = this.stages[index];
    if (stage) {
      stage.status = "failed";
      stage.completedAt = Date.now();
      stage.result = error;
    }
  }

  /** 進行状況をフォーマット */
  formatProgress(): string {
    const complete = this.stages.filter(s => s.status === "completed").length;
    const total = this.stages.length;
    const pct = Math.round((complete / total) * 100);

    const lines = [`🎬 **YouTubeパイプライン** (${complete}/${total}: ${pct}%)`];

    for (let i = 0; i < this.stages.length; i++) {
      const s = this.stages[i]!;
      const emoji = {
        pending: "⏳",
        running: "🔄",
        completed: "✅",
        failed: "❌",
      }[s.status];

      const elapsed = s.startedAt && s.completedAt
        ? `${((s.completedAt - s.startedAt) / 1000).toFixed(0)}s`
        : s.startedAt ? "実行中..." : "";

      lines.push(`${emoji} Stage ${i + 1}: ${s.name} ${elapsed}${s.result ? ` — ${s.result.slice(0, 50)}` : ""}`);
    }

    return lines.join("\n");
  }

  /** 現在のステージを特定 */
  getCurrentStage(): { index: number; stage: YouTubePipelineStage } | null {
    for (let i = 0; i < this.stages.length; i++) {
      if (this.stages[i]!.status === "pending" || this.stages[i]!.status === "running") {
        return { index: i, stage: this.stages[i]! };
      }
    }
    return null;
  }

  /** リセット */
  reset(): void {
    for (const stage of this.stages) {
      stage.status = "pending";
      stage.startedAt = undefined;
      stage.completedAt = undefined;
      stage.result = undefined;
      stage.artifactPath = undefined;
    }
  }
}

// ==================== 動画メタデータ ====================

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  category: string;
  language: string;
  thumbnail?: string;
  scheduledPublishAt?: number;
}

/**
 * 動画メタデータを生成（テンプレートベース）
 */
export function generateVideoMetadata(config: YouTubeVideoConfig, script: string): VideoMetadata {
  const firstLine = script.split("\n")[0] || config.topic;
  const title = `${config.topic} [AI Generated]`;

  return {
    title,
    description: `${config.topic}\n\n${firstLine.slice(0, 200)}\n\n#AI動画 #自動生成`,
    tags: [config.topic, "AI", "tutorial", ...config.style.split(" ")],
    category: config.style === "tutorial" ? "Education" : "Science & Technology",
    language: config.language,
  };
}

// ==================== シングルトン ====================

export const youtubePipeline = new YouTubePipeline();
