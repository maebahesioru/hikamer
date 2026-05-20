// ==========================================
// Hikamer - オンボーディング（Hermes Agent onboarding.py 由来）
// 新規ユーザー導入・初期設定フロー
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface OnboardingState {
  userId: string;
  step: OnboardingStep;
  completed: boolean;
  startedAt: number;
  completedAt?: number;
  preferences: UserPreferences;
  skipped: string[];
  metadata?: Record<string, unknown>;
}

export type OnboardingStep =
  | "welcome"
  | "platform_setup"
  | "model_config"
  | "tool_intro"
  | "first_command"
  | "complete";

export interface UserPreferences {
  language: "ja" | "en";
  model: string;
  platform: string;
  notifyOnErrors: boolean;
  autoReview: boolean;
  enableSubconscious: boolean;
  theme: "light" | "dark" | "auto";
  shortcuts: boolean;
}

export interface OnboardingMessage {
  step: OnboardingStep;
  title: string;
  content: string;
  tips: string[];
  nextHint: string;
}

// ==================== オンボーディングマネージャー ====================

class OnboardingManager {
  private states: Map<string, OnboardingState> = new Map();
  private initialized = false;

  private readonly MESSAGES: Record<OnboardingStep, OnboardingMessage> = {
    welcome: {
      step: "welcome",
      title: "👋 Hikamerへようこそ！",
      content:
        "Hikamerは多機能AIエージェントです。\n" +
        "Discord/Telegram/CLIから操作できます。\n\n" +
        "まずは基本的な設定を進めましょう。",
      tips: [
        "`/help`で全コマンド一覧を表示",
        "`/status`で現在の状態を確認",
      ],
      nextHint: "次のステップ: プラットフォーム設定",
    },
    platform_setup: {
      step: "platform_setup",
      title: "🔌 プラットフォーム設定",
      content:
        "Hikamerは複数のプラットフォームに対応しています。\n\n" +
        "現在利用可能なプラットフォーム:\n" +
        "- Discord: チャットBotとして動作\n" +
        "- Telegram: チャットBotとして動作\n" +
        "- CLI: ターミナルから直接操作",
      tips: [
        "`/gateway platforms`で接続状態を確認",
        "環境変数でプラットフォームのON/OFFを設定",
      ],
      nextHint: "次のステップ: モデル設定",
    },
    model_config: {
      step: "model_config",
      title: "🤖 モデル設定",
      content:
        "使用するAIモデルを設定します。\n\n" +
        "推奨設定:\n" +
        "- メインモデル: DeepSeek V4 Pro（高品質）\n" +
        "- サブモデル: DeepSeek V4 Flash（高速）\n\n" +
        "OpenRouter / OpenAI / Anthropic から選択できます。",
      tips: [
        "`/model`で現在のモデルを確認",
        "環境変数 AIKATA_LLM_API_KEY でAPIキー設定",
      ],
      nextHint: "次のステップ: ツール紹介",
    },
    tool_intro: {
      step: "tool_intro",
      title: "🛠️ ツール紹介",
      content:
        "Hikamerには多数のツールが組み込まれています。\n\n" +
        "主なツール:\n" +
        "- ファイル操作（読み書き・編集）\n" +
        "- Web検索・スクレイピング\n" +
        "- コード実行\n" +
        "- Discord/Telegram連携\n" +
        "- スケジュール管理\n" +
        "- メモリ・記憶",
      tips: [
        "`/tools`で全ツール一覧を表示",
        "各ツールは自然言語で指示可能",
      ],
      nextHint: "次のステップ: 最初のコマンド",
    },
    first_command: {
      step: "first_command",
      title: "🎯 最初のコマンド",
      content:
        "試しに以下のコマンドを実行してみましょう！\n\n" +
        "`/status` — システム状態を確認\n" +
        "`/help` — ヘルプを表示\n" +
        "`/doctor check` — 診断を実行\n\n" +
        "または、普通に会話を始めることもできます。",
      tips: [
        "スラッシュコマンドは `/` で開始",
        "自然言語でツールを呼び出すことも可能",
      ],
      nextHint: "セットアップ完了！",
    },
    complete: {
      step: "complete",
      title: "🎉 セットアップ完了！",
      content:
        "おめでとうございます！セットアップが完了しました。\n\n" +
        "これでHikamerの全ての機能を利用できます。\n" +
        "何か質問があれば、いつでも聞いてください。",
      tips: [
        "`/help`で全コマンド一覧",
        "困ったときは `doctor check` を実行",
      ],
      nextHint: "",
    },
  };

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Onboarding] initialized");
  }

  /** 新規ユーザーのオンボーディングを開始 */
  start(userId: string, platform?: string): OnboardingState {
    const state: OnboardingState = {
      userId,
      step: "welcome",
      completed: false,
      startedAt: Date.now(),
      preferences: {
        language: "ja",
        model: "deepseek/deepseek-v4-flash",
        platform: platform ?? "discord",
        notifyOnErrors: true,
        autoReview: true,
        enableSubconscious: false,
        theme: "dark",
        shortcuts: true,
      },
      skipped: [],
    };

    this.states.set(userId, state);
    logger.info(`[Onboarding] started for ${userId}`);
    return state;
  }

  /** 次のステップに進む */
  advance(userId: string): OnboardingMessage | null {
    const state = this.states.get(userId);
    if (!state || state.completed) return null;

    const steps: OnboardingStep[] = [
      "welcome", "platform_setup", "model_config",
      "tool_intro", "first_command", "complete",
    ];

    const currentIdx = steps.indexOf(state.step);
    if (currentIdx < 0 || currentIdx >= steps.length - 1) {
      state.step = "complete";
      state.completed = true;
      state.completedAt = Date.now();
      return this.MESSAGES["complete"];
    }

    state.step = steps[currentIdx + 1]!;

    if (state.step === "complete") {
      state.completed = true;
      state.completedAt = Date.now();
      logger.info(`[Onboarding] completed for ${userId}`);
    }

    return this.MESSAGES[state.step];
  }

  /** ステップをスキップ */
  skip(userId: string): OnboardingMessage | null {
    const state = this.states.get(userId);
    if (!state) return null;

    state.skipped.push(state.step);
    return this.advance(userId);
  }

  /** オンボーディングをスキップして完了 */
  skipAll(userId: string): void {
    const state = this.states.get(userId);
    if (!state) return;

    state.step = "complete";
    state.completed = true;
    state.completedAt = Date.now();
    state.skipped.push("all");
    logger.info(`[Onboarding] skipped for ${userId}`);
  }

  /** 現在のメッセージを取得 */
  getCurrentMessage(userId: string): OnboardingMessage | null {
    const state = this.states.get(userId);
    if (!state) return null;
    return this.MESSAGES[state.step] ?? null;
  }

  /** 状態を取得 */
  getState(userId: string): OnboardingState | undefined {
    return this.states.get(userId);
  }

  /** 設定を更新 */
  updatePreferences(
    userId: string,
    prefs: Partial<UserPreferences>
  ): boolean {
    const state = this.states.get(userId);
    if (!state) return false;
    state.preferences = { ...state.preferences, ...prefs };
    return true;
  }

  /** オンボーディング中か */
  isOnboarding(userId: string): boolean {
    const state = this.states.get(userId);
    return !!state && !state.completed;
  }

  /** 完了済みか */
  isComplete(userId: string): boolean {
    const state = this.states.get(userId);
    return !!state && state.completed;
  }

  formatMessage(msg: OnboardingMessage): string {
    return (
      `${msg.title}\n\n${msg.content}\n\n` +
      (msg.tips.length > 0
        ? `💡 **ヒント**\n${msg.tips.map((t) => `- ${t}`).join("\n")}\n\n`
        : "") +
      `➡️ ${msg.nextHint}`
    );
  }

  formatState(state: OnboardingState): string {
    const progress = state.completed
      ? "✅ 完了"
      : `🔄 ${state.step}`;
    return (
      `📋 **オンボーディング状態**\n` +
      `進捗: ${progress}\n` +
      `経過時間: ${((Date.now() - state.startedAt) / 1000 / 60).toFixed(0)}分\n` +
      `スキップ: ${state.skipped.length > 0 ? state.skipped.join(", ") : "なし"}\n\n` +
      `**設定**\n` +
      `言語: ${state.preferences.language === "ja" ? "日本語" : "English"}\n` +
      `モデル: ${state.preferences.model}\n` +
      `プラットフォーム: ${state.preferences.platform}\n` +
      `テーマ: ${state.preferences.theme}`
    );
  }
}

// ==================== シングルトン ====================

export const onboardingManager = new OnboardingManager();

export default OnboardingManager;
