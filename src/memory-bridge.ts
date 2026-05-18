// ==========================================
// Aikata - メモリブリッジ（拡張版memory.ts）
// 既存のFrozen Snapshot方式 + agentmemoryのハイブリッド検索 + 4-Tierパイプライン
// 後方互換性を維持しつつ強化
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getDefaultPipeline, MemoryPipeline, MemoryTier } from "./memory-pipeline";
import { getDefaultSearch, HybridSearch } from "./hybrid-search";
import { logger } from "./utils/logger";

// ==================== パス設定（既存互換） ====================

const MEMORY_DIR = resolve(process.env.DATA_DIR || "./data", "memory");
const MEMORY_FILE = resolve(MEMORY_DIR, "MEMORY.md");
const USER_FILE = resolve(MEMORY_DIR, "USER.md");
const PIPELINE_FILE = resolve(MEMORY_DIR, "pipeline.json");

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readFileSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeFileSafe(path: string, content: string): void {
  ensureDir();
  writeFileSync(path, content, "utf-8");
}

// ==================== 既存API（後方互換） ====================

/** エージェントメモリを取得（Frozen Snapshot） */
export function getAgentMemory(): string {
  return readFileSafe(MEMORY_FILE);
}

/** ユーザープロファイルを取得 */
export function getUserProfile(): string {
  return readFileSafe(USER_FILE);
}

/** エージェントメモリを更新 */
export function writeAgentMemory(content: string): void {
  writeFileSafe(MEMORY_FILE, content);
}

/** ユーザープロファイルを更新 */
export function writeUserProfile(content: string): void {
  writeFileSafe(USER_FILE, content);
}

/** メモリをシステムプロンプトに追加するブロックを生成 */
export function buildMemoryBlock(): string {
  const memory = getAgentMemory();
  const user = getUserProfile();
  const parts: string[] = [];

  if (memory) {
    parts.push(`<agent_memory>\n${memory}\n</agent_memory>`);
  }
  if (user) {
    parts.push(`<user_profile>\n${user}\n</user_profile>`);
  }
  if (parts.length === 0) return "";

  return `\n\n## 永続メモリ\n以下の情報はセッション間で保持されます。\n${parts.join("\n")}\n`;
}

/** メモリファイルが存在するか */
export function hasMemory(): boolean {
  return existsSync(MEMORY_FILE) && readFileSync(MEMORY_FILE, "utf-8").trim().length > 0;
}

// ==================== 拡張API（agentmemory由来の新機能） ====================

let pipeline: MemoryPipeline | null = null;

/** パイプラインインスタンスを取得 */
function getPipeline(): MemoryPipeline {
  if (!pipeline) {
    pipeline = getDefaultPipeline();
    loadPipelineFromDisk();
  }
  return pipeline;
}

/**
 * 観察を記録（自動メモリ）
 * Aikata起動中にエージェントが学習した内容を自動保存
 */
export async function observeMemory(
  text: string,
  options?: {
    sessionId?: string;
    entities?: string[];
    importance?: number;
    tier?: MemoryTier;
  }
): Promise<void> {
  const p = getPipeline();
  if (options?.tier === "semantic" || options?.tier === "procedural") {
    await p.remember(text, {
      entities: options.entities,
      importance: options.importance,
    });
  } else {
    await p.observe(text, {
      sessionId: options?.sessionId,
      entities: options?.entities,
      importance: options?.importance,
    });
  }
  savePipelineToDisk();
}

/**
 * ハイブリッド検索でメモリを検索
 * 新機能！BM25 + ベクトル + グラフのRRF融合検索
 */
export async function searchMemory(
  query: string,
  limit: number = 5,
  minTier?: MemoryTier
): Promise<string[]> {
  const p = getPipeline();
  const results = await p.search(query, limit * 2);

  let filtered = results;
  if (minTier) {
    const tierRank = { working: 1, episodic: 2, semantic: 3, procedural: 4 };
    const minRank = tierRank[minTier] || 1;
    filtered = results.filter(r => (tierRank[r.tier] || 0) >= minRank);
  }

  return filtered.slice(0, limit).map(r => {
    const tier = r.tier.toUpperCase();
    return `[${tier}][${(r.confidence * 100).toFixed(0)}%] ${r.summary || r.text}`;
  });
}

