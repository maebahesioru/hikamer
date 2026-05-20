// ==========================================
// Hikamer - ツリー要約（OpenHuman tree_summarizer/ 由来）
// 会話ツリーの階層的要約・圧縮
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface TreeNode {
  id: string;
  parentId: string | null;
  content: string;
  summary: string;
  depth: number;
  children: TreeNode[];
  tokenCount: number;
  createdAt: number;
}

export interface TreeSummary {
  rootSummary: string;
  nodeCount: number;
  depth: number;
  totalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  summariesByLevel: Record<number, string[]>;
}

export interface SummarizeOptions {
  maxTokensPerNode?: number;
  maxDepth?: number;
  model?: string;
}

// ==================== ツリー要約エンジン ====================

class TreeSummarizer {
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[TreeSummarizer] initialized");
  }

  /** テキストを階層的に要約 */
  async summarizeHierarchical(
    text: string,
    options?: SummarizeOptions
  ): Promise<TreeSummary> {
    const maxTokens = options?.maxTokensPerNode ?? 2000;
    const maxDepth = options?.maxDepth ?? 3;

    // テキストをチャンクに分割
    const chunks = this.chunkText(text, maxTokens);
    const tree = this.buildTree(chunks);

    // 各ノードを要約
    await this.summarizeTree(tree, options);

    // 統計
    const totalTokens = text.length;
    const compressedTokens = tree.summary.length;

    return {
      rootSummary: tree.summary,
      nodeCount: this.countNodes(tree),
      depth: this.maxDepth(tree),
      totalTokens,
      compressedTokens,
      compressionRatio: compressedTokens > 0 ? totalTokens / compressedTokens : 1,
      summariesByLevel: this.groupByLevel(tree),
    };
  }

  /** テキストをセクションに分割 */
  private chunkText(text: string, maxTokens: number): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);

    let current = "";
    for (const p of paragraphs) {
      if ((current.length + p.length) > maxTokens && current.length > 0) {
        chunks.push(current.trim());
        current = p;
      } else {
        current += (current ? "\n\n" : "") + p;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks.length > 0 ? chunks : [text];
  }

  /** チャンクからツリーを構築 */
  private buildTree(chunks: string[]): TreeNode {
    const root: TreeNode = {
      id: "root",
      parentId: null,
      content: "",
      summary: "",
      depth: 0,
      children: [],
      tokenCount: 0,
      createdAt: Date.now(),
    };

    for (let i = 0; i < chunks.length; i++) {
      const node: TreeNode = {
        id: `node-${i}`,
        parentId: "root",
        content: chunks[i]!,
        summary: "",
        depth: 1,
        children: [],
        tokenCount: chunks[i]!.length,
        createdAt: Date.now(),
      };
      root.children.push(node);
    }

    root.tokenCount = root.children.reduce((s, c) => s + c.tokenCount, 0);
    return root;
  }

  /** ツリーを再帰的に要約 */
  private async summarizeTree(
    node: TreeNode,
    options?: SummarizeOptions
  ): Promise<void> {
    for (const child of node.children) {
      await this.summarizeNode(child, options);
    }

    // 子ノードの要約を集約
    if (node.children.length > 0) {
      const childSummaries = node.children
        .filter((c) => c.summary)
        .map((c) => c.summary);

      if (childSummaries.length > 0) {
        node.summary = childSummaries.join("\n");
      } else {
        node.summary = `[${node.children.length}セクション]`;
      }
    }
  }

  /** 単一ノードを要約 */
  private async summarizeNode(
    node: TreeNode,
    options?: SummarizeOptions
  ): Promise<void> {
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;

    if (!apiKey || node.content.length < 200) {
      // APIがないか短い場合はそのまま
      node.summary = node.content.slice(0, 200);
      return;
    }

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
            model: options?.model ?? "deepseek/deepseek-v4-flash",
            messages: [
              {
                role: "system",
                content: "以下のテキストを簡潔に要約してください。重要なポイントのみ30-50文字で。",
              },
              { role: "user", content: node.content.slice(0, 3000) },
            ],
            temperature: 0.1,
            max_tokens: 100,
          }),
        }
      );

      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        node.summary = data.choices?.[0]?.message?.content?.trim() ?? node.content.slice(0, 200);
      } else {
        node.summary = node.content.slice(0, 200);
      }
    } catch {
      node.summary = node.content.slice(0, 200);
    }
  }

  /** ノード数をカウント */
  private countNodes(node: TreeNode): number {
    return 1 + node.children.reduce((s, c) => s + this.countNodes(c), 0);
  }

  /** 最大深さ */
  private maxDepth(node: TreeNode, currentDepth = 0): number {
    if (node.children.length === 0) return currentDepth + 1;
    return Math.max(...node.children.map((c) => this.maxDepth(c, currentDepth + 1)));
  }

  /** レベル別にグループ化 */
  private groupByLevel(node: TreeNode): Record<number, string[]> {
    const groups: Record<number, string[]> = {};
    this.collectByLevel(node, 0, groups);
    return groups;
  }

  private collectByLevel(node: TreeNode, depth: number, groups: Record<number, string[]>): void {
    if (!groups[depth]) groups[depth] = [];
    if (node.summary) groups[depth]!.push(node.summary);
    for (const child of node.children) {
      this.collectByLevel(child, depth + 1, groups);
    }
  }

  formatSummary(summary: TreeSummary): string {
    return (
      `🌳 **ツリー要約**\n` +
      `ノード数: ${summary.nodeCount}\n` +
      `深さ: ${summary.depth}\n` +
      `元のサイズ: ${(summary.totalTokens / 1000).toFixed(1)}K文字\n` +
      `圧縮後: ${(summary.compressedTokens / 1000).toFixed(1)}K文字\n` +
      `圧縮率: ${summary.compressionRatio.toFixed(1)}x\n\n` +
      `**要約**\n${summary.rootSummary.slice(0, 500)}` +
      (summary.rootSummary.length > 500 ? "..." : "")
    );
  }
}

// ==================== シングルトン ====================

export const treeSummarizer = new TreeSummarizer();

export default TreeSummarizer;
