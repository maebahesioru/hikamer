// ==========================================
// Hikamer - URL安全機構（Hermes Agent + OpenHuman由来）
// SSRF対策、プライベートIPブロック、不正URL検出
// ==========================================

import { resolve4 } from "dns/promises";
import { URL } from "url";
import { logger } from "./utils/logger";

// ==================== 常にブロック ====================

/** メタデータエンドポイント（常時ブロック・設定変更不可） */
const ALWAYS_BLOCKED_IPS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.169.253",
  "100.100.100.200",
]);

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

const ALWAYS_BLOCKED_NETWORKS = [
  { ip: parseIp("169.254.0.0"), mask: 16 },
];

// ==================== プライベートIP判定 ====================

/** プライベート/ループバック/リンクローカル等のネットワーク */
const PRIVATE_V4_RANGES: Array<{ ip: number; mask: number }> = [
  { ip: parseIp("10.0.0.0"), mask: 8 },
  { ip: parseIp("127.0.0.0"), mask: 8 },
  { ip: parseIp("169.254.0.0"), mask: 16 },
  { ip: parseIp("172.16.0.0"), mask: 12 },
  { ip: parseIp("192.168.0.0"), mask: 16 },
  { ip: parseIp("100.64.0.0"), mask: 10 },      // CGNAT
  { ip: parseIp("198.18.0.0"), mask: 15 },       // ベンチマーク
  { ip: parseIp("192.0.2.0"), mask: 24 },        // ドキュメンテーション
  { ip: parseIp("198.51.100.0"), mask: 24 },
  { ip: parseIp("203.0.113.0"), mask: 24 },
  { ip: parseIp("240.0.0.0"), mask: 4 },         // 予約済み
  { ip: parseIp("0.0.0.0"), mask: 8 },           // 未指定
  { ip: parseIp("224.0.0.0"), mask: 4 },         // マルチキャスト
];

function parseIp(str: string): number {
  const parts = str.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function ipInRange(ip: string, range: { ip: number; mask: number }): boolean {
  const addr = parseIp(ip);
  const maskBits = ~0 << (32 - range.mask);
  return (addr & maskBits) === (range.ip & maskBits);
}

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4_RANGES.some(r => ipInRange(ip, r));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

// ==================== 許可リスト ====================

/** プライベートIPを許可する信頼済みホスト */
const TRUSTED_PRIVATE_HOSTS: Set<string> = new Set();

// ==================== メイン判定 ====================

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * URLの安全性を検証
 * SSRF対策: プライベートIP/メタデータエンドポイントへのアクセスをブロック
 */
export async function checkUrlSafety(
  urlStr: string,
  options?: { allowPrivate?: boolean },
): Promise<UrlSafetyResult> {
  try {
    // 1. URLパース
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return { safe: false, reason: "URLのパースに失敗しました" };
    }

    // 2. スキームチェック（http/httpsのみ）
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: `許可されていないプロトコル: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();

    // 3. 常時ブロックホスト名
    if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
      return { safe: false, reason: `ブロックされたホスト名: ${hostname}` };
    }

    // 4. ループバック
    if (isLoopback(hostname)) {
      if (options?.allowPrivate) {
        return { safe: true };
      }
      return { safe: false, reason: `ループバックアドレスは許可されていません: ${hostname}` };
    }

    // 5. DNS解決
    let ips: string[];
    try {
      ips = await resolve4(hostname);
    } catch {
      // DNS解決失敗 → ホスト名のまま信頼する
      return { safe: true };
    }

    if (ips.length === 0) {
      return { safe: false, reason: "DNS解決結果が空です" };
    }

    // 6. 各IPをチェック
    for (const ip of ips) {
      // 常時ブロックIP
      if (ALWAYS_BLOCKED_IPS.has(ip)) {
        return {
          safe: false,
          reason: `ブロックされたIPアドレス: ${ip}`,
          resolvedIp: ip,
        };
      }

      // 常時ブロックネットワーク
      for (const net of ALWAYS_BLOCKED_NETWORKS) {
        if (ipInRange(ip, net)) {
          return {
            safe: false,
            reason: `ブロックされたネットワーク: ${ip} (${net.ip})`,
            resolvedIp: ip,
          };
        }
      }

      // プライベートIP
      if (isPrivateV4(ip)) {
        if (options?.allowPrivate || TRUSTED_PRIVATE_HOSTS.has(hostname)) {
          continue;
        }
        return {
          safe: false,
          reason: `プライベートIPへのアクセスは許可されていません: ${ip} (${hostname})`,
          resolvedIp: ip,
        };
      }
    }

    return { safe: true, resolvedIp: ips[0] };
  } catch (e: any) {
    logger.warn(`URL安全チェック例外: ${e.message}`);
    // フェイルセーフ: チェック不能なURLは安全とみなす
    return { safe: true };
  }
}

/**
 * 簡易URL検証（DNS解決なし、構文のみ）
 * 高速チェック用。問題なければOK、怪しい場合はフルチェック
 */
export function quickUrlCheck(urlStr: string): UrlSafetyResult {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: `許可されていないプロトコル: ${parsed.protocol}` };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
      return { safe: false, reason: `ブロックされたホスト名: ${hostname}` };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: "URL形式が無効です" };
  }
}
