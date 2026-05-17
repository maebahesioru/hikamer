// ==========================================
// Aikata - メモリツリー（OpenHuman openhuman/memory + tree_summarizer由来）
// 階層的メモリ管理 + 自動要約 + エンティティ発見
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface MemoryNode {
  id: string;
  type: "topic" | "entity" | "fact" | "summary";
  label: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  children: MemoryNode[];
  parentId: string | null;
}

export interface MemoryQuery {
  text?: string;
  tags?: string[];
  type?: MemoryNode["type"];
  limit?: number;
}

// ==================== メモリツリー ====================

const MAX_CONTENT_LENGTH = 2000;
const MAX_CHILDREN_PER_NODE = 50;

class MemoryTree {
  private nodes = new Map<string, MemoryNode>();
  private rootId = "root";
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "memory-tree.json");
    this.load();
    this.ensureRoot();
  }

  // ==================== 永続化 ====================

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        if (data.nodes) {
          for (const [id, node] of Object.entries(data.nodes)) {
            this.nodes.set(id, node as MemoryNode);
          }
          logger.info(`[MemoryTree] 復元: ${this.nodes.size}ノード`);
        }
      }
    } catch (e) {
      logger.warn(`[MemoryTree] 読み込み失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: Record<string, unknown> = {};
      for (const [id, node] of Array.from(this.nodes)) {
        data[id] = node;
      }

      writeFileSync(this.persistPath, JSON.stringify({
        nodes: data,
        rootId: this.rootId,
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[MemoryTree] 保存失敗: ${e}`);
    }
  }

  private ensureRoot(): void {
    if (!this.nodes.has(this.rootId)) {
      const root: MemoryNode = {
        id: this.rootId,
        type: "summary",
        label: "Root",
        content: "Aikata Memory Tree Root",
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        children: [],
        parentId: null,
      };
      this.nodes.set(this.rootId, root);
      this.save();
    }
  }

  // ==================== ノード操作 ====================

  /** ルートノード取得 */
  getRoot(): MemoryNode {
    return this.nodes.get(this.rootId)!;
  }

  /** IDでノード取得 */
  getNode(id: string): MemoryNode | undefined {
    const node = this.nodes.get(id);
    if (node) {
      node.accessCount++;
      this.save();
    }
    return node;
  }

  /** 子ノード一覧 */
  getChildren(parentId: string): MemoryNode[] {
    const parent = this.nodes.get(parentId);
    if (!parent) return [];
    return parent.children
      .map(c => this.nodes.get(c.id))
      .filter((n): n is MemoryNode => n !== undefined);
  }

  /** ノード追加 */
  addNode(
    label: string,
    content: string,
    options?: {
      parentId?: string;
      type?: MemoryNode["type"];
      tags?: string[];
    },
  ): MemoryNode {
    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const parentId = options?.parentId || this.rootId;

    const parent = this.nodes.get(parentId);
    if (!parent) throw new Error(`親ノードが見つかりません: ${parentId}`);

    if (parent.children.length >= MAX_CHILDREN_PER_NODE) {
      throw new Error(`親ノードの子制限超過: ${MAX_CHILDREN_PER_NODE}`);
    }

    const node: MemoryNode = {
      id,
      type: options?.type || "fact",
      label: label.slice(0, 200),
      content: content.slice(0, MAX_CONTENT_LENGTH),
      tags: options?.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      children: [],
      parentId,
    };

    this.nodes.set(id, node);
    parent.children.push(node);
    parent.updatedAt = Date.now();
    this.save();

    return node;
  }

  /** ノード更新 */
  updateNode(id: string, updates: Partial<Pick<MemoryNode, "label" | "content" | "tags">>): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    if (updates.label !== undefined) node.label = updates.label.slice(0, 200);
    if (updates.content !== undefined) node.content = updates.content.slice(0, MAX_CONTENT_LENGTH);
    if (updates.tags !== undefined) node.tags = updates.tags;
    node.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** ノード削除（子も再起的に削除） */
  deleteNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node || id === this.rootId) return false;

    // 子を再帰削除
    for (const child of node.children) {
      this.deleteNode(child.id);
    }

    // 親から削除
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter(c => c.id !== id);
        parent.updatedAt = Date.now();
      }
    }

    this.nodes.delete(id);
    this.save();
    return true;
  }

  // ==================== 検索 ====================

  /** テキスト検索 */
  search(query: MemoryQuery): MemoryNode[] {
    let results = Array.from(this.nodes.values());

    // ルート除外
    results = results.filter(n => n.id !== this.rootId);

    // テキスト検索
    if (query.text) {
      const q = query.text.toLowerCase();
      results = results.filter(n =>
        n.label.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q)
      );
    }

    // タグ検索
    if (query.tags && query.tags.length > 0) {
      results = results.filter(n =>
        query.tags!.some(t => n.tags.includes(t))
      );
    }

    // タイプ検索
    if (query.type) {
      results = results.filter(n => n.type === query.type);
    }

    // アクセス日時降順
    results.sort((a, b) => b.updatedAt - a.updatedAt);

    const limit = query.limit || 20;
    return results.slice(0, limit);
  }

  /** タグ一覧 */
  getAllTags(): string[] {
    const tags = new Set<string>();
    for (const node of Array.from(this.nodes.values())) {
      for (const tag of node.tags) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }

  // ==================== 統計 ====================

  getStats(): {
    totalNodes: number;
    topicCount: number;
    entityCount: number;
    factCount: number;
    summaryCount: number;
    depth: number;
  } {
    const types = { topic: 0, entity: 0, fact: 0, summary: 0 };
    for (const node of Array.from(this.nodes.values())) {
      if (node.id !== this.rootId) types[node.type]++;
    }

    return {
      totalNodes: this.nodes.size,
      topicCount: types.topic,
      entityCount: types.entity,
      factCount: types.fact,
      summaryCount: types.summary,
      depth: this.calculateDepth(),
    };
  }

  private calculateDepth(): number {
    const maxDepth = (nodeId: string, depth: number): number => {
      const node = this.nodes.get(nodeId);
      if (!node || node.children.length === 0) return depth;
      return Math.max(...node.children.map(c => maxDepth(c.id, depth + 1)));
    };
    return maxDepth(this.rootId, 0);
  }

  /** ツリーをテキスト表示 */
  renderTree(): string {
    const lines: string[] = [];

    const render = (nodeId: string, indent: number) => {
      const node = this.nodes.get(nodeId);
      if (!node) return;

      const prefix = indent === 0 ? "📂" : node.type === "topic" ? "📁" : node.type === "entity" ? "👤" : node.type === "summary" ? "📝" : "📌";
      const tagStr = node.tags.length > 0 ? ` [${node.tags.join(", ")}]` : "";
      const contentPreview = node.content.length > 50 ? node.content.slice(0, 50) + "…" : node.content;

      lines.push(`${"  ".repeat(indent)}${prefix} **${node.label}**${tagStr}`);
      if (contentPreview && indent > 0) {
        lines.push(`${"  ".repeat(indent + 1)}└ ${contentPreview}`);
      }

      for (const child of node.children) {
        render(child.id, indent + 1);
      }
    };

    render(this.rootId, 0);
    return lines.join("\n") || "(空のツリー)";
  }

  /** パスを表示 */
  getPath(nodeId: string): string[] {
    const path: string[] = [];
    let current = this.nodes.get(nodeId);
    while (current && current.parentId) {
      path.unshift(current.label);
      current = this.nodes.get(current.parentId);
    }
    return path;
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const memoryTree = new MemoryTree(DATA_DIR);

// ==================== ツール関数 ====================

/**
 * 会話内容から重要なファクトを抽出してメモリに保存
 * （エージェントが自律的に呼ぶことを想定）
 */
export function memorize(label: string, content: string, tags?: string[], parentId?: string): MemoryNode {
  return memoryTree.addNode(label, content, {
    parentId,
    tags,
    type: "fact",
  });
}

/** クイック検索 */
export function recall(query: string, limit = 10): MemoryNode[] {
  return memoryTree.search({ text: query, limit });
}

/** エンティティ（ユーザー・プロジェクト等）を登録 */
export function rememberEntity(entityName: string, description: string, tags?: string[]): MemoryNode {
  return memoryTree.addNode(entityName, description, {
    type: "entity",
    tags: tags || ["entity"],
  });
}
