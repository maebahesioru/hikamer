// ==========================================
// Hikamer - 軌跡圧縮（Hermes Agent trajectory_compressor.py 由来）
// 会話軌跡の圧縮・重要情報抽出・パターン認識
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface TrajectoryEntry {
  step: number;
  type: "thought" | "tool_call" | "tool_result" | "observation" | "response";
  content: string;
  tokens: number;
  timestamp: number;
}

export interface CompressedTrajectory {
  entries: CompressedEntry[];
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  preservedKeys: string[];
}

export interface CompressedEntry {
  step: number;
  type: string;
  summary: string;
  keyFindings: string[];
  redundant: boolean;
}

// ==================== 軌跡圧縮エンジン ====================

class TrajectoryCompressor {
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Trajectory] compressor initialized");
  }

  /** 軌跡を圧縮 */
  async compress(
    entries: TrajectoryEntry[],
    options?: {
      maxTokens?: number;
      preserveLastN?: number;
      aggressive?: boolean;
    }
  ): Promise<CompressedTrajectory> {
    const maxTokens = options?.maxTokens ?? 10000;
    const preserveLast = options?.preserveLastN ?? 3;
    const aggressive = options?.aggressive ?? false;

    const originalTokens = entries.reduce((s, e) => s + e.tokens, 0);

    // 1. 古いツール結果を要約
    // 2. 重複する思考を除去
    // 3. 重要でないステップを削除

    const compressed: CompressedEntry[] = [];
    const preservedKeys: string[] = [];
    const seenContent = new Set<string>();

    // 最新N件は保護
    const protectedEntries = entries.slice(-preserveLast);
    const processEntries = entries.slice(0, -preserveLast);

    for (const entry of processEntries) {
      const key = this.computeKey(entry);

      // 重複チェック
      if (seenContent.has(key) && aggressive) {
        compressed.push({
          step: entry.step,
          type: entry.type,
          summary: `[${entry.type}] (repetitive)`,
          keyFindings: [],
          redundant: true,
        });
        continue;
      }
      seenContent.add(key);

      // 要約
      const summary = entry.content.length > 200
        ? entry.content.slice(0, 200) + "..."
        : entry.content;

      const keyFindings = this.extractKeyFindings(entry.content);

      compressed.push({
        step: entry.step,
        type: entry.type,
        summary,
        keyFindings,
        redundant: false,
      });

      if (keyFindings.length > 0) {
        preservedKeys.push(...keyFindings);
      }
    }

    // 保護エントリを追加
    for (const entry of protectedEntries) {
      compressed.push({
        step: entry.step,
        type: entry.type,
        summary: entry.content,
        keyFindings: this.extractKeyFindings(entry.content),
        redundant: false,
      });
    }

    const compressedTokens = compressed.reduce(
      (s, e) => s + e.summary.length + e.keyFindings.join("").length,
      0
    );

    return {
      entries: compressed,
      originalTokens,
      compressedTokens,
      compressionRatio: compressedTokens > 0 ? originalTokens / compressedTokens : 1,
      preservedKeys: [...new Set(preservedKeys)],
    };
  }

  /** 軌跡から重要な情報を抽出 */
  extractKeyFindings(text: string): string[] {
    const findings: string[] = [];
    const lower = text.toLowerCase();

    // エラー
    if (lower.includes("error") || lower.includes("fail") || lower.includes("exception")) {
      findings.push(`Error: ${text.slice(0, 100)}`);
    }

    // URL
    const urls = text.match(/https?:\/\/[^\s,)]+/g);
    if (urls) findings.push(...urls.slice(0, 3));

    // 数値結果
    const numbers = text.match(/\d+[.,]?\d*%/g);
    if (numbers) findings.push(`Results: ${numbers.slice(0, 3).join(", ")}`);

    // JSON/コードブロック
    if (text.includes("{") && text.includes("}")) {
      findings.push("Contains structured data");
    }

    return findings;
  }

  /** エントリの重複キー */
  private computeKey(entry: TrajectoryEntry): string {
    return `${entry.type}:${entry.content.slice(0, 50)}`;
  }

  formatCompressed(c: CompressedTrajectory): string {
    const redundant = c.entries.filter((e) => e.redundant).length;
    return (
      `📦 **軌跡圧縮**\n` +
      `元: ${(c.originalTokens / 1000).toFixed(1)}K → 圧縮後: ${(c.compressedTokens / 1000).toFixed(1)}K\n` +
      `圧縮率: ${c.compressionRatio.toFixed(1)}x\n` +
      `ステップ: ${c.entries.length} (重複除去: ${redundant})\n` +
      `キーファインディング: ${c.preservedKeys.length}件\n\n` +
      (c.preservedKeys.length > 0
        ? `**重要情報**\n${c.preservedKeys.slice(0, 5).map((k) => `- ${k.slice(0, 80)}`).join("\n")}`
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const trajectoryCompressor = new TrajectoryCompressor();

export default TrajectoryCompressor;
