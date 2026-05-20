// ==========================================
// Hikamer - プロンプトエンジン
// 出典: prompt-master (nidhinjs/prompt-master)
// 9次元意図抽出 + 13テンプレート + ツールルーティング + 診断チェックリスト
// ==========================================

import { logger } from "./utils/logger";

// ==================== 9次元意図抽出 ====================

/** prompt-masterの9次元Intent Extraction */
export interface ExtractedIntent {
  task: string;
  targetTool: string;
  outputFormat: string;
  constraints: string[];
  input: string;
  context: string;
  audience: string;
  successCriteria: string[];
  examples: string[];
  /** 推論が必要か（CoTなど） */
  needsReasoning: boolean;
  /** 推論モデルか（CoT不要） */
  isReasoningModel: boolean;
  /** エージェント的タスクか */
  isAgentic: boolean;
  /** スコープ境界 */
  scopeBoundary?: string;
}

/**
 * 9次元意図抽出
 * prompt-master: ユーザー入力からtask/tool/format/constraints等を抽出
 */
export function extractIntent(input: string, modelHint?: string): ExtractedIntent {
  // 簡易ルールベース抽出（本番ではLLMに委譲する前提）
  const intent: ExtractedIntent = {
    task: extractTask(input),
    targetTool: extractTool(input),
    outputFormat: extractFormat(input),
    constraints: extractConstraints(input),
    input: input,
    context: "",
    audience: "",
    successCriteria: [],
    examples: [],
    needsReasoning: detectReasoningNeed(input),
    isReasoningModel: isReasoningModel(modelHint || ""),
    isAgentic: detectAgentic(input),
    scopeBoundary: extractScopeBoundary(input),
  };

  return intent;
}

function extractTask(input: string): string {
  // 最初の文や「〜して」「〜を」パターンを抽出
  const clean = input.replace(/^(教えて|お願い|依頼|タスク:?)\s*/i, "");
  const firstSentence = clean.split(/[。\n]/)[0] || clean;
  return firstSentence.length > 120 ? firstSentence.slice(0, 120) + "..." : firstSentence;
}

function extractTool(input: string): string {
  const tools = [
    "claude", "chatgpt", "gemini", "gpt", "deepseek",
    "midjourney", "dall-e", "stable diffusion",
    "cursor", "windsurf", "copilot", "cline",
    "bolt", "lovable", "v0", "devin",
    "comfyui", "sora", "runway", "kling",
    "elevenlabs",
  ];
  const lower = input.toLowerCase();
  const found = tools.find(t => lower.includes(t));
  return found || "general";
}

function extractFormat(input: string): string {
  if (/json|yaml|toml/i.test(input)) return "json";
  if (/markdown|md/i.test(input)) return "markdown";
  if (/csv|table|表/i.test(input)) return "table";
  if (/code|コード|script|関数/i.test(input)) return "code";
  if (/summary|要約/i.test(input)) return "summary";
  if (/list|リスト/i.test(input)) return "list";
  return "text";
}

function extractConstraints(input: string): string[] {
  const constraints: string[] = [];

  // 否定表現（〜しないで、〜するな）
  if (/しないで|するな|禁止|回避|避けて|やめて/i.test(input)) {
    constraints.push("avoid_negatives");
  }
  // 長さ制約
  const lenMatch = input.match(/(\d+)\s*(文字|tokens?\s*以内|words?\s*以内)/i);
  if (lenMatch) {
    constraints.push(`max_length:${lenMatch[1]}`);
  }
  // 言語
  if (/日本語|英語|中国語/i.test(input)) {
    constraints.push("language_specified");
  }

  return constraints;
}

function detectReasoningNeed(input: string): boolean {
  const patterns = [
    /なぜ|理由|説明|考え方|プロセス|process|reasoning|なぜなら|比較|分析|解析/i,
    /複雑|難しい|難しい問題|ロジック|論理|矛盾|トラブルシュート/i,
    /段階|順序|手順|step|algorithm|計算|コードの解説/i,
  ];
  return patterns.some(p => p.test(input));
}

function isReasoningModel(model: string): boolean {
  const reasoningModels = [
    "o3", "o4", "deepseek-r1", "deepseek-r1", "qwen3-thinking",
    "gpt-o", "claude-thinking", "gemini-thinking",
  ];
  const lower = model.toLowerCase();
  return reasoningModels.some(m => lower.includes(m));
}

