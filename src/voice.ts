// ==========================================
// Aikata - ボイス/TTS出力（OpenHuman voice + audio_toolkit由来）
// テキスト読み上げ・音声ファイル生成
// ==========================================

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "./utils/logger";
import { execSync } from "child_process";

// ==================== 型定義 ====================

export type TTSProvider = "edge" | "openai" | "custom";
export type VoiceStyle = "normal" | "cheerful" | "sad" | "angry" | "whisper" | "narration";

interface TTSConfig {
  provider: TTSProvider;
  voice?: string;
  rate?: number;       // 話速 0.5〜2.0
  pitch?: number;      // ピッチ 0.5〜2.0
  volume?: number;     // 音量 0.0〜1.0
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: TTSConfig = {
  provider: "edge",
  voice: "ja-JP-NanamiNeural",
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
};

// エッジボイス一覧
const EDGE_VOICES: Record<string, string> = {
  "nanami": "ja-JP-NanamiNeural",
  "keita": "ja-JP-KeitaNeural",
  "aoi": "ja-JP-AoiNeural",
  "daichi": "ja-JP-DaichiNeural",
  "mayu": "ja-JP-MayuNeural",
  "naoki": "ja-JP-NaokiNeural",
  "shiori": "ja-JP-ShioriNeural",
  "en-US-jenny": "en-US-JennyNeural",
  "en-US-guy": "en-US-GuyNeural",
  "en-US-aria": "en-US-AriaNeural",
};

// ==================== TTSエンジン ====================

class TTSEngine {
  private config: TTSConfig;
  private outputDir: string;

  constructor(config: Partial<TTSConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.outputDir = resolve(process.env.DATA_DIR || "./data", "tts");
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /** 音声ファイルを生成 */
  async synthesize(
    text: string,
    options?: {
      voice?: string;
      rate?: number;
      pitch?: number;
      filename?: string;
    },
  ): Promise<string> {
    const voice = options?.voice || this.config.voice || "ja-JP-NanamiNeural";
    const rate = options?.rate || this.config.rate || 1.0;
    const pitch = options?.pitch || this.config.pitch || 1.0;

    // 出力ファイルパス
    const timestamp = Date.now().toString(36);
    const filename = options?.filename || `tts-${timestamp}.mp3`;
    const outputPath = resolve(this.outputDir, filename);

    if (this.config.provider === "edge") {
      return this.synthesizeEdge(text, voice, rate, pitch, outputPath);
    } else if (this.config.provider === "openai") {
      return this.synthesizeOpenAI(text, voice, outputPath);
    }
    throw new Error(`未対応のTTSプロバイダー: ${this.config.provider}`);
  }

  /** Edge TTS（edge-tts CLIが必要）*/
  private async synthesizeEdge(
    text: string,
    voice: string,
    rate: number,
    pitch: number,
    outputPath: string,
  ): Promise<string> {
    // メッセージ分割（Edge TTSは1回あたり3000文字制限）
    const chunks = this.splitText(text, 2500);
    const outputPaths: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = chunks.length === 1
        ? outputPath
        : outputPath.replace(".mp3", `-part${i + 1}.mp3`);

      try {
        // edge-ttsコマンドがインストール済みかチェック
        const hasEdgeTts = execSync("which edge-tts 2>/dev/null || true", { timeout: 2000 })
          .toString().trim();

        if (!hasEdgeTts) {
          // pip install edge-tts を試す
          logger.info("[TTS] edge-ttsが未インストール。pip installを試行…");
          execSync("pip install edge-tts 2>/dev/null || pip3 install edge-tts 2>/dev/null || true", { timeout: 30000 });
        }

        const cmd = [
          "edge-tts",
          `--voice "${voice}"`,
          `--text "${this.escapeShell(text)}"`,
          `--write-media "${chunkPath}"`,
          `--rate=${rate > 0 ? "+" : ""}${Math.round((rate - 1) * 100)}%`,
          `--pitch=${pitch > 0 ? "+" : ""}${Math.round((pitch - 1) * 100)}Hz`,
        ].join(" ");

        execSync(cmd, { timeout: 30000, stdio: "ignore" });
        outputPaths.push(chunkPath);
      } catch (e: any) {
        logger.warn(`[TTS] Edge TTS失敗: ${e.message}`);
        // フォールバック: 単純なテキストファイルを作成
        const fallbackPath = chunkPath.replace(".mp3", ".txt");
        writeFileSync(fallbackPath, `[TTS不可] ${text.slice(0, 200)}`, "utf-8");
        outputPaths.push(fallbackPath);
      }
    }

    return outputPaths.length === 1 ? outputPaths[0]! : outputPath;
  }

  /** OpenAI TTS */
  private async synthesizeOpenAI(
    text: string,
    voice: string,
    outputPath: string,
  ): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn("[TTS] OPENAI_API_KEY未設定。代替テキスト出力。");
      writeFileSync(outputPath.replace(".mp3", ".txt"), `[TTS] ${text.slice(0, 200)}`, "utf-8");
      return outputPath.replace(".mp3", ".txt");
    }

    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text.slice(0, 4096),
          voice: voice || "alloy",
          response_format: "mp3",
        }),
      });

      if (!response.ok) throw new Error(`OpenAI TTS: ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      writeFileSync(outputPath, Buffer.from(arrayBuffer));
      return outputPath;
    } catch (e: any) {
      logger.warn(`[TTS] OpenAI TTS失敗: ${e.message}`);
      writeFileSync(outputPath.replace(".mp3", ".txt"), `[TTS Error] ${e.message}`, "utf-8");
      return outputPath.replace(".mp3", ".txt");
    }
  }

  // ==================== ユーティリティ ====================

  private splitText(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      // 文の切れ目で分割
      let cut = remaining.lastIndexOf("。", maxLen);
      if (cut === -1 || cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
      if (cut === -1 || cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
      if (cut === -1 || cut < maxLen / 2) cut = maxLen;
      chunks.push(remaining.slice(0, cut + 1));
      remaining = remaining.slice(cut + 1).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private escapeShell(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$")
      .replace(/\n/g, " ")
      .slice(0, 2500);
  }

  /** 利用可能なボイス一覧 */
  getAvailableVoices(): Record<string, string> {
    return { ...EDGE_VOICES };
  }

  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ==================== シングルトン ====================

export const ttsEngine = new TTSEngine();

/** クイックTTS */
export async function speak(text: string, voice?: string): Promise<string> {
  return ttsEngine.synthesize(text, { voice });
}
