// ==========================================
// Aikata - 機能カタログ（OpenHuman about_app由来）
// 全機能の登録・検索・プライバシー開示
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type Stability = "stable" | "beta" | "experimental" | "deprecated";

export interface Capability {
  id: string;
  name: string;
  description: string;
  category: string;
  stability: Stability;
  privacy: {
    dataSent: string[];       // 送信されるデータ
    dataLocal: string[];      // ローカルに留まるデータ
    requiresNetwork: boolean;
  };
  dependencies: string[];    // 依存機能
  since: string;             // 追加バージョン
}

// ==================== 機能カタログ ====================

class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();

  constructor() {
    this.registerBuiltin();
  }

  /** 組み込み機能登録 */
  private registerBuiltin(): void {
    const caps: Capability[] = [
      // === コア ===
      { id: "core.chat", name: "チャット", description: "LLMとの会話", category: "core", stability: "stable",
        privacy: { dataSent: ["メッセージ内容"], dataLocal: ["会話履歴"], requiresNetwork: true }, dependencies: [], since: "1.0" },
      { id: "core.memory", name: "長期メモリ", description: "会話を超えた情報の記憶", category: "core", stability: "stable",
        privacy: { dataSent: ["メモリ内容"], dataLocal: ["メモリファイル"], requiresNetwork: false }, dependencies: ["core.chat"], since: "1.3" },

      // === ツール ===
      { id: "tool.terminal", name: "シェル実行", description: "コマンドライン実行", category: "tool", stability: "stable",
        privacy: { dataSent: [], dataLocal: ["コマンド出力"], requiresNetwork: false }, dependencies: [], since: "1.0" },
      { id: "tool.web_search", name: "Web検索", description: "インターネット検索", category: "tool", stability: "stable",
        privacy: { dataSent: ["検索クエリ"], dataLocal: [], requiresNetwork: true }, dependencies: [], since: "1.0" },
      { id: "tool.browser", name: "ブラウザ操作", description: "Webページの表示・操作", category: "tool", stability: "stable",
        privacy: { dataSent: ["アクセスURL"], dataLocal: ["スクリーンショット"], requiresNetwork: true }, dependencies: [], since: "1.0" },
      { id: "tool.code", name: "コード実行", description: "コードの実行", category: "tool", stability: "beta",
        privacy: { dataSent: [], dataLocal: ["実行結果"], requiresNetwork: false }, dependencies: [], since: "1.5" },
      { id: "tool.git", name: "Git操作", description: "Gitリポジトリ操作", category: "tool", stability: "beta",
        privacy: { dataSent: [], dataLocal: ["リポジトリデータ"], requiresNetwork: false }, dependencies: [], since: "1.9" },
      { id: "tool.file", name: "ファイル操作", description: "ファイルの読み書き", category: "tool", stability: "stable",
        privacy: { dataSent: [], dataLocal: ["ファイル内容"], requiresNetwork: false }, dependencies: [], since: "1.0" },

      // === 統合 ===
      { id: "integration.discord", name: "Discord連携", description: "Discord Bot", category: "integration", stability: "stable",
        privacy: { dataSent: ["メッセージ内容", "ユーザーID"], dataLocal: [], requiresNetwork: true }, dependencies: ["core.chat"], since: "1.0" },
      { id: "integration.telegram", name: "Telegram連携", description: "Telegram Bot", category: "integration", stability: "stable",
        privacy: { dataSent: ["メッセージ内容", "ユーザーID"], dataLocal: [], requiresNetwork: true }, dependencies: ["core.chat"], since: "1.0" },
      { id: "integration.email", name: "メール", description: "メール送受信", category: "integration", stability: "experimental",
        privacy: { dataSent: ["メール内容"], dataLocal: [], requiresNetwork: true }, dependencies: [], since: "1.12" },
      { id: "integration.obsidian", name: "Obsidian連携", description: "Obsidian Vault読み書き", category: "integration", stability: "experimental",
        privacy: { dataSent: [], dataLocal: ["ノート内容"], requiresNetwork: false }, dependencies: [], since: "1.15" },

      // === セキュリティ ===
      { id: "security.sandbox", name: "サンドボックス", description: "隔離実行", category: "security", stability: "experimental",
        privacy: { dataSent: [], dataLocal: ["隔離環境"], requiresNetwork: false }, dependencies: ["tool.terminal"], since: "1.14" },
      { id: "security.prompt_inject", name: "インジェクション対策", description: "プロンプトインジェクション防止", category: "security", stability: "stable",
        privacy: { dataSent: [], dataLocal: ["スキャン結果"], requiresNetwork: false }, dependencies: ["core.chat"], since: "1.9" },
      { id: "security.rate_limit", name: "レート制限", description: "過剰利用防止", category: "security", stability: "stable",
        privacy: { dataSent: [], dataLocal: ["アクセスログ"], requiresNetwork: false }, dependencies: [], since: "1.9" },

      // === 実験的 ===
      { id: "experimental.voice", name: "音声出力", description: "テキスト読み上げ", category: "experimental", stability: "experimental",
        privacy: { dataSent: ["読み上げテキスト"], dataLocal: ["音声ファイル"], requiresNetwork: true }, dependencies: [], since: "1.11" },
      { id: "experimental.ocr", name: "OCR/画面認識", description: "画像からの文字抽出", category: "experimental", stability: "experimental",
        privacy: { dataSent: ["画像データ"], dataLocal: ["OCR結果"], requiresNetwork: true }, dependencies: [], since: "1.13" },
    ];

    for (const cap of caps) {
      this.capabilities.set(cap.id, cap);
    }
  }

  /** 機能登録 */
  register(cap: Capability): void {
    this.capabilities.set(cap.id, cap);
  }

  /** 機能取得 */
  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /** カテゴリ別一覧 */
  listByCategory(category?: string): Capability[] {
    let all = Array.from(this.capabilities.values());
    if (category) all = all.filter(c => c.category === category);
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 安定性フィルタ */
  listByStability(stability: Stability): Capability[] {
    return Array.from(this.capabilities.values()).filter(c => c.stability === stability);
  }

  /** 検索 */
  search(query: string): Capability[] {
    const q = query.toLowerCase();
    return Array.from(this.capabilities.values())
      .filter(c =>
        c.id.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
      );
  }

  /** プライバシーサマリ */
  getPrivacySummary(): { sent: string[]; local: string[]; networkCount: number } {
    const sent = new Set<string>();
    const local = new Set<string>();
    let networkCount = 0;

    for (const cap of Array.from(this.capabilities.values())) {
      for (const d of cap.privacy.dataSent) sent.add(d);
      for (const d of cap.privacy.dataLocal) local.add(d);
      if (cap.privacy.requiresNetwork) networkCount++;
    }

    return { sent: Array.from(sent), local: Array.from(local), networkCount };
  }

  get stats(): { total: number; stable: number; beta: number; experimental: number; categories: number } {
    const cats = new Set(Array.from(this.capabilities.values()).map(c => c.category));
    return {
      total: this.capabilities.size,
      stable: this.listByStability("stable").length,
      beta: this.listByStability("beta").length,
      experimental: this.listByStability("experimental").length,
      categories: cats.size,
    };
  }

  formatCapabilities(caps?: Capability[]): string {
    const list = caps || this.listByCategory();
    if (list.length === 0) return "📋 機能は登録されていません。";

    const stabIcons: Record<Stability, string> = { stable: "✅", beta: "🔶", experimental: "🧪", deprecated: "⚠️" };
    const cats = new Map<string, Capability[]>();
    for (const c of list) {
      const arr = cats.get(c.category) || [];
      arr.push(c);
      cats.set(c.category, arr);
    }

    return [
      "📋 **機能カタログ**",
      "",
      ...Array.from(cats.entries()).map(([cat, caps]) => {
        return `**${cat}:**\n${caps.map(c => `${stabIcons[c.stability]} \`${c.id}\`: ${c.description}`).join("\n")}`;
      }),
    ].join("\n\n");
  }
}

// ==================== シングルトン ====================

export const capabilityRegistry = new CapabilityRegistry();
