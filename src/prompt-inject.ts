// ==========================================
// Aikata - プロンプトインジェクション防止（OpenHuman prompt_injection由来）
// ユーザー入力をスキャンして既知のインジェクション手法を検出
// ==========================================

import { logger } from "./utils/logger";

// ==================== 検出ルール ====================

interface InjectionRule {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  patterns: RegExp[];
  description: string;
  action: "block" | "warn" | "strip";
}

const INJECTION_RULES: InjectionRule[] = [
  // === システムプロンプト上書き ===
  {
    id: "sysprompt-override",
    severity: "critical",
    patterns: [
      /forget\s+(all\s+)?(previous|prior)\s+instructions/i,
      /ignore\s+(all\s+)?(previous|prior)\s+(instructions|directions|commands)/i,
      /あなた(の)?(これまでの)?(指示|命令|ルール)(は)?(全て)?(無視|無効|忘れ)/i,
      /you\s+(should|must|will)\s+(ignore|forget|disregard)\s+(your|all)\s+(previous|prior)\s+(instructions|prompts|directions)/i,
    ],
    description: "システムプロンプト上書き試行",
    action: "block",
  },

  // === ロール変更 ===
  {
    id: "role-change",
    severity: "high",
    patterns: [
      /you\s+are\s+(now|no longer)\s+/i,
      /あなた(は)?(もう|これからは|これまで)?(ねこ|猫|bot|なんとか|DAN|開発者)/i,
      /you\s+are\s+DAN/i,
      /do\s+anything\s+now/i,
      /DAN\s*[:：]/i,
    ],
    description: "ロール改変/特権昇格",
    action: "block",
  },

  // === プロンプト漏洩 ===
  {
    id: "prompt-leak",
    severity: "high",
    patterns: [
      /出力(の)?(最初|はじめ)/i,
      /(教えて|表示して|出力して).*(プロンプト|指示|命令|system|instructions)/i,
      /(what|show|tell|print|output|display|reveal|leak).*(prompt|instructions|system\s+message|initial\s+text)/i,
      /repeat\s+(after\s+me|the\s+(words|text|prompt|above))/i,
      /あなたの(プロンプト|指示|命令)/i,
      /system\s*[:：]\s*you/i,
      /交代|役割\s+交代/i,
    ],
    description: "プロンプト情報漏洩試行",
    action: "block",
  },

  // === ペイロード埋め込み ===
  {
    id: "payload-embed",
    severity: "medium",
    patterns: [
      /\[system\]|\[user\]|\[assistant\]|\[tool\]|\[end\]/i,
      /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>/i,
      /##\s*(system|user|assistant)/i,
      /<<SYS>>|<<USER>>|<<ASSISTANT>>/i,
    ],
    description: "疑似会話タグの埋め込み",
    action: "strip",
  },

  // === エンコードによるバイパス ===
  {
    id: "encoding-bypass",
    severity: "high",
    patterns: [
      /base64\s*(で|で)?(エンコード|decode|でコード)/i,
      /(base64|rot13|hex|binary)\s*(encode|decode)/i,
      /(base64|binary)\s*(で|に)?(直して|変換|decode|decoding)/i,
    ],
    description: "エンコードによるバイパス試行",
    action: "warn",
  },

  // === トークナイザー操作 ===
  {
    id: "tokenizer-trick",
    severity: "medium",
    patterns: [
      /ignore\s+above/i,
      /無視.*上/i,
      /上記.*無視/i,
      /逆張り|裏技|裏ワザ/i,
      /security\s*[:：]\s*(low|none|disabled|off)/i,
    ],
    description: "トークナイザー操作/カジュアルなバイパス",
    action: "warn",
  },

  // === 感情操作 ===
  {
    id: "emotional-manipulation",
    severity: "low",
    patterns: [
      /もし(私|僕|俺)が(死ぬ|消える)/i,
      /お願い.*死/i,
      /最後の(お願い|チャンス)/i,
      /if\s+(you\s+)?(really\s+)?(care|love|understand)/i,
      /this\s+is\s+(very\s+)?important\s+to\s+me/i,
      /命に関わる/i,
    ],
    description: "感情操作/緊急性強調",
    action: "warn",
  },

  // === 多段命令 ===
  {
    id: "multi-stage",
    severity: "low",
    patterns: [
      /first.*then.*(next|after|finally).*/i,
      /step\s+by\s+step.*(but|however|actually).*/i,
      /最初に.*次に.*最後に/i,
      /手順.*しかし.*本当/i,
    ],
    description: "多段命令パターン",
    action: "warn",
  },

  // === ツールエイリアス >> エスケープ ===
  {
    id: "command-injection",
    severity: "high",
    patterns: [
      /`[^`]+`\s*(&&|\|\|)\s*`[^`]+`/i,          // シェルのコマンド連結
      /\$\{.*\}.*\$\{.*\}/i,                        // 変数展開2回
      /\\\$\\{[^}]+\\}/i,                           // エスケープされた変数
      /process\.env|process\.argv|Deno\.env/i,      // 環境変数アクセス
      /[\"']\s*\+\s*[\"']/,                         // 文字列連結
      /\/\/\s*todo/i,                                // コード内TODOマーカー（トークン化防止）
      /eval\s*\(|Function\s*\(/i,                    // コード実行
    ],
    description: "コードインジェクション/エスケープ試行",
    action: "warn",
  },

  // === 日本語向けバイパス ===
  {
    id: "japanese-bypass",
    severity: "medium",
    patterns: [
      /日本語(で|で)?(は)?(なく|禁止)/i,
      /英語(で|のみ)/i,
      /中国語(で|のみ)/i,
      /母国語/i,
      /日本語以外/i,
    ],
    description: "言語変更によるバイパス試行",
    action: "warn",
  },

  // === 自己参照 ===
  {
    id: "self-reference",
    severity: "low",
    patterns: [
      /あなた(自身|自信|自分|のシステム)/i,
      /あなたという(存在|システム|プログラム)/i,
      /(think|speak|respond)\s+(in|as|like)\s+(a|an)\s+(human|person|ai|assistant)/i,
    ],
    description: "自己参照/メタ認知",
    action: "warn",
  },
];

// ==================== スキャンエンジン ====================

interface ScanResult {
  safe: boolean;
  matchedRules: Array<{
    id: string;
    severity: string;
    description: string;
    action: string;
    matchedPattern: string;
  }>;
  action: "allow" | "block" | "warn";
  blockedText?: string;
}

/**
 * ユーザー入力をスキャンしてインジェクションを検出
 * テキストは正規化（全角→半角、大文字化）してチェック
 */
export function scanInput(text: string): ScanResult {
  const normalized = normalizeText(text);
  const matchedRules: ScanResult["matchedRules"] = [];

  for (const rule of INJECTION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) {
        matchedRules.push({
          id: rule.id,
          severity: rule.severity,
          description: rule.description,
          action: rule.action,
          matchedPattern: pattern.source.slice(0, 80),
        });
        break; // ルール内で1マッチのみ
      }
    }
  }

  if (matchedRules.length === 0) {
    return { safe: true, matchedRules: [], action: "allow" };
  }

  // アクション決定（最悪のSeverityで）
  const hasCritical = matchedRules.some(r => r.severity === "critical");
  const hasHigh = matchedRules.some(r => r.severity === "high" || r.action === "block");
  const hasMedium = matchedRules.some(r => r.severity === "medium");
  const hasWarn = matchedRules.some(r => r.action === "warn");

  // クリティカル/ハイ or action=block → ブロック
  if (hasCritical || hasHigh) {
    logger.warn(`[PromptInject] ブロック: ${matchedRules.map(r => `${r.id}(${r.severity})`).join(",")}`);
    return {
      safe: false,
      matchedRules,
      action: "block",
      blockedText: text.slice(0, 200),
    };
  }

  // 警告 → そのまま通すがログに記録
  if (hasWarn || hasMedium) {
    logger.warn(`[PromptInject] 警告: ${matchedRules.map(r => `${r.id}(${r.severity})`).join(",")}`);
    return {
      safe: true,
      matchedRules,
      action: "warn",
    };
  }

  return { safe: true, matchedRules: [], action: "allow" };
}