/**
 * コンテキストブロックを生成（トークン予算あり）
 * システムプロンプトに注入するための関連メモリブロック
 */
export async function buildEnhancedMemoryBlock(
  contextQuery: string,
  tokenBudget: number = 1500
): Promise<string> {
  const p = getPipeline();
  const contextBlock = await p.getContextBlock(contextQuery, tokenBudget);

  const traditional = buildMemoryBlock();

  if (!contextBlock) return traditional;

  return `${traditional}\n\n## 関連メモリ（ハイブリッド検索）\n${contextBlock}`;
}

/**
 * 明示的に覚えさせる（セマンティックメモリに直接追加）
 */
export async function rememberExplicitly(
  text: string,
  importance: number = 0.7
): Promise<void> {
  const p = getPipeline();
  await p.remember(text, { importance });
  savePipelineToDisk();
  logger.info(`[MemoryBridge] 明示的記憶: ${text.slice(0, 80)}...`);
}

/**
 * パイプラインの状態をディスクに保存
 */
export function savePipelineToDisk(): void {
  try {
    ensureDir();
    const p = getPipeline();
    const data = JSON.stringify({
      entries: p.exportData(),
      savedAt: Date.now(),
    });
    writeFileSafe(PIPELINE_FILE, data);
  } catch (e) {
    logger.error(`[MemoryBridge] 保存エラー: ${e}`);
  }
}

/**
 * パイプラインの状態をディスクから復元
 */
export function loadPipelineFromDisk(): void {
  try {
    const data = readFileSafe(PIPELINE_FILE);
    if (!data) return;

    const parsed = JSON.parse(data);
    if (parsed.entries && Array.isArray(parsed.entries)) {
      const p = getPipeline();
      p.importData(parsed.entries);
      logger.info(`[MemoryBridge] ${parsed.entries.length}件のメモリを復元`);
    }
  } catch (e) {
    logger.warn(`[MemoryBridge] 復元エラー（無視）: ${e}`);
  }
}

/**
 * 統合を手動実行
 */
export async function consolidateNow(): Promise<void> {
  const p = getPipeline();
  await p.consolidate();
  savePipelineToDisk();
  logger.info("[MemoryBridge] 手動統合完了");
}

/**
 * メモリ統計情報
 */
export function getMemoryStats(): Record<string, number> {
  const p = getPipeline();
  return {
    total: p.getAllEntries().length,
    working: p.getTierCount("working"),
    episodic: p.getTierCount("episodic"),
    semantic: p.getTierCount("semantic"),
    procedural: p.getTierCount("procedural"),
  };
}

// ==========================================
// SkillGraphs 原子的ノート + ドメインマップ
// 出典: SkillGraphs（atomic notes + wikilink + Domain Maps）
// Markdownファイルで知識を蓄積・接続し、AIが毎回思い出せるようにする
// ==========================================

const ATOMS_DIR = resolve(MEMORY_DIR, "atoms");
const MAPS_DIR = resolve(MEMORY_DIR, "maps");

/** 原子的ノート */
interface AtomicNote {
  /** ノートID（ファイル名 = id.md） */
  id: string;
  /** タイトル */
  title: string;
  /** 内容（Markdown） */
  content: string;
  /** タグ */
  tags: string[];
  /** ウィキリンク先（[[note-name]]から抽出） */
  linksTo: string[];
  /** ウィキリンク元（逆引き） */
  linkedFrom: string[];
  /** 作成日時 */
  createdAt: number;
  /** 更新日時 */
  updatedAt: number;
  /** ドメイン（フォルダ名） */
  domain: string;
}

/** ドメインマップ */
interface DomainMap {
  domain: string;
  title: string;
  description: string;
  noteIds: string[];
  subdomains: string[];
  createdAt: number;
}

/**
 * 原子的ノートを作成。
 * SkillGraphsの「1ノート=1概念」原則に従い、小さく保つ。
 */
