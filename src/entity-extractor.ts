// ==========================================
// Aikata - Entity-Relation Graph Extractor (v1.65)
// 出典: LightRAG (hkuds/lightrag) — entity-relationship extraction pattern
// ドキュメントからエンティティと関係を抽出し、グラフ検索を強化
// hybrid-search.ts の CodeGraph と統合
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface ExtractedEntity {
  name: string;
  type: string;       // "person", "organization", "concept", "technology", "event", "location"
  description: string;
  sourceChunkIds: string[];
  confidence: number; // 0-1
}

export interface ExtractedRelation {
  source: string;     // 主語エンティティ名
  target: string;     // 目的語エンティティ名
  relation: string;   // 関係の種類（例: "CREATED_BY", "DEPENDS_ON", "PART_OF"）
  description: string;
  sourceChunkIds: string[];
  confidence: number;
}

export interface EntityGraph {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  chunkCount: number;
  extractedAt: number;
}

// ==================== プロンプトテンプレート ====================

const EXTRACTION_PROMPT = `Extract entities and relationships from the text below.
Return a JSON object with:
- "entities": array of {name, type, description}
  - type must be one of: person, organization, concept, technology, event, location
- "relations": array of {source, target, relation, description}
  - relation: how source relates to target (e.g., CREATED_BY, DEPENDS_ON, PART_OF, USES, LOCATED_IN)

Rules:
- Only extract clearly mentioned entities
- entity name must be concise (1-5 words)
- Only create relations between extracted entities
- Skip vague or generic entities

Text:
{text}

JSON:`;

// ==================== エンティティ抽出エンジン ====================

class EntityGraphExtractor {
  private entities: Map<string, ExtractedEntity> = new Map();
  private relations: ExtractedRelation[] = [];
  private chunkCount = 0;

  /**
   * テキストからエンティティと関係を抽出（簡易版: キーワードベース）
   * 本格的なLLM抽出は extractWithLLM() を使用
   */
  extractKeywords(text: string, chunkId?: string): EntityGraph {
    const cid = chunkId || `chunk_${this.chunkCount++}`;

    // 簡易キーワード抽出（正規表現ベース）
    // 大文字で始まる2語以上のフレーズを候補に
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    const acronyms = text.match(/\b[A-Z]{2,6}\b/g) || [];
    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
    const mentions = text.match(/@[a-zA-Z0-9_]+/g) || [];
    const hashtags = text.match(/#[a-zA-Z0-9_]+/g) || [];

    // 技術用語（一般的なものを検出）
    const techTerms = text.match(
      /\b(TypeScript|JavaScript|Python|Rust|React|Node\.js|API|REST|GraphQL|Docker|Kubernetes|SQL|NoSQL|Redis|MongoDB|PostgreSQL|AWS|GCP|Azure|Linux|macOS|Windows|Git|GitHub)\b/gi
    ) || [];

    const allCandidates = [
      ...properNouns,
      ...acronyms.filter(a => a.length >= 3), // 2文字の略語はノイズ
      ...techTerms,
    ];

    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    for (const candidate of allCandidates) {
      const normalized = candidate.trim();
      if (normalized.length < 2 || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());

      // 既存エンティティとマージ or 新規作成
      const existing = this.entities.get(normalized);
      if (existing) {
        if (!existing.sourceChunkIds.includes(cid)) {
          existing.sourceChunkIds.push(cid);
        }
        existing.confidence = Math.min(existing.confidence + 0.1, 1.0);
        entities.push(existing);
      } else {
        const entity: ExtractedEntity = {
          name: normalized,
          type: this.guessType(normalized),
          description: `Extracted from text`,
          sourceChunkIds: [cid],
          confidence: 0.3,
        };
        this.entities.set(normalized, entity);
        entities.push(entity);
      }
    }

    // 簡易関係抽出: 近接するエンティティ間にCO_OCCURS関係を作成
    const relations: ExtractedRelation[] = [];
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        relations.push({
          source: entities[i]!.name,
          target: entities[j]!.name,
          relation: "CO_OCCURS",
          description: `Co-mentioned in chunk ${cid}`,
          sourceChunkIds: [cid],
          confidence: 0.2,
        });
      }
    }

    this.relations.push(...relations);

    // 重複関係のマージ
    this.deduplicateRelations();

