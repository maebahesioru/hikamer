// ==========================================
// Aikata - オーディオツールキット（OpenHuman audio_toolkit/ 由来）
// 音声処理ユーティリティ（voice.tsの補完）
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface AudioInfo {
  filePath: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  format: string;
  fileSize: number;
}

export interface AudioConversionOptions {
  format: "wav" | "mp3" | "ogg" | "flac";
  sampleRate?: number;
  channels?: number;
  bitRate?: string;
}

export interface AudioClip {
  id: string;
  filePath: string;
  startMs: number;
  endMs: number;
  label: string;
  createdAt: number;
}

// ==================== オーディオツールキット ====================

class AudioToolkit {
  private clips: AudioClip[] = [];
  private tempDir = "/tmp/aikata-audio";
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.initialized = true;
    logger.info("[AudioToolkit] initialized");
  }

  /** 音声ファイル情報を取得 */
  getInfo(filePath: string): AudioInfo | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase().replace(".", "");
      return {
        filePath,
        durationMs: 0, // ffprobeが必要
        sampleRate: 0,
        channels: 0,
        bitDepth: 16,
        format: ext || "unknown",
        fileSize: stat.size,
      };
    } catch {
      return null;
    }
  }

  /** 音声変換（ffmpeg） */
  async convert(
    inputPath: string,
    options: AudioConversionOptions
  ): Promise<string | null> {
    if (!fs.existsSync(inputPath)) return null;

    const outputPath = path.join(
      this.tempDir,
      `converted-${Date.now()}.${options.format}`
    );

    try {
      const args = ["-i", inputPath];
      if (options.sampleRate) args.push("-ar", String(options.sampleRate));
      if (options.channels) args.push("-ac", String(options.channels));
      if (options.bitRate) args.push("-b:a", options.bitRate);
      args.push("-y", outputPath);

      const { execSync } = await import("child_process");
      execSync(`ffmpeg ${args.join(" ")} 2>/dev/null`, { timeout: 30000 });

      if (fs.existsSync(outputPath)) {
        logger.info(`[AudioToolkit] converted: ${inputPath} -> ${outputPath}`);
        return outputPath;
      }
      return null;
    } catch (err) {
      logger.error("[AudioToolkit] conversion failed:", err);
      return null;
    }
  }

  /** 音声クリップを作成 */
  async createClip(
    inputPath: string,
    startMs: number,
    endMs: number,
    label?: string
  ): Promise<AudioClip | null> {
    if (!fs.existsSync(inputPath)) return null;

    const id = `clip-${Date.now()}`;
    const outputPath = path.join(this.tempDir, `${id}.wav`);

    try {
      const { execSync } = await import("child_process");
      const startSec = (startMs / 1000).toFixed(3);
      const duration = ((endMs - startMs) / 1000).toFixed(3);

      execSync(
        `ffmpeg -i ${inputPath} -ss ${startSec} -t ${duration} -c copy ${outputPath} -y 2>/dev/null`,
        { timeout: 30000 }
      );

      if (!fs.existsSync(outputPath)) return null;

      const clip: AudioClip = {
        id,
        filePath: outputPath,
        startMs,
        endMs,
        label: label ?? `Clip ${this.clips.length + 1}`,
        createdAt: Date.now(),
      };

      this.clips.push(clip);
      logger.info(`[AudioToolkit] clip created: ${label ?? id} (${startMs}-${endMs}ms)`);
      return clip;
    } catch (err) {
      logger.error("[AudioToolkit] clip creation failed:", err);
      return null;
    }
  }

  /** 音声の長さを正規化（dB） */
  async normalize(inputPath: string, targetDb = -3): Promise<string | null> {
    if (!fs.existsSync(inputPath)) return null;
    const outputPath = path.join(this.tempDir, `normalized-${Date.now()}.wav`);

    try {
      const { execSync } = await import("child_process");
      execSync(
        `ffmpeg -i ${inputPath} -af loudnorm=I=${targetDb}:LRA=11:TP=-1.5 ${outputPath} -y 2>/dev/null`,
        { timeout: 60000 }
      );
      return fs.existsSync(outputPath) ? outputPath : null;
    } catch {
      return null;
    }
  }

  /** 無音部分を除去 */
  async removeSilence(inputPath: string): Promise<string | null> {
    if (!fs.existsSync(inputPath)) return null;
    const outputPath = path.join(this.tempDir, `nosilence-${Date.now()}.wav`);

    try {
      const { execSync } = await import("child_process");
      execSync(
        `ffmpeg -i ${inputPath} -af silenceremove=1:0:-30dB:0:0.5:0:-30dB:0:0.5 ${outputPath} -y 2>/dev/null`,
        { timeout: 60000 }
      );
      return fs.existsSync(outputPath) ? outputPath : null;
    } catch {
      return null;
    }
  }

  /** クリップ一覧 */
  listClips(): AudioClip[] {
    return [...this.clips];
  }

  /** 一時ファイルをクリーンアップ */
  cleanup(): number {
    let count = 0;
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const f of files) {
        const filePath = path.join(this.tempDir, f);
        try {
          fs.unlinkSync(filePath);
          count++;
        } catch {}
      }
    } catch {}
    if (count > 0) logger.debug(`[AudioToolkit] cleaned ${count} temp files`);
    return count;
  }

  formatStatus(): string {
    return (
      `🎵 **オーディオツールキット**\n` +
      `ffmpeg: ${this.hasFFmpeg() ? "✅" : "❌"}\n` +
      `クリップ数: ${this.clips.length}\n` +
      `一時ファイル: ${fs.existsSync(this.tempDir) ? fs.readdirSync(this.tempDir).length : 0}`
    );
  }

  private hasFFmpeg(): boolean {
    try {
      require("child_process").execSync("which ffmpeg 2>/dev/null", { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ==================== シングルトン ====================

export const audioToolkit = new AudioToolkit();

export default AudioToolkit;
