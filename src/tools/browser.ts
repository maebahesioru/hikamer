// ==========================================
// Aikata - ブラウザ操作 v2 (camofox実API + playwright-fallback)
// camofox: tabベース (POST /tabs → /tabs/:id/navigate etc.)
// playwright: 直接操作 (camofox未起動時の自動フォールバック)
// UAローテーション対応: ClaudeWeb等で規制回避
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { logger } from "../utils/logger";
import { checkUrlSafety } from "../url-safety";

const CAMOFOX_URL = process.env.CAMOFOX_URL || "http://localhost:9377";

// ==================== UAプリセット ====================

const UA_PRESETS: Record<string, string> = {
  /** デフォルト: 普通のChrome 131 Windows */
  default: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

  /** ClaudeWeb: Anthropic Claude Web クライアントUA → 規制緩和されてることがある */
  claude: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ClaudeWeb/1.0",

  /** ClaudeDesktop: Claude デスクトップアプリ */
  claude_desktop: "ClaudeDesktop/1.0 (Windows NT 10.0; Win64; x64)",

  /** GPTBot: OpenAI GPT クローラー → 多くのサイトが許可 */
  ai: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 GPTBot/1.0",

  /** ChatGPT-User: ChatGPT ユーザーエージェント */
  chatgpt: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",

  /** Googlebot: Google 検索クローラー → ブロックされにくい */
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",

  /** Mobile Safari: iOS Safari → モバイル最適化サイト向け */
  mobile: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",

  /** Mobile Chrome Android */
  mobile_android: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",

  /** Edge: たまにUAブロックがあるサイト向け */
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",

  /** Firefox: 特定のGecko-onlyサイト向け */
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
};

/** フォールバック順序（UAごとに試行） */
const UA_FALLBACK_CHAIN = ["default", "mobile", "googlebot", "ai", "claude", "firefox", "edge"];

/** UA名から実際のUA文字列を解決 */
function resolveUserAgent(name?: string): string {
  const uaName = name || "default";
  if (uaName === "default") return UA_PRESETS["default"]!;
  const found: string | undefined = UA_PRESETS[uaName];
  return found !== undefined ? found : UA_PRESETS["default"]!;
}

/** フォールバック用のUAリストを生成（指定UAを先頭に） */
function buildFallbackUaChain(name?: string): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];

  // 指定UAを先頭に
  const primary = resolveUserAgent(name);
  seen.add(primary);
  chain.push(primary);

  // フォールバックチェーンを追加
  for (const key of UA_FALLBACK_CHAIN) {
    const ua = UA_PRESETS[key]!;
    if (!seen.has(ua)) {
      seen.add(ua);
      chain.push(ua);
    }
  }

  return chain;
}

// camofox死活キャッシュ（初回のみcheck、以降スキップ）
let camofoxAlive: boolean | null = null;
let camofoxTabId: string | null = null; // 再利用するタブID

async function checkCamofoxAlive(): Promise<boolean> {
  if (camofoxAlive !== null) return camofoxAlive;
  try {
    const res = await fetch(`${CAMOFOX_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    camofoxAlive = res.ok;
  } catch {
    camofoxAlive = false;
  }
  if (camofoxAlive) logger.info("camofox発見 → ステルスブラウザ使用");
  else logger.info("camofox未起動 → playwrightに直行します");
  return camofoxAlive;
}

// ==================== camofox実API (tabベース) ====================

async function camofoxEnsureTab(url?: string): Promise<string> {
  if (camofoxTabId) {
    // 既存タブが生きてるか軽く確認
    try {
      const res = await fetch(`${CAMOFOX_URL}/tabs/${camofoxTabId}/snapshot?userId=aikata`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return camofoxTabId;
    } catch { camofoxTabId = null; }
  }
  // 新規タブ作成
  const body: any = { userId: "aikata", sessionKey: "default" };
  if (url) body.url = url;
  const res = await fetch(`${CAMOFOX_URL}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`camofox tab作成失敗: ${res.status}`);
  const data = await res.json();
  camofoxTabId = data.tabId;
  return camofoxTabId!;
}

async function camofoxNavigate(url: string): Promise<string> {
  // URL安全チェック
  const safety = await checkUrlSafety(url);
  if (!safety.safe) {
    return `[エラー] URLがブロックされました: ${safety.reason}`;
  }

  const tabId = await camofoxEnsureTab(url);
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/navigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "aikata", url }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`camofox navigate ${res.status}`);
  const data = await res.json();
  return `[camofox] ナビゲート: ${url}\nタイトル: ${data.title || ""}\nURL: ${data.url || url}`;
}

