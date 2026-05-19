// ==========================================
// Aikata - 4階層メモリ統合パイプライン
// 出典: agentmemory (rohitg00/agentmemory) の4-Tier Memory Consolidation
// Working → Episodic → Semantic → Procedural
// v1.59: 3層コンテンツカテゴリ (supermemory由来) + LRUターンキャッシュ
//   ContentCategory: Static(恒久) / Dynamic(最近) / Search(検索結果)
//   これは4-Tierパイプラインと直交する軸
// ==========================================

import { logger } from "./utils/logger";
import { HybridSearch, SearchDocument, getDefaultSearch, tokenEmbedding } from "./hybrid-search";

// ==================== 型定義 ====================

/** メモリ階層（agentmemoryの4-Tierに準拠） */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";

/** コンテンツカテゴリ（supermemory由来: 記憶の鮮度・永続性による分類） */
export type ContentCategory = "static" | "dynamic" | "search";

/** コンテキスト配送モード（paperclip由来） */
export type ContextMode = "thin" | "fat";

/** メモリエントリ */
export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  text: string;
  summary?: string;
  entities?: string[];
  sessionId?: string;
  projectScope?: string;
  confidence: number;        // 0.0 - 1.0
  accessCount: number;
  createdAt: number;         // unix ms
  accessedAt: number;
  importance: number;        // 0.0 - 1.0（agentmemoryのimportanceと同等）
  /** v1.59: コンテンツカテゴリ（4-Tierとは直交） */
  contentCategory: ContentCategory;
  metadata?: Record<string, unknown>;
}

/** パイプライン設定 */
export interface PipelineConfig {
  /** 各階層の最大エントリ数 */
  maxWorking: number;
  maxEpisodic: number;
  maxSemantic: number;
  maxProcedural: number;
  /** 減衰率（1.0 = 減衰なし） */
  decayRate: number;
  /** 減衰半減期（ミリ秒） */
  decayHalfLifeMs: number;
  /** 自動忘却の閾値 */
  forgetThreshold: number;
  /** 統合インターバル（ミリ秒） */
  consolidateIntervalMs: number;
}

const DEFAULT_CONFIG: PipelineConfig = {
  maxWorking: 200,
  maxEpisodic: 100,
  maxSemantic: 500,
  maxProcedural: 100,
  decayRate: 0.9,
  decayHalfLifeMs: 7 * 24 * 60 * 60 * 1000,  // 7日
  forgetThreshold: 0.05,
  consolidateIntervalMs: 30 * 60 * 1000,       // 30分
};

// ==================== メモリパイプライン ====================

export class MemoryPipeline {
  private entries: MemoryEntry[] = [];
  private config: PipelineConfig;
  private searchEngine: HybridSearch;
  private lastConsolidation = 0;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;

  /** v1.59: LRUターンキャッシュ — 同一会話ターン内の重複検索を防止 */
  private turnCache: Map<string, { result: MemoryEntry[]; timestamp: number }> = new Map();
  private turnCacheMaxSize = 100;
  /** 現在のターンID（会話ID。ターンが変わったらキャッシュクリア） */
  private currentTurnId: string | null = null;

