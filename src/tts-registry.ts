// ==========================================
// Aikata - TTS Backend レジストリ
// 出典: OmniVoice-Studio (debpalash/OmniVoice-Studio)
// Abstract Base + Plugin Registry パターン
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface TTSOptions {
  voice?: string;
  speed?: number;     // 0.5 - 2.0
  pitch?: number;     // 0.5 - 2.0
  language?: string;
  emotion?: string;
}

export interface TTSResult {
  /** オーディオデータ（Base64） */
  audio: string;
  /** フォーマット（wav/mp3/ogg） */
  format: string;
  /** 再生時間（秒） */
  durationSec: number;
  /** 使用モデル名 */
  modelUsed: string;
}

export interface TTSBackendInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  availableMessage: string;
  supportsStreaming: boolean;
  supportedLanguages: string[];
  supportedVoices: string[];
}

// ==================== 抽象基底クラス（OmniVoice TTSBackend(ABC)由来） ====================

export abstract class TTSBackend {
  abstract readonly id: string;
  abstract readonly name: string;

  /** テキストを音声に変換 */
  abstract generate(text: string, options?: TTSOptions): Promise<TTSResult>;

  /** このバックエンドが利用可能かチェック */
  abstract isAvailable(): boolean | Promise<boolean>;

  /** 利用可能性のメッセージ */
  abstract getAvailabilityMessage(): string;

  /** ストリーミング対応 */
  supportsStreaming(): boolean {
    return false;
  }

  /** 対応言語 */
  getSupportedLanguages(): string[] {
    return ["ja", "en"];
  }

  /** 対応ボイス */
  getSupportedVoices(): string[] {
    return ["default"];
  }

  /** 情報を取得 */
  getInfo(): TTSBackendInfo {
    return {
      id: this.id,
      name: this.name,
      description: this.constructor.name,
      available: false,
      availableMessage: "not checked",
      supportsStreaming: this.supportsStreaming(),
      supportedLanguages: this.getSupportedLanguages(),
      supportedVoices: this.getSupportedVoices(),
    };
  }
}

// ==================== レジストリ（OmniVoice _REGISTRYパターン由来） ====================

class TTSRegistry {
  private backends = new Map<string, TTSBackend>();
  private activeId: string | null = null;

  /** バックエンドを登録 */
  register(backend: TTSBackend): void {
    this.backends.set(backend.id, backend);
    if (!this.activeId) {
      this.activeId = backend.id;
    }
    logger.info(`[TTSRegistry] 登録: ${backend.id} (${backend.name})`);
  }

  /** バックエンドを登録解除 */
  unregister(id: string): boolean {
    const removed = this.backends.delete(id);
    if (this.activeId === id) {
      this.activeId = this.backends.keys().next().value ?? null;
    }
    return removed;
  }

  /** アクティブなバックエンドを設定 */
  setActive(id: string): boolean {
    if (!this.backends.has(id)) return false;
    this.activeId = id;
    logger.info(`[TTSRegistry] アクティブ変更: ${id}`);
    return true;
  }

  /** アクティブなバックエンドを取得 */
  getActive(): TTSBackend | null {
    if (!this.activeId) return null;
    return this.backends.get(this.activeId) ?? null;
  }

  /** テキストを音声に変換（アクティブバックエンドを使用） */
  async generate(text: string, options?: TTSOptions): Promise<TTSResult> {
    const backend = this.getActive();
    if (!backend) {
      throw new Error("利用可能なTTSバックエンドがありません");
    }
    return backend.generate(text, options);
  }

  /** 全バックエンドの情報を取得 */
  listBackends(): TTSBackendInfo[] {
    return Array.from(this.backends.values()).map(b => {
      const info = b.getInfo();
      info.available = typeof b.isAvailable() === "boolean"
        ? (b.isAvailable() as boolean)
        : false;
      info.availableMessage = b.getAvailabilityMessage();
      info.id = b.id;
      return info;
    });
  }

  /** バックエンド数を取得 */
  get count(): number {
    return this.backends.size;
  }
}

// ==================== 組み込みバックエンド ====================

/**
 * フォールバックTTS（コマンドライン）
 */
class FallbackTTS extends TTSBackend {
  readonly id = "fallback";
  readonly name = "Fallback TTS";

  isAvailable(): boolean {
    return false; // デフォルトでは利用不可、インストール時にtrueに
  }

  getAvailabilityMessage(): string {
    return "要セットアップ: say/mpg123/espeak等のCLIツール";
  }

  async generate(text: string, options?: TTSOptions): Promise<TTSResult> {
    throw new Error("フォールバックTTSは未設定です。TTSBackendを登録してください。");
  }
}

// ==================== Edge TTS（無料・ブラウザ音声API由来） ====================

class EdgeTTS extends TTSBackend {
  readonly id = "edge";
  readonly name = "Edge TTS";

  private static readonly VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

  private voices: Array<{ shortName: string; locale: string }> = [];
  private ssmlTemplate = (text: string, voice: string, rate: string) =>
    `<speak version='1.0' xml:lang='ja-JP'><voice name='${voice}'><prosody rate='${rate}' pitch='default'>${this.escapeXml(text)}</prosody></voice></speak>`;

