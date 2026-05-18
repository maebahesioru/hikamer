// ==========================================
// Aikata - Network Utilities（OpenClaw shared/net/ + utils/fetch-timeout由来）
// SSRF対策IP検証・タイムアウト付きHTTP・ログ用URL秘匿化
// ==========================================

import https from "https";
import http from "http";
import { URL } from "url";

// ==================== IPアドレス検証（SSRF対策） ====================

/** IPv4アドレスをパース */
function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) || n < 0 || n > 255 ? -1 : n;
  });
  return nums.some((n) => n < 0) ? null : nums;
}

/** ループバックアドレス判定 */
export function isLoopbackIp(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return ipv4[0] === 127;
  return false;
}

/** プライベートIPアドレス判定 */
export function isPrivateIp(host: string): boolean {
  if (host.startsWith("10.")) return true;
  if (host.startsWith("172.")) {
    const second = parseInt(host.split(".")[1] || "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.startsWith("192.168.")) return true;
  if (host === "169.254.0.1" || host.startsWith("169.254.")) return true;
  return false;
}

/** クラウドメタデータIP判定 */
export function isCloudMetadataIp(host: string): boolean {
  return host === "169.254.169.254";
}

/** URL文字列からホスト名を抽出してSSRFリスクをチェック */
export function validateUrlForSsrf(urlStr: string): { safe: boolean; reason?: string } {
  try {
    const url = new URL(urlStr);
    const host = url.hostname;
    if (isLoopbackIp(host)) return { safe: false, reason: "ループバックアドレスへのリクエストは禁止されています" };
    if (isCloudMetadataIp(host)) return { safe: false, reason: "クラウドメタデータエンドポイントへのリクエストは禁止されています" };
    if (isPrivateIp(host)) return { safe: false, reason: "プライベートIPアドレスへのリクエストは禁止されています" };
    return { safe: true };
  } catch {
    return { safe: false, reason: "URLのパースに失敗しました" };
  }
}

// ==================== 安全なHTTPリクエスト ====================

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseSize?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

/** タイムアウト＋SSRFチェック付きHTTPリクエスト */
export async function safeFetch(urlStr: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  // SSRFチェック
  const ssrf = validateUrlForSsrf(urlStr);
  if (!ssrf.safe) {
    throw new Error(`SSRF blocked: ${ssrf.reason}`);
  }

  const timeout = options.timeoutMs ?? 15000;
  const maxSize = options.maxResponseSize ?? 5_242_880; // 5MB default

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const url = new URL(urlStr);
    const httpModule = url.protocol === "https:" ? https : http;

    const req = httpModule.request(
      urlStr,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        signal: controller.signal,
        timeout,
      },
      (res) => {
        let data = "";
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxSize) {
            req.destroy(new Error(`Response too large (max ${maxSize} bytes)`));
            return;
          }
          data += chunk.toString();
        });
        res.on("end", () => {
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({
            ok: (res.statusCode ?? 500) < 400,
            status: res.statusCode ?? 500,
            statusText: res.statusMessage || "",
            body: data,
            headers,
          });
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      if (err.name === "AbortError") reject(new Error(`Request timed out after ${timeout}ms`));
      else reject(err);
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ==================== ログ用URL秘匿化 ====================

const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "access_token", "api_key", "apikey", "secret", "password", "passwd",
  "auth", "key", "session", "sid", "jwt", "refresh_token",
]);

/** URLからクレデンシャル情報を秘匿化 */
export function redactUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);

    // username:password@host の形式
    if (url.username) {
      url.username = "***";
    }
    if (url.password) {
      url.password = "***";
    }

    // 機密クエリパラメータ
    for (const [key] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, "***");
      }
    }

    return url.toString();
  } catch {
    // パースできない場合は単純なパターンマッチ
    return urlStr.replace(/(?<=[?&](?:token|api_key|secret|password)=)[^&]+/gi, "***")
      .replace(/\/\/[^:]+:[^@]+@/g, "//***:***@");
  }
}

// ==================== 並列実行制御 ====================

/** バウンデッド並列実行 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<{ results: T[]; errors: Error[] }> {
  const results: T[] = [];
  const errors: Error[] = [];
  const queue = [...tasks];
  let index = 0;

  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= queue.length) break;
      try {
        results[i] = await queue[i]!();
      } catch (e) {
        errors[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);

  return { results, errors };
}
