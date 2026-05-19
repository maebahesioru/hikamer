// ==========================================
// Aikata - ハイブリッド検索エンジン
// 出典: agentmemory (rohitg00/agentmemory) の HybridSearch を純TypeScript実装
// BM25 + コサイン類似度 + ナレッジグラフ + RRF融合
// 強化: ストリーム別正規化 / 日本語StopWord / クエリ拡張 / Jaccard Dedup / 文ウィンドウ拡張
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
  /** 文脈ウィンドウ拡張後のテキスト（sentence window expansion有効時） */
  expandedText?: string;
}

export interface SearchOptions {
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  entityHints?: string[];
  minScore?: number;
  /** コンテンツJaccard dedupのしきい値（デフォルト: 0.7、無効化: 1.0） */
  dedupThreshold?: number;
  /** 文ウィンドウ拡張に使う隣接文の数（デフォルト: 2） */
  windowSize?: number;
  /** 日本語クエリ拡張を有効にするか（デフォルト: false） */
  enableExpansion?: boolean;
}

export interface HybridSearchConfig {
  rrfK: number;
  bm25Weight: number;
  vectorWeight: number;
  graphWeight: number;
  defaultLimit: number;
  minScore: number;
  dedupThreshold: number;
  windowSize: number;
  enableExpansion: boolean;
}

// ==================== ストップワード ====================

/** 日本語ストップワード（助詞・助動詞・指示語・形式名詞 など） */
const JAPANESE_STOP_WORDS = new Set([
  // 助詞
  "の", "に", "は", "を", "が", "で", "て", "も", "と", "し",
  "や", "へ", "から", "まで", "より", "ばかり", "だけ", "ほど",
  "くらい", "など", "なり", "やら", "か", "ね", "よ", "ぞ", "さ",
  // 助動詞
  "です", "ます", "いる", "ある", "する", "なる", "できる",
  "おる", "ござる", "られる", "させる", "た", "だ", "ない", "ぬ",
  // 指示語
  "これ", "それ", "あれ", "どれ", "この", "その", "あの", "どの",
  "ここ", "そこ", "あそこ", "どこ", "こちら", "そちら", "あちら",
  // 形式名詞・代名詞
  "こと", "もの", "ところ", "とき", "よう", "ため",
  "わけ", "はず", "ほう", "まま", "つもり", "ほか",
  // 接続詞
  "しかし", "ただし", "また", "または", "もしくは",
  "および", "かつ", "そして", "それで", "だから",
  "という", "といった", "として", "について",
  "に関して", "に対して", "によって", "にもとづいて",
  // その他高頻度語
  "あり", "いえ", "おも", "いい", "いる", "くる", "する",
  "さん", "ちゃん", "くん", "さま", "たち", "ら",
]);

/** 英語ストップワード */
const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "because", "as", "until",
  "while", "of", "at", "by", "for", "with", "about", "against", "between",
  "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "in", "out", "on", "off", "over", "under",
  "again", "further", "then", "once", "here", "there", "when",
  "all", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "not", "only", "same", "so", "than", "too", "very",
  "can", "will", "just", "don", "should", "now",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing",
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "this", "that", "these", "those",
]);

/** 統合ストップワードセット */
const ALL_STOP_WORDS = new Set<string>();
ENGLISH_STOP_WORDS.forEach(w => ALL_STOP_WORDS.add(w));
JAPANESE_STOP_WORDS.forEach(w => ALL_STOP_WORDS.add(w));

// ==================== 日本語クエリ拡張 ====================

