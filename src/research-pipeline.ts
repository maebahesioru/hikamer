// ==========================================
// Hikamer - Research Pipeline (v1.64)
// 出典: Imbad0202/academic-research-skills (12.7K stars)
// 5段階パイプライン: Research → Write → Review → Revise → Finalize
// token budget管理 + per-mode最適化
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type ResearchStage = "research" | "write" | "review" | "revise" | "finalize";

export interface ResearchTask {
  id: string;
  topic: string;
  stage: ResearchStage;
  /** 各段階の成果物 */
  artifacts: {
    research?: string;   // 調査メモ
    draft?: string;      // 初稿
    review?: string;     // レビュー指摘
    revised?: string;    // 修正稿
    final?: string;      // 最終稿
  };
  /** トークン予算（トークン数） */
  tokenBudget: number;
  /** 使用トークン */
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  status: "in_progress" | "completed" | "abandoned";
}

export interface ResearchConfig {
  /** 各段階のトークン予算 */
  budgets: Record<ResearchStage, number>;
  /** 自動レビューを有効にするか */
  autoReview: boolean;
  /** 最大修正ラウンド数 */
  maxRevisionRounds: number;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: ResearchConfig = {
  budgets: {
    research: 8000,   // 調査: 広く浅く
    write: 12000,      // 執筆: 最も多くのトークン
    review: 4000,      // レビュー: 簡潔に
    revise: 6000,      // 修正: レビュー指摘に対応
    finalize: 3000,    // 最終化: フォーマット調整
  },
  autoReview: true,
  maxRevisionRounds: 2,
};

// 段階ごとのシステムプロンプト指示
const STAGE_PROMPTS: Record<ResearchStage, string> = {
  research: `## 調査段階
- トピックに関する情報を広く収集する
- 信頼できるソースを優先（学術論文、公式ドキュメント、専門家の記事）
- キーポイントを箇条書きで整理する
- この段階では文章を書かない。情報収集に徹する
- 出力: 調査メモ（箇条書き + ソースURL）`,

  write: `## 執筆段階
- 調査メモに基づいて初稿を作成する
- 読みやすい構成を心がける（導入→本論→結論）
- 専門用語は初出時に簡潔に説明する
- 出力: Markdown形式の初稿`,

  review: `## レビュー段階
- 初稿を批判的に評価する
- 以下の観点でチェック: 正確性、網羅性、読みやすさ、構成
- 具体的な改善提案を箇条書きで出力する
- 「良い点」も明記すること（バランスの取れたフィードバック）
- 出力: レビュー指摘（良い点 + 改善点）`,

  revise: `## 修正段階
- レビュー指摘に基づいて初稿を修正する
- すべての改善点に対応すること
- 対応できない指摘は理由を明記する
- 出力: 修正稿`,

  finalize: `## 最終化段階
- 修正稿を最終的な形に整える
- フォーマットの統一、誤字脱字のチェック
- 必要に応じて要約を追加する
- 出力: 最終稿`,
};

// ==================== Research Pipeline ====================

class ResearchPipeline {
  private tasks: Map<string, ResearchTask> = new Map();
  private config: ResearchConfig;