function detectAgentic(input: string): boolean {
  const patterns = [
    /自律|自動|agent|エージェント|繰り返し|監視|継続的に|バックグラウンド/i,
    /スケジュール|cron|定期|毎日|毎週|ウォッチ|watch/i,
    /調査|リサーチ|収集|深掘り|徹底/i,
  ];
  return patterns.some(p => p.test(input));
}

function extractScopeBoundary(input: string): string | undefined {
  const patterns = [
    /(?:この|その|指定された)(?:ファイル|ディレクトリ|プロジェクト|リポジトリ)/i,
    /^~[/\\]|[A-Z]:[/\\]/i,
    /以下の\s*(?:ファイル|コード|ソース)/i,
  ];
  const found = patterns.find(p => p.test(input));
  return found ? input.match(found)?.[0] : undefined;
}

// ==================== 13プロンプトテンプレート（prompt-master A〜M） ====================

export type PromptTemplateId =
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M";

export interface PromptTemplate {
  id: PromptTemplateId;
  name: string;
  description: string;
  bestFor: string;
  build: (params: Record<string, string>) => string;
}

/**
 * 13テンプレート（prompt-master参照実装をTypeScript化）
 */
export const PROMPT_TEMPLATES: Record<PromptTemplateId, PromptTemplate> = {
  A: {
    id: "A",
    name: "RTF (Role-Task-Format)",
    description: "シンプルなRole/Task/Formatの3要素",
    bestFor: "高速な1回きりのタスク",
    build: (p) => [
      `# Role`,
      p.role || "あなたはアシスタントです。",
      ``,
      `# Task`,
      p.task || "",
      ``,
      `# Format`,
      p.format || "テキスト",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  B: {
    id: "B",
    name: "CO-STAR",
    description: "Context-Objective-Style-Tone-Audience-Response",
    bestFor: "プロフェッショナルな文章作成",
    build: (p) => [
      `# Context`,
      p.context || "",
      ``,
      `# Objective`,
      p.objective || "",
      ``,
      `# Style`,
      p.style || "プロフェッショナル",
      ``,
      `# Tone`,
      p.tone || "中立的",
      ``,
      `# Audience`,
      p.audience || "一般",
      ``,
      `# Response`,
      p.response || "構造化された回答",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  C: {
    id: "C",
    name: "RISEN",
    description: "Role-Instructions-Steps-Endgoal-Narrowing",
    bestFor: "複数ステップの複雑プロジェクト",
    build: (p) => [
      `# Role`,
      p.role || "",
      ``,
      `# Instructions`,
      p.instructions || "",
      ``,
      `# Steps`,
      p.steps || "",
      ``,
      `# End Goal`,
      p.endgoal || "",
      ``,
      `# Narrowing`,
      p.narrowing || "",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  D: {
    id: "D",
    name: "CRISPE",
    description: "Capacity-Role-Insight-Statement-Personality-Experiment",
    bestFor: "クリエイティブな作業",
    build: (p) => [
      `# Capacity & Role`,
      p.capacity || "",
      ``,
      `# Insight`,
      p.insight || "",
      ``,
      `# Statement`,
      p.statement || "",
      ``,
      `# Personality`,
      p.personality || "",
      ``,
      `# Experiment`,
      p.experiment || "",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  E: {
    id: "E",
    name: "Chain of Thought",
    description: "思考過程を段階的に出力させる",
    bestFor: "ロジック・数学・デバッグ",
    build: (p) => [
      p.instruction || "",
      ``,
      `Think through this step by step:`,
      ``,
      `1. First, understand the problem`,
      `2. Break it down into parts`,
      `3. Work through each part`,
      `4. Verify the solution`,
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  F: {
    id: "F",
    name: "Few-Shot",
    description: "例示でフォーマットを指定",
    bestFor: "一貫した構造化出力",
    build: (p) => {
      const examples = p.examples ? p.examples.split("||").filter(Boolean) : [];
      return [
        `# Task`,
        p.task || "",
        ``,
        `# Examples`,
        ...examples.map((ex, i) => `Example ${i + 1}:\n${ex.trim()}\n`),
        ``,
        `# Now produce the output for:`,
        p.input || "",
        ...(p.additional ? [`\n${p.additional}`] : []),
      ].join("\n");
    },
  },
  G: {
    id: "G",
    name: "File-Scope",
    description: "ファイル単位の編集指示（Cursor/Windsurf/Copilot向け）",
    bestFor: "コード編集タスク",
    build: (p) => [
      `## File: ${p.file || "unknown"}`,
      ``,
      `## Task`,
      p.task || "",
      ``,
      `## Constraints`,
      p.constraints || "既存のコードスタイルを維持",
      ``,
      `## Scope`,
      `- Only modify the specified file`,
      `- Do not refactor unrelated code`,
      `- Keep imports organized`,
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  H: {
    id: "H",
    name: "ReAct + Stop Conditions",
    description: "思考→行動→観察のループ＋停止条件",
    bestFor: "自律エージェント（Claude Code, Devin）",
    build: (p) => [
      `# Objective`,
      p.objective || "",
      ``,
      `# Available Actions`,
      p.actions || "ターミナル・ファイル操作・コード実行",
      ``,
      `# Stop Conditions`,
      p.stop || "- 目標達成\n- エラー多発\n- ユーザーからの割り込み",
      ``,
      `# Format: Thought → Action → Observation → ...`,
      p.additional || "",
    ].join("\n"),
  },
  I: {
    id: "I",
    name: "Visual Descriptor",
    description: "画像/動画生成のための詳細記述",
    bestFor: "画像生成プロンプト",
    build: (p) => [
      `## Subject`,
      p.subject || "",
      ``,
      `## Setting`,
      p.setting || "",
      ``,
      `## Lighting & Mood`,
      p.lighting || "",
      ``,
      `## Style`,
      p.style || "",
      ``,
      `## Composition`,
      p.composition || "",
      ``,
      `## Technical Specs`,
      p.technical || "",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  J: {
    id: "J",
    name: "Reference Image Editing",
    description: "既存画像の編集指示",
    bestFor: "画像編集",
    build: (p) => [
      `# Reference`,
      p.reference || "",
      ``,
      `# Edit Instruction`,
      p.instruction || "",
      ``,
      `# Preserve`,
      p.preserve || "元の構図と雰囲気を維持",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  K: {
    id: "K",
    name: "ComfyUI Workflow",
    description: "ComfyUIノードワークフロー記述",
    bestFor: "ComfyUI",
    build: (p) => [
      `# Workflow Goal`,
      p.goal || "",
      ``,
      `# Nodes`,
      p.nodes || "",
      ``,
      `# Connections`,
      p.connections || "",
      ``,
      `# Parameters`,
      p.parameters || "",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  L: {
    id: "L",
    name: "Prompt Decompiler",
    description: "既存プロンプトの分解・解析",
    bestFor: "プロンプト解析・移植",
    build: (p) => [
      `# Source Prompt`,
      p.source || "",
      ``,
      `# Decompile Request`,
      p.request || "このプロンプトを分析して主要要素に分解してください",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
  M: {
    id: "M",
    name: "Opus 4.7 Task Brief",
    description: "複雑なマルチステップエージェントタスク",
    bestFor: "Claude Opus 4.7での高度なタスク",
    build: (p) => [
      `# Mission Brief`,
      p.mission || "",
      ``,
      `# Context`,
      p.context || "",
      ``,
      `# Deliverables`,
      p.deliverables || "",
      ``,
      `# Constraints`,
      p.constraints || "",
      ``,
      `# Thinking Depth`,
      p.thinking || "medium",
      ``,
      `# Session Strategy`,
      p.strategy || "Plan first, then execute step by step",
      ...(p.additional ? [`\n${p.additional}`] : []),
    ].join("\n"),
  },
};

/**
 * 最適なテンプレートを選択
 */
export function selectTemplate(intent: ExtractedIntent): PromptTemplate {
  if (intent.isAgentic) return PROMPT_TEMPLATES.H;
  if (intent.needsReasoning && !intent.isReasoningModel) return PROMPT_TEMPLATES.E;
  if (intent.outputFormat === "code") return PROMPT_TEMPLATES.G;
  if (intent.targetTool.match(/midjourney|dall-e|stable diffusion|sora/i)) return PROMPT_TEMPLATES.I;
  if (intent.targetTool === "comfyui") return PROMPT_TEMPLATES.K;

  // タスクの複雑さで判断
  if (intent.constraints.length > 2 || intent.successCriteria.length > 2) {
    return PROMPT_TEMPLATES.C; // RISEN
  }
  if (intent.audience) {
    return PROMPT_TEMPLATES.B; // CO-STAR
  }

  return PROMPT_TEMPLATES.A; // RTF（デフォルト）
}

/**
 * プロンプトをビルド（自動テンプレート選択＋パラメータ補完）
 */
export function buildPrompt(
  userInput: string,
  options?: {
    model?: string;
    template?: PromptTemplateId;
    params?: Record<string, string>;
  }
): string {
  const intent = extractIntent(userInput, options?.model);

  if (options?.template && PROMPT_TEMPLATES[options.template]) {
    const tpl = PROMPT_TEMPLATES[options.template];
    return tpl.build({
      task: intent.task,
      ...options.params,
    });
  }

  // 自動選択
  const tpl = selectTemplate(intent);
  return tpl.build({
    task: intent.task,
    input: userInput,
    context: intent.context,
    ...options?.params,
  });
}

// ==================== 診断チェックリスト（prompt-master 37の失敗パターン） ====================

export interface DiagnosticIssue {
  category: "task" | "context" | "format" | "scope" | "reasoning" | "agentic";
  pattern: string;
  severity: "high" | "medium" | "low";
  suggestion: string;
}

/**
 * プロンプトの品質診断
 * prompt-master: 37 failure patternsをTypeScriptルールエンジン化
 */
export function diagnosePrompt(input: string, options?: {
  model?: string;
  isCodePrompt?: boolean;
}): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // --- Task Patterns ---
  if (/何か作って|何か書いて|適当に/i.test(input)) {
    issues.push({
      category: "task",
      pattern: "Vague verb — 命令が曖昧",
      severity: "high",
      suggestion: "具体的なタスク内容を明示（例：「〇〇機能を持つWebアプリを作成」）",
    });
  }
  if (input.includes("と") && (input.includes("、") || input.includes("，"))) {
    // 複数タスクの可能性（簡易判定）
    issues.push({
      category: "task",
      pattern: "Two tasks in one prompt — 1プロンプトに複数タスク",
      severity: "medium",
      suggestion: "タスクを分割。1プロンプト=1タスク",
    });
  }

  // --- Context Patterns ---
  if (input.length < 20 && !options?.isCodePrompt) {
    issues.push({
      category: "context",
      pattern: "Too short — コンテキスト不足",
      severity: "high",
      suggestion: "背景・目的・制約事項を追加",
    });
  }
  if (/よろしく|お願いします$/i.test(input)) {
    issues.push({
      category: "context",
      pattern: "Assumed prior knowledge — 前提知識が不明",
      severity: "medium",
      suggestion: "読者の前提知識レベルを明示",
    });
  }

  // --- Format Patterns ---
  if (!/json|markdown|table|リスト|形式|format|output/i.test(input)) {
    issues.push({
      category: "format",
      pattern: "Missing output format — 出力形式未指定",
      severity: "low",
      suggestion: "出力形式を明示（JSON/Markdown/Table等）",
    });
  }

  // --- Scope Patterns ---
  if (input.length > 800 && !options?.isCodePrompt) {
    issues.push({
      category: "scope",
      pattern: "No scope boundary — スコープが広すぎる",
      severity: "medium",
      suggestion: "対象範囲を制限（「この関数だけ」「このファイル内で」等）",
    });
  }

  // --- Reasoning Patterns ---
  if (options?.model && isReasoningModel(options.model) && /step by step|段階的|順を追って/i.test(input)) {
    issues.push({
      category: "reasoning",
      pattern: "Adding CoT to reasoning model — 推論モデルにCoTは不要",
      severity: "high",
      suggestion: `このモデル(${options.model})は推論モデルのため、CoT指示を削除。余計な思考を強制しない`,
    });
  }

  // --- Agentic Patterns ---
  if (detectAgentic(input)) {
    if (!/停止|止め|stop|終了|完了/i.test(input)) {
      issues.push({
        category: "agentic",
        pattern: "No stop condition — エージェントの停止条件なし",
        severity: "high",
        suggestion: "停止条件を明示（「目標達成したら停止」「最大5回の試行」等）",
      });
    }
  }

  return issues;
}

/**
 * 診断結果を見やすい文字列にフォーマット
 */
export function formatDiagnosis(issues: DiagnosticIssue[]): string {
  if (issues.length === 0) return "✅ 問題なし。プロンプト品質良好。";

  const severityEmoji = { high: "🔴", medium: "🟡", low: "🟢" } as const;

  return issues
    .map(i => `${severityEmoji[i.severity]} [${i.category}] ${i.pattern}\n  → ${i.suggestion}`)
    .join("\n");
}

/**
 * プロンプトの改善提案を生成
 */
export function suggestPromptImprovements(input: string, options?: {
  model?: string;
}): string {
  const issues = diagnosePrompt(input, options);
  if (issues.length === 0) return "";

  const intent = extractIntent(input, options?.model);
  const template = selectTemplate(intent);

  return [
    `## プロンプト改善提案`,
    ``,
    `検出された問題（${issues.length}件）:`,
    formatDiagnosis(issues),
    ``,
    `## 推奨テンプレート: ${template.id} - ${template.name}`,
    template.build({
      task: intent.task,
      input: input,
    }),
  ].join("\n");
}

// ==========================================
// Caveman Mode（JuliusBrussee/caveman 62k stars パターン）
// AIの出力をcaveman調に圧縮。75%トークン削減。
// システムプロンプト注入のみで実現。依存ゼロ。
// ==========================================

export type CavemanLevel = "lite" | "full" | "ultra" | "off";

const CAVEMAN_PROMPTS: Record<Exclude<CavemanLevel, "off">, string> = {
  lite: [
    "Drop filler words (sure, I'd be happy to, let me).",
    "Skip greetings and closings. Go straight to the answer.",
    "Keep technical accuracy 100%. Just remove the fluff.",
  ].join(" "),
  full: [
    "You are caveman. Brain still big. Mouth small.",
    "Answer like this: 'Bug in X. Cause Y. Fix: Z'",
    "No polite phrases. No explanations unless asked.",
    "One sentence per point. Verb first. Subject drop ok.",
    "Preserve ALL technical accuracy. Only cut words.",
  ].join("\n"),
  ultra: [
    "Absolute minimum words. Telegraphic style.",
    "Code blocks only when needed. No prose wrapping.",
    "Commands not sentences. Facts not paragraphs.",
    "Answer format: '<what>' not 'The issue is <what>'",
  ].join("\n"),
};

/**
 * caveman出力モードのシステムプロンプトを生成。
 * 既存のシステムプロンプトの末尾に追加する。
 */
export function buildCavemanPrompt(level: CavemanLevel): string {
  if (level === "off") return "";
  const prompt = CAVEMAN_PROMPTS[level];
  return `\n\n## Output Style: CAVEMAN (level: ${level})\n${prompt}\n\nRemember: same technical accuracy, 75% fewer words. Brain big. Mouth small.`;
}

/** cavemanレベルを文字列からパース */
export function parseCavemanLevel(raw: string): CavemanLevel {
  const r = raw.toLowerCase().trim();
  if (r === "lite" || r === "light") return "lite";
  if (r === "full" || r === "default" || r === "on" || r === "true") return "full";
  if (r === "ultra" || r === "max" || r === "extreme") return "ultra";
  return "off";
}

// ==========================================
// PreCompact Snapshot + SessionStart Restore（claude-mem 76k stars パターン）
// 会話圧縮前に重要なコンテキストをsnapshotとして保存し、
// 新セッション開始時に復元。圧縮生存率を向上。
// ==========================================

export interface SessionSnapshot {
  id: string;
  createdAt: number;
  compactedAt?: number;
  /** 保存する重要情報 */
  activeGoal?: string;
  keyDecisions: string[];
  unresolvedItems: string[];
  fileState: { path: string; hash: string }[];
  tokenCount: number;
}

/**
 * 現在のセッション状態からスナップショットを作成。
 * claude-memの PreCompact snapshot パターン。
 */
export function createSessionSnapshot(params: {
  activeGoal?: string;
  keyDecisions?: string[];
  unresolvedItems?: string[];
  fileHashes?: { path: string; hash: string }[];
  tokenCount?: number;
}): SessionSnapshot {
  return {
    id: `snap-${Date.now().toString(36)}`,
    createdAt: Date.now(),
    activeGoal: params.activeGoal,
    keyDecisions: params.keyDecisions ?? [],
    unresolvedItems: params.unresolvedItems ?? [],
    fileState: params.fileHashes ?? [],
    tokenCount: params.tokenCount ?? 0,
  };
}

/**
 * スナップショットから復元用のコンテキストブロックを生成。
 * claude-memの SessionStart restore パターン。
 * /clear 後にシステムプロンプトへ注入する。
 */
export function buildRestoreBlock(snapshot: SessionSnapshot): string {
  const parts: string[] = ["[SESSION RESTORED — 前回の重要コンテキスト]"];

  if (snapshot.activeGoal) {
    parts.push(`🎯 アクティブゴール: ${snapshot.activeGoal}`);
  }
  if (snapshot.keyDecisions.length > 0) {
    parts.push(`📋 決定事項:\n${snapshot.keyDecisions.map(d => `  - ${d}`).join("\n")}`);
  }
  if (snapshot.unresolvedItems.length > 0) {
    parts.push(`⚠️ 未解決:\n${snapshot.unresolvedItems.map(i => `  - ${i}`).join("\n")}`);
  }
  if (snapshot.fileState.length > 0) {
    parts.push(`📁 ファイル状態:\n${snapshot.fileState.map(f => `  - ${f.path}`).join("\n")}`);
  }
  parts.push(`(snapshot: ${snapshot.id}, tokens: ${snapshot.tokenCount})`);

  return parts.join("\n");
}

/**
 * AIによる観察の意味的要約（claude-mem AI summarization パターン）。
 * 生のツール出力を受け取り、LLMに要約させるためのプロンプトを生成。
 */
export function buildSummarizePrompt(rawObservation: string, maxTokens: number = 200): string {
  return [
    "Summarize the following tool output. Keep ONLY:",
    "- Key facts and numbers",
    "- Errors or warnings",
    "- Decisions made",
    "- Actionable next steps",
    "",
    "Drop: logs, stack traces (unless critical), redundant lines, boilerplate.",
    `Keep under ${maxTokens} tokens.`,
    "",
    "=== RAW OUTPUT ===",
    rawObservation.slice(0, 5000),
  ].join("\n");
}

// ==========================================
// Anti-Slop 禁止パターン（taste-skill 18k stars パターン）
// AIが統計的に生成しがちな凡庸パターンを明示禁止。
// システムプロンプトに注入してデザイン品質を向上。
// ==========================================

const ANTI_SLOP_RULES = [
  // Typography
  "NEVER use Inter font. Use system font stack or project-specified fonts.",
  "NEVER use AI-purple (#7C3AED, #8B5CF6) gradients.",
  "NEVER use blue-purple gradient text on dark backgrounds.",
  // Layout
  "NEVER use 3-column card grids as default layout.",
  "NEVER center-align hero text. Left-align or asymmetric.",
  "NEVER use generic emoji as section icons (🚀, ⭐, 💡, 🔥).",
  // Design
  "NEVER use glassmorphism (backdrop-blur translucent cards).",
  "NEVER use cookie-cutter SaaS landing page layouts.",
  "NEVER generate dark-mode-only designs without asking.",
  // Animation
  "Animate ONLY transform and opacity. NEVER animate width/height/color.",
  // Code
  "NEVER use placeholder comments (// TODO, // FIXME without details).",
  "NEVER use console.log without explaining what and why.",
  "NEVER import React.useState when useMotionValue is project standard.",
];

/**
 * Anti-Slopルールを含むシステムプロンプトを生成。
 * taste-skillの「禁止パターン明示」戦略。
 */
export function buildAntiSlopPrompt(): string {
  return [
    "",
    "## 🚫 Anti-Slop Rules (taste-skill)",
    "The following patterns are FORBIDDEN. They are statistically generic AI output — not good design:",
    "",
    ...ANTI_SLOP_RULES.map(r => `- ${r}`),
    "",
    "Be creative. Be specific. Be intentional. If the result looks like it could come from any AI, it's wrong.",
  ].join("\n");
}

// ==========================================
// Grill-Me 対話型詰めセッション（mattpocock/skills 93k stars パターン）
// 一次に1問だけ質問し、計画の設計木を段階的に解決。
// ==========================================

export interface GrillSession {
  /** セッション状態 */
  phase: "initial" | "questioning" | "resolved" | "done";
  /** 累積質問数 */
  questionCount: number;
  /** 解決済みの疑問 */
  resolved: { question: string; answer: string }[];
  /** 残っている未解決の疑問 */
  unresolved: string[];
  /** 信頼度（0-100） */
  confidence: number;
}

/**
 * Grill-Meセッションの次の質問を生成。
 * mattpocockの /grill-me コマンドに相当。
 * 
 * 使い方: ユーザーの曖昧な指示を受け、
 * 「これが現在の理解だが、ここが不明瞭だ。これで合ってるか？」
 * という形で1問だけ質問する。
 */
export function buildGrillQuestion(
  userIntent: string,
  session: GrillSession,
): string {
  if (session.phase === "done") {
    return "✅ All questions resolved. Ready to implement.";
  }

  if (session.unresolved.length > 0) {
    const next = session.unresolved[0]!;
    return [
      `🎯 **Question ${session.questionCount + 1}**`,
      ``,
      `Based on your intent: "${userIntent.slice(0, 200)}"`,
      ``,
      `I need to clarify: **${next}**`,
      ``,
      `My current understanding is: (explain what you think the answer is)`,
      `Is this correct? If not, what should it be?`,
    ].join("\n");
  }

  // 初回: 意図の再確認
  return [
    `🎯 **Let me confirm my understanding**`,
    ``,
    `You want: ${userIntent.slice(0, 200)}`,
    ``,
    `Here's what I'm assuming:`,
    `1. (assumption 1)`,
    `2. (assumption 2)`,
    ``,
    `Before I proceed, is this correct? What's missing?`,
  ].join("\n");
}

/**
 * ユーザー回答からグリルセッションを更新。
 * 信頼度が95%を超えたら done に遷移。
 */
export function updateGrillSession(
  session: GrillSession,
  userAnswer: string,
): GrillSession {
  const updated = { ...session, questionCount: session.questionCount + 1 };

  if (session.unresolved.length > 0) {
    const [answered, ...rest] = session.unresolved;
    updated.resolved = [...session.resolved, { question: answered!, answer: userAnswer }];
    updated.unresolved = rest;
  }

  // 全疑問が解決したらdone
  if (updated.unresolved.length === 0) {
    updated.confidence = 100;
    updated.phase = "done";
  } else {
    // 解決済み数から信頼度を推定
    updated.confidence = Math.min(95, Math.round(
      (updated.resolved.length / (updated.resolved.length + updated.unresolved.length)) * 100
    ));
    updated.phase = updated.confidence >= 95 ? "done" : "questioning";
  }

  return updated;
}

/**
 * 新しいGrill-Meセッションを開始。
 * ユーザーの意図から自動的に未解決の疑問を抽出。
 */
export function startGrillSession(userIntent: string): GrillSession {
  // 意図から抽出した疑似的な未解決疑問
  const unresolved = extractUnknowns(userIntent);
  return {
    phase: unresolved.length > 0 ? "questioning" : "done",
    questionCount: 0,
    resolved: [],
    unresolved,
    confidence: unresolved.length > 0 ? 30 : 95,
  };
}

/** 曖昧な指示から未解決の疑問を抽出 */
function extractUnknowns(intent: string): string[] {
  const unknowns: string[] = [];
  const lower = intent.toLowerCase();

  // スタック・フレームワークが指定されていない
  if (!/(react|vue|svelte|next|nuxt|express|fastify|django|flask|rails)/i.test(lower)) {
    unknowns.push("What tech stack/framework should be used?");
  }
  // UIライブラリが指定されていない
  if (!/(tailwind|css|styled|material|chakra|shadcn)/i.test(lower)) {
    unknowns.push("What styling approach? (Tailwind, CSS modules, styled-components, etc.)");
  }
  // デプロイ先が指定されていない
  if (!/(deploy|vercel|netlify|aws|cloudflare|docker|fly)/i.test(lower)) {
    unknowns.push("Where will this be deployed?");
  }
  // 対象ユーザーが不明
  if (!/(user|admin|customer|developer|internal|public)/i.test(lower)) {
    unknowns.push("Who is the target user?");
  }

  return unknowns;
}
