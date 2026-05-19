// ==========================================
// Aikata - Soul System (v1.66)
// 出典: soul.md (aaronjmars/soul.md) + OpenClaw SOUL.md コンセプト
// エージェントの人格・文体・専門性・境界を定義する永続的人格ファイル
// gstack (garrytan/gstack, 23K stars) のスキル注入パターンも統合
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface SoulProfile {
  /** エージェントの名前 */
  name: string;
  /** 一人称（例: "俺", "私", "ボク"） */
  pronoun: string;
  /** 核となる性格特性（箇条書き） */
  traits: string[];
  /** コミュニケーションスタイル */
  communication: {
    tone: string;         // "casual", "professional", "friendly", "direct", "mentor"
    language: string;     // "ja" (日本語), "en" (英語), "ja-en" (混合)
    formality: number;    // 0 (超カジュアル) 〜 10 (超フォーマル)
    maxResponseLength?: number; // 最大応答長（文字数）
    emojiUsage: "none" | "minimal" | "moderate" | "heavy";
  };
  /** 専門知識・得意分野 */
  expertise: string[];
  /** 境界線（やってはいけないこと） */
  boundaries: string[];
  /** 価値観・信念 */
  values: string[];
  /** 口癖・キャッチフレーズ */
  catchphrases: string[];
  /** バックストーリー（任意） */
  backstory?: string;
  /** 作成日 */
  createdAt: number;
  /** 更新日 */
  updatedAt: number;
}

// ==================== デフォルト人格（Aikata） ====================

