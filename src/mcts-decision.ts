// ==========================================
// Aikata - MCTS戦略的意思決定エンジン
// 出典: Scenario Lab (YSLAB-ai/scenario-lab) MCTS Engine
// 探索 + スコアリング + 枝刈り + 最適経路選択
// ==========================================

import { logger } from "./utils/logger";

// ==================== MCTSノード ====================

interface MCTSNode {
  id: string;
  state: string;           // 現在の状態記述
  parentId: string | null;
  children: MCTSNode[];
  visits: number;
  value: number;           // 累積報酬
  score: number;           // UCB1スコア
  depth: number;
  isFullyExpanded: boolean;
}

// ==================== MCTS設定 ====================

interface MCTSConfig {
  maxIterations: number;
  maxDepth: number;
  explorationConstant: number; // UCB1用。デフォルト√2
  timeLimitMs: number;
}

const DEFAULT_CONFIG: MCTSConfig = {
  maxIterations: 50,
  maxDepth: 10,
  explorationConstant: 1.414, // √2
  timeLimitMs: 30000, // 30秒
};

// ==================== MCTSエンジン ====================

class MCTSEngine {
  private config: MCTSConfig;
  private nodes = new Map<string, MCTSNode>();
  private nextId = 1;
  private scoreFn: (state: string) => number = () => 0.5;
  private transitionFn: (state: string, action: string) => string = (s, a) => `${s} → ${a}`;
  private actionFn: (state: string) => string[] = () => ["continue", "stop", "explore"];

  constructor(config?: Partial<MCTSConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * スコア関数を設定
   */
  setScoreFunction(fn: (state: string) => number): void {
    this.scoreFn = fn;
  }

  /**
   * 状態遷移関数を設定
   */
  setTransitionFunction(fn: (state: string, action: string) => string): void {
    this.transitionFn = fn;
  }

  /**
   * 行動生成関数を設定
   */
  setActionFunction(fn: (state: string) => string[]): void {
    this.actionFn = fn;
  }

  /**
   * 最適な経路を探索
   * Scenario Lab MCTS: propose → sample → score → select
   */
  search(initialState: string): { bestPath: string[]; bestScore: number; iterations: number; nodesExplored: number } {
    const root = this.createNode(null, initialState, 0);
    const startTime = Date.now();

    let iterations = 0;
    while (iterations < this.config.maxIterations) {
      // 時間制限チェック
      if (Date.now() - startTime > this.config.timeLimitMs) break;

      // 1. Selection: UCB1で最適ノードを選択
      let node = root;
      while (node.isFullyExpanded && node.children.length > 0) {
        node = this.selectBestChild(node);
      }

      // 2. Expansion: 未探索の行動を追加
      if (!node.isFullyExpanded && node.depth < this.config.maxDepth) {
        const actions = this.actionFn(node.state);
        const unexpanded = actions.filter(a =>
          !node.children.some(c => c.state.endsWith(a))
        );

        if (unexpanded.length > 0 && unexpanded[0]) {
          const action = unexpanded[0];
          const newState = this.transitionFn(node.state, action);
          const child = this.createNode(node, newState, node.depth + 1);
          node.children.push(child);
          node = child;
        } else {
          node.isFullyExpanded = true;
        }
      }

      // 3. Simulation: ランダムプレイアウト
      const reward = this.simulate(node);

      // 4. Backpropagation: 報酬を親に伝播
      this.backpropagate(node, reward);

      iterations++;
    }

    // 最適経路を抽出
    const result = this.extractBestPath(root);

    return {
      bestPath: result.path,
      bestScore: result.score,
      iterations,
      nodesExplored: this.nodes.size,
    };
  }

  /** ノード作成 */
  private createNode(parent: MCTSNode | null, state: string, depth: number): MCTSNode {
    const node: MCTSNode = {
      id: `mcts-${this.nextId++}`,
      state,
      parentId: parent?.id || null,
      children: [],
      visits: 0,
      value: 0,
      score: 0,
      depth,
      isFullyExpanded: false,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /** UCB1で最適な子ノードを選択 */
  private selectBestChild(node: MCTSNode): MCTSNode {
    let bestChild: MCTSNode | null = null;
    let bestUCB = -Infinity;

    for (const child of node.children) {
      if (child.visits === 0) return child;

      const exploitation = child.value / child.visits;
      const exploration = this.config.explorationConstant *
        Math.sqrt(Math.log(node.visits + 1) / child.visits);
      const ucb = exploitation + exploration;

      if (ucb > bestUCB) {
        bestUCB = ucb;
        bestChild = child;
      }
    }

    return bestChild || node.children[0] || node;
  }

  /** ランダムシミュレーション（ロールアウト） */
  private simulate(node: MCTSNode): number {
    let currentState = node.state;
    let depth = node.depth;
    const maxSimDepth = 20;

    while (depth < this.config.maxDepth && depth < maxSimDepth) {
      const actions = this.actionFn(currentState);
      if (actions.length === 0) break;

      // ランダムに行動を選択
      const action = actions[Math.floor(Math.random() * actions.length)]!;
      currentState = this.transitionFn(currentState, action);
      depth++;
    }

    return this.scoreFn(currentState);
  }

  /** 報酬をルートまで伝播 */
  private backpropagate(node: MCTSNode, reward: number): void {
    let current: MCTSNode | undefined = node;
    while (current) {
      current.visits++;
      current.value += reward;
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
  }

  /** 最適経路を抽出 */
  private extractBestPath(root: MCTSNode): { path: string[]; score: number } {
    const path: string[] = [root.state];
    let current = root;
    let totalReward = root.value / Math.max(root.visits, 1);

    while (current.children.length > 0) {
      let bestChild: MCTSNode | null = null;
      let bestScore = -Infinity;

      for (const child of current.children) {
        const avgReward = child.value / Math.max(child.visits, 1);
        if (avgReward > bestScore) {
          bestScore = avgReward;
          bestChild = child;
        }
      }

      if (!bestChild) break;
      current = bestChild;
      totalReward = current.value / Math.max(current.visits, 1);
      path.push(current.state);
    }

    return { path, score: totalReward };
  }

  /** 全ノードをリセット */
  reset(): void {
    this.nodes.clear();
    this.nextId = 1;
  }
}

export { MCTSEngine, MCTSConfig };
