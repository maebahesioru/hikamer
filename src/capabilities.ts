// ==========================================
// Aikata - 機能カタログ（OpenHuman about_app/ 完全移植）
// 全Aikata機能の自己記述カタログ + カテゴリ別検索 + プライバシー開示
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type CapabilityCategory =
  | "conversation" | "intelligence" | "skills" | "local_ai" | "team"
  | "settings" | "auth" | "screen" | "channels" | "automation";

export type CapabilityStatus = "stable" | "beta" | "coming_soon" | "deprecated";

export type PrivacyDataKind = "raw" | "derived" | "credentials" | "diagnostics" | "metadata";

export interface CapabilityPrivacy {
  leavesDevice: boolean;
  dataKind: PrivacyDataKind;
  destinations: string[];
}

export interface Capability {
  id: string;
  name: string;
  domain: string;
  category: CapabilityCategory;
  description: string;
  howTo: string;
  status: CapabilityStatus;
  privacy?: CapabilityPrivacy;
}

// ==================== カタログ（85+ 機能） ====================

const CAPABILITIES: Capability[] = [
  // === Conversation ===
  { id: "conversation.chat", name: "会話", domain: "conversation", category: "conversation", description: "自然言語での対話", howTo: "任意のメッセージを送信", status: "stable" },
  { id: "conversation.streaming", name: "ストリーミング応答", domain: "conversation", category: "conversation", description: "リアルタイムでの応答生成", howTo: "自動", status: "stable" },
  { id: "conversation.threads", name: "スレッド管理", domain: "conversation", category: "conversation", description: "会話スレッドの作成・管理", howTo: "/threads", status: "stable" },
  { id: "conversation.context", name: "コンテキスト管理", domain: "conversation", category: "conversation", description: "会話履歴の圧縮・管理", howTo: "自動", status: "stable" },
  { id: "conversation.send_text", name: "テキスト送信", domain: "messaging", category: "conversation", description: "Discord/Telegramへのメッセージ送信", howTo: "自動", status: "stable", privacy: { leavesDevice: true, dataKind: "raw", destinations: ["discord", "telegram"] } },

  // === Intelligence ===
  { id: "intelligence.web_search", name: "Web検索", domain: "tools", category: "intelligence", description: "SearXNG・内蔵検索によるWeb情報収集", howTo: "自動または/search", status: "stable" },
  { id: "intelligence.web_extract", name: "ページ抽出", domain: "tools", category: "intelligence", description: "Webページ内容の構造化抽出", howTo: "自動", status: "stable" },
  { id: "intelligence.browser", name: "ブラウザ操作", domain: "tools", category: "intelligence", description: "ヘッドレスブラウザによるWeb操作", howTo: "/browser", status: "beta" },
  { id: "intelligence.code_exec", name: "コード実行", domain: "tools", category: "intelligence", description: "Python/シェルコードの実行", howTo: "自動", status: "stable" },
  { id: "intelligence.mcp", name: "MCPサーバー連携", domain: "tools", category: "intelligence", description: "Model Context Protocolによる外部ツール統合", howTo: "自動", status: "beta" },
  { id: "intelligence.file_ops", name: "ファイル操作", domain: "tools", category: "intelligence", description: "ファイルの読み書き・編集", howTo: "自動", status: "stable" },
  { id: "intelligence.git", name: "Git操作", domain: "tools", category: "intelligence", description: "Gitリポジトリ管理", howTo: "自動", status: "stable" },
  { id: "intelligence.image_gen", name: "画像生成", domain: "tools", category: "intelligence", description: "AI画像生成", howTo: "/image", status: "beta" },
  { id: "intelligence.tts", name: "音声合成", domain: "tools", category: "intelligence", description: "テキスト読み上げ", howTo: "自動", status: "stable" },
  { id: "intelligence.rem_memory", name: "REM記憶システム", domain: "intelligence", category: "intelligence", description: "短期→長期記憶の自動昇格", howTo: "/memory", status: "beta" },
  { id: "intelligence.embeddings", name: "埋め込みベクトル", domain: "intelligence", category: "intelligence", description: "セマンティック検索用ベクトル埋め込み", howTo: "自動", status: "stable" },
  { id: "intelligence.screen", name: "画面認識", domain: "intelligence", category: "intelligence", description: "OCR・画面内容の解析", howTo: "/screen", status: "beta" },
  { id: "intelligence.think_scrubber", name: "思考タグ除去", domain: "intelligence", category: "intelligence", description: "ストリーミング中の思考ブロック除去", howTo: "自動", status: "stable" },
  { id: "intelligence.learning", name: "学習", domain: "intelligence", category: "intelligence", description: "会話からのパターン学習", howTo: "自動", status: "stable" },
  { id: "intelligence.reflection", name: "振り返り", domain: "intelligence", category: "intelligence", description: "サブコンシャス思考", howTo: "/reflection (自動)", status: "beta" },
  { id: "intelligence.commitments", name: "約束追跡", domain: "intelligence", category: "intelligence", description: "会話からの約束自動抽出・フォローアップ", howTo: "/commits", status: "beta" },

  // === Skills ===
  { id: "skills.system", name: "スキルシステム", domain: "skills", category: "skills", description: "プラグイン可能なスキル管理", howTo: "/skills", status: "beta" },
  { id: "skills.cron", name: "スケジューラー", domain: "cron", category: "skills", description: "定期実行ジョブ管理", howTo: "/cron", status: "stable" },
  { id: "skills.heartbeat", name: "心拍エンジン", domain: "cron", category: "skills", description: "定期バックグラウンド処理", howTo: "/heartbeat", status: "beta" },
  { id: "skills.subagents", name: "サブエージェント", domain: "agents", category: "skills", description: "バックグラウンド分離エージェント", howTo: "/subagents", status: "beta" },

  // === Local AI ===
  { id: "local_ai.ollama", name: "Ollama連携", domain: "local", category: "local_ai", description: "ローカルLLM推論", howTo: "/locals", status: "stable" },
  { id: "local_ai.embed_text", name: "テキスト埋め込み", domain: "local", category: "local_ai", description: "ローカルベクトル埋め込み", howTo: "自動", status: "stable", privacy: { leavesDevice: true, dataKind: "derived", destinations: ["開示なし"] } },

  // === Team ===
  { id: "team.multi_session", name: "マルチセッション", domain: "session", category: "team", description: "複数同時会話セッション", howTo: "自動", status: "stable" },
  { id: "team.people", name: "人物管理", domain: "people", category: "team", description: "連絡先・人物情報管理", howTo: "/people", status: "stable" },

  // === Settings ===
  { id: "settings.config", name: "設定管理", domain: "config", category: "settings", description: "全設定の管理・検証", howTo: "/crestodian config", status: "stable" },
  { id: "settings.secrets", name: "機密情報管理", domain: "secrets", category: "settings", description: "SecretRef解決・監査", howTo: "/secrets", status: "beta" },
  { id: "settings.crestodian", name: "自己診断", domain: "health", category: "settings", description: "LLM駆動システム診断", howTo: "/crestodian", status: "beta" },
  { id: "settings.health", name: "ヘルスチェック", domain: "health", category: "settings", description: "死活監視", howTo: "/health", status: "stable" },
  { id: "settings.doctor", name: "ドクター診断", domain: "health", category: "settings", description: "自動修復付き診断", howTo: "/crestodian doctor", status: "beta" },
  { id: "settings.sandbox", name: "セキュリティサンドボックス", domain: "security", category: "settings", description: "コマンドリスク評価・プロセス隔離", howTo: "/sandbox", status: "beta" },
  { id: "settings.approval", name: "承認ワークフロー", domain: "security", category: "settings", description: "危険操作の承認フロー", howTo: "自動", status: "stable" },
  { id: "settings.billing", name: "コスト追跡", domain: "cost", category: "settings", description: "API使用料の追跡", howTo: "/cost", status: "stable" },
  { id: "settings.ratelimit", name: "レート制限", domain: "security", category: "settings", description: "APIレート制限管理", howTo: "/ratelimit", status: "stable" },

  // === Auth ===
  { id: "auth.credentials", name: "認証情報", domain: "auth", category: "auth", description: "API鍵の暗号化保存", howTo: "/keys", status: "stable", privacy: { leavesDevice: false, dataKind: "credentials", destinations: ["ローカル暗号化保存"] } },
  { id: "auth.mcp_oauth", name: "MCP OAuth", domain: "auth", category: "auth", description: "MCPサーバーOAuth認証", howTo: "/mcp-oauth", status: "beta" },

  // === Screen ===
  { id: "screen.capture", name: "スクリーンキャプチャ", domain: "screen", category: "screen", description: "画面内容の取得・解析", howTo: "/screen", status: "beta" },
  { id: "screen.ocr", name: "OCR文字認識", domain: "screen", category: "screen", description: "画像からの文字抽出", howTo: "/screen ocr", status: "beta" },

  // === Channels ===
  { id: "channels.discord", name: "Discord連携", domain: "discord", category: "channels", description: "Discord Botとして応答", howTo: "/discord", status: "stable" },
  { id: "channels.telegram", name: "Telegram連携", domain: "telegram", category: "channels", description: "Telegram Botとして応答", howTo: "/channels", status: "stable" },
  { id: "channels.slack", name: "Slack連携", domain: "slack", category: "channels", description: "Slackアプリとして応答", howTo: "/channels", status: "beta" },
  { id: "channels.multi", name: "マルチチャンネル", domain: "channels", category: "channels", description: "複数プラットフォーム統合", howTo: "/channels", status: "beta" },

  // === Automation ===
  { id: "automation.scheduler", name: "スケジューラー", domain: "cron", category: "automation", description: "定期タスク実行", howTo: "/cron", status: "stable" },
  { id: "automation.webhook", name: "Webhook受信", domain: "webhook", category: "automation", description: "外部Webhookの受信・ルーティング", howTo: "/webhook", status: "beta" },
  { id: "automation.flows", name: "セットアップフロー", domain: "setup", category: "automation", description: "対話型セットアップウィザード", howTo: "/flows", status: "beta" },
  { id: "automation.auto_update", name: "自動更新", domain: "update", category: "automation", description: "セルフアップデート", howTo: "/update", status: "stable" },
  { id: "automation.self_heal", name: "自己修復", domain: "health", category: "automation", description: "問題の自動検出・回復", howTo: "/healer", status: "stable" },

  // === モデル ===
  { id: "model.openrouter", name: "OpenRouter連携", domain: "provider", category: "settings", description: "OpenRouter API経由のLLMアクセス", howTo: "自動", status: "stable" },
  { id: "model.provider_router", name: "プロバイダルーティング", domain: "provider", category: "settings", description: "LLMプロバイダの自動選択", howTo: "/models", status: "stable" },

  // === システム ===
  { id: "system.status", name: "システム状態", domain: "system", category: "settings", description: "稼働状態の確認", howTo: "/status", status: "stable" },
  { id: "system.logs", name: "ログ管理", domain: "system", category: "settings", description: "実行ログの確認", howTo: "/logs", status: "stable" },
  { id: "system.db", name: "データベース", domain: "system", category: "settings", description: "SQLiteデータベース管理", howTo: "/db", status: "stable" },
  { id: "system.plugins", name: "プラグイン", domain: "system", category: "settings", description: "プラグイン管理", howTo: "/plugin", status: "stable" },
];