  constructor(config?: Partial<PipelineConfig>, search?: HybridSearch) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.searchEngine = search ?? getDefaultSearch();
    this.startAutoConsolidation();
  }

  /** 自動統合を開始 */
  private startAutoConsolidation(): void {
    if (this.consolidationTimer) clearInterval(this.consolidationTimer);
    this.consolidationTimer = setInterval(() => {
      this.consolidate().catch(e => logger.error(`[MemoryPipeline] 自動統合エラー: ${e}`));
    }, this.config.consolidateIntervalMs);
  }

  /** 自動統合を停止 */
  stop(): void {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
  }

  /**
   * 観察を記録（Workingメモリに追加）
   * agentmemory: PostToolUse hook → store raw observation
   */
  async observe(text: string, options?: {
    sessionId?: string;
    projectScope?: string;
    entities?: string[];
    importance?: number;
    contentCategory?: ContentCategory;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: this.generateId(),
      tier: "working",
      text,
      entities: options?.entities,
      sessionId: options?.sessionId,
      projectScope: options?.projectScope,
      confidence: 0.3,
      accessCount: 0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      importance: options?.importance ?? 0.3,
      contentCategory: options?.contentCategory ?? "dynamic",
      metadata: options?.metadata,
    };

    this.entries.push(entry);

    // 検索インデックスに追加
    this.searchEngine.addDocument({
      id: entry.id,
      text: text,
      metadata: { tier: "working", createdAt: entry.createdAt, sessionId: entry.sessionId },
      entities: entry.entities,
      sessionId: entry.sessionId,
    });

    // 上限を超えたら古いものから削除
    this.enforceLimit("working", this.config.maxWorking);

    logger.debug(`[MemoryPipeline] observe: ${text.slice(0, 60)}...`);
    return entry;
  }

  /**
   * ハイブリッド検索（LRUターンキャッシュ付き）
   */
  async search(query: string, limit: number = 10, turnId?: string): Promise<MemoryEntry[]> {
    // v1.59: ターンキャッシュチェック
    const cacheKey = `${turnId || this.currentTurnId || "default"}:${query}:${limit}`;
    const cached = this.turnCache.get(cacheKey);
    if (cached) {
      cached.timestamp = Date.now();
      logger.debug(`[MemoryPipeline] ターンキャッシュヒット: ${query.slice(0, 30)}`);
      return cached.result;
    }

    const results = await this.searchEngine.search(query, { limit });

    // アクセスカウント更新
    const matched = new Set(results.map(r => r.document.id));
    for (const entry of this.entries) {
      if (matched.has(entry.id)) {
        entry.accessCount++;
        entry.accessedAt = Date.now();
      }
    }

    const entries = results
      .map(r => this.entries.find(e => e.id === r.document.id))
      .filter((e): e is MemoryEntry => e !== undefined);

    // キャッシュに保存
    this.turnCache.set(cacheKey, { result: entries, timestamp: Date.now() });
    // LRU: 上限超えたら古いものを削除
    if (this.turnCache.size > this.turnCacheMaxSize) {
      const oldest = [...this.turnCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.turnCache.delete(oldest[0]);
    }

    return entries;
  }

  /** ターン切替: キャッシュをクリア */
  clearTurnCache(newTurnId?: string): void {
    this.turnCache.clear();
    if (newTurnId) this.currentTurnId = newTurnId;
  }

  /**
   * セマンティック検索のショートカット
   */
  async semanticSearch(query: string, limit: number = 10): Promise<MemoryEntry[]> {
    // Working/EpisodicからSemantic/Proceduralへ昇格しているものだけを優先
    const results = await this.search(query, limit);
    return results.filter(r => r.tier === "semantic" || r.tier === "procedural");
  }

  // ==================== 4-Tier 統合パイプライン ====================

  /**
   * メモリ統合を実行
   * agentmemory: consolidate → crystallize
   */
  async consolidate(): Promise<void> {
    const now = Date.now();
    logger.info("[MemoryPipeline] 統合開始...");

    // 1. 減衰を適用
    this.applyDecay();

    // 2. Working → Episodic（セッションサマリーを生成）
    await this.promoteWorkingToEpisodic();

    // 3. Episodic → Semantic（パターン抽出）
    await this.promoteEpisodicToSemantic();

    // 4. Semantic → Procedural（手続き的知識の結晶化）
    await this.promoteSemanticToProcedural();

    // 5. 古いメモリの忘却
    this.forgetStale();

    // 6. 検索インデックスを再構築
    this.rebuildSearchIndex();

    this.lastConsolidation = now;
    logger.info(`[MemoryPipeline] 統合完了。総エントリ数: ${this.entries.length}`);
  }

  /** 減衰を適用（agentmemory: decay curves, Ebbinghaus curve） */
  private applyDecay(): void {
    const now = Date.now();
    for (const entry of this.entries) {
      const age = now - entry.createdAt;
      const halfLives = age / this.config.decayHalfLifeMs;
      // C(t) = C(0) * 0.5^(t/halfLife)
      const decayFactor = Math.pow(0.5, halfLives);

      // アクセスが多いほど減衰しにくい
      const accessBonus = Math.min(entry.accessCount * 0.05, 0.5);
      entry.confidence = Math.max(0, (entry.confidence + accessBonus) * decayFactor);
    }
  }

  /** Working → Episodic への昇格 */
  private async promoteWorkingToEpisodic(): Promise<void> {
    const working = this.entries.filter(e => e.tier === "working");

    // 古いセッションのWorkingメモリをEpisodicに
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const oldWorking = working.filter(e => e.createdAt < oneHourAgo);

    for (const entry of oldWorking) {
      entry.tier = "episodic";
      entry.confidence = Math.min(entry.confidence + 0.1, 1.0);
    }

    // Episodicの上限
    this.enforceLimit("episodic", this.config.maxEpisodic);
  }

  /** Episodic → Semantic への昇格（パターン抽出） */
  private async promoteEpisodicToSemantic(): Promise<void> {
    const episodic = this.entries.filter(e => e.tier === "episodic");

    // 重要度とアクセス頻度が高いものをSemanticに
    const candidates = episodic
      .map(e => ({
        entry: e,
        score: e.importance * 0.5 + Math.min(e.accessCount / 20, 1) * 0.5,
      }))
      .filter(c => c.score > 0.6)
      .sort((a, b) => b.score - a.score);

    for (const { entry } of candidates) {
      entry.tier = "semantic";
      entry.confidence = Math.min(entry.confidence + 0.2, 1.0);
    }

    // Semanticの上限
    this.enforceLimit("semantic", this.config.maxSemantic);
  }

  /** Semantic → Procedural への昇格（agentmemory: crystallize） */
  private async promoteSemanticToProcedural(): Promise<void> {
    const semantic = this.entries.filter(e => e.tier === "semantic");

    // 非常に高いアクセス頻度・重要度のものをProceduralに
    const candidates = semantic
      .map(e => ({
        entry: e,
        score: e.importance * 0.4 + Math.min(e.accessCount / 50, 1) * 0.4 + e.confidence * 0.2,
      }))
      .filter(c => c.score > 0.8)
      .sort((a, b) => b.score - a.score);

    for (const { entry } of candidates) {
      entry.tier = "procedural";
      entry.confidence = Math.min(entry.confidence + 0.3, 1.0);
    }

    // Proceduralの上限
    this.enforceLimit("procedural", this.config.maxProcedural);
  }

  /** 古いメモリを忘却（agentmemory: auto-forgetting, TTL expiry） */
  private forgetStale(): void {
    const before = this.entries.length;

    this.entries = this.entries.filter(entry => {
      const score = entry.confidence * 0.4 +
        Math.min(entry.accessCount / 10, 1) * 0.3 +
        entry.importance * 0.3;
      return score > this.config.forgetThreshold;
    });

    const forgotten = before - this.entries.length;
    if (forgotten > 0) {
      logger.info(`[MemoryPipeline] ${forgotten}件のメモリを忘却`);
    }
  }

  /** 検索インデックスを再構築 */
  private rebuildSearchIndex(): void {
    const docs: SearchDocument[] = this.entries.map(entry => ({
      id: entry.id,
      text: entry.summary || entry.text,
      metadata: {
        tier: entry.tier,
        confidence: entry.confidence,
        createdAt: entry.createdAt,
        importance: entry.importance,
      },
      entities: entry.entities,
      sessionId: entry.sessionId,
    }));

    this.searchEngine.setDocuments(docs);
    logger.debug(`[MemoryPipeline] 検索インデックス再構築: ${docs.length}件`);
  }

  // ==================== コンテキスト注入 ====================

  /**
   * トークン予算内でコンテキストブロックを生成
   * agentmemory: mem::context → token-budget-respecting context block
   * v1.59: Thin/Fatモード（paperclip由来）
   *   thin = IDとメタデータのみ（最小トークン）
   *   fat  = 全文を含む（従来通り、デフォルト）
   */
  async getContextBlock(
    query: string,
    tokenBudget: number = 2000,
    contextMode: ContextMode = "fat",
  ): Promise<string> {
    const results = await this.search(query, 20);

    // 優先度: procedural > semantic > episodic > working
    const prioritized = results.sort((a, b) => {
      const tierOrder = { procedural: 4, semantic: 3, episodic: 2, working: 1 };
      const aTier = tierOrder[a.tier] || 0;
      const bTier = tierOrder[b.tier] || 0;
      if (aTier !== bTier) return bTier - aTier;
      return b.confidence - a.confidence;
    });

    // Thin モード: ID + メタデータのみ
    if (contextMode === "thin") {
      const thinParts: string[] = [];
      for (const entry of prioritized.slice(0, 15)) {
        thinParts.push(
          `[${entry.tier.toUpperCase()}][${entry.contentCategory}] ` +
          `${(entry.confidence * 100).toFixed(0)}% ${entry.id} ${(entry.summary || entry.text).slice(0, 80)}`
        );
      }
      return `<memory_context mode="thin">\n${thinParts.join("\n")}\n</memory_context>`;
    }

    // Fat モード: 全文（従来通り）
    const parts: string[] = [];
    let totalTokens = 0;

    for (const entry of prioritized) {
      const text = entry.summary || entry.text;
      const estimatedTokens = Math.ceil(text.length / 3);

      if (totalTokens + estimatedTokens > tokenBudget) break;

      parts.push(`【${entry.tier.toUpperCase()}】【${entry.contentCategory}】${text}`);
      totalTokens += estimatedTokens;
    }

    if (parts.length === 0) return "";

    return `<memory_context>\n${parts.join("\n\n")}\n</memory_context>`;
  }

  // ==================== ユーティリティ ====================

  /** 特定階層の上限を強制 */
  private enforceLimit(tier: MemoryTier, max: number): void {
    const tierEntries = this.entries
      .map((e, i) => ({ entry: e, index: i }))
      .filter(e => e.entry.tier === tier)
      .sort((a, b) => {
        // 古いもの・重要度が低いものを優先削除
        const aScore = a.entry.importance + Math.min(a.entry.accessCount / 10, 1);
        const bScore = b.entry.importance + Math.min(b.entry.accessCount / 10, 1);
        return aScore - bScore;
      });

    while (tierEntries.length > max) {
      const oldest = tierEntries.shift();
      if (oldest) {
        this.entries.splice(oldest.index, 1);
      }
    }
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 全エントリを取得 */
  getAllEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  /** 特定階層のエントリ数を取得 */
  getTierCount(tier: MemoryTier): number {
    return this.entries.filter(e => e.tier === tier).length;
  }

  /** ペルシスタンス用にデータをエクスポート */
  exportData(): MemoryEntry[] {
    return this.entries;
  }

  /** データをインポート */
  importData(entries: MemoryEntry[]): void {
    this.entries = entries;
    this.rebuildSearchIndex();
  }

  /** 手動で操作: セマンティックメモリに直接追加（agentmemory: rememberと同等） */
  async remember(text: string, options?: {
    entities?: string[];
    importance?: number;
    projectScope?: string;
    contentCategory?: ContentCategory;
  }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: this.generateId(),
      tier: "semantic",
      text,
      entities: options?.entities,
      confidence: 0.7,
      accessCount: 0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      importance: options?.importance ?? 0.7,
      contentCategory: options?.contentCategory ?? "static",
      metadata: { source: "manual" },
      projectScope: options?.projectScope,
    };

    this.entries.push(entry);

    this.searchEngine.addDocument({
      id: entry.id,
      text,
      metadata: { tier: "semantic", createdAt: entry.createdAt, importance: entry.importance },
      entities: entry.entities,
    });

    return entry;
  }
}

// デフォルトインスタンス
let defaultPipeline: MemoryPipeline | null = null;

export function getDefaultPipeline(): MemoryPipeline {
  if (!defaultPipeline) {
    defaultPipeline = new MemoryPipeline();
  }
  return defaultPipeline;
}

export function resetDefaultPipeline(): void {
  if (defaultPipeline) {
    defaultPipeline.stop();
    defaultPipeline = null;
  }
}
