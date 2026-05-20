// ==========================================
// Hikamer - 多エージェントオーケストレーター（OpenHuman agent/agents/ 由来）
// 18種のエージェントを統括・プランナー/リサーチャー/コーダー等
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type AgentType =
  | "orchestrator" | "planner" | "researcher" | "coder"
  | "critic" | "summarizer" | "archivist" | "tool_specialist"
  | "skill_creator" | "integration_specialist" | "crypto_agent"
  | "trigger_reactor" | "trigger_triage" | "help"
  | "morning_briefing" | "welcome" | "tools_agent" | "tool_maker";

export interface AgentSpec {
  type: AgentType;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxIterations: number;
  tools: string[];
  enabled: boolean;
}

export interface OrchestrationPlan {
  id: string;
  goal: string;
  steps: OrchestrationStep[];
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
}

export interface OrchestrationStep {
  id: string;
  agent: AgentType;
  description: string;
  input: string;
  output?: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
  durationMs?: number;
}

// ==================== エージェント定義 ====================

const AGENT_DEFINITIONS: Record<AgentType, { name: string; description: string }> = {
  orchestrator: { name: "指揮官", description: "タスクを分解し、適切なエージェントに委譲" },
  planner: { name: "プランナー", description: "タスクの実行計画を立案" },
  researcher: { name: "調査官", description: "Web検索・情報収集・分析" },
  coder: { name: "実装者", description: "コード生成・デバッグ・リファクタリング" },
  critic: { name: "レビュアー", description: "出力の品質チェック・改善提案" },
  summarizer: { name: "要約者", description: "長文の要約・情報抽出" },
  archivist: { name: "記録係", description: "会話の記録・タグ付け・整理" },
  tool_specialist: { name: "ツール専門家", description: "ツールの選択・連携・最適化" },
  skill_creator: { name: "スキル作成者", description: "新しいスキル/コマンドの作成" },
  integration_specialist: { name: "連携専門家", description: "外部サービスとの連携" },
  crypto_agent: { name: "暗号資産エージェント", description: "Web3・暗号資産関連タスク" },
  trigger_reactor: { name: "トリガー処理", description: "イベントトリガーへの応答" },
  trigger_triage: { name: "トリガー分類", description: "イベントの優先順位付け" },
  help: { name: "ヘルプ", description: "ユーザーガイド・コマンド説明" },
  morning_briefing: { name: "朝の報告", description: "日次サマリー生成" },
  welcome: { name: "ウェルカム", description: "新規ユーザー対応" },
  tools_agent: { name: "ツールエージェント", description: "ツールチェーン実行" },
  tool_maker: { name: "ツール作成者", description: "新しいツールの開発" },
};

// ==================== オーケストレーター ====================

class Orchestrator {
  private agents: Map<AgentType, AgentSpec> = new Map();
  private plans: OrchestrationPlan[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.registerAllAgents();
    this.initialized = true;
    logger.info(`[Orchestrator] initialized with ${this.agents.size} agents`);
  }

  /** 全エージェントを登録 */
  private registerAllAgents(): void {
    for (const [type, def] of Object.entries(AGENT_DEFINITIONS)) {
      this.registerAgent({
        type: type as AgentType,
        name: def.name,
        description: def.description,
        systemPrompt: this.getDefaultPrompt(type as AgentType),
        model: "deepseek/deepseek-v4-flash",
        maxIterations: 15,
        tools: this.getDefaultTools(type as AgentType),
        enabled: true,
      });
    }
  }

  /** エージェントを登録 */
  registerAgent(spec: AgentSpec): void {
    this.agents.set(spec.type, spec);
  }

  /** プランを作成 */
  createPlan(goal: string, agents?: AgentType[]): OrchestrationPlan {
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const selectedAgents = agents ?? this.selectAgentsForGoal(goal);

    const steps: OrchestrationStep[] = selectedAgents.map((agentType, i) => ({
      id: `step-${id}-${i}`,
      agent: agentType,
      description: `${AGENT_DEFINITIONS[agentType]?.name ?? agentType}: ${this.getStepDescription(agentType, goal)}`,
      input: goal,
      status: "pending",
    }));

    const plan: OrchestrationPlan = {
      id,
      goal,
      steps,
      status: "planning",
      createdAt: Date.now(),
    };

    this.plans.push(plan);
    if (this.plans.length > 50) this.plans.shift();

    eventBus.publish(createEvent("orchestrator:plan_created", {
      planId: id,
      goal: goal.slice(0, 100),
      steps: steps.length,
    }));

    logger.info(`[Orchestrator] plan ${id}: ${goal.slice(0, 60)}... (${steps.length} steps)`);
    return plan;
  }

  /** プランを実行 */
  async executePlan(planId: string): Promise<OrchestrationPlan | null> {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) return null;

    plan.status = "executing";

