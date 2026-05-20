// ==========================================
// Hikamer - 埋め込み生成（OpenHuman embeddings由来）
// テキスト→ベクトル変換 + セマンティック検索
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
  text: string;
}

export interface SimilarityResult {
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ==================== 埋め込みエンジン（APIベース） ====================

class EmbeddingEngine {
  private cacheDir: string;
  private cache = new Map<string, number[]>();

  constructor() {
    this.cacheDir = resolve(process.env.DATA_DIR || "./data", "embeddings-cache");
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
    this.loadCache();
  }

  /** テキストをベクトル化 */
  async embed(text: string, model?: string): Promise<EmbeddingResult> {
    const cacheKey = `${model || "default"}:${text.slice(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { vector: cached, model: model || "openai", dimensions: cached.length, text };
    }

    const selectedModel = model || "openai/text-embedding-3-small";
    let vector: number[] | null = null;

    // OpenAI Embeddings
    if (selectedModel.includes("openai")) {
      vector = await this.openAIEmbed(text);
    }

    // フォールバック: 簡易トークン埋め込み（API不要）
    if (!vector) {
      vector = this.fallbackEmbed(text);
    }

    // キャッシュ
    if (vector.length > 0) {
      this.cache.set(cacheKey, vector);
      if (this.cache.size > 1000) {
        // 古いキャッシュを削除
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }

    return { vector, model: selectedModel, dimensions: vector.length, text };
  }

  /** OpenAI Embeddings API */
  private async openAIEmbed(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.slice(0, 8192),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;

      const json = await response.json() as any;
      return json.data?.[0]?.embedding || null;
    } catch (e: any) {
      logger.warn(`[Embed] OpenAI API失敗: ${e.message}`);
      return null;
    }
  }

  /** フォールバック埋め込み（文字n-gramベースの簡易ベクトル） */
  private fallbackEmbed(text: string, dimensions: number = 128): number[] {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, " ");
    const words = normalized.split(/\s+/).filter(Boolean);

    // 文字バイグラムでベクトル化
    const ngrams = new Map<string, number>();
    for (const word of words) {
      for (let i = 0; i < word.length - 1; i++) {
        const ngram = word.slice(i, i + 2);
        ngrams.set(ngram, (ngrams.get(ngram) || 0) + 1);
      }
    }

    // 全ngramをハッシュでdimensions次元にマッピング
    const vector = new Array(dimensions).fill(0);
    for (const [ngram, count] of ngrams) {
      const hash = this.hashStr(ngram);
      const idx = hash % dimensions;
      vector[idx] = (vector[idx] || 0) + count;
    }

    // L2正規化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] = Number((vector[i]! / norm).toFixed(6));
    }

    return vector;
  }

  /** コサイン類似度 */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** テキスト群から類似度順に検索 */
  async searchSimilar(
    query: string,
    candidates: string[],
    topK: number = 5,
  ): Promise<SimilarityResult[]> {
    const queryVec = await this.embed(query);

    const results: SimilarityResult[] = [];
    for (const text of candidates) {
      const docVec = await this.embed(text);
      const score = this.cosineSimilarity(queryVec.vector, docVec.vector);
      results.push({ text, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** バッチ埋め込み */
  async embedBatch(texts: string[], model?: string): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.embed(t, model)));
  }

  /** シンプルなハッシュ関数 */
  private hashStr(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const char = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit
    }
    return Math.abs(hash);
  }

  // ==================== キャッシュ ====================

  private loadCache(): void {
    try {
      const cachePath = resolve(this.cacheDir, "embed-cache.json");
      if (existsSync(cachePath)) {
        const data = JSON.parse(readFileSync(cachePath, "utf-8"));
        for (const [key, vec] of Object.entries(data)) {
          this.cache.set(key, vec as number[]);
        }
        logger.info(`[Embed] キャッシュ復元: ${this.cache.size}件`);
      }
    } catch {}
  }

  saveCache(): void {
    try {
      const data: Record<string, number[]> = {};
      for (const [key, vec] of this.cache) {
        data[key] = vec;
      }
      writeFileSync(resolve(this.cacheDir, "embed-cache.json"), JSON.stringify(data), "utf-8");
    } catch (e: any) {
      logger.warn(`[Embed] キャッシュ保存失敗: ${e.message}`);
    }
  }

  get stats(): { cacheSize: number; dimensions: number } {
    const first = this.cache.values().next().value;
    return {
      cacheSize: this.cache.size,
      dimensions: first?.length || 128,
    };
  }
}

// ==================== シングルトン ====================

export const embedder = new EmbeddingEngine();

// プロセス終了時にキャッシュ保存
process.on("exit", () => embedder.saveCache());
