// ==========================================
// Aikata - Flow System（OpenClaw flows/ 由来）
// LLMガイド付きセットアップウィザード＋ヘルスチェックフロー
// ==========================================

import { logger } from "./utils/logger";
import { toolRegistry } from "./tools/registry";
import { collectOverview } from "./crestodian";
import { channelManager } from "./channels";

// ==================== 型定義 ====================

export type FlowSurface = "auth_choice" | "health" | "model_picker" | "setup";
export type FlowContributionKind = "channel" | "core" | "provider" | "search";

export interface FlowOption<Value = any> {
  label: string;
  value: Value;
  description?: string;
  hint?: string;
}

export interface FlowContribution {
  kind: FlowContributionKind;
  surface: FlowSurface;
  label: string;
  options: FlowOption[];
}

// ==================== フロー管理 ====================

const contributions: FlowContribution[] = [];

export function registerFlow(contrib: FlowContribution): void {
  contributions.push(contrib);
  logger.info(`[Flows] 登録: ${contrib.label} (${contrib.kind}/${contrib.surface})`);
}

export function getFlows(surface?: FlowSurface): FlowContribution[] {
  if (surface) return contributions.filter((c) => c.surface === surface);
  return [...contributions];
}

// ==================== セットアップフロー ====================

/** プロバイダセットアップフロー（モデル選択） */
export function providerFlow(): FlowContribution[] {
  // 組み込みモデルプロバイダ
  const providers: FlowOption[] = [
    { label: "OpenRouter (DeepSeek V4 Pro)", value: "openrouter:deepseek/deepseek-v4-pro", description: "推奨: 最速・最高性能" },
    { label: "OpenAI (GPT-5.5)", value: "openrouter:openai/gpt-5.5", description: "OpenRouter経由GPT-5.5" },
    { label: "Anthropic (Claude 4.7 Opus)", value: "openrouter:anthropic/claude-4.7-opus", description: "OpenRouter経由Claude" },
    { label: "xAI (Grok 4.3)", value: "openrouter:xai/grok-4.3", description: "OpenRouter経由Grok" },
    { label: "OpenCode Go", value: "opencode:deepseek-v4-pro", description: "OpenCode Go CLI連携" },
    { label: "カスタムAPI", value: "custom", description: "独自のAPIエンドポイント" },
  ];

  return [{ kind: "provider", surface: "model_picker", label: "モデルプロバイダ", options: providers }];
}

/** チャンネルセットアップフロー */
export function channelSetupFlow(): FlowContribution[] {
  const channels: FlowOption[] = [
    { label: "Discord Bot", value: "discord", description: "Discord Botトークンが必要", hint: "DISCORD_TOKEN" },
    { label: "Telegram Bot", value: "telegram", description: "Telegram Bot Tokenが必要", hint: "TELEGRAM_BOT_TOKEN" },
    { label: "Slack App", value: "slack", description: "Slack Bot Tokenが必要", hint: "SLACK_BOT_TOKEN" },
  ];
  return [{ kind: "channel", surface: "setup", label: "チャンネル追加", options: channels }];
}

/** Web検索プロバイダセットアップ */
export function searchSetupFlow(): FlowContribution[] {
  const searchProviders: FlowOption[] = [
    { label: "SearXNG (自己ホスト)", value: "searxng", description: "最高のプライバシー" },
    { label: "Web Search (内蔵)", value: "builtin", description: "デフォルトのWeb検索" },
  ];
  return [{ kind: "search", surface: "setup", label: "検索プロバイダ", options: searchProviders }];
}

// 組み込みフローを登録
registerFlow(providerFlow()[0]!);
registerFlow(channelSetupFlow()[0]!);
registerFlow(searchSetupFlow()[0]!);

// ==================== ヘルスチェックフロー ====================

export interface HealthCheck {
  name: string;
  description: string;
  check: () => Promise<boolean>;
  fix?: () => Promise<boolean>;
  category: string;
}

const healthChecks: HealthCheck[] = [];

export function registerHealthCheck(check: HealthCheck): void {
  healthChecks.push(check);
}

export function getHealthChecks(category?: string): HealthCheck[] {
  if (category) return healthChecks.filter((c) => c.category === category);
  return [...healthChecks];
}

