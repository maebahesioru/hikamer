// ==========================================
// Aikata - リポジトリパッカー（repomix 25k stars パターン）
// リポジトリ全体を1つのAIフレンドリーなファイルにパック
// + Semantic Cache（token-optimizer-mcp パターン）
// ==========================================

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { resolve, relative, join, extname } from "path";
import { createHash } from "crypto";
import { logger } from "./utils/logger";

// ==================== Repo Packer ====================

export interface PackOptions {
  /** 除外パターン（glob風） */
  exclude?: string[];
  /** 最大ファイルサイズ（bytes、超えるとスキップ） */
  maxFileSize?: number;
  /** 出力フォーマット */
  format?: "markdown" | "xml" | "plain";
  /** 出力パス */
  outputPath?: string;
  /** 最大行数（超えると後半切り捨て） */
  maxLines?: number;
}

const DEFAULT_EXCLUDE = [
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "*.min.js", "*.min.css", "*.map", "*.d.ts",
  "__pycache__", ".venv", "venv", ".tox", ".eggs",
  "*.pyc", "*.pyo", "*.so", "*.dylib", "*.wasm",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.svg",
  "*.woff", "*.woff2", "*.ttf", "*.eot",
  "*.zip", "*.tar", "*.gz", "*.7z",
];

/**
 * リポジトリを1つのAIフレンドリーファイルにパック。
 * repomix (yamadashy/repomix, 25k stars) のTypeScript移植版。
 * 
 * 出力形式:
 * ```markdown
 * # repo-name
 * 
 * ## File: src/index.ts
 * ```typescript
 * // content
 * ```
 * 
 * ## File: README.md
 * (content)
 * ```
 */
export function packRepository(
  rootDir: string,
  options?: PackOptions,
): { outputPath: string; fileCount: number; totalSize: number; skippedCount: number } {
  const exclude = [...DEFAULT_EXCLUDE, ...(options?.exclude ?? [])];
  const maxFileSize = options?.maxFileSize ?? 500_000; // 500KB
  const format = options?.format ?? "markdown";
  const maxLines = options?.maxLines ?? 0;

  const files = collectFiles(rootDir, exclude, maxFileSize);
  const sections: string[] = [];
  const repoName = rootDir.split("/").pop() ?? "repo";
  let totalSize = 0;
  let skippedCount = 0;

  // ヘッダー
  if (format === "markdown") {
    sections.push(`# ${repoName} — Repository Snapshot`, "");
    sections.push(`> Packed at: ${new Date().toISOString()}`, "");
    sections.push(`> Files: ${files.length}`, "");
    sections.push("");
  }

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const relPath = relative(rootDir, file);
      let displayContent = content;

      // 行数制限
      if (maxLines > 0) {
        const lines = content.split("\n");
        if (lines.length > maxLines) {
          displayContent = lines.slice(0, maxLines).join("\n") +
            `\n\n...(truncated at ${maxLines} lines, ${lines.length - maxLines} more)`;
        }
      }

      // ファイルサイズ制限
      if (content.length > maxFileSize) {
        displayContent = content.slice(0, maxFileSize) +
          `\n\n...(truncated at ${maxFileSize} bytes, ${content.length - maxFileSize} more)`;
        skippedCount++;
      }

      // 言語推測
      const lang = guessLanguage(relPath);

      if (format === "markdown") {
        sections.push(`## File: \`${relPath}\``);
        sections.push("");
        sections.push(`\`\`\`${lang}`);
        sections.push(displayContent);
        sections.push("```");
        sections.push("");
      } else if (format === "xml") {
        sections.push(`<file path="${relPath}" language="${lang}">`);
        sections.push(`<![CDATA[${displayContent}]]>`);
        sections.push("</file>");
      } else {
        sections.push(`=== ${relPath} ===`);
        sections.push(displayContent);
        sections.push("");
      }

      totalSize += content.length;
    } catch {
      skippedCount++;
    }
  }

  const output = sections.join("\n");
  const outputPath = options?.outputPath ?? join(rootDir, `${repoName}-packed.md`);

  writeFileSync(outputPath, output, "utf-8");
  logger.info(`[RepoPacker] ${files.length} files → ${outputPath} (${(totalSize / 1024).toFixed(1)}KB)`);

  return { outputPath, fileCount: files.length, totalSize, skippedCount };
}

