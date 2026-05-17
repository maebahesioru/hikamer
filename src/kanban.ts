// ==========================================
// Aikata - Kanbanボード（Hermes Agent kanban由来）
// カラム別タスク管理 + WIP制限 + スイムレーン
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  column: string;
  swimlane?: string;
  priority: "low" | "medium" | "high" | "urgent";
  assignee?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  estimate?: number; // 時間見積もり
  blockedBy?: string[]; // 依存タスクID
  attachments: string[];
}

export interface KanbanColumn {
  id: string;
  title: string;
  wipLimit: number;
  color: string;
}

export interface KanbanBoard {
  name: string;
  columns: KanbanColumn[];
  swimlanes: string[];
  cards: KanbanCard[];
}

// ==================== デフォルト設定 ====================

const DEFAULT_BOARD: KanbanBoard = {
  name: "default",
  columns: [
    { id: "backlog", title: "📋 Backlog", wipLimit: 0, color: "gray" },
    { id: "todo", title: "📝 To Do", wipLimit: 10, color: "blue" },
    { id: "in_progress", title: "🔄 In Progress", wipLimit: 5, color: "yellow" },
    { id: "review", title: "👀 Review", wipLimit: 3, color: "purple" },
    { id: "done", title: "✅ Done", wipLimit: 0, color: "green" },
  ],
  swimlanes: ["default"],
  cards: [],
};

// ==================== Kanbanエンジン ====================