/** 全ヘルスチェックを実行 */
export async function runAllHealthChecks(): Promise<Array<{ name: string; ok: boolean; fixed: boolean }>> {
  const results: Array<{ name: string; ok: boolean; fixed: boolean }> = [];

  for (const check of healthChecks) {
    try {
      const ok = await check.check();
      if (!ok && check.fix) {
        const fixed = await check.fix();
        results.push({ name: check.name, ok: false, fixed });
      } else {
        results.push({ name: check.name, ok, fixed: false });
      }
    } catch {
      results.push({ name: check.name, ok: false, fixed: false });
    }
  }

  return results;
}

// 組み込みヘルスチェックを登録
registerHealthCheck({
  name: "api-connectivity",
  description: "LLM APIへの接続確認",
  category: "network",
  check: async () => {
    const overview = await collectOverview();
    return overview.network.reachable["api.openrouter.ai"] !== false;
  },
});

registerHealthCheck({
  name: "mcp-servers",
  description: "MCPサーバー接続状態",
  category: "tools",
  check: async () => {
    const mcpTools = toolRegistry.list().filter((t) => t.name.startsWith("mcp_"));
    return mcpTools.length > 0;
  },
  fix: async () => {
    try {
      const { connectAllMcpServers } = await import("./tools/mcp-client");
      await connectAllMcpServers();
      return true;
    } catch { return false; }
  },
});

registerHealthCheck({
  name: "config-valid",
  description: "設定ファイルの検証",
  category: "config",
  check: async () => {
    const overview = await collectOverview();
    return overview.config.valid;
  },
});

registerHealthCheck({
  name: "discord-connection",
  description: "Discord接続状態",
  category: "channels",
  check: async () => {
    const ch = channelManager.getChannel("telegram");
    if (ch) return ch.healthCheck();
    return true; // チャンネル未設定はスキップ
  },
});

// ==================== ウィザード実行 ====================

/** 対話型セットアップウィザード（LLMが使えないときのテキストベース） */
export function formatSetupGuide(): string {
  const lines: string[] = [
    "🚀 **Aikata セットアップガイド**",
    "",
    "**ステップ1: モデルプロバイダの設定**",
    "  対応プロバイダ:",
    "  • OpenRouter (DeepSeek V4 Pro / GPT-5.5 / Claude 4.7 / Grok 4.3)",
    "  • OpenCode Go CLI",
    "  • カスタムAPIエンドポイント",
    "",
    "**ステップ2: チャンネルの追加**",
    "  • Discord: DISCORD_TOKEN を環境変数に設定",
    "  • Telegram: TELEGRAM_BOT_TOKEN を環境変数に設定",
    "  • Slack: SLACK_BOT_TOKEN を環境変数に設定",
    "",
    "**ステップ3: 検索プロバイダ**",
    "  • SearXNG (http://localhost:18080) — 推奨",
    "  • 内蔵Web検索",
    "",
    "**ステップ4: ヘルスチェックの実行**",
    "  `/crestodian doctor` または `/crestodian doctor-fix` で診断",
    "",
    "**参考: 全てのコマンド**",
    "  `/channels` — チャンネル状態",
    "  `/crestodian` — システム診断",
    "  `/health` — ヘルスチェック",
    "  `/commits` — 約束管理",
    "  `/memory` — REM記憶システム",
    "  `/heartbeat` — 定期実行エンジン",
  ];
  return lines.join("\n");
}

export function formatHealthReport(results: Array<{ name: string; ok: boolean; fixed: boolean }>): string {
  if (results.length === 0) return "🏥 **ヘルスチェック**: 登録されたチェックはありません。";

  const lines: string[] = ["🏥 **ヘルスチェックレポート**"];
  let allOk = true;

  for (const r of results) {
    if (r.ok) {
      lines.push(`  ✅ ${r.name}`);
    } else if (r.fixed) {
      lines.push(`  🔧 ${r.name} (修復済み)`);
      allOk = false;
    } else {
      lines.push(`  ❌ ${r.name}`);
      allOk = false;
    }
  }

  lines.push("");
  lines.push(allOk ? "**すべて正常です** 🎉" : "**一部の問題があります** ⚠️");
  return lines.join("\n");
}
