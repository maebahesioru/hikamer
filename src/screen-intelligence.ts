// ==========================================
// Hikamer - 画面インテリジェンス（OpenHuman screen_intelligence/ 由来）
// スクリーンキャプチャ・OCR・ビジョン解析
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ==================== 型定義 ====================

export interface CaptureResult {
  filePath: string;
  width: number;
  height: number;
  format: string;
  timestamp: number;
  source: "screen" | "window" | "area";
}

export interface OCRResult {
  text: string;
  confidence: number;
  blocks: OCRBlock[];
}

export interface OCRBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface VisionAnalysis {
  description: string;
  labels: string[];
  text: string;
  objects: Array<{ name: string; confidence: number }>;
}

// ==================== 画面マネージャー ====================

class ScreenIntelligence {
  private captures: CaptureResult[] = [];
  private initialized = false;
  private tempDir = "/tmp/hikamer-screen";

  init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.initialized = true;
    logger.info("[Screen] intelligence initialized");
  }

  /** 画面全体をキャプチャ */
  async captureScreen(): Promise<CaptureResult | null> {
    const filePath = path.join(this.tempDir, `screen-${Date.now()}.png`);

    try {
      if (process.platform === "linux" && this.hasCommand("import")) {
        execSync(`import -window root ${filePath}`, { timeout: 10000 });
      } else if (this.hasCommand("ffmpeg")) {
        execSync(
          `ffmpeg -f x11grab -video_size 1920x1080 -i :0.0 -vframes 1 ${filePath} -y`,
          { timeout: 10000 }
        );
      } else if (this.hasCommand("screencapture")) {
        execSync(`screencapture ${filePath}`, { timeout: 10000 });
      } else {
        logger.warn("[Screen] no capture tool available");
        return null;
      }

      const result: CaptureResult = {
        filePath,
        width: 0,
        height: 0,
        format: "png",
        timestamp: Date.now(),
        source: "screen",
      };

      this.captures.push(result);
      logger.info(`[Screen] captured: ${filePath}`);
      return result;
    } catch (err) {
      logger.error("[Screen] capture failed:", err);
      return null;
    }
  }

  /** OCR実行（tesseract） */
  async ocr(imagePath: string): Promise<OCRResult | null> {
    if (!this.hasCommand("tesseract")) {
      logger.warn("[Screen] tesseract not available");
      return null;
    }

    try {
      const outputBase = imagePath.replace(/\.[^.]+$/, "");
      execSync(`tesseract ${imagePath} ${outputBase} -l jpn+eng 2>/dev/null`, {
        timeout: 30000,
      });

      const textFile = `${outputBase}.txt`;
      if (!fs.existsSync(textFile)) return null;

      const text = fs.readFileSync(textFile, "utf-8").trim();

      // 一時ファイルを削除
      try { fs.unlinkSync(textFile); } catch {}

      return {
        text,
        confidence: 0.8,
        blocks: text.split("\n").filter(Boolean).map((line) => ({
          text: line,
          x: 0, y: 0, width: 0, height: 0, confidence: 0.8,
        })),
      };
    } catch (err) {
      logger.error("[Screen] OCR failed:", err);
      return null;
    }
  }

  /** LLMビジョン解析 */
  async analyze(imagePath: string, question?: string): Promise<string | null> {
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      logger.warn("[Screen] vision API not configured");
      return null;
    }

    try {
      const imageBase64 = fs.readFileSync(imagePath).toString("base64");
      const res = await fetch(
        process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "openai/gpt-4o",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: question ?? "この画像について説明してください。" },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
                ],
              },
            ],
            max_tokens: 1000,
          }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      logger.error("[Screen] vision analysis failed:", err);
      return null;
    }
  }

  /** キャプチャ履歴 */
  getCaptures(): CaptureResult[] {
    return [...this.captures];
  }

  /** 画像のメタデータ */
  getImageInfo(imagePath: string): { width: number; height: number; size: number } | null {
    try {
      const stat = fs.statSync(imagePath);
      return { width: 0, height: 0, size: stat.size };
    } catch {
      return null;
    }
  }

  private hasCommand(cmd: string): boolean {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  formatStatus(): string {
    return (
      `🖥️ **画面インテリジェンス**\n` +
      `キャプチャ: ${this.hasCommand("import") || this.hasCommand("screencapture") ? "✅" : "❌"}\n` +
      `OCR: ${this.hasCommand("tesseract") ? "✅ tesseract" : "❌"}\n` +
      `ビジョン: ${process.env.AIKATA_LLM_API_KEY ? "✅" : "❌ (APIキー未設定)"}\n` +
      `キャプチャ履歴: ${this.captures.length}件`
    );
  }
}

// ==================== シングルトン ====================

export const screenIntelligence = new ScreenIntelligence();

export default ScreenIntelligence;
