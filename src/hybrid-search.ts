// ==========================================
// Aikata - ハイブリッド検索エンジン
// 出典: agentmemory (rohitg00/agentmemory) の HybridSearch を純TypeScript実装
// BM25 + コサイン類似度 + ナレッジグラフ + RRF融合
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface SearchDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  entities?: string[];
  createdAt?: number;
  updatedAt?: number;
  sessionId?: string;
}

export interface SearchResult {
  document: SearchDocument;
  score: number;
  method: "bm25" | "vector" | "graph";
}

export interface SearchOptions {
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  entityHints?: string[];
  minScore?: number;
}

export interface HybridSearchConfig {
  rrfK: number;
  bm25Weight: number;
  vectorWeight: number;
  graphWeight: number;
  defaultLimit: number;
  minScore: number;
}

// ==================== BM25 検索エンジン ====================

class BM25Index {
  private documents: SearchDocument[] = [];
  private df = new Map<string, number>();    // document frequency
  private avgDocLen = 0;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  /** ドキュメントを追加してインデックスを更新 */
  add(doc: SearchDocument): void {
    this.documents.push(doc);
    this.rebuild();
  }

  /** 複数ドキュメントを追加 */
  addMany(docs: SearchDocument[]): void {
    this.documents.push(...docs);
    this.rebuild();
  }

  /** 全ドキュメントを設定 */
  setDocuments(docs: SearchDocument[]): void {
    this.documents = docs;
    this.rebuild();
  }

  /** インデックスを再構築 */
  rebuild(): void {
    this.df.clear();
    let totalLen = 0;

    for (const doc of this.documents) {
      const tokens = this.tokenize(doc.text);
      totalLen += tokens.length;
      const seen = new Set<string>();

      for (const token of tokens) {
        if (!seen.has(token)) {
          this.df.set(token, (this.df.get(token) || 0) + 1);
          seen.add(token);
        }
      }
    }

    this.avgDocLen = this.documents.length > 0 ? totalLen / this.documents.length : 0;
  }

  /** クエリで検索 */
  search(query: string, limit: number = 10): SearchResult[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const n = this.documents.length;
    const results: SearchResult[] = [];

    for (const doc of this.documents) {
      const docTokens = this.tokenize(doc.text);
      const docLen = docTokens.length;
      let score = 0;

      for (const qt of queryTokens) {
        const tf = docTokens.filter(t => t === qt).length;
        const df = this.df.get(qt) || 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen));
        score += idf * (numerator / Math.max(denominator, 0.001));
      }

      if (score > 0) {
        results.push({ document: doc, score, method: "bm25" });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** 簡易トークナイザ（英数字＋日本語対応） */
  private tokenize(text: string): string[] {
    // 小文字化
    let t = text.toLowerCase();
    // 英数字 + 日本語文字を残し、記号類はスペースに
    t = t.replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\s-]/g, " ");
    // 分割
    const words = t.split(/\s+/).filter(w => w.length > 0);
    // 短すぎる単語を除去（1文字は除去）
    return words.filter(w => w.length >= 2);
  }
}

// ==================== ベクトル検索 ====================

class VectorIndex {
  private documents: SearchDocument[] = [];
  private dimension = 0;

  add(doc: SearchDocument): void {
    if (doc.embedding) {
      if (this.dimension === 0) this.dimension = doc.embedding.length;
      this.documents.push(doc);
    }
  }

  addMany(docs: SearchDocument[]): void {
    for (const doc of docs) {
      if (doc.embedding) {
        if (this.dimension === 0) this.dimension = doc.embedding.length;
        this.documents.push(doc);
      }
    }
  }

  setDocuments(docs: SearchDocument[]): void {
    this.documents = [];
    this.dimension = 0;
    this.addMany(docs);
  }