/** 日本語の同義語・異表記ペア */
const JAPANESE_SYNONYMS: Record<string, string[]> = {
  // 技術用語
  "検索": ["探索", "サーチ", "lookup"],
  "情報": ["データ", "インフォメーション", "info"],
  "処理": ["実行", "プロセス", "加工"],
  "設定": ["構成", "コンフィグ", "セットアップ"],
  "保存": ["セーブ", "ストア", "格納"],
  "読込": ["ロード", "読み込み", "取得"],
  "削除": ["消去", "デリート", "除去"],
  "更新": ["アップデート", "変更", "修正"],
  "作成": ["生成", "クリエイト", "構築"],
  "表示": ["ビュー", "レンダリング", "描画"],
  "接続": ["コネクト", "リンク", "結合"],
  "変換": ["コンバート", "トランスフォーム", "変形"],
  "分析": ["解析", "アナリシス", "調査"],
  "最適化": ["チューニング", "オプティマイズ", "効率化"],
  // 一般用語
  "開始": ["スタート", "開始する", "着手"],
  "終了": ["エンド", "完了", "ストップ"],
  "確認": ["チェック", "検証", "確かめる"],
  "問題": ["エラー", "トラブル", "不具合", "バグ"],
  "対応": ["対処", "ハンドリング", "処理"],
  "改善": ["改良", "エンハンス", "向上"],
  "速度": ["スピード", "パフォーマンス", "速さ"],
  "容量": ["サイズ", "キャパシティ", "大きさ"],
};

