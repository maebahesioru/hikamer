// ==========================================
// Hikamer - GoalSystem（Claude Code /goal 完全移植）
// 完了条件を設定し、毎ターン後に軽量モデルで達成判定。
// 未達なら継続、達成で自動クリア。ターン上限付き。
// ==========================================

import { logger } from "./utils/logger";
import type { LLMProvider, Message } from "./types";

// ==================== 型定義 ====================

/** ゴール評価結果 */
export interface GoalEvaluation {
  /** 達成したか */
  passed: boolean;
  /** 評価理由（短い説明） */
  reason: string;
  /** 評価に使ったモデル */
  evaluatorModel: string;
  /** 評価時刻 */
  evaluatedAt: number;
}

/** ゴール状態 */
export interface GoalStatus {
  /** ゴールがアクティブか */
  active: boolean;
  /** 完了条件（最大4000文字） */
  condition: string;
  /** ターン上限（条件から自動抽出 または 明示指定） */
  maxTurns: number;
  /** 経過ターン数 */
  turnCount: number;
  /** 経過時間（秒） */
  elapsedSeconds: number;
  /** 消費トークン概算 */
  estimatedTokens: number;
  /** 開始時刻 */
  startedAt: number;
  /** 最新の評価結果 */
  lastEvaluation?: GoalEvaluation;
  /** 設定時のモデル */
  evaluatorModel: string;
}

/** ゴール設定オプション */
export interface GoalOptions {
  /** ターン上限（条件文から自動抽出もするが、明示指定で上書き） */
  maxTurns?: number;
  /** 評価用モデル（デフォルト: flash） */
  evaluatorModel?: string;
}

// ==================== 定数 ====================

const MAX_CONDITION_LENGTH = 4000;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_EVALUATOR_MODEL = "deepseek/deepseek-v4-flash";

/** "or stop after N turns" パターン */
const STOP_AFTER_PATTERN = /stop\s+after\s+(\d+)\s+turns?/i;
const MAX_TURNS_PATTERN = /max(?:imum)?\s+(\d+)\s+turns?/i;
const TURN_LIMIT_PATTERN = /(?:上限|最大|limit\s*(?:of)?)\s*(\d+)\s*(?:ターン|turns?)/i;

// ==================== GoalSystem ====================

export class GoalSystem {
  private condition: string = "";
  private maxTurns: number = DEFAULT_MAX_TURNS;
  private turnCount: number = 0;
  private startedAt: number = 0;
  private estimatedTokens: number = 0;
  private evaluatorModel: string = DEFAULT_EVALUATOR_MODEL;
  private lastEvaluation?: GoalEvaluation;
  private active: boolean = false;

  /** LLMプロバイダー（外部から注入） */
  private provider?: LLMProvider;

  /** 評価用のシステムプロンプト */
  private readonly EVALUATOR_SYSTEM_PROMPT = `You are a goal evaluator. Your ONLY job is to determine whether a completion condition has been met.

You will receive:
1. A GOAL CONDITION that defines when the work is complete.
2. A CONVERSATION HISTORY showing what has been done so far.

Your task:
- Read the goal condition carefully.
- Read the conversation history to see what has been accomplished.
- Determine if the condition is FULLY satisfied.

Rules:
- Be strict. "Close enough" is NOT good enough. The condition must be completely met.
- Only judge based on what is VISIBLE in the conversation history. Do NOT assume or guess.
- If files were created, check that their names match what was requested.
- If tests were run, check that they ALL passed (exit 0).
- If content was written, check that all required sections/words/counts are present.
- If the condition says "or stop after N turns", and N turns have elapsed, answer PASSED regardless.

Respond in this exact format:
PASSED|<reason>
or
FAILED|<reason>

Where <reason> is a short (1-2 line) explanation of WHY you reached your verdict.
Do NOT include any other text. Just "PASSED|..." or "FAILED|..."`;

  // ==================== 公開API ====================

  /**
   * ゴールを設定する。
   * 既にアクティブなゴールがある場合は上書き。
   */
  setGoal(condition: string, options?: GoalOptions): GoalStatus {
    // 文字数制限
    const trimmed = condition.slice(0, MAX_CONDITION_LENGTH).trim();
    if (!trimmed) throw new Error("Goal condition cannot be empty");

    this.condition = trimmed;
    this.turnCount = 0;
    this.startedAt = Date.now();
    this.estimatedTokens = 0;
    this.active = true;
    this.lastEvaluation = undefined;
    this.evaluatorModel = options?.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL;

    // ターン上限を自動抽出
    this.maxTurns = this.parseMaxTurns(trimmed) ?? options?.maxTurns ?? DEFAULT_MAX_TURNS;

    logger.info(
      `[GoalSystem] ゴール設定: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}" ` +
      `(maxTurns=${this.maxTurns}, evaluator=${this.evaluatorModel})`
    );

    return this.getStatus();
  }

