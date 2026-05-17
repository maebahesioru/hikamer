// ==========================================
// Aikata - ブラウザ操作 v2 (camofox実API + playwright-fallback)
// camofox: tabベース (POST /tabs → /tabs/:id/navigate etc.)
// playwright: 直接操作 (camofox未起動時の自動フォールバック)
// ==========================================

import type { Tool } from "../types";
import { logger } from "../utils/logger";

const CAMOFOX_URL = process.env.CAMOFOX_URL || "http://localhost:9377";

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

async function getPlaywrightPage(): Promise<any> {
  if (!playwrightBrowser) {
    const { chromium } = await import("playwright-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth") as any;
    chromium.use(StealthPlugin());
    playwrightBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
  }
  if (!playwrightPage || playwrightPage.isClosed()) {
    playwrightPage = await (await playwrightBrowser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      viewport: { width: 1280, height: 800 },
    })).newPage();
  }
  return playwrightPage;
}

async function fallbackPlaywright(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const page = await getPlaywrightPage();

  switch (action) {
    case "navigate": {
      const url = args.url as string;
      if (!url) return "[Playwright] url が必要";
      await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 10_000));
      return `[Playwright] ナビゲート: ${url}\nタイトル: ${title}\n\n${text}`;
    }
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

export const browserTool: Tool = {
  name: "browser",
  description: "camofoxステルスブラウザ(優先) または playwright(自動フォールバック)でWebを操作。navigate/extract/click/type/screenshot/close。",
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
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;

    try {
      // camofoxが生きてれば優先使用
      if (await checkCamofoxAlive()) {
        try {
          switch (action) {
            case "navigate": {
              const url = args.url as string;
              if (!url) return "[エラー] url が必要";
              return await camofoxNavigate(url);
            }
            case "extract":
              return await camofoxExtract();
            case "click": {
              const ref: string = (args.selector || (args as any).ref || "") as string;
              if (!ref) return "[エラー] selector(ref) が必要";
              return await camofoxClick(ref);
            }
            case "type": {
              const ref: string = (args.selector || (args as any).ref || "") as string;
              const text: string = (args.text || "") as string;
              if (!ref || !text) return "[エラー] selector(ref) と text が必要";
              return await camofoxType(ref, text);
            }
            case "screenshot":
              return await camofoxScreenshot();
            case "close": {
              await camofoxClose();
              if (playwrightBrowser) { await playwrightBrowser.close().catch(() => {}); playwrightBrowser = null; playwrightPage = null; }
              return "ブラウザを閉じました。";
            }
            default:
              return `[エラー] 不明なアクション: ${action}`;
          }
        } catch (e: any) {
          // camofox失敗→playwrightにフォールバック
          logger.debug(`camofox失敗、playwrightにフォールバック: ${e.message}`);
          camofoxAlive = false;
          return await fallbackPlaywright(args);
        }
      }

      // camofox未起動→playwright直行
      return await fallbackPlaywright(args);

    } catch (e: any) {
      return `[エラー] ブラウザ操作失敗: ${e.message}`;
    }
  },
};