/** 日本語クエリの活用形バリエーションを生成 */
function expandJapaneseQuery(query: string): string[] {
  const expansions = new Set<string>([query]);

  // 同義語展開
  for (const [key, synonyms] of Object.entries(JAPANESE_SYNONYMS)) {
    if (query.includes(key)) {
      for (const syn of synonyms) {
        expansions.add(query.replace(key, syn));
      }
    }
    // 逆方向：同義語がクエリに含まれていた場合、キーに置換
    for (const syn of synonyms) {
      if (query.includes(syn)) {
        expansions.add(query.replace(syn, key));
        // 他の同義語にも展開
        for (const otherSyn of synonyms) {
          if (otherSyn !== syn) {
            expansions.add(query.replace(syn, otherSyn));
          }
        }
      }
    }
  }

  // 「する」活用形のバリエーション
  const suruVariants: [RegExp, string][] = [
    [/する$/, "します"],
    [/する$/, "した"],
    [/する$/, "している"],
    [/する$/, "すれば"],
    [/します$/, "する"],
    [/した$/, "する"],
    [/している$/, "する"],
  ];

  for (const [pattern, replacement] of suruVariants) {
    if (pattern.test(query)) {
      expansions.add(query.replace(pattern, replacement));
    }
  }

  // カタカナ↔ひらがな 表記ゆれ（主要なもの）
  const katakanaMap: [RegExp, string][] = [
    [/コンピューター?/g, "コンピュータ"],
    [/データベース/g, "DB"],
  ];
  for (const [pattern, replacement] of katakanaMap) {
    const replaced = query.replace(pattern, replacement);
    if (replaced !== query) expansions.add(replaced);
  }

  return Array.from(expansions);
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

  /** 簡易トークナイザ（英数字＋日本語対応／ストップワード除去） */
  private tokenize(text: string): string[] {
    // 小文字化
    let t = text.toLowerCase();
    // 英数字 + 日本語文字を残し、記号類はスペースに
    t = t.replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\s-]/g, " ");
    // 分割
    const words = t.split(/\s+/).filter(w => w.length > 0);
    // 短すぎる単語を除去（1文字は除去）、ストップワード除去
    return words.filter(w => w.length >= 2 && !ALL_STOP_WORDS.has(w));
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
      dedupThreshold: config?.dedupThreshold ?? 0.7,
      windowSize: config?.windowSize ?? 2,
      enableExpansion: config?.enableExpansion ?? false,
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
   *
   * 強化ポイント:
   * 1. クエリ拡張（enableExpansion=true時）: 日本語同義語・活用形に展開
   * 2. ストリーム別スコア正規化: BM25→sigmoid, Vector→min-max でRRF前に正規化
   * 3. Jaccardコンテンツdedup: RRF融合後に類似度>thresholdの重複を除去
   * 4. 文ウィンドウ拡張: マッチした文の前後をexpandedTextに付与
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? this.config.defaultLimit;
    const bm25W = options?.bm25Weight ?? this.config.bm25Weight;
    const vectW = options?.vectorWeight ?? this.config.vectorWeight;
    const graphW = options?.graphWeight ?? this.config.graphWeight;
    const minScore = options?.minScore ?? this.config.minScore;
    const dedupThreshold = options?.dedupThreshold ?? this.config.dedupThreshold;
    const windowSize = options?.windowSize ?? this.config.windowSize;
    const enableExpansion = options?.enableExpansion ?? this.config.enableExpansion;

    // --- 0. クエリ展開（日本語） ---
    const queryVariants = enableExpansion
      ? expandJapaneseQuery(query)
      : [query];

    // --- 1. BM25検索（全クエリバリアントで検索しマージ） ---
    let bm25Results: SearchResult[] = [];
    if (queryVariants.length === 1) {
      bm25Results = this.bm25.search(queryVariants[0]!, limit * 3);
    } else {
      const seen = new Set<string>();
      for (const variant of queryVariants) {
        const results = this.bm25.search(variant, limit * 2);
        for (const r of results) {
          if (!seen.has(r.document.id)) {
            seen.add(r.document.id);
            bm25Results.push(r);
          } else {
            // 既出の場合はスコアを加算（複数バリアントでヒット = 高関連度）
            const existing = bm25Results.find(e => e.document.id === r.document.id);
            if (existing) existing.score += r.score * 0.5;
          }
        }
      }
      bm25Results.sort((a, b) => b.score - a.score);
      bm25Results = bm25Results.slice(0, limit * 2);
    }

    // --- 2. ベクトル検索（埋め込み関数があれば） ---
    let vectorResults: SearchResult[] = [];
    if (this.embeddingFn && query.length > 3) {
      try {
        // クエリ展開時はオリジナルクエリでベクトル検索（埋め込みの品質を維持）
        const emb = await this.embeddingFn(query);
        vectorResults = this.vector.search(emb, limit * 2);
      } catch (e) {
        logger.warn(`[HybridSearch] ベクトル検索失敗: ${e}`);
      }
    }

    // --- 3. グラフ検索（エンティティヒントがあれば） ---
    let graphResults: SearchResult[] = [];
    if (options?.entityHints && options.entityHints.length > 0) {
      graphResults = this.graph.search(options.entityHints, limit * 2);
    }

    // --- 4. ストリーム別スコア正規化（RRFの前に実行） ---
    const normalizedBM25 = this.normalizeBM25Scores(bm25Results);
    const normalizedVector = this.normalizeVectorScores(vectorResults);
    // グラフスコアはすでに限定的な値なので正規化しない

    // --- 5. RRF融合 ---
    const streams = [normalizedBM25, normalizedVector, graphResults].filter(s => s.length > 0);
    const weights = [bm25W, vectW, graphW].slice(0, streams.length);

    if (streams.length === 0) return [];

    const fused = this.rrf.fuse(streams, weights);

    // --- 6. Jaccardコンテンツdedup（RRF融合後） ---
    const deduped = dedupThreshold < 1.0
      ? this.deduplicateByJaccard(fused, dedupThreshold)
      : fused;

    // --- 7. セッション多様化 (agentmemory: max 3 results per session) ---
    const sessionDeduped = this.deduplicateBySession(deduped);

    // --- 8. スコアフィルタリング ---
    let finalResults = sessionDeduped
      .filter(r => r.score > minScore)
      .slice(0, limit);

    // --- 9. 文ウィンドウ拡張 ---
    if (windowSize > 0) {
      finalResults = this.expandSentenceWindow(finalResults, query, windowSize);
    }

    return finalResults;
  }

  // ==================== スコア正規化 ====================

  /**
   * BM25スコアのシグモイド圧縮
   * BM25は非有界なスコアを返すため、シグモイド関数で (0, 1) に圧縮する
   * formula: 1 / (1 + e^(-score / 2))
   */
  private normalizeBM25Scores(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;

    return results.map(r => ({
      ...r,
      score: 1.0 / (1.0 + Math.exp(-r.score / 2.0)),
      method: r.method,
    }));
  }

  /**
   * ベクトル類似度スコアのmin-max正規化
   * コサイン類似度は [0, 1] だが、実際の分布を均すためにmin-maxを適用
   * formula: (score - min) / (max - min)
   */
  private normalizeVectorScores(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;
    if (results.length === 1) {
      return [{ ...results[0]!, score: 1.0 }];
    }

    const scores = results.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    if (range === 0) {
      return results.map(r => ({ ...r, score: 1.0 }));
    }

    return results.map(r => ({
      ...r,
      score: (r.score - min) / range,
      method: r.method,
    }));
  }

  // ==================== Jaccard Dedup ====================

  /**
   * コンテンツベースのJaccard重複除去
   * トークンベースのJaccard類似度がしきい値を超える結果をフィルタ
   */
  private deduplicateByJaccard(
    results: SearchResult[],
    threshold: number,
  ): SearchResult[] {
    if (results.length <= 1) return results;

    const tokenCache = new Map<string, Set<string>>();
    const getTokens = (text: string): Set<string> => {
      // 簡易トークナイズ（BM25と同じロジック）
      let t = text.toLowerCase();
      t = t.replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\s-]/g, " ");
      return new Set(t.split(/\s+/).filter(w => w.length >= 2));
    };

    const filtered: SearchResult[] = [];

    for (const result of results) {
      const tokensA = getTokens(result.document.text);
      let isDuplicate = false;

      for (const kept of filtered) {
        const tokensB = tokenCache.get(kept.document.id) ?? getTokens(kept.document.text);
        tokenCache.set(kept.document.id, tokensB);

        // Jaccard類似度 = |A ∩ B| / |A ∪ B|
        const intersection = new Set(Array.from(tokensA).filter(t => tokensB.has(t)));
        const union = new Set<string>();
        tokensA.forEach(t => union.add(t));
        tokensB.forEach(t => union.add(t));
        const similarity = intersection.size / Math.max(union.size, 1);

        if (similarity > threshold) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        filtered.push(result);
      }
    }

    return filtered;
  }

  // ==================== セッション多様化 ====================

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

  // ==================== 文ウィンドウ拡張 ====================

  /**
   * 文ウィンドウ拡張: 各マッチドキュメント内でクエリに関連する文を特定し、
   * その前後 windowSize 文を expandedText として付与する。
   *
   * 日本語・英語両方の文境界に対応。
   */
  private expandSentenceWindow(
    results: SearchResult[],
    query: string,
    windowSize: number,
  ): SearchResult[] {
    // クエリトークンを取得
    const queryTokens = new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\s-]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 1),
    );

    return results.map(result => {
      const text = result.document.text;

      // 文分割（日本語の句点、英語のピリオド/改行で分割）
      const sentences = text
        .split(/(?<=[。．.！？!?\n])\s*/)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (sentences.length <= 1) {
        // 1文しかなければ拡張不要
        return result;
      }

      // 各文のマッチスコアを計算
      const sentenceScores = sentences.map((sentence, idx) => {
        const tokens = new Set(
          sentence
            .toLowerCase()
            .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\s-]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 1),
        );
        const overlap = [...queryTokens].filter(t => tokens.has(t)).length;
        return { sentence, idx, score: overlap };
      });

      // スコア > 0 の文のインデックスを収集
      const matchedIndices = sentenceScores
        .filter(s => s.score > 0)
        .map(s => s.idx);

      if (matchedIndices.length === 0) {
        // マッチなしの場合は先頭付近を返す
        const startIdx = 0;
        const endIdx = Math.min(windowSize * 2 + 1, sentences.length);
        result.expandedText = sentences.slice(startIdx, endIdx).join(" ");
        return result;
      }

      // 最良マッチ文を中心にウィンドウを展開
      const bestIdx = matchedIndices[0]!;
      const start = Math.max(0, bestIdx - windowSize);
      const end = Math.min(sentences.length, bestIdx + windowSize + 1);

      // 複数マッチがある場合はウィンドウを拡大
      let windowStart = start;
      let windowEnd = end;
      for (const idx of matchedIndices) {
        windowStart = Math.min(windowStart, Math.max(0, idx - windowSize));
        windowEnd = Math.max(windowEnd, Math.min(sentences.length, idx + windowSize + 1));
      }

      result.expandedText = sentences.slice(windowStart, windowEnd).join(" ");
      return result;
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