// ==================== クエリ関数 ====================

/** 全機能を取得 */
export function allCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

/** カテゴリ別 */
export function capabilitiesByCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITIES.filter((c) => c.category === category);
}

/** ID検索 */
export function lookupCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id.toLowerCase() === id.toLowerCase().trim());
}

/** 全文検索 */
export function searchCapabilities(query: string): Capability[] {
  const q = query.toLowerCase();
  return CAPABILITIES.filter(
    (c) =>
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.domain.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.status.toLowerCase().includes(q),
  );
}

/** フォーマット */
export function formatCapability(c: Capability, verbose = false): string {
  const statusIcon: Record<CapabilityStatus, string> = {
    stable: "✅", beta: "🧪", coming_soon: "🔜", deprecated: "⚠️",
  };

  const lines = [`${statusIcon[c.status] ?? "❓"} **${c.name}**`];
  lines.push(`  ${c.description}`);
  if (verbose) {
    lines.push(`  ID: \`${c.id}\``);
    lines.push(`  カテゴリ: ${c.category} | ドメイン: ${c.domain}`);
    lines.push(`  使い方: ${c.howTo}`);
    if (c.privacy) {
      const ds = c.privacy.leavesDevice ? `→ ${c.privacy.destinations.join(", ")}` : "端末内";
      lines.push(`  プライバシー: ${c.privacy.dataKind} (${ds})`);
    }
  } else {
    lines.push(`  \`${c.howTo}\``);
  }

  return lines.join("\n");
}