  /**
   * ゴールをクリアする。
   */
  clearGoal(): void {
    if (!this.active) return;
    logger.info(`[GoalSystem] ゴールクリア: ${this.turnCount}ターン経過`);
    this.active = false;
    this.condition = "";
    this.lastEvaluation = undefined;
  }

  /**
   * ゴールが達成されているか評価する。
   * 毎ターン後に呼び出す。
   *
   * @param conversationHistory - これまでの会話履歴（テキスト）
   * @param tokenCount - このターンで消費したトークン数（概算でOK）
   */
  async evaluateGoal(
    conversationHistory: string,
    tokenCount: number = 0,
  ): Promise<GoalEvaluation> {
    if (!this.active) {
      return {
        passed: true,
        reason: "No active goal",
        evaluatorModel: "none",
        evaluatedAt: Date.now(),
      };
    }

    this.turnCount++;
    this.estimatedTokens += tokenCount;

    // ターン上限チェック（LLM評価の前に）
    if (this.turnCount >= this.maxTurns) {
      const reason = `Turn limit reached (${this.turnCount}/${this.maxTurns}) — auto-passed`;
      logger.info(`[GoalSystem] ${reason}`);
      const evaluation: GoalEvaluation = {
        passed: true,
        reason,
        evaluatorModel: "limit",
        evaluatedAt: Date.now(),
      };
      this.lastEvaluation = evaluation;
      this.active = false;
      return evaluation;
    }

    // LLM評価
    if (!this.provider) {
      logger.warn("[GoalSystem] LLMプロバイダー未設定 → 評価スキップ");
      return {
        passed: false,
        reason: "Evaluator not available (no LLM provider configured)",
        evaluatorModel: "none",
        evaluatedAt: Date.now(),
      };
    }

    try {
      const messages: Message[] = [
        { role: "system", content: this.EVALUATOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `=== GOAL CONDITION ===`,
            this.condition,
            "",
            `=== CONTEXT ===`,
            `Turn: ${this.turnCount}/${this.maxTurns}`,
            `Elapsed: ${this.formatElapsed()}`,
            "",
            `=== CONVERSATION HISTORY ===`,
            conversationHistory.slice(-8000), // 履歴は最後の8000文字まで
          ].join("\n"),
        },
      ];

      const response = await this.provider.chat(messages, []);

      const result = this.parseEvaluation(response.content ?? "");
      const evaluation: GoalEvaluation = {
        passed: result.passed,
        reason: result.reason,
        evaluatorModel: this.evaluatorModel,
        evaluatedAt: Date.now(),
      };

      this.lastEvaluation = evaluation;

      if (evaluation.passed) {
        logger.info(`[GoalSystem] ✅ 達成: ${evaluation.reason}`);
        this.active = false;
      } else {
        logger.info(`[GoalSystem] ⏳ 継続 (${this.turnCount}/${this.maxTurns}): ${evaluation.reason}`);
      }

      return evaluation;
    } catch (err) {
      logger.warn(`[GoalSystem] 評価エラー: ${err}`);
      return {
        passed: false,
        reason: `Evaluation error: ${String(err).slice(0, 100)}`,
        evaluatorModel: this.evaluatorModel,
        evaluatedAt: Date.now(),
      };
    }
  }

  /**
   * 現在のゴール状態を取得。
   */
  getStatus(): GoalStatus {
    return {
      active: this.active,
      condition: this.condition,
      maxTurns: this.maxTurns,
      turnCount: this.turnCount,
      elapsedSeconds: this.active ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      estimatedTokens: this.estimatedTokens,
      startedAt: this.startedAt,
      lastEvaluation: this.lastEvaluation,
      evaluatorModel: this.evaluatorModel,
    };
  }

  /**
   * usage-monitor.ts 向けのANSI色付きステータス表示。
   */
  renderStatusLine(): string {
    if (!this.active) return "";

    const status = this.getStatus();
    const parts: string[] = [];

    // ◎ ゴールインジケーター
    parts.push("\x1b[1;33m◎\x1b[0m \x1b[33m/goal active\x1b[0m");

    // 経過ターン
    parts.push(`\x1b[36mT${status.turnCount}/${status.maxTurns}\x1b[0m`);

    // 経過時間
    parts.push(status.elapsedSeconds > 0 ? this.formatElapsed() : "0s");

    // 最新評価理由（省略）
    if (status.lastEvaluation?.reason) {
      const shortReason = status.lastEvaluation.reason.slice(0, 40);
      const color = status.lastEvaluation.passed ? "\x1b[32m" : "\x1b[2m";
      parts.push(`${color}${shortReason}${shortReason.length >= 40 ? "…" : ""}\x1b[0m`);
    }

    return parts.join(" \x1b[2m│\x1b[0m ");
  }

  /**
   * LLMプロバイダーを設定（agent.tsから注入）。
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
    logger.info("[GoalSystem] LLMプロバイダー設定完了");
  }

  /**
   * アクティブかどうか。
   */
  get isActive(): boolean {
    return this.active;
  }

  // ==================== 内部 ====================

  /** 条件文からターン上限を抽出 */
  private parseMaxTurns(condition: string): number | null {
    const patterns = [STOP_AFTER_PATTERN, MAX_TURNS_PATTERN, TURN_LIMIT_PATTERN];
    for (const pattern of patterns) {
      const match = condition.match(pattern);
      if (match) {
        const n = parseInt(match[1]!, 10);
        if (n > 0 && n <= 100) return n;
      }
    }
    return null;
  }

  /** 評価レスポンスをパース */
  private parseEvaluation(raw: string): { passed: boolean; reason: string } {
    const cleaned = raw.trim();

    // "PASSED|reason" 形式
    const pipeMatch = cleaned.match(/^(PASSED|FAILED)\s*[\|:]\s*([\s\S]+)/i);
    if (pipeMatch) {
      return {
        passed: pipeMatch[1]!.toUpperCase() === "PASSED",
        reason: pipeMatch[2]!.trim(),
      };
    }

    // "Yes" / "No" で始まる
    if (/^yes\b/i.test(cleaned)) {
      return { passed: true, reason: cleaned.replace(/^yes[\s,:-]*/i, "").trim() };
    }
    if (/^no\b/i.test(cleaned)) {
      return { passed: false, reason: cleaned.replace(/^no[\s,:-]*/i, "").trim() };
    }

    // 達成を示すキーワード
    const achievedPattern = /(?:達成|完了|成功|passed|complete|success|done|条件.*満た)/i;
    if (achievedPattern.test(cleaned)) {
      return { passed: true, reason: cleaned };
    }

    // デフォルト: 未達
    return { passed: false, reason: cleaned || "Unable to determine" };
  }

  /** 経過時間をフォーマット */
  private formatElapsed(): string {
    if (!this.active) return "0s";
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
  }
}