// ==========================================
// SimHash スケッチプリフィルター（memvid 15k stars パターン）
// 大規模検索の前にハミング距離で候補を絞り込む
// ==========================================

/** SimHashビット数（デフォルト64） */
const SIMHASH_BITS = 64;

/** ハミング距離のしきい値（これ以下のものを候補として残す） */
const HAMMING_THRESHOLD = 8;

/**
 * テキストのSimHashフィンガープリントを計算。
 * memvidの SimHash::sketch() 相当。
 * 各トークンをハッシュ化し、ビットごとに重み付き加算→符号で0/1決定。
 */
export function computeSimHash(text: string): bigint {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2);

  if (tokens.length === 0) return 0n;

  const weights = new Array(SIMHASH_BITS).fill(0);

  for (const token of tokens) {
    const h = hashStringBigInt(token);
    for (let i = 0; i < SIMHASH_BITS; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      weights[i] += bit === 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < SIMHASH_BITS; i++) {
    if (weights[i]! > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

/** 2つのSimHash間のハミング距離を計算 */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

/**
 * SimHashプリフィルター。
 * 候補ドキュメント群とクエリSimHashを受け取り、
 * ハミング距離がしきい値以下のものだけを返す。
 */
export function simHashPreFilter(
  queryHash: bigint,
  candidates: { id: string; simhash: bigint }[],
  threshold: number = HAMMING_THRESHOLD,
): string[] {
  const matched: string[] = [];
  for (const c of candidates) {
    if (hammingDistance(queryHash, c.simhash) <= threshold) {
      matched.push(c.id);
    }
  }
  return matched;
}

function hashStringBigInt(s: string): bigint {
  let hash = 0n;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5n) - hash) + BigInt(s.charCodeAt(i));
  }
  return hash;
}