  supportsStreaming(): boolean { return false; }

  getSupportedLanguages(): string[] {
    return ["ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt", "ru"];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4", {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  getAvailabilityMessage(): string {
    return "Edge TTS: インターネット経由（無料、要ネット接続）";
  }

  async generate(text: string, options?: TTSOptions): Promise<TTSResult> {
    const voice = options?.voice || this.selectVoice(options?.language || "ja");
    const rate = options?.speed ? `+${Math.round((options.speed - 1) * 50)}%` : "+0%";
    const ssml = this.ssmlTemplate(text, voice, rate);

    const resp = await fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4", {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: ssml,
    });

    if (!resp.ok) {
      throw new Error(`Edge TTS失敗: HTTP ${resp.status}`);
    }

    const audioBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString("base64");

    return {
      audio: base64,
      format: "mp3",
      durationSec: Math.ceil(text.length / 10), // 概算
      modelUsed: `edge-tts:${voice}`,
    };
  }

  private selectVoice(language: string): string {
    const voiceMap: Record<string, string> = {
      ja: "ja-JP-NanamiNeural",
      en: "en-US-JennyNeural",
      zh: "zh-CN-XiaoxiaoNeural",
      ko: "ko-KR-SunHiNeural",
      fr: "fr-FR-DeniseNeural",
      de: "de-DE-KatjaNeural",
      es: "es-ES-ElviraNeural",
    };
    return voiceMap[language] || "ja-JP-NanamiNeural";
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}

// ==================== OpenAI TTS ====================

class OpenAITTS extends TTSBackend {
  readonly id = "openai";
  readonly name = "OpenAI TTS";

  supportsStreaming(): boolean { return false; }

  getSupportedLanguages(): string[] {
    return ["ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt"];
  }

  isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  getAvailabilityMessage(): string {
    return "OpenAI TTS: $0.015/1K文字（tts-1モデル）";
  }

  async generate(text: string, options?: TTSOptions): Promise<TTSResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");

    const voice = options?.voice || (options?.language === "ja" ? "nova" : "alloy");
    const model = "tts-1";
    const speed = Math.max(0.25, Math.min(4.0, options?.speed ?? 1.0));

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        speed,
        response_format: "mp3",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI TTS失敗: HTTP ${resp.status}: ${errText}`);
    }

    const audioBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString("base64");

    return {
      audio: base64,
      format: "mp3",
      durationSec: Math.ceil(text.length / 10),
      modelUsed: `${model}:${voice}`,
    };
  }
}

// ==================== ローカルTTS（espeak/say） ====================

class LocalTTS extends TTSBackend {
  readonly id = "local";
  readonly name = "Local TTS";

  private useCommand: string | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.useCommand) return true;
    // espeak をチェック
    try {
      const { execSync } = await import("child_process");
      execSync("which espeak 2>/dev/null || which say 2>/dev/null", { timeout: 3000 });
      this.useCommand = "espeak";
      return true;
    } catch {
      return false;
    }
  }

  getAvailabilityMessage(): string {
    return "ローカルTTS: espeak (Linux/WSL) または say (macOS)。完全オフライン・無料";
  }

  async generate(text: string, options?: TTSOptions): Promise<TTSResult> {
    const { execSync } = await import("child_process");
    const { writeFileSync, unlinkSync } = await import("fs");
    const { resolve } = await import("path");
    const os = process.platform;

    const tmpFile = resolve("/tmp", `aikata-tts-${Date.now()}.wav`);
    const speed = options?.speed ?? 1.0;

    try {
      if (os === "darwin") {
        // macOS say
        execSync(`say -o "${tmpFile}" --data-format=LEI16@22050 "${text.replace(/"/g, '\\"')}"`, { timeout: 30000 });
      } else {
        // Linux/WSL: espeak
        const lang = options?.language === "ja" ? "ja" : "en";
        const wordsPerMin = Math.round(175 * speed);
        execSync(`espeak -v${lang} -s${wordsPerMin} -w "${tmpFile}" "${text.replace(/"/g, '\\"')}"`, { timeout: 30000 });
      }

      const { readFileSync } = await import("fs");
      const audioBuffer = readFileSync(tmpFile);
      const base64 = audioBuffer.toString("base64");

      try { unlinkSync(tmpFile); } catch {}

      return {
        audio: base64,
        format: "wav",
        durationSec: Math.ceil(text.length / 8 / speed),
        modelUsed: `local:${this.useCommand || os}`,
      };
    } catch (e: any) {
      try { unlinkSync(tmpFile); } catch {}
      throw new Error(`ローカルTTS失敗: ${e.message}`);
    }
  }
}

// ==================== シングルトン ====================

export const ttsRegistry = new TTSRegistry();

// デフォルトで全バックエンドを登録
ttsRegistry.register(new FallbackTTS());
ttsRegistry.register(new EdgeTTS());
ttsRegistry.register(new OpenAITTS());
ttsRegistry.register(new LocalTTS());

// Edge TTSをデフォルトに設定
ttsRegistry.setActive("edge");

export { TTSRegistry };