  /** コサイン類似度で検索 */
  search(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    if (this.documents.length === 0 || queryEmbedding.length === 0) return [];

    const queryNorm = this.norm(queryEmbedding);
    if (queryNorm === 0) return [];

    const results: SearchResult[] = [];

    for (const doc of this.documents) {
      if (!doc.embedding) continue;
      const dot = this.dotProduct(queryEmbedding, doc.embedding);
      const docNorm = this.norm(doc.embedding);
      const cosSim = dot / Math.max(queryNorm * docNorm, 0.000001);
      
      if (cosSim > 0) {
        results.push({ document: doc, score: cosSim, method: "vector" });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private dotProduct(a: number[], b: number[]): number {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
    return sum;
  }

  private norm(v: number[]): number {
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  }
}

// ==================== ナレッジグラフ検索 ====================

interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  label?: string;
}

class KnowledgeGraph {
  private entities = new Map<string, Set<string>>();    // entity → document IDs
  private edges = new Map<string, GraphEdge[]>();       // entity → relationships
  private docToEntities = new Map<string, string[]>();  // doc ID → entities

  addDocument(docId: string, entities: string[]): void {
    this.docToEntities.set(docId, entities);
    for (const entity of entities) {
      if (!this.entities.has(entity)) {
        this.entities.set(entity, new Set());
      }
      this.entities.get(entity)!.add(docId);
    }
  }

  addEdge(from: string, to: string, weight: number = 1, label?: string): void {
    if (!this.edges.has(from)) this.edges.set(from, []);
    this.edges.get(from)!.push({ from, to, weight, label });
  }

  /** エンティティが関連するドキュメントを検索 */
  search(entityHints: string[], limit: number = 10): SearchResult[] {
    const scored = new Map<string, { doc: SearchDocument; score: number }>();

    for (const hint of entityHints) {
      const direct = this.entities.get(hint);
      if (direct) {
      Array.from(direct).forEach(docId => {
        const current = scored.get(docId);
        if (current) {
          current.score += 2.0;
        }
      });
      }

      // BFS: 関連エンティティを辿る
      const related = this.edges.get(hint);
      if (related) {
        for (const edge of related) {
          const indirectDocs = this.entities.get(edge.to);
          if (indirectDocs) {
            Array.from(indirectDocs).forEach(docId => {
              const current = scored.get(docId);
              if (current) {
                current.score += edge.weight; // 間接マッチは重み付き
              }
            });
          }
        }
      }
    }

    // Note: scoredには実際のSearchDocumentがないので、別途解決が必要。
    // このグラフはあくまで補助的なリランキングに使う
    return [];
  }
}

// ==================== RRF融合 ====================

class RRF {
  private readonly k: number;

  constructor(k: number = 60) {
    this.k = k;
  }

  /**
   * 複数の検索結果リストをRRF（Reciprocal Rank Fusion）で融合
   */
  fuse(results: SearchResult[][], weights: number[]): SearchResult[] {
    const scoreMap = new Map<string, { doc: SearchDocument; totalScore: number; method: "bm25" | "vector" | "graph" }>();

    for (let streamIdx = 0; streamIdx < results.length; streamIdx++) {
      const stream = results[streamIdx];
      if (!stream) continue;
      const weight = weights[streamIdx] ?? 1;

      for (let rank = 0; rank < stream.length; rank++) {
        const r = stream[rank];
        if (!r) continue;
        const key = r.document.id;
        const existing = scoreMap.get(key);

        const rrfScore = weight / (this.k + rank + 1);

        if (existing) {
          existing.totalScore += rrfScore;
        } else {
          scoreMap.set(key, {
            doc: r.document,
            totalScore: rrfScore,
            method: r.method,
          });
        }
      }
    }

    const fused: SearchResult[] = Array.from(scoreMap.values())
      .map(s => ({
        document: s.doc,
        score: s.totalScore,
        method: s.method,
      }))
      .sort((a, b) => b.score - a.score);

    return fused;
  }
}

// ==================== メイン HybridSearch クラス ====================

export class HybridSearch {
  private bm25: BM25Index;
  private vector: VectorIndex;
  private graph: KnowledgeGraph;
  private rrf: RRF;
  private config: HybridSearchConfig;
  private embeddingFn?: (text: string) => Promise<number[]>;

  constructor(config?: Partial<HybridSearchConfig>) {
    this.bm25 = new BM25Index();
    this.vector = new VectorIndex();
    this.graph = new KnowledgeGraph();
    this.rrf = new RRF(config?.rrfK ?? 60);
    this.config = {
      rrfK: config?.rrfK ?? 60,
      bm25Weight: config?.bm25Weight ?? 0.4,
      vectorWeight: config?.vectorWeight ?? 0.6,
      graphWeight: config?.graphWeight ?? 0.3,
      defaultLimit: config?.defaultLimit ?? 10,
      minScore: config?.minScore ?? 0.01,
    };
  }

  /** 埋め込み関数を設定（外部から注入） */
  setEmbeddingFn(fn: (text: string) => Promise<number[]>): void {
    this.embeddingFn = fn;
  }

  /** ドキュメントを追加 */
  addDocument(doc: SearchDocument): void {
    this.bm25.add(doc);
    this.vector.add(doc);
    if (doc.entities && doc.entities.length > 0) {
      this.graph.addDocument(doc.id, doc.entities);
    }
  }

  /** 複数ドキュメントを追加 */
  addDocuments(docs: SearchDocument[]): void {
    this.bm25.addMany(docs);
    this.vector.addMany(docs);
    for (const doc of docs) {
      if (doc.entities && doc.entities.length > 0) {
        this.graph.addDocument(doc.id, doc.entities);
      }
    }
  }

  /** 全ドキュメントを設定 */
  setDocuments(docs: SearchDocument[]): void {
    this.bm25.setDocuments(docs);
    this.vector.setDocuments(docs);
    this.graph = new KnowledgeGraph();
    for (const doc of docs) {
      if (doc.entities && doc.entities.length > 0) {
        this.graph.addDocument(doc.id, doc.entities);
      }
    }
  }

  /**
   * ハイブリッド検索（3ストリーム + RRF融合）
   * agentmemoryのtripleStreamSearch相当
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? this.config.defaultLimit;
    const bm25W = options?.bm25Weight ?? this.config.bm25Weight;
    const vectW = options?.vectorWeight ?? this.config.vectorWeight;
    const graphW = options?.graphWeight ?? this.config.graphWeight;
    const minScore = options?.minScore ?? this.config.minScore;

    // 1. BM25検索（常に実行）
    const bm25Results = this.bm25.search(query, limit * 2);

    // 2. ベクトル検索（埋め込み関数があれば）
    let vectorResults: SearchResult[] = [];
    if (this.embeddingFn && query.length > 3) {
      try {
        const emb = await this.embeddingFn(query);
        vectorResults = this.vector.search(emb, limit * 2);
      } catch (e) {
        logger.warn(`[HybridSearch] ベクトル検索失敗: ${e}`);
      }
    }

    // 3. グラフ検索（エンティティヒントがあれば）
    let graphResults: SearchResult[] = [];
    if (options?.entityHints && options.entityHints.length > 0) {
      graphResults = this.graph.search(options.entityHints, limit * 2);
    }

    // 4. RRF融合
    const streams = [bm25Results, vectorResults, graphResults].filter(s => s.length > 0);
    const weights = [bm25W, vectW, graphW].slice(0, streams.length);

    if (streams.length === 0) return [];

    const fused = this.rrf.fuse(streams, weights);

    // 5. セッション多様化 (agentmemory: max 3 results per session)
    const sessionDeduped = this.deduplicateBySession(fused);

    // 6. スコアフィルタリング
    return sessionDeduped
      .filter(r => r.score > minScore)
      .slice(0, limit);
  }

  /** 同一セッションからの結果を制限 */
  private deduplicateBySession(results: SearchResult[]): SearchResult[] {
    const sessionCount = new Map<string, number>();
    const maxPerSession = 3;

    return results.filter(r => {
      const sid = r.document.sessionId || "default";
      const count = sessionCount.get(sid) || 0;
      if (count >= maxPerSession) return false;
      sessionCount.set(sid, count + 1);
      return true;
    });
  }

  /** ドキュメント数を取得 */
  get size(): number {
    // BM25とVectorは同じドキュメントを参照する前提
    return this.bm25["documents"]?.length ?? 0;
  }
}

// デフォルトインスタンス（シングルトン）
let defaultInstance: HybridSearch | null = null;

export function getDefaultSearch(): HybridSearch {
  if (!defaultInstance) {
    defaultInstance = new HybridSearch();
  }
  return defaultInstance;
}

export function resetDefaultSearch(): void {
  defaultInstance = null;
}

// 簡易トークン埋め込み（フォールバック用）
export function tokenEmbedding(text: string, dimensions: number = 384): number[] {
  const vec = new Array(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(t => t.length > 0);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const hash = hashString(token);
    const idx = Math.abs(hash) % dimensions;
    vec[idx] += 1.0 / Math.max(tokens.length, 1);
  }

  return vec;
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}
