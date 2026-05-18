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

// ==================== シングルトン ====================

export const ttsRegistry = new TTSRegistry();

// デフォルトでFallbackを登録
ttsRegistry.register(new FallbackTTS());

export { TTSRegistry };
