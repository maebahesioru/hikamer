// ==========================================
// Aikata - 画面認識/OCR（OpenHuman screen_intelligence + accessibility由来）
// 画像テキスト抽出 + スクリーンショット解析
// ==========================================

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface OCRResult {
  text: string;
  confidence: number;
  blocks: OCRBlock[];
  raw: string;
}

export interface OCRBlock {
  text: string;
  boundingBox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface ScreenCaptureResult {
  path: string;
  width: number;
  height: number;
  format: string;
  size: number;
}

// ==================== OCRエンジン ====================

class OCREngine {
  private outputDir: string;

  constructor() {
    this.outputDir = resolve(process.env.DATA_DIR || "./data", "ocr");
    if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true });
  }

  /** 画像ファイルからテキスト抽出 */
  async extractText(imagePath: string): Promise<OCRResult> {
    // 1. tesseract があれば使う
    const tesseractResult = await this.tryTesseract(imagePath);
    if (tesseractResult) return tesseractResult;

    // 2. フォールバック: Python pytesseract
    const pythonResult = await this.tryPythonOCR(imagePath);
    if (pythonResult) return pythonResult;

    // 3. 最終フォールバック: LLMによる画像認識
    return this.tryLLMVision(imagePath);
  }

  /** Tesseract OCR */
  private async tryTesseract(imagePath: string): Promise<OCRResult | null> {
    try {
      const hasTesseract = execSync("which tesseract 2>/dev/null || echo ''", { timeout: 3000 })
        .toString().trim();
      if (!hasTesseract) return null;

      const outputPath = resolve(this.outputDir, `ocr-${Date.now()}`);
      execSync(
        `tesseract "${imagePath}" "${outputPath}" -l jpn+eng --psm 3 2>/dev/null || ` +
        `tesseract "${imagePath}" "${outputPath}" --psm 3 2>/dev/null || true`,
        { timeout: 30000 },
      );

      const txtPath = `${outputPath}.txt`;
      if (!existsSync(txtPath)) return null;

      const text = readFileSync(txtPath, "utf-8").trim();
      if (!text) return null;

      // Tesseractの信頼度は直接取れないので簡易計算
      const printableRatio = (text.match(/[\x20-\x7E\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g)?.length || 0) / text.length;
      const confidence = Math.round(printableRatio * 100);

      logger.info(`[OCR] Tesseract: ${text.length}文字 (confidence=${confidence}%)`);
      return {
        text,
        confidence,
        blocks: [],
        raw: text,
      };
    } catch (e: any) {
      logger.warn(`[OCR] Tesseract失敗: ${e.message}`);
      return null;
    }
  }

  /** Python pytesseract */
  private async tryPythonOCR(imagePath: string): Promise<OCRResult | null> {
    try {
      const hasPython = execSync("which python3 2>/dev/null || which python 2>/dev/null || echo ''", { timeout: 3000 })
        .toString().trim();
      if (!hasPython) return null;

      const script = `
import sys, json
try:
    from PIL import Image
    import pytesseract
    text = pytesseract.image_to_string(Image.open(sys.argv[1]), lang='jpn+eng')
    print(json.dumps({"text": text.strip(), "success": True}))
except Exception as e:
    print(json.dumps({"error": str(e), "success": False}))
`;
      const scriptPath = resolve(this.outputDir, `ocr-script-${Date.now()}.py`);
      writeFileSync(scriptPath, script, "utf-8");

      const result = execSync(
        `${hasPython} "${scriptPath}" "${imagePath}" 2>/dev/null || echo '{"success":false}'`,
        { timeout: 30000, encoding: "utf-8" },
      ).toString().trim();

      try {
        const parsed = JSON.parse(result);
        if (parsed.success && parsed.text) {
          logger.info(`[OCR] Python: ${parsed.text.length}文字`);
          return {
            text: parsed.text,
            confidence: 80,
            blocks: [],
            raw: parsed.text,
          };
        }
      } catch {}

      return null;
    } catch (e: any) {
      logger.warn(`[OCR] Python失敗: ${e.message}`);
      return null;
    } finally {
      // スクリプト削除
      const scriptPath = resolve(this.outputDir, `ocr-script-${Date.now()}.py`);
      try { execSync(`rm -f "${scriptPath}"`, { timeout: 2000 }); } catch {}
    }
  }

  /** LLM Vision フォールバック */
  private async tryLLMVision(imagePath: string): Promise<OCRResult> {
    try {
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return { text: "(OCR不可: ツール未インストール)", confidence: 0, blocks: [], raw: "" };
      }

      // 画像をBase64
      const imageBuffer = readFileSync(imagePath);
      const base64 = imageBuffer.toString("base64");
      const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

      // OpenAI Vision
      if (process.env.OPENAI_API_KEY) {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "この画像に含まれるテキストをすべて抽出してください。レイアウトを維持してMarkdownで出力。" },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
              ],
            }],
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const json = await response.json() as any;
          const text = json.choices?.[0]?.message?.content || "";
          logger.info(`[OCR] LLM Vision: ${text.length}文字`);
          return { text, confidence: 70, blocks: [], raw: text };
        }
      }
    } catch (e: any) {
      logger.warn(`[OCR] LLM Vision失敗: ${e.message}`);
    }

    return { text: "(OCR失敗)", confidence: 0, blocks: [], raw: "" };
  }

  /** スクリーンショット取得（Linux/X11） */
  async captureScreen(filename?: string): Promise<ScreenCaptureResult | null> {
    const name = filename || `screenshot-${Date.now()}.png`;
    const outputPath = resolve(this.outputDir, name);

    try {
      // importやgnome-screenshot
      const hasImport = execSync("which import 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim();
      const hasScrot = execSync("which scrot 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim();

      if (hasImport) {
        execSync(`import -window root "${outputPath}"`, { timeout: 10000 });
      } else if (hasScrot) {
        execSync(`scrot "${outputPath}"`, { timeout: 10000 });
      } else {
        logger.warn("[Screen] スクリーンショットツールなし(import/scrot)");
        return null;
      }

      const { statSync } = require("fs") as typeof import("fs");
      const stat = statSync(outputPath);

      // identifyでサイズ取得
      let width = 0, height = 0;
      try {
        const identify = execSync(
          `identify -format '%w %h' "${outputPath}" 2>/dev/null || echo '0 0'`,
          { timeout: 3000, encoding: "utf-8" },
        ).toString().trim();
        const dims = identify.split(" ");
        width = parseInt(dims[0]!) || 0;
        height = parseInt(dims[1]!) || 0;
      } catch {}

      logger.info(`[Screen] キャプチャ: ${outputPath} (${width}x${height})`);
      return {
        path: outputPath,
        width,
        height,
        format: "png",
        size: stat.size,
      };
    } catch (e: any) {
      logger.error(`[Screen] キャプチャ失敗: ${e.message}`);
      return null;
    }
  }

  /** 画像メタデータ取得 */
  getImageInfo(imagePath: string): { width: number; height: number; format: string; size: number } | null {
    try {
      const identify = execSync(
        `identify -format '%w|%h|%m' "${imagePath}" 2>/dev/null || echo '0|0|unknown'`,
        { timeout: 5000, encoding: "utf-8" },
      ).toString().trim();
      const parts = identify.split("|");

      const { statSync } = require("fs") as typeof import("fs");
      const stat = statSync(imagePath);

      return {
        width: parseInt(parts[0]!) || 0,
        height: parseInt(parts[1]!) || 0,
        format: parts[2] || "unknown",
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  /** 利用可能なOCRツールをチェック */
  checkCapabilities(): string[] {
    const caps: string[] = [];
    try {
      if (execSync("which tesseract 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) {
        caps.push("tesseract");
      }
    } catch {}
    try {
      if (execSync("which python3 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) {
        caps.push("python");
      }
    } catch {}
    if (process.env.OPENAI_API_KEY) caps.push("openai-vision");
    if (process.env.ANTHROPIC_API_KEY) caps.push("anthropic-vision");
    try {
      if (execSync("which import 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) {
        caps.push("screenshot(import)");
      }
    } catch {}
    return caps;
  }
}

// ==================== シングルトン ====================

export const ocrEngine = new OCREngine();
