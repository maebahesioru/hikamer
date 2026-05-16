// ==========================================
// Aikata - Web検索ツール (SearXNG)
// ==========================================

import { getSearxngUrl } from "../utils/config";
import { logger } from "../utils/logger";
import type { Tool } from "../types";

export const webTool: Tool = {
  name: "web_search",
  description: "Web検索を実行します。SearXNGエンジンを使用。",
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
        description: "使用する検索エンジン（カンマ区切り）。省略時はデフォルト。例: google,duckduckgo,bing",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 10, 50);
    const engines = (args.engines as string) || "";

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
      const results = json.results || [];

      if (results.length === 0) {
        return `検索結果0件: "${query}"`;
      }

      const limited = results.slice(0, limit);
      const output = limited.map((r: any, i: number) => {
        const title = r.title || "(タイトルなし)";
        const url = r.url || "";
        const snippet = (r.content || r.snippet || "").replace(/\n/g, " ").slice(0, 300);
        return `[${i + 1}] ${title}\n    ${url}\n    ${snippet}`;
      });

      return `"${query}" の検索結果 (${results.length}件中${limited.length}件表示):\n\n${output.join("\n\n")}`;
    } catch (e: any) {
      return `[エラー] Web検索に失敗: ${e.message}\nSearXNG(${searxngUrl})が起動しているか確認してください。`;
    }
  },
};