export function createAtomicNote(
  title: string,
  content: string,
  options?: { domain?: string; tags?: string[] },
): AtomicNote {
  ensureDir();
  const domain = options?.domain ?? "general";
  const atomsDir = resolve(ATOMS_DIR, domain);
  if (!existsSync(atomsDir)) mkdirSync(atomsDir, { recursive: true });

  const id = `${Date.now().toString(36)}-${title.replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff_-]/gi, "_").slice(0, 40)}`;
  const linksTo = extractWikilinks(content);

  // Markdownにフロントマターを付けて保存
  const md = [
    "---",
    `title: ${title}`,
    `domain: ${domain}`,
    `tags: [${(options?.tags ?? []).join(", ")}]`,
    `links: [${linksTo.join(", ")}]`,
    `created: ${new Date().toISOString()}`,
    "---",
    "",
    content,
  ].join("\n");

  const filePath = resolve(atomsDir, `${id}.md`);
  writeFileSync(filePath, md, "utf-8");

  const note: AtomicNote = {
    id,
    title,
    content,
    tags: options?.tags ?? [],
    linksTo,
    linkedFrom: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    domain,
  };

  logger.info(`[AtomicNote] 作成: ${domain}/${id} "${title}" (${linksTo.length} links)`);
  return note;
}

/**
 * 2つのノートをウィキリンクで接続。
 * fromNote の内容に [[toTitle]] を追記する。
 */
export function linkNotes(fromId: string, toTitle: string): boolean {
  const from = findAtomicNoteById(fromId);
  if (!from) return false;

  const atomsDir = resolve(ATOMS_DIR, from.domain);
  const filePath = resolve(atomsDir, `${from.id}.md`);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    const appendLine = `\n関連: [[${toTitle}]]\n`;
    if (!existing.includes(`[[${toTitle}]]`)) {
      writeFileSync(filePath, existing + appendLine, "utf-8");
      from.linksTo.push(toTitle);
      logger.info(`[AtomicNote] リンク: ${from.id} → [[${toTitle}]]`);
      return true;
    }
  }

  return false;
}

/**
 * ドメイン内の全ノートを取得し、接続グラフを構築。
 */
export function getDomainMap(domain: string): {
  notes: AtomicNote[];
  map: DomainMap | null;
  graph: { nodes: string[]; edges: { from: string; to: string }[] };
} {
  const atomsDir = resolve(ATOMS_DIR, domain);
  const notes: AtomicNote[] = [];

  if (existsSync(atomsDir)) {
    const { readdirSync } = require("fs");
    const files = readdirSync(atomsDir).filter((f: string) => f.endsWith(".md"));
    for (const file of files) {
      const note = loadAtomicNote(resolve(atomsDir, file), domain);
      if (note) notes.push(note);
    }
  }

  // 逆リンクを計算
  for (const note of notes) {
    note.linkedFrom = notes
      .filter(n => n.linksTo.includes(note.title) || n.linksTo.includes(note.id))
      .map(n => n.id);
  }

  // ドメインマップ読み込み
  const mapPath = resolve(MAPS_DIR, `${domain}.json`);
  let map: DomainMap | null = null;
  if (existsSync(mapPath)) {
    try { map = JSON.parse(readFileSync(mapPath, "utf-8")); } catch {}
  }

  // グラフ構築
  const edges: { from: string; to: string }[] = [];
  for (const note of notes) {
    for (const link of note.linksTo) {
      const target = notes.find(n => n.title === link || n.id === link);
      if (target) edges.push({ from: note.id, to: target.id });
    }
  }

  return { notes, map, graph: { nodes: notes.map(n => n.id), edges } };
}

/**
 * 原子的ノートを全文+タグ検索。
 * ドメイン指定で絞り込み可能。
 */