async function camofoxSnapshot(): Promise<string> {
  const tabId = await camofoxEnsureTab();
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/snapshot?userId=aikata`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`camofox snapshot ${res.status}`);
  const data = await res.json();
  return `[camofox] ${data.url || ""}\nタイトル: ${data.title || ""}\n\n${data.snapshot || data.text || JSON.stringify(data).slice(0, 8000)}`;
}

async function camofoxClick(ref: string): Promise<string> {
  const tabId = await camofoxEnsureTab();
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/click`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "aikata", ref }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`camofox click ${res.status}`);
  const data = await res.json();
  // クリック後は自動でsnapshotも返ってくる
  return `[camofox] クリック: ${ref}\n\n${data.snapshot || ""}`;
}

async function camofoxType(ref: string, text: string): Promise<string> {
  const tabId = await camofoxEnsureTab();
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "aikata", ref, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`camofox type ${res.status}`);
  const data = await res.json();
  return `[camofox] 入力: ${ref} ← "${text}"\n\n${data.snapshot || ""}`;
}

async function camofoxScreenshot(): Promise<string> {
  const tabId = await camofoxEnsureTab();
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/screenshot?userId=aikata`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`camofox screenshot ${res.status}`);
  const data = await res.json();
  return `[camofox] スクリーンショット撮影\n${data.snapshot || ""}`;
}

async function camofoxExtract(): Promise<string> {
  const tabId = await camofoxEnsureTab();
  const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "aikata" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`camofox extract ${res.status}`);
  const data = await res.json();
  return `[camofox] 抽出\nタイトル: ${data.title || ""}\n\n${data.content || data.text || JSON.stringify(data).slice(0, 8000)}`;
}

async function camofoxClose(): Promise<void> {
  if (camofoxTabId) {
    try {
      await fetch(`${CAMOFOX_URL}/tabs/${camofoxTabId}?userId=aikata`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {}
    camofoxTabId = null;
  }
}

// ==================== Playwright fallback ====================

let playwrightBrowser: any = null;
let playwrightPage: any = null;
let currentUa = UA_PRESETS.default;

async function getPlaywrightPage(ua?: string): Promise<any> {
  const targetUa = resolveUserAgent(ua);

  if (!playwrightBrowser) {
    const { chromium } = await import("playwright-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth") as any;
    chromium.use(StealthPlugin());
    playwrightBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    currentUa = targetUa;
  }

  // UAが変わったら新しいコンテキストを作成
  if (currentUa !== targetUa || !playwrightPage || playwrightPage.isClosed()) {
    if (playwrightPage && !playwrightPage.isClosed()) {
      try { await playwrightPage.context().close(); } catch {}
    }
    currentUa = targetUa;
    playwrightPage = await (await playwrightBrowser.newContext({
      userAgent: targetUa,
      viewport: { width: 1280, height: 800 },
    })).newPage();
    logger.info(`UA切替: ${ua || "default"}`);
  }

  return playwrightPage;
}

async function fallbackPlaywright(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const requestedUa = (args.user_agent as string) || "default";

  // navigateのみUAフォールバック対応
  if (action === "navigate") {
    const url = args.url as string;
    if (!url) return "[Playwright] url が必要";

    // URL安全チェック
    const safety = await checkUrlSafety(url);
    if (!safety.safe) {
      return `[エラー] URLがブロックされました: ${safety.reason}`;
    }

    // UAフォールバックチェーンで試行
    const uasToTry = buildFallbackUaChain(requestedUa);
    const errors: string[] = [];

    for (const ua of uasToTry) {
      try {
        const page = await getPlaywrightPage(ua);
        await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
        const title = await page.title();
        const text = await page.evaluate(() => document.body.innerText.slice(0, 10_000));
        return `[Playwright] ナビゲート: ${url}\nタイトル: ${title}\n` +
          (ua !== resolveUserAgent(requestedUa) ? `UAフォールバック: ${ua}\n` : "") +
          `\n${text}`;
      } catch (e: any) {
        errors.push(`${ua}: ${e.message.slice(0, 100)}`);
      }
    }

    return `[エラー] 全UAでナビゲート失敗:\n${errors.join("\n")}`;
  }

  // navigate以外は通常のswitch
  const page = await getPlaywrightPage(requestedUa);
  switch (action) {
    case "extract": {
      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 15_000));
      return `[Playwright] ${page.url()}\nタイトル: ${title}\n\n${text}`;
    }
    case "click": {
      const sel: string = (args.selector || (args as any).ref || "") as string;
      if (!sel) return "[Playwright] selector(ref) が必要";
      await page.click(sel, { timeout: 10_000 });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 5_000));
      return `[Playwright] クリック: ${sel}\n\n${text}`;
    }
    case "type": {
      const sel: string = (args.selector || (args as any).ref || "") as string;
      const text: string = (args.text || "") as string;
      if (!sel || !text) return "[Playwright] selector(ref) と text が必要";
      await page.fill(sel, text, { timeout: 10_000 });
      return `[Playwright] 入力: ${sel} ← "${text}"`;
    }
    case "screenshot": {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      return `[Playwright] スクリーンショット撮影 (${(buf.length / 1024).toFixed(1)}KB)`;
    }
    case "close": {
      if (playwrightBrowser) { await playwrightBrowser.close().catch(() => {}); playwrightBrowser = null; playwrightPage = null; }
      await camofoxClose();
      return "ブラウザを閉じました。";
    }
    default:
      return "[Playwright] 不明なアクション";
  }
}

// ==================== ツール本体 ====================

const browserTool: ToolDescriptor = {
  emoji: "🌐",
  owner: "core",
  name: "browser",
  description: "camofoxステルスブラウザ(優先) または playwright(自動フォールバック)でWebを操作。navigate/extract/click/type/screenshot/close。include_snapshot=trueで操作後のページ状態を自動返却（往復削減）。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "extract", "click", "type", "screenshot", "close"],
        description: "navigate=URL移動, extract=ページ内容抽出, click=クリック(ref), type=入力, screenshot=撮影, close=終了",
      },
      url: { type: "string", description: "navigate時のURL" },
      selector: { type: "string", description: "click/type時のセレクタ(ref)" },
      text: { type: "string", description: "type時の入力テキスト" },
      include_snapshot: { type: "boolean", description: "操作後にページスナップショットも返す（デフォルト: true）。エージェント往復削減に有効。" },
      user_agent: { type: "string", description: "UAプリセット: default/claude/claude_desktop/ai/chatgpt/googlebot/mobile/mobile_android/edge/firefox" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;
    const includeSnapshot = args.include_snapshot !== false; // デフォルトtrue

    try {
      let result: string;

      // camofoxが生きてれば優先使用
      if (await checkCamofoxAlive()) {
        try {
          switch (action) {
            case "navigate": {
              const url = args.url as string;
              if (!url) return "[エラー] url が必要";
              result = await camofoxNavigate(url);
              break;
            }
            case "extract":
              result = await camofoxExtract();
              break;
            case "click": {
              const ref: string = (args.selector || (args as any).ref || "") as string;
              if (!ref) return "[エラー] selector(ref) が必要";
              result = await camofoxClick(ref);
              break;
            }
            case "type": {
              const ref: string = (args.selector || (args as any).ref || "") as string;
              const text: string = (args.text || "") as string;
              if (!ref || !text) return "[エラー] selector(ref) と text が必要";
              result = await camofoxType(ref, text);
              break;
            }
            case "screenshot":
              result = await camofoxScreenshot();
              break;
            case "close": {
              await camofoxClose();
              if (playwrightBrowser) { await playwrightBrowser.close().catch(() => {}); playwrightBrowser = null; playwrightPage = null; }
              result = "ブラウザを閉じました。";
              break;
            }
            default:
              return `[エラー] 不明なアクション: ${action}`;
          }

          // include_snapshot: 操作後に追加スナップショットを取得（click/typeはcamofox側で既に返却）
          if (includeSnapshot && action !== "close" && action !== "screenshot") {
            try {
              // click/typeはcamofoxが既にsnapshotを含めて返すのでスキップ
              if (action !== "click" && action !== "type") {
                const snap = await camofoxSnapshot();
                result += `\n\n## 現在のページ状態\n${snap}`;
              }
            } catch { /* snapshot失敗は無視 */ }
          }

          return result;

        } catch (e: any) {
          // camofox失敗→playwrightにフォールバック
          logger.debug(`camofox失敗、playwrightにフォールバック: ${e.message}`);
          camofoxAlive = false;
          result = await fallbackPlaywright(args);
        }
      } else {
        // camofox未起動→playwright直行
        result = await fallbackPlaywright(args);
      }

      // include_snapshot: Playwright結果にもスナップショット追加（navigate/extract/click時）
      if (includeSnapshot && action !== "close" && result && !result.startsWith("[エラー]")) {
        try {
          if (playwrightPage && !playwrightPage.isClosed()) {
            const text = await playwrightPage.evaluate(() => document.body.innerText.slice(0, 5000));
            result += `\n\n## 現在のページ状態\n[Playwright] ${playwrightPage.url()}\n\n${text}`;
          }
        } catch { /* ignore */ }
      }

      return result;

    } catch (e: any) {
      return `[エラー] ブラウザ操作失敗: ${e.message}`;
    }
  },
};

toolRegistry.register(browserTool);
export { browserTool };
