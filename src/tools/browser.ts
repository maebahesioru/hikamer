// ==========================================
// Aikata - ブラウザ操作 (camofox-primary + playwright-fallback)
// ==========================================

import type { Tool } from "../types";
import { logger } from "../utils/logger";

const CAMOFOX_URL = process.env.CAMOFOX_URL || "http://localhost:9377";

// Playwright fallback (lazy import)
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

// ==================== camofox REST API ヘルパー ====================

async function camofoxCall(endpoint: string, body?: any): Promise<any> {
  const res = await fetch(`${CAMOFOX_URL}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`camofox ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function camofoxNavigate(url: string): Promise<string> {
  const data = await camofoxCall("/navigate", { url });
  return `ナビゲート: ${url}\nタイトル: ${data.title || ""}\n\n${data.snapshot || data.text || ""}`;
}

async function camofoxSnapshot(): Promise<string> {
  const data = await camofoxCall("/snapshot");
  return `現在: ${data.url || ""}\nタイトル: ${data.title || ""}\n\n${data.snapshot || data.text || ""}`;
}

async function camofoxClick(ref: string): Promise<string> {
  const data = await camofoxCall("/click", { ref });
  return `クリック: ${ref}\n\n${data.snapshot || ""}`;
}

async function camofoxType(ref: string, text: string): Promise<string> {
  const data = await camofoxCall("/type", { ref, text });
  return `入力: ${ref} ← "${text}"\n\n${data.snapshot || ""}`;
}

// ==================== ツール本体 ====================

export const browserTool: Tool = {
  name: "browser",
  description: "camofoxステルスブラウザでWebを操作。navigate/extract/click/type/screenshot。camofox未起動時はplaywright-extraにフォールバック。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "extract", "click", "type", "screenshot", "close"],
        description: "navigate=移動, extract=抽出, click=クリック(e1等), type=入力, screenshot=撮影, close=終了",
      },
      url: { type: "string", description: "navigate時のURL" },
      selector: { type: "string", description: "click/type時のセレクタ(ref)" },
      text: { type: "string", description: "type時の入力テキスト" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = args.action as string;
    // camofoxを試し、失敗したらplaywrightにフォールバック
    const useCamofox = async (fn: () => Promise<string>): Promise<string> => {
      try { return await fn(); }
      catch (e: any) {
        logger.debug(`camofox失敗、playwrightにフォールバック: ${e.message}`);
        return await fallbackPlaywright(args);
      }
    };

    try {
      switch (action) {
        case "navigate": {
          const url = args.url as string;
          if (!url) return "[エラー] url が必要";
          return await useCamofox(() => camofoxNavigate(url));
        }
        case "extract":
          return await useCamofox(() => camofoxSnapshot());
        case "click": {
          const ref: string = (args.selector || (args as any).ref || "") as string;
          if (!ref) return "[エラー] selector(ref) が必要";
          return await useCamofox(() => camofoxClick(ref));
        }
        case "type": {
          const ref: string = (args.selector || (args as any).ref || "") as string;
          const text: string = (args.text || "") as string;
          if (!ref || !text) return "[エラー] selector(ref) と text が必要";
          return await useCamofox(() => camofoxType(ref, text));
        }
        case "screenshot":
          return await useCamofox(async () => {
            const data = await camofoxCall("/snapshot", { screenshot: true });
            return `[スクリーンショット付き]\n${data.snapshot || ""}`;
          });
        case "close": {
          if (playwrightBrowser) { await playwrightBrowser.close().catch(() => {}); playwrightBrowser = null; playwrightPage = null; }
          try { await camofoxCall("/close"); } catch {}
          return "ブラウザを閉じました。";
        }
        default:
          return `[エラー] 不明なアクション: ${action}`;
      }
    } catch (e: any) {
      return `[エラー] ブラウザ操作失敗: ${e.message}`;
    }
  },
};

// フォールバック: Playwright
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
      const sel: string = (args as any).selector || "";
      if (!sel) return "[Playwright] selector が必要";
      await page.click(sel, { timeout: 10_000 });
      return `[Playwright] クリック: ${sel}`;
    }
    case "type": {
      const sel: string = (args as any).selector || "";
      const text: string = (args as any).text || "";
      if (!sel || !text) return "[Playwright] selector と text が必要";
      await page.fill(sel, text, { timeout: 10_000 });
      return `[Playwright] 入力: ${sel} ← "${text}"`;
    }
    default: return "[Playwright] 不明なアクション";
  }
}