/** 再帰的にファイルを収集 */
function collectFiles(dir: string, exclude: string[], maxSize: number): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (shouldExclude(entry.name, fullPath, exclude)) continue;

      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath, exclude, maxSize));
      } else if (entry.isFile()) {
        try {
          const stat = statSync(fullPath);
          if (stat.size < maxSize * 2) { // 2倍までは許容（truncateするので）
            results.push(fullPath);
          }
        } catch {}
      }
    }
  } catch {}

  return results.sort();
}

function shouldExclude(name: string, _fullPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\./g, "\\.") + "$");
      if (regex.test(name)) return true;
    } else if (name === pattern || name.startsWith(".")) {
      if (pattern === name || pattern === ".*") return true;
      if (name.startsWith(".") && !patterns.includes(name)) continue;
    }
  }
  return false;
}

/** 拡張子から言語を推測 */
function guessLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".rs": "rust", ".go": "go",
    ".md": "markdown", ".mdx": "mdx",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".html": "html", ".css": "css", ".scss": "scss",
    ".sql": "sql", ".sh": "bash", ".bash": "bash",
    ".toml": "toml", ".xml": "xml",
    ".vue": "vue", ".svelte": "svelte",
  };
  return map[ext] ?? "";
}

// ==========================================
// Semantic Cache（token-optimizer-mcp パターン）
// LLM応答をキャッシュしてトークン消費を60-90%削減
// ==========================================

interface CacheEntry {
  response: string;
  hash: string;
  timestamp: number;
  hitCount: number;
  ttlMs: number;
}

interface SemanticCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  savedTokens: number;
}

class SemanticCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private savedTokens = 0;
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5分

  /**
   * プロンプトのセマンティックハッシュを計算。
   * token-optimizer-mcpの consistent hashing パターン。
   * 完全一致だけでなく、正規化後の類似プロンプトもキャッシュヒットさせる。
   */
  private hashPrompt(prompt: string): string {
    // 正規化: 空白・改行の統一、小文字化
    const normalized = prompt
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim();
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /** キャッシュから応答を取得 */
  get(prompt: string): string | null {
    const hash = this.hashPrompt(prompt);
    const entry = this.cache.get(hash);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(hash);
      this.misses++;
      return null;
    }

    entry.hitCount++;
    this.hits++;
    this.savedTokens += entry.response.length;
    return entry.response;
  }

  /** キャッシュに応答を保存 */
  set(prompt: string, response: string, ttlMs?: number): void {
    const hash = this.hashPrompt(prompt);
    this.cache.set(hash, {
      response,
      hash,
      timestamp: Date.now(),
      hitCount: 0,
      ttlMs: ttlMs ?? this.DEFAULT_TTL,
    });
  }

  /** キャッシュ統計 */
  getStats(): SemanticCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      savedTokens: this.savedTokens,
    };
  }

  /** キャッシュをクリア */
  clear(): void {
    this.cache.clear();
  }

  /** 期限切れエントリを除去 */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [hash, entry] of this.cache) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(hash);
        removed++;
      }
    }
    return removed;
  }
}

export const semanticCache = new SemanticCache();

/**
 * キャッシュ付きLLM呼び出しのラッパー。
 * 使い方:
 *   const cached = semanticCache.get(prompt);
 *   if (cached) return cached;
 *   const response = await llm.chat(messages, tools);
 *   semanticCache.set(prompt, response.content ?? "");
 *   return response.content;
 */
export function withSemanticCache<T>(
  prompt: string,
  fetchFn: () => Promise<T>,
  serializeFn: (result: T) => string,
  ttlMs?: number,
): { result: T; fromCache: boolean } | Promise<{ result: T; fromCache: boolean }> {
  const cached = semanticCache.get(prompt);
  if (cached !== null) {
    return { result: JSON.parse(cached) as T, fromCache: true };
  }

  return fetchFn().then(result => {
    semanticCache.set(prompt, serializeFn(result), ttlMs);
    return { result, fromCache: false };
  });
}
