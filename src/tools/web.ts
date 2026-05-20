// ==========================================
// Hikamer - Web検索ツール v2 (SearXNG)
// 重複除去 + 結果整形改善（OpenClaw発想）
// ==========================================

import { getSearxngUrl } from "../utils/config";
import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";

// ==================== 重複除去 ====================

/** URLからトラッキングパラメータを除去して正規化 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // トラッキングパラメータ除去
    const tracking = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "ref", "source", "si", "mc_cid", "mc_eid"]);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (tracking.has(key)) parsed.searchParams.delete(key);
    }
    // ハッシュ除去
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 結果の重複除去（同じ正規化URL、同じタイトル） */
function dedupResults(results: any[]): any[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  return results.filter(r => {
    const normUrl = normalizeUrl(r.url || "");
    const title = (r.title || "").trim().toLowerCase();
    if (seenUrls.has(normUrl)) return false;
    if (title && seenTitles.has(title)) return false;
    seenUrls.add(normUrl);
    if (title) seenTitles.add(title);
    return true;
  });
}

// ==================== ソースエンジン絵文字 ====================

function engineEmoji(engine?: string): string {
  const map: Record<string, string> = {
    google: "🔍", duckduckgo: "🦆", bing: "🔵", brave: "🦁",
    yahoo: "📰", searx: "🔎", wikipedia: "📖", news: "📰",
  };
  return (engine && map[engine.toLowerCase()]) || "🌐";
}

// ==================== ツール ====================

const webTool: ToolDescriptor = {
  name: "web_search",
  emoji: "🌐",
  owner: "core",
  description: "Web検索を実行します。SearXNGエンジンを使用。重複除去・ソース表示対応。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ。Google検索と同じ感覚で入力してください。",
      },
      limit: {
        type: "number",
        description: "取得件数（デフォルト10、最大50）",
        default: 10,
      },
      engines: {
        type: "string",
        description: "使用する検索エンジン（カンマ区切り）。例: google,duckduckgo,bing",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 10, 50);
    const engines = (args.engines as string) || "";

    if (!query) return "[エラー] query が必要です";

    const searxngUrl = getSearxngUrl();
    const params = new URLSearchParams({
      q: query,
      format: "json",
      pageno: "1",
    });
    if (engines) params.set("engines", engines);

    const url = `${searxngUrl}/search?${params.toString()}`;
    logger.debug(`SearXNG: ${url}`);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        return `[エラー] SearXNG 応答 ${res.status}: ${await res.text().catch(() => "unknown").then(t => t.slice(0, 200))}`;
      }

      const json = await res.json() as any;
      const rawResults = json.results || [];
      const infoboxes = json.infoboxes || [];

      if (rawResults.length === 0) {
        return `🔍 「${query}」の検索結果0件`;
      }

      // 重複除去
      const results = dedupResults(rawResults);
      const limited = results.slice(0, limit);

      // ブロック構築
      const parts: string[] = [];

      // 件数サマリ
      const dedupCount = rawResults.length - results.length;
      parts.push(`🔍 **「${query}」の検索結果**`);
      parts.push(`全${rawResults.length}件${dedupCount > 0 ? `（重複${dedupCount}件除去）` : ""} - ${limited.length}件表示`);
      if (infoboxes.length > 0) parts.push(`📦 情報ボックス: ${infoboxes.length}件`);
      parts.push("");

      // 結果行
      for (let i = 0; i < limited.length; i++) {
        const r = limited[i]!;
        const title = r.title || "(タイトルなし)";
        const rUrl = r.url || "";
        const snippet = (r.content || r.snippet || "").replace(/\n/g, " ").slice(0, 250);
        const engine = r.engine || r.source || "";
        const emoji = engineEmoji(engine);
        parts.push(`${emoji} **[${i + 1}] ${title}**`);
        parts.push(`   ${rUrl}`);
        if (snippet) parts.push(`   ${snippet}`);
        if (engine) parts.push(`   via ${engine}`);
        parts.push("");
      }

      return parts.join("\n").slice(0, 15000);
    } catch (e: any) {
      return `[エラー] Web検索に失敗: ${e.message}\nSearXNG(${searxngUrl})が起動しているか確認してください。`;
    }
  },
};

toolRegistry.register(webTool);
export { webTool };
