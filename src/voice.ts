// ==========================================
// Hikamer - 音声処理（OpenHuman voice/ 由来）
// 音声キャプチャ・TTS・音声認識・ホットキー
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";

// ==================== 型定義 ====================

export interface VoiceConfig {
  enabled: boolean;
  inputDevice: string;
  outputDevice: string;
  sampleRate: number;
  silenceThreshold: number;
  vadEnabled: boolean;
  hotkey: string;
}

export interface AudioCaptureResult {
  filePath: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  peakAmplitude: number;
}

export interface TTSOptions {
  voice: string;
  speed: number;
  pitch: number;
  format: "wav" | "mp3" | "ogg";
}

// ==================== 音声マネージャー ====================

class VoiceManager {
  private config: VoiceConfig = {
    enabled: false,
    inputDevice: "default",
    outputDevice: "default",
    sampleRate: 16000,
    silenceThreshold: 0.03,
    vadEnabled: true,
    hotkey: "Ctrl+Shift+V",
  };

  private recordings: Map<string, AudioCaptureResult> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.detectPlatform();
    this.initialized = true;
    logger.info("[Voice] initialized");
  }

  /** 音声キャプチャ開始 */
  async startCapture(
    durationMs?: number
  ): Promise<AudioCaptureResult | null> {
    if (!this.checkAvailable()) {
      logger.warn("[Voice] audio capture not available");
      return null;
    }

    const start = Date.now();
    const id = `rec-${Date.now()}`;
    const filePath = `/tmp/hikamer-voice-${id}.wav`;

    try {
      // arecord (Linux) / ffmpeg で録音
      if (this.hasCommand("arecord")) {
        const dur = durationMs ?? 5000;
        execSync(
          `arecord -d ${Math.ceil(dur / 1000)} -f S16_LE -r ${this.config.sampleRate} -c 1 ${filePath}`,
          { timeout: dur + 5000 }
        );
      } else if (this.hasCommand("ffmpeg")) {
        const dur = durationMs ?? 5000;
        execSync(
          `ffmpeg -f pulse -i ${this.config.inputDevice} -t ${Math.ceil(dur / 1000)} -ac 1 -ar ${this.config.sampleRate} ${filePath} -y`,
          { timeout: dur + 5000 }
        );
      } else {
        logger.warn("[Voice] no capture tool found");
        return null;
      }

      const result: AudioCaptureResult = {
        filePath,
        durationMs: Date.now() - start,
        sampleRate: this.config.sampleRate,
        channels: 1,
        peakAmplitude: 0,
      };

      this.recordings.set(id, result);
      logger.info(`[Voice] captured ${filePath} (${result.durationMs}ms)`);
      return result;
    } catch (err) {
      logger.error("[Voice] capture failed:", err);
      return null;
    }
  }

  /** TTS（テキスト読み上げ） */
  async speak(
    text: string,
    options?: Partial<TTSOptions>
  ): Promise<string | null> {
    const opts: TTSOptions = {
      voice: options?.voice ?? "default",
      speed: options?.speed ?? 1.0,
      pitch: options?.pitch ?? 1.0,
      format: options?.format ?? "wav",
    };

    const outputPath = `/tmp/hikamer-tts-${Date.now()}.${opts.format}`;

    try {
      if (this.hasCommand("espeak")) {
        execSync(
          `espeak "${text.slice(0, 200)}" -w ${outputPath}`,
          { timeout: 10000 }
        );
      } else if (this.hasCommand("ffmpeg")) {
        // ffmpeg で簡易TTSは不可 → 代わりにsayコマンド
        if (this.hasCommand("say")) {
          execSync(
            `say "${text.slice(0, 200)}" -o ${outputPath.replace(/\.[^.]+$/, ".aiff")}`,
            { timeout: 10000 }
          );
        } else {
          logger.warn("[Voice] no TTS tool found");
          return null;
        }
      } else {
        logger.warn("[Voice] no TTS tool found");
        return null;
      }

      logger.info(`[Voice] TTS: "${text.slice(0, 50)}..." -> ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.error("[Voice] TTS failed:", err);
      return null;
    }
  }

  /** 音声認識（簡易：ファイルパスを受け取って認識） */
  async transcribe(
    audioPath: string
  ): Promise<string | null> {
    if (!this.checkAvailable()) return null;

    try {
      if (this.hasCommand("whisper")) {
        const output = execSync(
          `whisper ${audioPath} --language ja --output_format txt 2>/dev/null`,
          { timeout: 60000 }
        );
        return output.toString().trim();
      }
      logger.warn("[Voice] whisper not available");
      return null;
    } catch (err) {
      logger.error("[Voice] transcription failed:", err);
      return null;
    }
  }

  /** 音声レベルの検出（VAD） */
  detectVoiceActivity(audioBuffer: Buffer): boolean {
    if (!this.config.vadEnabled) return true;

    let sum = 0;
    let count = 0;

    for (let i = 0; i < audioBuffer.length; i += 2) {
      const sample = audioBuffer.readInt16LE(i);
      sum += Math.abs(sample);
      count++;
    }

    const avgAmplitude = count > 0 ? sum / count : 0;
    const normalized = avgAmplitude / 32768;
    return normalized > this.config.silenceThreshold;
  }

  /** 設定の更新 */
  setConfig(config: Partial<VoiceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): VoiceConfig {
    return { ...this.config };
  }

  /** 録音履歴 */
  getRecordings(): AudioCaptureResult[] {
    return [...this.recordings.values()];
  }

  // ---- 内部 ----

  private detectPlatform(): void {
    if (process.platform === "win32") {
      this.config.inputDevice = "default";
    } else if (process.platform === "darwin") {
      this.config.inputDevice = "default";
    }
  }

  private checkAvailable(): boolean {
    return this.hasCommand("arecord") || this.hasCommand("ffmpeg");
  }

  private hasCommand(cmd: string): boolean {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  formatConfig(): string {
    const cap = this.checkAvailable();
    return (
      `🎙️ **音声設定**\n` +
      `有効: ${this.config.enabled ? "✅" : "❌"}\n` +
      `入力: ${this.config.inputDevice}\n` +
      `出力: ${this.config.outputDevice}\n` +
      `サンプルレート: ${this.config.sampleRate}Hz\n` +
      `VAD: ${this.config.vadEnabled ? "✅" : "❌"}\n` +
      `ホットキー: ${this.config.hotkey}\n` +
      `\n利用可能: ${cap ? "arecord ✅" : "❌ 録音ツールなし"}` +
      ` ${this.hasCommand("espeak") ? "espeak ✅" : ""}` +
      ` ${this.hasCommand("whisper") ? "whisper ✅" : ""}`
    );
  }
}

// ==================== シングルトン ====================

export const voiceManager = new VoiceManager();

export default VoiceManager;