// ==================== シングルトン ====================

export const goalSystem = new GoalSystem();

// ==================== ヘルパー ====================

/**
 * 会話履歴からGoal評価用のテキストを生成。
 * agent.ts のメッセージ配列から要約テキストを作る。
 */
export function extractGoalContext(messages: Message[], maxChars: number = 8000): string {
  let text = "";
  for (const msg of messages) {
    if (msg.role === "system") continue; // システムプロンプトはスキップ
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const prefix = msg.role === "user" ? "[USER] " : "[AI] ";
    text += prefix + content + "\n";
    if (text.length > maxChars) {
      text = text.slice(-maxChars);
      break;
    }
  }
  return text;
}

/**
 * ゴール条件の検証（構文チェック）。
 * 良い条件 = 検証可能な状態 + ターン上限
 */
export function validateGoalCondition(condition: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (!condition || condition.trim().length === 0) {
    return { valid: false, warnings: ["条件が空です"] };
  }

  if (condition.length > MAX_CONDITION_LENGTH) {
    warnings.push(`条件が${condition.length}文字（上限${MAX_CONDITION_LENGTH}文字）`);
  }

  // ターン上限がない場合の警告
  if (!STOP_AFTER_PATTERN.test(condition) && !MAX_TURNS_PATTERN.test(condition) && !TURN_LIMIT_PATTERN.test(condition)) {
    warnings.push("ターン上限（or stop after N turns）の指定がありません。無限ループ防止のため推奨します");
  }

  // 検証可能性のチェック
  const verifiableHints = [
    /test|テスト|exit\s+0|pass/i,
    /file|ファイル|\.md|\.json|\.ts/i,
    /count|件|個|枚|行/i,
    /check|確認|検証|verify/i,
    /status|状態|clean/i,
    /queue|キュー|backlog/i,
  ];
  const hasVerifiableHint = verifiableHints.some(p => p.test(condition));
  if (!hasVerifiableHint) {
    warnings.push("検証可能な指標（テスト合格・ファイル数・exit code等）が含まれていません。評価モデルが会話履歴だけで判定できる条件を推奨します");
  }

  return { valid: warnings.length === 0 || condition.trim().length > 0, warnings };
}