class KanbanEngine {
  private boards = new Map<string, KanbanBoard>();
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "kanban.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data: KanbanBoard[] = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        for (const board of data) {
          this.boards.set(board.name, board);
        }
        logger.info(`[Kanban] 復元: ${this.boards.size}ボード`);
      }
    } catch (e) {
      logger.warn(`[Kanban] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(Array.from(this.boards.values()), null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Kanban] 保存失敗: ${e}`);
    }
  }

  /** ボード取得（なければ作成） */
  getBoard(name: string = "default"): KanbanBoard {
    let board = this.boards.get(name);
    if (!board) {
      board = JSON.parse(JSON.stringify(DEFAULT_BOARD));
      board.name = name;
      this.boards.set(name, board);
      this.save();
    }
    return board;
  }

  /** カード追加 */
  addCard(boardName: string, title: string, options?: {
    column?: string;
    description?: string;
    priority?: KanbanCard["priority"];
    assignee?: string;
    tags?: string[];
    swimlane?: string;
    dueDate?: number;
  }): KanbanCard | null {
    const board = this.getBoard(boardName);
    const column = options?.column || board.columns[0]?.id || "backlog";

    // カラム存在チェック
    if (!board.columns.find(c => c.id === column)) return null;

    // WIP制限チェック
    const col = board.columns.find(c => c.id === column)!;
    if (col.wipLimit > 0) {
      const currentCount = board.cards.filter(c => c.column === column).length;
      if (currentCount >= col.wipLimit) {
        logger.warn(`[Kanban] WIP制限超過: ${column} (${currentCount}/${col.wipLimit})`);
        return null;
      }
    }

    const card: KanbanCard = {
      id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: title.slice(0, 200),
      description: options?.description || "",
      column,
      swimlane: options?.swimlane || "default",
      priority: options?.priority || "medium",
      assignee: options?.assignee,
      tags: options?.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dueDate: options?.dueDate,
      attachments: [],
    };

    board.cards.push(card);
    this.save();
    logger.info(`[Kanban] カード追加: "${title}" → ${column}`);
    return card;
  }

  /** カード移動 */
  moveCard(boardName: string, cardId: string, targetColumn: string): boolean {
    const board = this.getBoard(boardName);
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return false;

    const col = board.columns.find(c => c.id === targetColumn);
    if (!col) return false;

    // WIP制限
    if (col.wipLimit > 0) {
      const currentCount = board.cards.filter(c => c.column === targetColumn).length;
      if (currentCount >= col.wipLimit) {
        logger.warn(`[Kanban] WIP制限: ${targetColumn} (${currentCount}/${col.wipLimit})`);
        return false;
      }
    }

    card.column = targetColumn;
    card.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** カード更新 */
  updateCard(boardName: string, cardId: string, updates: Partial<KanbanCard>): boolean {
    const board = this.getBoard(boardName);
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return false;

    Object.assign(card, updates);
    card.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** カード削除 */
  deleteCard(boardName: string, cardId: string): boolean {
    const board = this.getBoard(boardName);
    const idx = board.cards.findIndex(c => c.id === cardId);
    if (idx === -1) return false;
    board.cards.splice(idx, 1);
    this.save();
    return true;
  }

  /** カラム追加 */
  addColumn(boardName: string, id: string, title: string, options?: { wipLimit?: number; color?: string }): boolean {
    const board = this.getBoard(boardName);
    if (board.columns.find(c => c.id === id)) return false;
    board.columns.push({
      id,
      title,
      wipLimit: options?.wipLimit || 0,
      color: options?.color || "gray",
    });
    this.save();
    return true;
  }

  /** カラム削除（カードは全部backlogへ） */
  removeColumn(boardName: string, columnId: string): boolean {
    const board = this.getBoard(boardName);
    const idx = board.columns.findIndex(c => c.id === columnId);
    if (idx === -1 || board.columns.length <= 1) return false;
    board.columns.splice(idx, 1);
    // カードを移動
    for (const card of board.cards) {
      if (card.column === columnId) card.column = board.columns[0]!.id;
    }
    this.save();
    return true;
  }

  /** ボードのテキスト表示 */
  renderBoard(boardName: string = "default"): string {
    const board = this.getBoard(boardName);
    if (board.cards.length === 0) {
      return `**${boardName}**\nカードはありません。\n\nカラム: ${board.columns.map(c => c.title).join(" | ")}`;
    }

    const lines: string[] = [];
    lines.push(`📋 **${boardName} Kanban**`);

    // スイムレーンごとに表示
    const swimlanes = Array.from(new Set(board.cards.map(c => c.swimlane || "default")));
    for (const swimlane of swimlanes) {
      if (swimlane !== "default") {
        lines.push(`\n🏊 **${swimlane}**`);
      }

      for (const col of board.columns) {
        const cards = board.cards.filter(c => c.column === col.id && (c.swimlane || "default") === swimlane);
        if (cards.length === 0) continue;

        const wipInfo = col.wipLimit > 0 ? ` (${cards.length}/${col.wipLimit})` : ` (${cards.length})`;
        lines.push(`\n**${col.title}**${wipInfo}`);

        for (const card of cards) {
          const priorityIcon = card.priority === "urgent" ? "🔴" : card.priority === "high" ? "🟠" : card.priority === "medium" ? "🟢" : "⚪";
          const assigneeInfo = card.assignee ? ` 👤${card.assignee}` : "";
          const tagInfo = card.tags.length > 0 ? ` [${card.tags.join(", ")}]` : "";
          const dueInfo = card.dueDate ? ` 📅${new Date(card.dueDate).toLocaleDateString("ja-JP")}` : "";
          const descPreview = card.description ? `: ${card.description.slice(0, 60)}` : "";
          lines.push(`  ${priorityIcon} \`${card.id.slice(0, 12)}…\` **${card.title}**${descPreview}${assigneeInfo}${tagInfo}${dueInfo}`);
        }
      }
    }

    return lines.join("\n");
  }

  /** 統計 */
  getStats(boardName: string = "default"): Record<string, number> {
    const board = this.getBoard(boardName);
    const stats: Record<string, number> = { total: board.cards.length };
    for (const col of board.columns) {
      stats[col.id] = board.cards.filter(c => c.column === col.id).length;
    }
    stats.urgent = board.cards.filter(c => c.priority === "urgent").length;
    stats.overdue = board.cards.filter(c => c.dueDate && c.dueDate < Date.now() && c.column !== "done").length;
    return stats;
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const kanban = new KanbanEngine(DATA_DIR);