// ==================== テキスト正規化 ====================

function normalizeText(text: string): string {
  let s = text;

  // 全角英数字→半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );

  // 全角スペース→半角
  s = s.replace(/　/g, " ");

  // 制御文字除去（改行は維持）
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  // 複数スペース→1つ
  s = s.replace(/\s+/g, " ");

  return s.trim();
}

// ==================== 管理API ====================

/** ルール一覧取得 */
export function listRules(): InjectionRule[] {
  return INJECTION_RULES.map(r => ({
    ...r,
    patterns: [], // パターンは非公開
  }));
}

/** ルール動的追加（柔軟なスキャンカスタマイズ） */
export function addRule(rule: InjectionRule): void {
  INJECTION_RULES.push(rule);
  logger.info(`[PromptInject] ルール追加: ${rule.id} (${rule.severity})`);
}

/** ルール削除 */
export function removeRule(id: string): boolean {
  const idx = INJECTION_RULES.findIndex(r => r.id === id);
  if (idx === -1) return false;
  INJECTION_RULES.splice(idx, 1);
  logger.info(`[PromptInject] ルール削除: ${id}`);
  return true;
}

// ==================== フォーマット ====================

export function formatScanResult(result: ScanResult): string | null {
  if (result.safe && result.action === "allow") return null;

  if (result.action === "block") {
    return [
      "🚨 **プロンプトインジェクションを検出しました**",
      "",
      ...result.matchedRules.map(r =>
        `- ${r.severity === "critical" ? "🔴" : r.severity === "high" ? "🟠" : "🟡"} **${r.description}** (${r.severity})`
      ),
      "",
      "このメッセージはセキュリティ上の理由から処理できません。",
    ].join("\n");
  }

  if (result.action === "warn") {
    return [
      "⚠️ **注意: インジェクションの可能性**",
      "",
      ...result.matchedRules.map(r =>
        `- ${r.severity === "critical" ? "🔴" : r.severity === "high" ? "🟠" : "🟡"} ${r.description}`
      ),
    ].join("\n");
  }

  return null;
}
