// ==========================================
// Aikata - Multi-Modal Input Handler (v1.70)
// 画像・音声・動画の入力処理
// 画像: base64エンコード->LLM Vision API
// 音声: ローカル文字起こし + APIフォールバック
// ==========================================

import { logger } from "./utils/logger";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ==================== 型定義 ====================

export type MediaType = "image" | "audio" | "video" | "unknown";

export interface MediaInput {
  type: MediaType;
  mimeType: string;
  path?: string;       // ローカルファイルパス
  url?: string;         // リモートURL
  base64?: string;      // base64データ
  sizeBytes: number;
}

export interface ImageAnalysis {
  description: string;
  objects: string[];
  text?: string;         // OCR抽出テキスト
  colors?: string[];
  confidence: number;
}

export interface AudioTranscription {
  text: string;
  language?: string;
  durationSeconds?: number;
  confidence: number;
}

// ==================== MIME検出 ====================

const MIME_MAP: Record<string, MediaType> = {
  // 画像
  "image/png": "image", "image/jpeg": "image", "image/jpg": "image",
  "image/gif": "image", "image/webp": "image", "image/svg+xml": "image",
  "image/bmp": "image", "image/tiff": "image",
  // 音声
  "audio/mpeg": "audio", "audio/mp3": "audio", "audio/wav": "audio",
  "audio/ogg": "audio", "audio/flac": "audio", "audio/aac": "audio",
  "audio/webm": "audio", "audio/mp4": "audio", "audio/opus": "audio",
  // 動画
  "video/mp4": "video", "video/webm": "video", "video/ogg": "video",
  "video/quicktime": "video", "video/x-msvideo": "video",
};

function detectType(pathOrUrl: string, mimeHint?: string): MediaType {
  if (mimeHint) return MIME_MAP[mimeHint] || "unknown";

  const lower = pathOrUrl.toLowerCase();
  const ext = lower.split(".").pop() || "";

  const extMap: Record<string, MediaType> = {
    png: "image", jpg: "image", jpeg: "image", gif: "image",
    webp: "image", svg: "image", bmp: "image", tiff: "image",
    mp3: "audio", wav: "audio", ogg: "audio", flac: "audio",
    aac: "audio", opus: "audio", m4a: "audio",
    mp4: "video", webm: "video", avi: "video", mov: "video",
  };

  return extMap[ext] || "unknown";
}

// ==================== マルチモーダルハンドラー ====================

class MultiModalHandler {
  /**
   * 画像をVision API対応のbase64形式に変換
   */
  async loadImage(input: string, isUrl: boolean = false): Promise<MediaInput> {
    if (isUrl) {
      // リモート画像を取得
      try {
        const res = await fetch(input, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mimeType = res.headers.get("content-type") || "image/jpeg";
        return {
          type: "image",
          mimeType,
          url: input,
          base64: buffer.toString("base64"),
          sizeBytes: buffer.length,
        };
      } catch (e: any) {
        throw new Error(`画像の取得に失敗: ${e.message}`);
      }
    }

    // ローカル画像
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`ファイルが見つかりません: ${path}`);

    const buffer = readFileSync(path);
    const mimeType = this.guessMimeFromBuffer(buffer) || "image/png";

    return {
      type: "image",
      mimeType,
      path,
      base64: buffer.toString("base64"),
      sizeBytes: buffer.length,
    };
  }