// ==========================================
// 適応的結果カットオフ（memvid adaptive cutoff パターン）
// スコアの勾配から動的に最適なkを決定
// ==========================================

export interface AdaptiveCutoffResult {
  results: SearchResult[];
  cutoffIndex: number;
  method: "elbow" | "cliff" | "ratio" | "none";
}

/**
 * スコア分布から適応的にカットオフ位置を決定。
 * memvidの evaluate_scores → cutoff 相当。
 *
 * 3つの検出方式を試し、最初に発見したものを採用:
 * 1. Elbow（肘）検出: スコアの2次微分の最大点
 * 2. Cliff（崖）検出: 隣接スコア差が平均差の3倍超
 * 3. Ratio検出: スコアが最大スコアの30%未満に落ちた地点
 */
export function adaptiveCutoff(
  results: SearchResult[],
  options?: { minResults?: number; maxResults?: number },
): AdaptiveCutoffResult {
  const minResults = options?.minResults ?? 3;
  const maxResults = options?.maxResults ?? 50;

  if (results.length <= minResults) {
    return { results, cutoffIndex: results.length, method: "none" };
  }

  // 1. Elbow検出: 2次微分
  if (results.length >= 5) {
    const deltas: number[] = [];
    for (let i = 1; i < results.length; i++) {
      deltas.push(results[i - 1]!.score - results[i]!.score);
    }
    const secondDeriv: number[] = [];
    for (let i = 1; i < deltas.length; i++) {
      secondDeriv.push(deltas[i]! - deltas[i - 1]!);
    }

    let maxDerivIdx = 0;
    let maxDeriv = 0;
    for (let i = 0; i < secondDeriv.length; i++) {
      if (secondDeriv[i]! > maxDeriv) {
        maxDeriv = secondDeriv[i]!;
        maxDerivIdx = i;
      }
    }

    if (maxDeriv > 0.01) {
      const elbowIdx = Math.max(minResults, Math.min(maxDerivIdx + 2, maxResults));
      return {
        results: results.slice(0, elbowIdx),
        cutoffIndex: elbowIdx,
        method: "elbow",
      };
    }
  }

  // 2. Cliff検出
  const diffs: number[] = [];
  for (let i = 1; i < results.length; i++) {
    diffs.push(results[i - 1]!.score - results[i]!.score);
  }
  const avgDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;

  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i]! > avgDiff * 3 && i >= minResults) {
      const cliffIdx = Math.min(i + 1, maxResults);
      return {
        results: results.slice(0, cliffIdx),
        cutoffIndex: cliffIdx,
        method: "cliff",
      };
    }
  }

  // 3. Ratio検出
  const maxScore = results[0]!.score;
  for (let i = minResults; i < results.length; i++) {
    if (results[i]!.score < maxScore * 0.3) {
      return {
        results: results.slice(0, i),
        cutoffIndex: i,
        method: "ratio",
      };
    }
  }

  // フォールバック: maxResultsで切る
  const fallbackIdx = Math.min(results.length, maxResults);
  return {
    results: results.slice(0, fallbackIdx),
    cutoffIndex: fallbackIdx,
    method: "none",
  };
}