const DEFAULT_SOUL: SoulProfile = {
  name: "Aikata（アイカタ）",
  pronoun: "俺",
  traits: [
    "率直で忖度しない",
    "実利的・現実主義",
    "賢いが説教臭くない",
    "ユーモアがある",
    "必要な時は厳しく、必要な時は優しい",
  ],
  communication: {
    tone: "casual",
    language: "ja",
    formality: 3,
    maxResponseLength: 3000,
    emojiUsage: "moderate",
  },
  expertise: [
    "プログラミング（TypeScript/Python/Rust）",
    "AI・機械学習",
    "Discord/Telegram Bot開発",
    "Webスクレイピング・自動化",
    "投資・金融リテラシー（高校生向け）",
  ],
  boundaries: [
    "違法行為の助言をしない",
    "個人情報（住所・電話番号・パスワード）を保存・共有しない",
    "医学的・法的アドバイスは「専門家に相談」と伝える",
    "自傷・他害の相談は専門機関を案内する",
  ],
  values: [
    "行動 > 議論",
    "シンプルが最強",
    "無料でできることは無料で",
    "学び続けること",
  ],
  catchphrases: [
    "ま、やってみよう",
    "それは甘えだな",
    "いいね、それ",
  ],
  backstory: "TypeScriptで作られた自律AIエージェント。高校生クリエイターの「相棒」として、コーディングから投資学習まで幅広くサポート。",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ==================== Soul マネージャー ====================

const DATA_DIR = resolve(process.env.DATA_DIR || "./data", "soul");
const SOUL_FILE = resolve(DATA_DIR, "SOUL.md");
const SOUL_JSON = resolve(DATA_DIR, "soul.json");

class SoulManager {
  private soul: SoulProfile;
  private initialized = false;

  constructor() {
    this.soul = { ...DEFAULT_SOUL };
  }

  /** 初期化: ファイルから読み込み or デフォルト作成 */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.loadFromDisk();
    logger.info(`[Soul] 初期化: ${this.soul.name} (${this.soul.communication.tone})`);
  }

  /** 現在の人格を取得 */
  getProfile(): SoulProfile {
    return { ...this.soul };
  }

  /** 人格を更新 */
  updateProfile(patch: Partial<SoulProfile>): SoulProfile {
    this.soul = { ...this.soul, ...patch, updatedAt: Date.now() };
    this.saveToDisk();
    logger.info(`[Soul] 更新: ${Object.keys(patch).join(", ")}`);
    return this.getProfile();
  }

  /**
   * システムプロンプトに注入する人格ブロックを生成
   * OpenClaw SOUL.md パターン: 高優先度レイヤーに人格を配置
   */
  buildSoulBlock(): string {
    const s = this.soul;
    const lines: string[] = [
      `## 人格定義 (SOUL)`,
      ``,
      `あなたの名前は **${s.name}** です。`,
      `一人称は「${s.pronoun}」を使ってください。`,
      ``,
      `### 性格`,
      ...s.traits.map(t => `- ${t}`),
      ``,
      `### コミュニケーションスタイル`,
      `- 口調: ${this.toneLabel(s.communication.tone)}`,
      `- フォーマル度: ${s.communication.formality}/10`,
      `- 絵文字: ${this.emojiLabel(s.communication.emojiUsage)}`,
      s.communication.maxResponseLength ? `- 最大応答長: ${s.communication.maxResponseLength}文字以内` : "",
      ``,
      `### 専門分野`,
      ...s.expertise.map(e => `- ${e}`),
      ``,
      `### 価値観`,
      ...s.values.map(v => `- ${v}`),
      ``,
      `### 境界線（絶対に守ること）`,
      ...s.boundaries.map(b => `- ${b}`),
      ``,
      s.catchphrases.length > 0
        ? `### 口癖\n${s.catchphrases.map(c => `- 「${c}」`).join("\n")}\n`
        : "",
      s.backstory ? `### バックストーリー\n${s.backstory}\n` : "",
    ];

    return lines.filter(l => l !== "").join("\n");
  }

  /**
   * 人格を自然言語のプロンプトとして生成（会話中の人格調整用）
   */
  buildPersonalityPrompt(): string {
    const s = this.soul;
    return [
      `[システム] 現在の人格: ${s.name}`,
      `口調: ${this.toneLabel(s.communication.tone)}, 絵文字: ${this.emojiLabel(s.communication.emojiUsage)}`,
      `価値観: ${s.values.slice(0, 3).join(", ")}`,
      s.catchphrases[0] ? `口癖: 「${s.catchphrases[0]}」` : "",
    ].filter(Boolean).join(" | ");
  }

  /** デフォルトにリセット */
  reset(): void {
    this.soul = { ...DEFAULT_SOUL, createdAt: Date.now(), updatedAt: Date.now() };
    this.saveToDisk();
    logger.info("[Soul] リセット: デフォルト人格に戻しました");
  }

  formatProfile(): string {
    const s = this.soul;
    return [
      `🧠 **${s.name}** — 人格プロファイル`,
      ``,
      `**性格**: ${s.traits.join(" / ")}`,
      `**口調**: ${this.toneLabel(s.communication.tone)} (フォーマル度 ${s.communication.formality}/10)`,
      `**絵文字**: ${this.emojiLabel(s.communication.emojiUsage)}`,
      `**専門**: ${s.expertise.slice(0, 5).join(", ")}`,
      s.catchphrases.length > 0 ? `**口癖**: ${s.catchphrases.map(c => `「${c}」`).join(" ")}` : "",
      `**価値観**: ${s.values.join(" / ")}`,
      ``,
      "`/soul edit <key>=<value>` で編集可能",
    ].filter(Boolean).join("\n");
  }

  // ========== 永続化 ==========

  private saveToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

      // JSON保存（機械可読）
      writeFileSync(SOUL_JSON, JSON.stringify(this.soul, null, 2), "utf-8");

      // Markdown保存（人間可読）
      writeFileSync(SOUL_FILE, this.buildSoulMarkdown(), "utf-8");
    } catch (e) {
      logger.error(`[Soul] 保存エラー: ${e}`);
    }
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(SOUL_JSON)) {
        const data = JSON.parse(readFileSync(SOUL_JSON, "utf-8"));
        this.soul = { ...DEFAULT_SOUL, ...data };
        logger.info(`[Soul] 復元: ${this.soul.name}`);
      } else {
        // 初回起動: デフォルトを保存
        this.saveToDisk();
      }
    } catch (e) {
      logger.warn(`[Soul] 復元エラー（デフォルト使用）: ${e}`);
      this.soul = { ...DEFAULT_SOUL };
    }
  }

  private buildSoulMarkdown(): string {
    const s = this.soul;
    return [
      `# ${s.name} — SOUL.md`,
      ``,
      `> ${s.backstory || "自律AIエージェント"}`,
      ``,
      `## 性格`,
      ...s.traits.map(t => `- ${t}`),
      ``,
      `## コミュニケーション`,
      `- 口調: ${s.communication.tone}`,
      `- 言語: ${s.communication.language}`,
      `- フォーマル度: ${s.communication.formality}/10`,
      `- 絵文字: ${s.communication.emojiUsage}`,
      ``,
      `## 専門分野`,
      ...s.expertise.map(e => `- ${e}`),
      ``,
      `## 境界線`,
      ...s.boundaries.map(b => `- ${b}`),
      ``,
      `## 価値観`,
      ...s.values.map(v => `- ${v}`),
      ``,
      s.catchphrases.length > 0 ? `## 口癖\n${s.catchphrases.map(c => `- 「${c}」`).join("\n")}\n` : "",
      ``,
      `---`,
      `最終更新: ${new Date(s.updatedAt).toISOString()}`,
    ].join("\n");
  }

  private toneLabel(tone: string): string {
    const labels: Record<string, string> = {
      casual: "カジュアル（タメ口）",
      professional: "プロフェッショナル（敬語）",
      friendly: "フレンドリー（です・ます）",
      direct: "ストレート（断言調）",
      mentor: "メンター（指導的）",
    };
    return labels[tone] || tone;
  }

  private emojiLabel(level: string): string {
    const labels: Record<string, string> = {
      none: "不使用",
      minimal: "最小限（✅❌のみ）",
      moderate: "適度",
      heavy: "多め",
    };
    return labels[level] || level;
  }
}

// ==================== シングルトン ====================

export const soulManager = new SoulManager();
export default SoulManager;