export function formatCapabilityList(caps: Capability[], verbose = false): string {
  if (caps.length === 0) return "📋 該当する機能はありません。";
  const total = {
    stable: caps.filter((c) => c.status === "stable").length,
    beta: caps.filter((c) => c.status === "beta").length,
    coming_soon: caps.filter((c) => c.status === "coming_soon").length,
    deprecated: caps.filter((c) => c.status === "deprecated").length,
  };

  const lines: string[] = [
    "📋 **Aikata 機能カタログ**",
    `  合計: ${caps.length}機能 (✅${total.stable} 🧪${total.beta} ${total.coming_soon ? "🔜" + total.coming_soon : ""}${total.deprecated ? " ⚠️" + total.deprecated : ""})`,
    "",
  ];

  for (const c of caps) {
    lines.push(formatCapability(c, verbose));
    lines.push("");
  }

  return lines.join("\n");
}

export function formatCategories(): string {
  const categories: CapabilityCategory[] = [
    "conversation", "intelligence", "skills", "local_ai", "team",
    "settings", "auth", "screen", "channels", "automation",
  ];
  const categoryLabels: Record<CapabilityCategory, string> = {
    conversation: "💬 会話", intelligence: "🧠 知能", skills: "🔧 スキル",
    local_ai: "🖥️ ローカルAI", team: "👥 チーム", settings: "⚙️ 設定",
    auth: "🔐 認証", screen: "🖼️ 画面", channels: "🔌 チャンネル",
    automation: "🤖 自動化",
  };

  const lines: string[] = ["📂 **機能カテゴリ**"];
  for (const cat of categories) {
    const count = CAPABILITIES.filter((c) => c.category === cat).length;
    lines.push(`  ${categoryLabels[cat]}: ${count}機能`);
  }
  return lines.join("\n");
}