    for (const step of plan.steps) {
      step.status = "running";
      const start = Date.now();

      try {
        const agent = this.agents.get(step.agent);
        if (!agent || !agent.enabled) {
          throw new Error(`Agent ${step.agent} not available`);
        }

        // エージェント実行（実際のLLM呼び出しは設定次第）
        const output = await this.runAgent(agent, step.input);
        step.output = output;
        step.status = "completed";
        step.durationMs = Date.now() - start;

        eventBus.publish(createEvent("orchestrator:step_completed", {
          planId,
          stepId: step.id,
          agent: step.agent,
          durationMs: step.durationMs,
        }));
      } catch (err) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : String(err);
        step.durationMs = Date.now() - start;
        logger.error(`[Orchestrator] step ${step.id} failed: ${step.error}`);
      }
    }

    const allCompleted = plan.steps.every((s) => s.status === "completed");
    plan.status = allCompleted ? "completed" : "failed";
    plan.completedAt = Date.now();

    return plan;
  }

  /** エージェント一覧 */
  listAgents(): AgentSpec[] {
    return Array.from(this.agents.values());
  }

  /** 有効なエージェント一覧 */
  getEnabledAgents(): AgentSpec[] {
    return this.listAgents().filter((a) => a.enabled);
  }

  /** プラン一覧 */
  listPlans(): OrchestrationPlan[] {
    return [...this.plans].reverse();
  }

  /** エージェントの有効/無効 */
  setAgentEnabled(type: AgentType, enabled: boolean): boolean {
    const agent = this.agents.get(type);
    if (!agent) return false;
    agent.enabled = enabled;
    return true;
  }

  /** プランのフォーマット */
  formatPlan(plan: OrchestrationPlan): string {
    const statusIcon =
      plan.status === "completed" ? "✅" :
      plan.status === "failed" ? "❌" :
      plan.status === "executing" ? "🔄" : "📋";

    return (
      `${statusIcon} **プラン** \`${plan.id.slice(0, 12)}...\`\n` +
      `目標: ${plan.goal.slice(0, 100)}\n` +
      `ステップ: ${plan.steps.filter(s => s.status === "completed").length}/${plan.steps.length}\n\n` +
      plan.steps.map((s, i) => {
        const icon =
          s.status === "completed" ? "✅" :
          s.status === "failed" ? "❌" :
          s.status === "running" ? "🔄" : "⏳";
        return (
          `${i + 1}. ${icon} **${AGENT_DEFINITIONS[s.agent]?.name ?? s.agent}**\n` +
          `   ${s.description}\n` +
          (s.output ? `   📝 ${s.output.slice(0, 80)}...\n` : "") +
          (s.error ? `   ❌ ${s.error}\n` : "") +
          (s.durationMs ? `   ⏱ ${s.durationMs}ms\n` : "")
        );
      }).join("\n")
    );
  }

  // ---- 内部実装 ----

  private async runAgent(agent: AgentSpec, input: string): Promise<string> {
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) return `[${agent.name} simulation]: received "${input.slice(0, 50)}..."`;

    try {
      const res = await fetch(
        process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: agent.model,
            messages: [
              { role: "system", content: agent.systemPrompt },
              { role: "user", content: input },
            ],
            temperature: 0.3,
            max_tokens: 1000,
          }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "（応答なし）";
    } catch (err) {
      throw new Error(`Agent execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private selectAgentsForGoal(goal: string): AgentType[] {
    const lower = goal.toLowerCase();
    const selected: AgentType[] = ["planner"];

    if (lower.includes("code") || lower.includes("implement") || lower.includes("build") || lower.includes("fix")) {
      selected.push("coder", "critic");
    }
    if (lower.includes("search") || lower.includes("research") || lower.includes("find") || lower.includes("investigate")) {
      selected.push("researcher", "summarizer");
    }
    if (lower.includes("crypto") || lower.includes("wallet") || lower.includes("token")) {
      selected.push("crypto_agent");
    }
    if (lower.includes("integrate") || lower.includes("api") || lower.includes("connect")) {
      selected.push("integration_specialist");
    }

    selected.push("summarizer");
    return [...new Set(selected)];
  }

  private getStepDescription(agentType: AgentType, goal: string): string {
    const desc = AGENT_DEFINITIONS[agentType]?.description ?? "";
    return `${desc}: "${goal.slice(0, 60)}..."`;
  }

  private getDefaultPrompt(type: AgentType): string {
    const prompts: Partial<Record<AgentType, string>> = {
      orchestrator: "あなたはマルチエージェントシステムの指揮官です。タスクを分析し、最適なサブエージェントに委譲してください。",
      planner: "あなたはプランナーです。与えられた目標を達成するための詳細な実行計画を立案してください。各ステップは具体的で実行可能である必要があります。",
      researcher: "あなたは調査官です。Web検索や情報収集を通じて、正確で最新の情報を提供してください。情報源を明記すること。",
      coder: "あなたは実装者です。コードを生成・修正・デバッグしてください。ベストプラクティスに従い、テストを含めること。",
      critic: "あなたはレビュアーです。出力の品質・正確性・セキュリティをチェックし、改善提案を行ってください。",
      summarizer: "あなたは要約者です。長文を簡潔に要約し、重要なポイントを抽出してください。",
    };
    return prompts[type] ?? `あなたは${AGENT_DEFINITIONS[type]?.name ?? type}です。タスクを遂行してください。`;
  }

  private getDefaultTools(type: AgentType): string[] {
    const common = ["search", "read", "write"];
    const toolMap: Partial<Record<AgentType, string[]>> = {
      coder: [...common, "terminal", "git"],
      researcher: ["search", "web_fetch", "extract"],
      planner: common,
      orchestrator: ["delegate", "search"],
    };
    return toolMap[type] ?? common;
  }

  /** エージェント設定をフォーマット */
  formatAgents(): string {
    const agents = this.listAgents();
    return (
      `🤖 **エージェント一覧 (${agents.length})**\n\n` +
      agents.map((a) =>
        `${a.enabled ? "✅" : "⛔"} **${a.name}** (\`${a.type}\`)\n` +
        `   ${a.description} | model: ${a.model} | tools: ${a.tools.length}`
      ).join("\n\n")
    );
  }
}

// ==================== シングルトン ====================

export const orchestrator = new Orchestrator();

export default Orchestrator;