    return {
      entities,
      relations,
      chunkCount: this.chunkCount,
      extractedAt: Date.now(),
    };
  }

  /**
   * LLMを使って高精度なエンティティ・関係抽出
   * 呼び出し側でLLM APIにプロンプトを送信する
   */
  buildExtractionPrompt(text: string): string {
    return EXTRACTION_PROMPT.replace("{text}", text.slice(0, 15000));
  }

  /**
   * LLMの抽出結果をグラフにマージ
   */
  mergeLLMResult(result: EntityGraph, chunkId?: string): void {
    const cid = chunkId || `chunk_${this.chunkCount++}`;

    for (const entity of result.entities) {
      const existing = this.entities.get(entity.name);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, entity.confidence);
        existing.type = entity.type || existing.type;
        existing.description = entity.description || existing.description;
        if (!existing.sourceChunkIds.includes(cid)) {
          existing.sourceChunkIds.push(cid);
        }
      } else {
        this.entities.set(entity.name, {
          ...entity,
          sourceChunkIds: [cid],
        });
      }
    }

    for (const rel of result.relations) {
      this.relations.push({
        ...rel,
        sourceChunkIds: [cid],
      });
    }

    this.deduplicateRelations();
    logger.info(`[EntityGraph] LLM抽出マージ: ${result.entities.length} entities, ${result.relations.length} relations`);
  }

  /**
   * エンティティ名でグラフ検索（1-hop）
   */
  searchByEntity(name: string): {
    entity: ExtractedEntity | null;
    related: { entity: ExtractedEntity; relation: ExtractedRelation }[];
  } {
    const entity = this.entities.get(name);
    const related: { entity: ExtractedEntity; relation: ExtractedRelation }[] = [];

    if (!entity) return { entity: null, related: [] };

    for (const rel of this.relations) {
      if (rel.source === name) {
        const target = this.entities.get(rel.target);
        if (target) related.push({ entity: target, relation: rel });
      } else if (rel.target === name) {
        const source = this.entities.get(rel.source);
        if (source) related.push({ entity: source, relation: rel });
      }
    }

    return { entity, related };
  }

  /**
   * キーワードでエンティティを検索
   */
  searchEntities(query: string, limit: number = 10): ExtractedEntity[] {
    const lower = query.toLowerCase();
    const results: ExtractedEntity[] = [];

    for (const entity of this.entities.values()) {
      if (
        entity.name.toLowerCase().includes(lower) ||
        entity.type.toLowerCase().includes(lower) ||
        entity.description.toLowerCase().includes(lower)
      ) {
        results.push(entity);
      }
    }

    // confidence × 出現チャンク数 でソート
    results.sort((a, b) => {
      const aScore = a.confidence * a.sourceChunkIds.length;
      const bScore = b.confidence * b.sourceChunkIds.length;
      return bScore - aScore;
    });

    return results.slice(0, limit);
  }

  /** 全エンティティを取得 */
  getAllEntities(): ExtractedEntity[] {
    return [...this.entities.values()];
  }

  /** 全関係を取得 */
  getAllRelations(): ExtractedRelation[] {
    return [...this.relations];
  }

  /** 統計 */
  getStats(): { entityCount: number; relationCount: number; chunkCount: number } {
    return {
      entityCount: this.entities.size,
      relationCount: this.relations.length,
      chunkCount: this.chunkCount,
    };
  }

  formatStats(): string {
    const s = this.getStats();
    return `🕸️ **エンティティグラフ**\n` +
      `エンティティ: ${s.entityCount} | 関係: ${s.relationCount} | チャンク: ${s.chunkCount}`;
  }

  formatEntity(entity: ExtractedEntity): string {
    const related = this.searchByEntity(entity.name);
    return [
      `🔹 **${entity.name}** (${entity.type})`,
      `  confidence: ${(entity.confidence * 100).toFixed(0)}%`,
      `  chunks: ${entity.sourceChunkIds.length}`,
      entity.description ? `  ${entity.description.slice(0, 100)}` : "",
      related.related.length > 0
        ? `  関連: ${related.related.map(r => r.entity.name).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");
  }

  /** リセット */
  reset(): void {
    this.entities.clear();
    this.relations = [];
    this.chunkCount = 0;
  }

  private guessType(name: string): ExtractedEntity["type"] {
    if (/Inc\.?$|Corp\.?$|Ltd\.?$|LLC$|株式会社/.test(name)) return "organization";
    if (/^@/.test(name)) return "person";
    if (/^https?:/.test(name)) return "location";
    if (/^(AWS|GCP|Azure|API|SDK|CLI|IDE|OS)$/i.test(name)) return "technology";
    if (/TypeScript|JavaScript|Python|Rust|React|Node|Docker|Kubernetes/i.test(name)) return "technology";
    return "concept";
  }

  private deduplicateRelations(): void {
    const seen = new Set<string>();
    const filtered: ExtractedRelation[] = [];

    for (const rel of this.relations) {
      const key = `${rel.source}::${rel.relation}::${rel.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push(rel);
    }

    this.relations = filtered;
  }
}

// ==================== シングルトン ====================

export const entityGraph = new EntityGraphExtractor();
export default EntityGraphExtractor;