  constructor(config?: Partial<ResearchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 新しい研究タスクを開始 */
  start(topic: string, customBudgets?: Partial<Record<ResearchStage, number>>): ResearchTask {
    const id = `res_${Date.now().toString(36)}`;
    const budgets = { ...this.config.budgets, ...customBudgets };

    const task: ResearchTask = {
      id,
      topic,
      stage: "research",
      artifacts: {},
      tokenBudget: budgets.research,
      tokensUsed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "in_progress",
    };

    this.tasks.set(id, task);
    logger.info(`[Research] 開始: ${id} "${topic.slice(0, 60)}"`);
    return task;
  }

  /** 現在の段階のプロンプトを取得 */
  getStagePrompt(task: ResearchTask): string {
    const stagePrompt = STAGE_PROMPTS[task.stage];
    const progress = this.getProgress(task);

    return [
      `# 研究タスク: ${task.topic}`,
      ``,
      `現在の段階: **${this.stageLabel(task.stage)}** (${progress.current}/${progress.total})`,
      ``,
      stagePrompt,
      ``,
      `---`,
      `前の段階の成果:`,
      task.stage === "write" && task.artifacts.research
        ? `<research_notes>\n${task.artifacts.research.slice(0, 8000)}\n</research_notes>`
        : "",
      task.stage === "review" && task.artifacts.draft
        ? `<draft>\n${task.artifacts.draft.slice(0, 10000)}\n</draft>`
        : "",
      task.stage === "revise" && task.artifacts.review
        ? `<review_feedback>\n${task.artifacts.review}\n</review_feedback>`
        : "",
      task.stage === "finalize" && task.artifacts.revised
        ? `<revised_draft>\n${task.artifacts.revised.slice(0, 10000)}\n</revised_draft>`
        : "",
      ``,
      `トークン予算: ${task.tokenBudget.toLocaleString()} | 使用済み: ${task.tokensUsed.toLocaleString()}`,
    ].filter(line => line !== "").join("\n");
  }

  /** 段階の成果を記録して次の段階に進む */
  advanceStage(task: ResearchTask, artifact: string, tokensUsed: number): ResearchTask | null {
    // 成果を保存
    switch (task.stage) {
      case "research": task.artifacts.research = artifact; break;
      case "write": task.artifacts.draft = artifact; break;
      case "review": task.artifacts.review = artifact; break;
      case "revise": task.artifacts.revised = artifact; break;
      case "finalize":
        task.artifacts.final = artifact;
        task.status = "completed";
        task.updatedAt = Date.now();
        logger.info(`[Research] 完了: ${task.id}`);
        return null; // 終了
    }

    task.tokensUsed += tokensUsed;
    task.updatedAt = Date.now();

    // 次の段階へ
    const nextStage = this.nextStage(task.stage);
    if (!nextStage) {
      task.status = "completed";
      return null;
    }

    task.stage = nextStage;
    task.tokenBudget = this.config.budgets[nextStage];
    logger.info(`[Research] 段階進行: ${task.id} → ${nextStage}`);
    return task;
  }

  /** 現在の段階の次を取得 */
  private nextStage(current: ResearchStage): ResearchStage | null {
    const order: ResearchStage[] = ["research", "write", "review", "revise", "finalize"];
    const idx = order.indexOf(current);
    return idx < order.length - 1 ? order[idx + 1]! : null;
  }

  /** 進捗情報 */
  getProgress(task: ResearchTask): { current: number; total: number; percent: number } {
    const order: ResearchStage[] = ["research", "write", "review", "revise", "finalize"];
    const idx = order.indexOf(task.stage);
    return {
      current: idx + 1,
      total: order.length,
      percent: Math.round(((idx + 1) / order.length) * 100),
    };
  }

  /** 段階の日本語ラベル */
  stageLabel(stage: ResearchStage): string {
    const labels: Record<ResearchStage, string> = {
      research: "🔍 調査",
      write: "✍️ 執筆",
      review: "🔎 レビュー",
      revise: "🔧 修正",
      finalize: "✅ 最終化",
    };
    return labels[stage];
  }

  /** タスクの状態をフォーマット */
  formatTask(task: ResearchTask): string {
    const progress = this.getProgress(task);
    const progressBar = "█".repeat(progress.current) + "░".repeat(progress.total - progress.current);

    return [
      `📝 **研究タスク**: ${task.topic.slice(0, 80)}`,
      `ID: \`${task.id}\``,
      `段階: ${this.stageLabel(task.stage)} [${progressBar}] ${progress.percent}%`,
      `トークン: ${task.tokensUsed.toLocaleString()} / 予算合計`,
      `作成: ${new Date(task.createdAt).toLocaleString("ja-JP")}`,
      task.status === "completed" ? "✅ 完了" : "",
    ].filter(Boolean).join("\n");
  }

  /** 完了したタスクの最終稿を取得 */
  getFinalArtifact(task: ResearchTask): string | null {
    return task.artifacts.final || task.artifacts.revised || task.artifacts.draft || null;
  }
}

// ==================== シングルトン ====================

export const researchPipeline = new ResearchPipeline();
export default ResearchPipeline;