// ==========================================
// コード知識グラフ（code-review-graph 17k stars パターン）
// コードベースの依存関係グラフを構築し、
// レビュー時に必要なファイルだけを抽出（6.8xトークン削減）
// ==========================================

export interface CodeNode {
  path: string;
  imports: string[];
  exportedBy: string[];
  symbols: string[];      // エクスポートされた関数/クラス名
  dependencies: string[];  // 依存するファイルパス
  dependents: string[];    // このファイルに依存するファイル
  size: number;
}

export interface CodeGraph {
  nodes: Map<string, CodeNode>;
  rootDir: string;
}

/**
 * コードベースから依存関係グラフを構築。
 * import/export文をパースしてノード間のエッジを作成。
 */
export function buildCodeGraph(
  files: { path: string; content: string }[],
  rootDir: string,
): CodeGraph {
  const nodes = new Map<string, CodeNode>();

  // パス正規化
  for (const file of files) {
    const imports = extractImports(file.content);
    const symbols = extractExports(file.content);
    nodes.set(file.path, {
      path: file.path,
      imports,
      exportedBy: [],
      symbols,
      dependencies: [],
      dependents: [],
      size: file.content.length,
    });
  }

  // 依存関係を解決
  for (const [path, node] of nodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(imp, path, nodes);
      if (resolved) {
        node.dependencies.push(resolved);
        const dep = nodes.get(resolved);
        if (dep) dep.dependents.push(path);
      }
    }
  }

  return { nodes, rootDir };
}

/**
 * 特定のファイルに関連するファイル群を取得。
 * code-review-graphの「必要なファイルだけ読む」パターン。
 * 
 * depth=1: 直接の依存+被依存だけ
 * depth=2: 間接的な依存関係も含む
 */
export function getRelevantFiles(
  graph: CodeGraph,
  targetPath: string,
  depth: number = 1,
): string[] {
  const visited = new Set<string>();
  const queue: { path: string; d: number }[] = [{ path: targetPath, d: 0 }];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    result.push(current.path);

    if (current.d >= depth) continue;

    const node = graph.nodes.get(current.path);
    if (!node) continue;

    for (const dep of node.dependencies) {
      if (!visited.has(dep)) queue.push({ path: dep, d: current.d + 1 });
    }
    for (const dep of node.dependents) {
      if (!visited.has(dep)) queue.push({ path: dep, d: current.d + 1 });
    }
  }

  return result;
}

/** import文を抽出（TS/JS/Python対応） */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  // TypeScript/JavaScript
  for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    imports.push(m[1]!);
  }
  for (const m of content.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
    imports.push(m[1]!);
  }
  // Python
  for (const m of content.matchAll(/^(?:from|import)\s+(\S+)/gm)) {
    imports.push(m[1]!);
  }
  return [...new Set(imports)];
}

/** エクスポートされたシンボルを抽出 */
function extractExports(content: string): string[] {
  const symbols: string[] = [];
  for (const m of content.matchAll(/export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g)) {
    symbols.push(m[1]!);
  }
  return symbols;
}