  /**
   * Vision API用のメッセージフォーマットを生成
   * OpenAI互換フォーマット
   */
  buildVisionMessage(image: MediaInput, prompt: string): any {
    const dataUrl = `data:${image.mimeType};base64,${image.base64}`;

    return {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
      ],
    };
  }

  /**
   * 複数画像をVision API用にパッケージ
   */
  buildMultiVisionMessage(images: MediaInput[], prompt: string): any {
    const content: any[] = [{ type: "text", text: prompt }];

    for (const img of images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: "auto" },
      });
    }

    return { role: "user", content };
  }

  /**
   * 音声ファイルを読み込み
   */
  async loadAudio(input: string): Promise<MediaInput> {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`音声ファイルが見つかりません: ${path}`);

    const buffer = readFileSync(path);
    const mimeType = this.guessMimeFromBuffer(buffer) || this.mimeFromPath(path);

    return {
      type: "audio",
      mimeType,
      path,
      base64: buffer.toString("base64"),
      sizeBytes: buffer.length,
    };
  }

  /**
   * 音声文字起こし（簡易版: 外部ツール連携）
   * whisper.cpp または Web Speech API を使用
   */
  async transcribe(audio: MediaInput): Promise<AudioTranscription> {
    if (!audio.path) throw new Error("ローカル音声ファイルが必要です");

    // 簡易: サイズが小さければテキストとして扱うダミー（実際のSTTはwhisper.cpp等が必要）
    if (audio.sizeBytes < 1024 * 1024) {
      // 16MB以下ならwhisper CLIを試行
      try {
        const { execSync } = require("child_process");
        const result = execSync(`whisper "${audio.path}" --model tiny --language ja --output_format txt 2>/dev/null || echo ""`, {
          timeout: 60_000,
          encoding: "utf-8",
        }).trim();

        if (result) {
          return {
            text: result,
            language: "ja",
            durationSeconds: audio.sizeBytes / 16000, // 16kHz monoの概算
            confidence: 0.8,
          };
        }
      } catch {
        // whisperがない場合はフォールバック
      }
    }

    // フォールバック: 音声データの情報を返す
    logger.warn(`[MultiModal] 音声文字起こしに失敗（whisper未インストール？）: ${audio.path}`);
    return {
      text: `[音声ファイル: ${(audio.sizeBytes / 1024).toFixed(1)}KB, ${audio.mimeType}]`,
      confidence: 0,
    };
  }

  /**
   * 画像の簡易分析（base64サイズ・形式・寸法）
   */
  analyzeImageMetadata(image: MediaInput): Record<string, any> {
    const meta: Record<string, any> = {
      mimeType: image.mimeType,
      sizeKB: (image.sizeBytes / 1024).toFixed(1),
      base64Length: image.base64?.length || 0,
    };

    // PNG/JPEGの簡易ヘッダ解析
    if (image.base64) {
      try {
        const buf = Buffer.from(image.base64, "base64");
        if (image.mimeType === "image/png" && buf.length > 24) {
          meta.width = buf.readUInt32BE(16);
          meta.height = buf.readUInt32BE(20);
        } else if (image.mimeType === "image/jpeg" && buf.length > 2) {
          // JPEGは複雑なのでスキップ
          meta.format = "JPEG";
        }
      } catch {}
    }

    return meta;
  }

  /**
   * Vision API対応をチェック
   */
  static SUPPORTED_IMAGE_FORMATS = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  static MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

  validateImage(image: MediaInput): { valid: boolean; reason?: string } {
    if (image.type !== "image") return { valid: false, reason: "画像ではありません" };
    if (!MultiModalHandler.SUPPORTED_IMAGE_FORMATS.includes(image.mimeType)) {
      return { valid: false, reason: `非対応フォーマット: ${image.mimeType}` };
    }
    if (image.sizeBytes > MultiModalHandler.MAX_IMAGE_SIZE) {
      return { valid: false, reason: `画像が大きすぎます (${(image.sizeBytes / 1024 / 1024).toFixed(1)}MB > 20MB)` };
    }
    return { valid: true };
  }

  formatMetadata(meta: Record<string, any>): string {
    const lines: string[] = ["🖼️ **画像情報**"];
    if (meta.width && meta.height) lines.push(`寸法: ${meta.width}×${meta.height}px`);
    lines.push(`形式: ${meta.mimeType}`);
    lines.push(`サイズ: ${meta.sizeKB}KB`);
    return lines.join("\n");
  }

  // ========== 内部 ==========

  private guessMimeFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "image/png";
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "image/jpeg";
    // GIF: 47 49 46
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
    }
    // MP3: FF FB or ID3
    if ((buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) || (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)) return "audio/mpeg";
    // WAV: 52 49 46 46 ... 57 41 56 45
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      if (buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) return "audio/wav";
    }

    return null;
  }

  private mimeFromPath(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
      flac: "audio/flac", aac: "audio/aac", opus: "audio/opus",
      m4a: "audio/mp4",
    };
    return map[ext] || "audio/mpeg";
  }
}

// ==================== シングルトン ====================

export const multiModal = new MultiModalHandler();
export default MultiModalHandler;
