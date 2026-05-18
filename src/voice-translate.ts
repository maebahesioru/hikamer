// ==========================================
// Aikata - 音声翻訳エンジン
// 出典: HaloVoice (Monkiia/HaloVoice) Real-time Voice Translation
// テキスト翻訳 + TTS連携で多言語音声出力
// ==========================================

import { ttsRegistry } from "./tts-registry";
import { logger } from "./utils/logger";

// ==================== 翻訳エンジン ====================

interface TranslationResult {
  original: string;
  translated: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence: number;
}

const LANGUAGE_MAP: Record<string, string> = {
  ja: "日本語", en: "English", zh: "中文", ko: "한국어",
  fr: "Français", de: "Deutsch", es: "Español", pt: "Português",
  ru: "Русский", it: "Italiano", th: "ไทย", vi: "Tiếng Việt",
  id: "Bahasa Indonesia", ms: "Bahasa Melayu",
};

class VoiceTranslator {
  /**
   * テキストを翻訳（簡易辞書ベース → 本番はLLMに委譲）
   * HaloVoice: リアルタイム翻訳パイプライン
   */
  async translate(text: string, targetLang: string): Promise<TranslationResult> {
    // 簡易言語検出
    const sourceLang = this.detectLanguage(text);

    // 同一言語ならそのまま
    if (sourceLang === targetLang) {
      return {
        original: text,
        translated: text,
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        confidence: 1.0,
      };
    }

    // LLMに翻訳を依頼するプレースホルダー
    // 本番では: agentLoopを呼ぶか、直接APIを叩く
    const translated = await this.translateViaLLM(text, sourceLang, targetLang);

    return {
      original: text,
      translated: translated || text,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      confidence: translated ? 0.85 : 0.5,
    };
  }

  /**
   * 音声翻訳: テキスト → 翻訳 → TTS
   * HaloVoiceメイン機能
   */
  async speakTranslated(
    text: string,
    targetLang: string,
    voiceOptions?: { voice?: string; speed?: number; pitch?: number }
  ): Promise<{ translated: string; audioBase64: string; format: string }> {
    const translated = await this.translate(text, targetLang);
    const ttsResult = await ttsRegistry.generate(translated.translated, {
      language: targetLang,
      ...voiceOptions,
    });

    return {
      translated: translated.translated,
      audioBase64: ttsResult.audio,
      format: ttsResult.format,
    };
  }

  /**
   * 言語を検出
   * HaloVoice: 30+言語の自動検出
   */
  detectLanguage(text: string): string {
    // 簡易検出（本番は文字コード分析）
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return "ja";
    if (/[\u4e00-\u9fff]/.test(text)) return /[가-힣]/.test(text) ? "ko" : "zh";
    if (/[а-яА-Я]/.test(text)) return "ru";
    if (/[à-üÀ-Ü]/.test(text)) return /[éèêë]/.test(text) ? "fr" : /[ñ]/.test(text) ? "es" : "de";
    return "en";
  }

  /**
   * 対応言語リスト
   */
  getSupportedLanguages(): Record<string, string> {
    return { ...LANGUAGE_MAP };
  }

  /**
   * LLM経由で翻訳（プレースホルダー）
   */
  private async translateViaLLM(text: string, from: string, to: string): Promise<string | null> {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY || ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: `Translate from ${from} to ${to}. Output only the translation.` },
            { role: "user", content: text },
          ],
          max_tokens: 2000,
        }),
      });

      if (!resp.ok) return null;
      const json: any = await resp.json();
      return json.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      return null;
    }
  }
}

export const voiceTranslator = new VoiceTranslator();
export { LANGUAGE_MAP };