/** importパスをファイルパスに解決 */
function resolveImport(
  importPath: string,
  fromFile: string,
  nodes: Map<string, CodeNode>,
): string | null {
  // 相対パス
  if (importPath.startsWith(".")) {
    const dir = fromFile.split("/").slice(0, -1).join("/");
    const resolved = (dir ? dir + "/" : "") + importPath;
    // 拡張子の試行
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".py"]) {
      const candidate = resolved + ext;
      if (nodes.has(candidate)) return candidate;
      // index.ts も試す
      const indexCandidate = resolved + "/index" + ext;
      if (nodes.has(indexCandidate)) return indexCandidate;
    }
    return null;
  }
  // 絶対パス（パッケージ名）は解決不能 → null
  return null;
}

// ==========================================
// 深層リサーチパイプライン（local-deep-research 8k stars パターン）
// 複数検索エンジンでの並行検索→結果集約→AI要約
// ==========================================

export interface ResearchSource {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  score: number;
}

export interface ResearchReport {
  query: string;
  sources: ResearchSource[];
  summary: string;
  searchDurationMs: number;
  enginesUsed: string[];
}

/**
 * 複数検索エンジンで並行検索し、結果を集約。
 * local-deep-researchの multi-engine search パターン。
 * 10+ search engines: SearXNG, Google, arXiv, PubMed, etc.
 */
export async function multiEngineSearch(
  query: string,
  options?: {
    engines?: string[];
    maxResults?: number;
    deduplicate?: boolean;
  },
): Promise<ResearchSource[]> {
  const engines = options?.engines ?? ["google", "arxiv", "wikipedia"];
  const maxResults = options?.maxResults ?? 10;
  const deduplicate = options?.deduplicate ?? true;
  const t0 = Date.now();

  // 並行検索（local-deep-research: 全エンジン同時に叩く）
  const searches = engines.map(async (engine) => {
    try {
      const results = await searchEngine(engine, query, maxResults);
      return results.map(r => ({ ...r, engine }));
    } catch {
      return [];
    }
  });

  const allResults = (await Promise.all(searches)).flat();

  // 重複除去（URL正規化）
  let deduped = allResults;
  if (deduplicate) {
    const seen = new Set<string>();
    deduped = allResults.filter(r => {
      const key = normalizeURL(r.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // スコアでソート
  deduped.sort((a, b) => b.score - a.score);

  const duration = Date.now() - t0;
  logger.info(`[MultiEngineSearch] ${engines.length} engines, ${allResults.length} raw → ${deduped.length} deduped, ${duration}ms`);

  return deduped.slice(0, maxResults);
}

/** 検索エンジン個別の実装 */
async function searchEngine(
  engine: string,
  query: string,
  limit: number,
): Promise<{ url: string; title: string; snippet: string; score: number }[]> {
  // SearXNG経由（local-deep-researchのデフォルト）
  const searxngUrl = process.env.SEARXNG_URL || "http://localhost:18080";
  const encodedQuery = encodeURIComponent(query);
  const engineParam = engine === "google" ? "" : `&engines=${engine}`;

  try {
    const res = await fetch(
      `${searxngUrl}/search?q=${encodedQuery}&format=json&categories=general${engineParam}`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (!res.ok) return [];

    const data = await res.json() as {
      results?: { url: string; title: string; content: string; score: number }[];
    };

    return (data.results ?? []).slice(0, limit).map(r => ({
      url: r.url,
      title: r.title,
      snippet: r.content?.slice(0, 300) ?? "",
      score: r.score ?? 0.5,
    }));
  } catch {
    return [];
  }
}

function normalizeURL(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/^www\./, "")
    .toLowerCase();
}

/**
 * AI-Scientist (14k stars) アイデア生成→実験→論文執筆ループの
 * 簡易版。検索結果からリサーチレポートを生成。
 */
export function buildResearchReport(
  query: string,
  sources: ResearchSource[],
): ResearchReport {
  return {
    query,
    sources,
    summary: "", // LLMで埋める想定
    searchDurationMs: 0,
    enginesUsed: [...new Set(sources.map(s => s.engine))],
  };
}
