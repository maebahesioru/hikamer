// ==========================================
// Aikata - HTTPリクエストツール（OpenHuman由来）
// ブラウザ不要のシンプルHTTPリクエスト
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";
import { checkUrlSafety } from "../url-safety";

// ==================== 機密ヘッダー ====================

const SENSITIVE_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "x-api-key",
  "api-key", "api_secret", "access-token", "refresh-token",
  "proxy-authorization", "x-auth-token",
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : val;
  }
  return result;
}

// ==================== レスポンス整形 ====================

function formatResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
  elapsedMs: number,
  truncated: boolean,
): string {
  const headerLines = Object.entries(redactHeaders(headers))
    .slice(0, 30)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let result = `HTTP ${status} ${statusText} (${elapsedMs}ms)\n`;
  result += `--- Headers ---\n${headerLines || "(なし)"}\n`;
  result += `--- Body (${body.length}文字${truncated ? ", 切り詰め" : ""}) ---\n`;
  result += body.slice(0, 8000);

  if (body.length > 8000) {
    result += `\n…[${body.length - 8000}文字省略]`;
  }

  return result;
}

// ==================== ツール定義 ====================

const httpTool: ToolDescriptor = {
  name: "http_request",
  emoji: "🌍",
  owner: "core",
  description: "HTTPリクエストを送信します。ブラウザを起動せずにAPIやWebページのデータを取得するのに使用。GET/POST/PUT/DELETE/PATCH/HEADに対応。",
  parameters: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
        description: "HTTPメソッド（デフォルトGET）",
        default: "GET",
      },
      url: {
        type: "string",
        description: "リクエストURL",
      },
      headers: {
        type: "object",
        description: "リクエストヘッダー（オブジェクト形式）",
        default: {},
      },
      body: {
        type: "string",
        description: "リクエストボディ（POST/PUT/PATCH時）",
      },
      timeout: {
        type: "number",
        description: "タイムアウト（ミリ秒、デフォルト15000）",
        default: 15000,
      },
    },
    required: ["url"],
  },
  async execute(args) {
    const method = (args.method as string) || "GET";
    const url = args.url as string;
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;
    const timeoutMs = Math.min((args.timeout as number) || 15000, 60_000);

    if (!url) return "[エラー] url が必要です";

    // URL安全チェック
    const safety = await checkUrlSafety(url);
    if (!safety.safe) {
      return `[エラー] URLがブロックされました: ${safety.reason}`;
    }

    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Aikata/1.0 (HTTP Request Tool)",
      ...headers,
    };

    // bodyがあるならContent-Type自動設定
    if (body && !fetchHeaders["Content-Type"] && !fetchHeaders["content-type"]) {
      try {
        JSON.parse(body);
        fetchHeaders["Content-Type"] = "application/json";
      } catch {
        fetchHeaders["Content-Type"] = "text/plain";
      }
    }

    logger.info(`HTTP ${method} ${url}`);

    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method: method as any,
        headers: fetchHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });

      const elapsed = Date.now() - startTime;
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => { respHeaders[key] = val; });

      // HEADメソッドはボディなし
      if (method === "HEAD") {
        return formatResponse(
          response.status, response.statusText,
          respHeaders, "(HEAD: ボディなし)", elapsed, false,
        );
      }

      const text = await response.text();
      const truncated = text.length > 8000;

      return formatResponse(
        response.status, response.statusText,
        respHeaders, text, elapsed, truncated,
      );
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        return `[エラー] タイムアウト (${timeoutMs}ms): ${url}`;
      }
      return `[エラー] HTTPリクエスト失敗 (${elapsed}ms): ${e.message?.slice(0, 200) || String(e)}`;
    }
  },
};

toolRegistry.register(httpTool);
export { httpTool };
