// ==========================================
// Aikata - チーム管理（OpenHuman team/ 由来）
// マルチエージェントチームの管理・調整
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type AgentRole =
  | "orchestrator"
  | "researcher"
  | "coder"
  | "reviewer"
  | "summarizer"
  | "planner"
  | "tool_specialist"
  | "observer";

export type TeamStatus = "active" | "paused" | "archived";

export interface TeamAgent {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  enabled: boolean;
  skills: string[];
  maxIterations: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  agents: TeamAgent[];
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
  currentTask: string | null;
  taskHistory: string[];
  stats: {
    tasksCompleted: number;
    totalTurns: number;
    avgLatencyMs: number;
  };
}

export interface TeamCreateRequest {
  name: string;
  description?: string;
  agents?: Partial<TeamAgent>[];
}

// ==================== チームでフォルトエージェント ====================

const DEFAULT_AGENTS: Partial<TeamAgent>[] = [
  {
    name: "指揮官",
    role: "orchestrator",
    model: "deepseek/deepseek-v4-pro",
    skills: ["planning", "delegation", "coordination"],
    maxIterations: 20,
  },
  {
    name: "調査官",
    role: "researcher",
    model: "deepseek/deepseek-v4-flash",
    skills: ["web_search", "data_extraction", "analysis"],
    maxIterations: 10,
  },
  {
    name: "実装者",
    role: "coder",
    model: "deepseek/deepseek-v4-pro",
    skills: ["code_generation", "debugging", "refactoring"],
    maxIterations: 15,
  },
  {
    name: "レビュアー",
    role: "reviewer",
    model: "deepseek/deepseek-v4-flash",
    skills: ["code_review", "quality_check", "security_audit"],
    maxIterations: 8,
  },
];

// ==================== チームマネージャー ====================

class TeamManager {
  private teams: Map<string, Team> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Team] initialized");
  }

  /** チームを作成 */
  createTeam(request: TeamCreateRequest): Team {
    if (!request.name.trim()) throw new Error("Team name required");
    if (this.teamsByName(request.name)) {
      throw new Error(`Team "${request.name}" already exists`);
    }

    const id = `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const agents: TeamAgent[] = (request.agents ?? DEFAULT_AGENTS).map(
      (a, i) => ({
        id: `agent-${id}-${i}`,
        name: a.name ?? `Agent ${i + 1}`,
        role: a.role ?? "observer",
        model: a.model ?? "deepseek/deepseek-v4-flash",
        enabled: a.enabled ?? true,
        skills: a.skills ?? [],
        maxIterations: a.maxIterations ?? 10,
        createdAt: now,
      })
    );

    const team: Team = {
      id,
      name: request.name.trim(),
      description: request.description ?? "",
      agents,
      status: "active",
      createdAt: now,
      updatedAt: now,
      currentTask: null,
      taskHistory: [],
      stats: {
        tasksCompleted: 0,
        totalTurns: 0,
        avgLatencyMs: 0,
      },
    };

    this.teams.set(id, team);
    eventBus.emit(createEvent("team:created", { teamId: id, name: team.name }));
    logger.info(`[Team] created: ${team.name} (${agents.length} agents)`);
    return team;
  }

  /** チーム一覧 */
  listTeams(status?: TeamStatus): Team[] {
    const all = [...this.teams.values()];
    return status ? all.filter((t) => t.status === status) : all;
  }

  /** チームを取得 */
  getTeam(idOrName: string): Team | undefined {
    return this.teams.get(idOrName) ?? this.teamsByName(idOrName);
  }

  /** チームを削除 */
  removeTeam(id: string): boolean {
    const team = this.teams.get(id);
    if (!team) return false;
    this.teams.delete(id);
    eventBus.emit(createEvent("team:deleted", { teamId: id }));
    logger.info(`[Team] removed: ${team.name}`);
    return true;
  }

  /** チームステータス変更 */
  setTeamStatus(id: string, status: TeamStatus): boolean {
    const team = this.teams.get(id);
    if (!team) return false;
    team.status = status;
    team.updatedAt = Date.now();
    logger.info(`[Team] ${team.name} → ${status}`);
    return true;
  }

  /** エージェントを追加 */
  addAgent(teamId: string, agent: Partial<TeamAgent>): TeamAgent | null {
    const team = this.teams.get(teamId);
    if (!team) return null;

    const newAgent: TeamAgent = {
      id: `agent-${teamId}-${team.agents.length}`,
      name: agent.name ?? `Agent ${team.agents.length + 1}`,
      role: agent.role ?? "observer",
      model: agent.model ?? "deepseek/deepseek-v4-flash",
      enabled: agent.enabled ?? true,
      skills: agent.skills ?? [],
      maxIterations: agent.maxIterations ?? 10,
      createdAt: Date.now(),
    };

    team.agents.push(newAgent);
    team.updatedAt = Date.now();
    return newAgent;
  }

  /** エージェントを削除 */
  removeAgent(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    const idx = team.agents.findIndex((a) => a.id === agentId);
    if (idx === -1) return false;
    team.agents.splice(idx, 1);
    team.updatedAt = Date.now();
    return true;
  }

  /** タスクをチームに割り当て */
  assignTask(teamId: string, task: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    team.currentTask = task;
    team.taskHistory.push(task);
    if (team.taskHistory.length > 100) team.taskHistory.shift();
    team.updatedAt = Date.now();
    return true;
  }

  /** タスク実行を記録 */
  recordTurn(teamId: string, latencyMs: number): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.stats.totalTurns++;
    team.stats.avgLatencyMs =
      (team.stats.avgLatencyMs * (team.stats.totalTurns - 1) + latencyMs) /
      team.stats.totalTurns;
  }

  /** タスク完了を記録 */
  recordTaskCompletion(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.stats.tasksCompleted++;
    team.currentTask = null;
    team.updatedAt = Date.now();
  }

  /** チーム情報をフォーマット */
  formatTeam(team: Team): string {
    const statusIcon =
      team.status === "active" ? "🟢" :
      team.status === "paused" ? "🟡" : "⚪";

    const agentsList = team.agents
      .map(
        (a) =>
          `${a.enabled ? "✅" : "⛔"} **${a.name}** (${a.role})` +
          ` [${a.model}] ${a.skills.length > 0 ? `🏷️ ${a.skills.join(", ")}` : ""}`
      )
      .join("\n");

    return (
      `${statusIcon} **${team.name}**\n` +
      `ID: \`${team.id}\`\n` +
      `${team.description ? `📝 ${team.description}\n` : ""}` +
      `ステータス: ${team.status}\n` +
      `エージェント: ${team.agents.length}人\n` +
      `タスク完了: ${team.stats.tasksCompleted}\n` +
      `総ターン数: ${team.stats.totalTurns}\n` +
      `平均レイテンシ: ${Math.round(team.stats.avgLatencyMs)}ms\n` +
      `現在のタスク: ${team.currentTask ?? "なし"}\n\n` +
      `**エージェント一覧**\n${agentsList}`
    );
  }

  private teamsByName(name: string): Team | undefined {
    return this.listTeams().find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    );
  }
}