export function searchAtomicNotes(
  query: string,
  options?: { domain?: string; limit?: number },
): AtomicNote[] {
  const results: AtomicNote[] = [];
  const lowerQ = query.toLowerCase();

  const domains = options?.domain ? [options.domain] : listDomains();
  for (const domain of domains) {
    const domainDir = resolve(ATOMS_DIR, domain);
    if (!existsSync(domainDir)) continue;

    const { readdirSync } = require("fs");
    const files = readdirSync(domainDir).filter((f: string) => f.endsWith(".md"));
    for (const file of files) {
      const note = loadAtomicNote(resolve(domainDir, file), domain);
      if (!note) continue;
      if (
        note.title.toLowerCase().includes(lowerQ) ||
        note.content.toLowerCase().includes(lowerQ) ||
        note.tags.some(t => t.toLowerCase().includes(lowerQ))
      ) {
        results.push(note);
      }
    }
  }

  // スコアリング（タイトル完全一致 > タイトル部分一致 > 内容一致）
  results.sort((a, b) => {
    const aTitle = a.title.toLowerCase() === lowerQ ? 3 : a.title.toLowerCase().includes(lowerQ) ? 2 : 1;
    const bTitle = b.title.toLowerCase() === lowerQ ? 3 : b.title.toLowerCase().includes(lowerQ) ? 2 : 1;
    return bTitle - aTitle;
  });

  return results.slice(0, options?.limit ?? 20);
}

/**
 * ドメインマップを作成/更新。
 * SkillGraphsの「領域マップ」: ドメイン内のテーマ構造を定義。
 */
export function upsertDomainMap(
  domain: string,
  title: string,
  description: string,
  subdomains?: string[],
): DomainMap {
  ensureDir();
  if (!existsSync(MAPS_DIR)) mkdirSync(MAPS_DIR, { recursive: true });

  const { notes } = getDomainMap(domain);
  const map: DomainMap = {
    domain,
    title,
    description,
    noteIds: notes.map(n => n.id),
    subdomains: subdomains ?? [],
    createdAt: Date.now(),
  };

  writeFileSync(resolve(MAPS_DIR, `${domain}.json`), JSON.stringify(map, null, 2), "utf-8");
  logger.info(`[DomainMap] upsert: ${domain} "${title}" (${map.noteIds.length} notes)`);
  return map;
}

/** 全ドメイン一覧 */
export function listDomains(): string[] {
  if (!existsSync(ATOMS_DIR)) return [];
  const { readdirSync } = require("fs");
  return readdirSync(ATOMS_DIR).filter((d: string) => {
    const dp = resolve(ATOMS_DIR, d);
    try { return require("fs").statSync(dp).isDirectory(); } catch { return false; }
  });
}

// ---- 内部ヘルパー ----

/** Markdownからウィキリンクを抽出 */
function extractWikilinks(content: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const link = m[1]!.split("|")[0]!.trim(); // [[title|alias]] → title
    links.push(link);
  }
  return [...new Set(links)];
}

/** 原子的ノートをファイルから読み込み */
function loadAtomicNote(filePath: string, domain: string): AtomicNote | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const id = filePath.split("/").pop()?.replace(".md", "") ?? "";

    // フロントマター解析
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let title = id;
    let tags: string[] = [];
    let links: string[] = [];
    let content = raw;

    if (fmMatch) {
      const fm = fmMatch[1]!;
      content = fmMatch[2]!.trim();
      const titleMatch = fm.match(/title:\s*(.+)/);
      if (titleMatch) title = titleMatch[1]!.trim();
      const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
      if (tagsMatch) tags = tagsMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);
      const linksMatch = fm.match(/links:\s*\[([^\]]*)\]/);
      if (linksMatch) links = linksMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);
    }

    links = [...new Set([...links, ...extractWikilinks(content)])];

    return {
      id,
      title,
      content,
      tags,
      linksTo: links,
      linkedFrom: [],
      createdAt: 0,
      updatedAt: 0,
      domain,
    };
  } catch {
    return null;
  }
}

function findAtomicNoteById(id: string): AtomicNote | null {
  for (const domain of listDomains()) {
    const fp = resolve(ATOMS_DIR, domain, `${id}.md`);
    if (existsSync(fp)) {
      return loadAtomicNote(fp, domain);
    }
  }
  return null;
}