// ==================== シングルトン ====================

export const teamManager = new TeamManager();

// ==================== システムコマンド ====================

export function getTeamCommands(): Record<
  string,
  (args: string[]) => string
> {
  return {
    "/team": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "list":
        case "ls": {
          const teams = teamManager.listTeams();
          if (teams.length === 0) return "📭 チームがありません";
          return (
            `👥 **チーム一覧 (${teams.length})**\n\n` +
            teams
              .map((t, i) => {
                const icon =
                  t.status === "active"
                    ? "🟢"
                    : t.status === "paused"
                      ? "🟡"
                      : "⚪";
                return (
                  `${i + 1}. ${icon} **${t.name}** — ${t.agents.length}エージェント` +
                  ` | ${t.stats.tasksCompleted}タスク完了` +
                  (t.currentTask ? ` | 📋 ${t.currentTask.slice(0, 40)}...` : "")
                );
              })
              .join("\n")
          );
        }

        case "create": {
          const name = args[1];
          if (!name) return "⚠️ チーム名が必要です";
          const team = teamManager.createTeam({
            name: name,
            description: args.slice(2).join(" "),
          });
          return `✅ チーム「${team.name}」を作成しました\n${teamManager.formatTeam(team)}`;
        }

        case "get":
        case "info": {
          const idOrName = args[1];
          if (!idOrName) return "⚠️ チームIDまたは名前が必要です";
          const team = teamManager.getTeam(idOrName);
          if (!team) return "❌ チームが見つかりません";
          return teamManager.formatTeam(team);
        }

        case "rm":
        case "remove": {
          const id = args[1];
          if (!id) return "⚠️ チームIDが必要です";
          return teamManager.removeTeam(id)
            ? `🗑️ チームを削除しました`
            : "❌ チームが見つかりません";
        }

        case "pause":
        case "resume": {
          const idOrName = args[1];
          if (!idOrName) return "⚠️ チームIDが必要です";
          const team = teamManager.getTeam(idOrName);
          if (!team) return "❌ チームが見つかりません";
          const newStatus = sub === "pause" ? "paused" as TeamStatus : "active" as TeamStatus;
          teamManager.setTeamStatus(team.id, newStatus);
          return `✅ ${team.name} を${sub === "pause" ? "一時停止" : "再開"}しました`;
        }

        case "add-agent": {
          const idOrName = args[1];
          const agentName = args[2];
          const role = args[3] as AgentRole | undefined;
          if (!idOrName || !agentName) return "⚠️ チームIDとエージェント名が必要です";
          const team = teamManager.getTeam(idOrName);
          if (!team) return "❌ チームが見つかりません";
          const agent = teamManager.addAgent(team.id, {
            name: agentName,
            role: role ?? "observer",
          });
          return agent
            ? `✅ エージェント「${agent.name}」(${agent.role})を追加しました`
            : "❌ エージェント追加に失敗";
        }

        case "task": {
          const idOrName = args[1];
          const task = args.slice(2).join(" ");
          if (!idOrName || !task) return "⚠️ チームIDとタスク内容が必要です";
          const team = teamManager.getTeam(idOrName);
          if (!team) return "❌ チームが見つかりません";
          teamManager.assignTask(team.id, task);
          return `📋 ${team.name} にタスクを割り当てました: ${task.slice(0, 100)}`;
        }

        default:
          return (
            `👥 **チームコマンド**\n` +
            `/team list — チーム一覧\n` +
            `/team create <name> [desc] — 新規作成\n` +
            `/team get <id|name> — チーム詳細\n` +
            `/team rm <id> — チーム削除\n` +
            `/team pause|resume <id> — 一時停止/再開\n` +
            `/team add-agent <id> <name> [role] — エージェント追加\n` +
            `/team task <id> <task> — タスク割り当て`
          );
      }
    },
  };
}

export default TeamManager;
