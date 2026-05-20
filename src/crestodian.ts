// ==========================================
// Hikamer - Crestodian / AI Self-Heal（OpenClaw crestodian/由来）
// LLM駆動のシステム診断・自己修復エンジン
// 既存のself-healer.ts（ルールベース）と連携し、LLM診断を追加
// ==========================================

import { logger } from "./utils/logger";
import { selfHealer } from "./self-healer";
import { eventBus, createEvent } from "./event-bus";
import { runHealthCheck } from "./health";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { createHash } from "crypto";

// ==================== 型定義 ====================

/** システム全体の診断状態 */
export interface SystemOverview {
  config: { path: string; exists: boolean; valid: boolean; issues: string[]; hash: string };
  services: Array<{ name: string; status: string; pid?: number }>;
  hardware: { cpu: number; memory: { used: number; total: number }; disk: { used: number; total: number } };
  network: { reachable: Record<string, boolean> };
  processes: { running: number; zombie: number; old: number };
  tools: { mcp: { connected: number; total: number }; skills: number };
  llm: { provider: string; model: string; lastLatency?: number };
}

/** 診断操作 */
export type CrestodianOperation =
  | { kind: "none" }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-set"; path: string; value: string }
  | { kind: "config-set-ref"; path: string; source: "env" | "file" | "exec"; id: string }
  | { kind: "gateway-status" }
  | { kind: "gateway-start" | "gateway-stop" | "gateway-restart" }
  | { kind: "agents" }
  | { kind: "models" }
  | { kind: "help" };

/** 診断結果 */
export interface CrestodianResult {
  applied: boolean;
  message: string;
  operation: CrestodianOperation;
}

/** 診断監査エントリ */
interface AuditEntry {
  timestamp: string;
  operation: string;
  summary: string;
  configHashBefore?: string;
  configHashAfter?: string;
  details?: string;
}

// ==================== 内部状態 ====================

let operationInProgress = false;
let pendingOperation: { operation: CrestodianOperation; configHashBefore: string } | null = null;
const auditLog: AuditEntry[] = [];
const MAX_AUDIT = 50;

// LLM診断コールバック
let crestodianLLM: ((prompt: string) => Promise<string>) | null = null;

// ==================== 診断コレクション ====================

/** システム診断オーバービューを収集 */
export async function collectOverview(): Promise<SystemOverview> {
  const configPath = resolve(process.env.DATA_DIR || "./data", "config.json");
  const configExists = existsSync(configPath);
  let configValid = true;
  const configIssues: string[] = [];
  let configHash = "";

  if (configExists) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      configHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      JSON.parse(raw); // validation
    } catch {
      configValid = false;
      configIssues.push("config.json has invalid JSON");
    }
  } else {
    configValid = false;
    configIssues.push("config.json not found");
  }

  // CPU
  let cpuPct = 0;
  try {
    const cpuOut = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { timeout: 3000, stdio: "pipe" }).toString().trim();
    cpuPct = parseFloat(cpuOut) || 0;
  } catch { /* ignore */ }

  // Memory
  let memUsed = 0, memTotal = 0;
  try {
    const memOut = execSync("free -m | awk 'NR==2{print $3,$2}'", { timeout: 3000, stdio: "pipe" }).toString().trim();
    const parts = memOut.split(/\s+/);
    memUsed = parseInt(parts[0]!) || 0;
    memTotal = parseInt(parts[1]!) || 1;
  } catch { /* ignore */ }

  // Disk
  let diskUsed = 0, diskTotal = 0;
  try {
    const dfOut = execSync("df -k . | tail -1 | awk '{print $3,$2}'", { timeout: 3000, stdio: "pipe" }).toString().trim();
    const parts = dfOut.split(/\s+/);
    diskUsed = parseInt(parts[0]!) || 0;
    diskTotal = parseInt(parts[1]!) || 1;
  } catch { /* ignore */ }

  // Network reachability
  const reachable: Record<string, boolean> = {};
  for (const host of ["api.openrouter.ai", "google.com", "discord.com"]) {
    try {
      execSync(`ping -c 1 -W 2 ${host} 2>/dev/null`, { timeout: 3000 });
      reachable[host] = true;
    } catch {
      reachable[host] = false;
    }
  }

  // Processes
  let runningProcs = 0, zombieProcs = 0;
  try {
    const procOut = execSync("ps aux | awk '{print $8}' | sort | uniq -c", { timeout: 3000, stdio: "pipe" }).toString();
    const lines = procOut.split("\n");
    for (const line of lines) {
      if (line.includes("R")) runningProcs += parseInt(line.trim().split(/\s+/)[0]!) || 0;
      if (line.includes("Z")) zombieProcs += parseInt(line.trim().split(/\s+/)[0]!) || 0;
    }
  } catch { /* ignore */ }

  // MCP tools
  let mcpConnected = 0, mcpTotal = 0;
  try {
    const { toolRegistry } = await import("./tools/registry");
    const mcpTools = toolRegistry.list().filter((t) => t.name.startsWith("mcp_"));
    mcpTotal = mcpTools.length;
    mcpConnected = mcpTools.length;
  } catch { /* ignore */ }

  return {
    config: { path: configPath, exists: configExists, valid: configValid, issues: configIssues, hash: configHash },
    services: [],
    hardware: { cpu: cpuPct, memory: { used: memUsed, total: memTotal }, disk: { used: diskUsed, total: diskTotal } },
    network: { reachable },
    processes: { running: runningProcs, zombie: zombieProcs > 0 ? zombieProcs : 0, old: 0 },
    tools: { mcp: { connected: mcpConnected, total: mcpTotal }, skills: 0 },
    llm: { provider: process.env.LLM_PROVIDER || "openrouter", model: process.env.LLM_MODEL || "deepseek/deepseek-v4-pro" },
  };
}

/** オーバービューをフォーマット */
export function formatOverview(overview: SystemOverview): string {
  const lines: string[] = [
    "🏥 **システム診断レポート**",
    "",
    `**設定**: ${overview.config.exists ? "✅" : "❌"} ${overview.config.path}`,
    `  状態: ${overview.config.valid ? "正常" : "⚠️ 問題あり"}`,
    ...overview.config.issues.map((i) => `  ❌ ${i}`),
    "",
    `**ハードウェア**:`,
    `  CPU: ${overview.hardware.cpu.toFixed(1)}%`,
    `  メモリ: ${overview.hardware.memory.used}MB / ${overview.hardware.memory.total}MB (${((overview.hardware.memory.used / Math.max(overview.hardware.memory.total, 1)) * 100).toFixed(1)}%)`,
    `  ディスク: ${(overview.hardware.disk.used / 1024 / 1024).toFixed(1)}GB / ${(overview.hardware.disk.total / 1024 / 1024).toFixed(1)}GB`,
    "",
    `**ネットワーク**:`,
    ...Object.entries(overview.network.reachable).map(([host, ok]) => `  ${ok ? "✅" : "❌"} ${host}`),
    "",
    `**プロセス**: ${overview.processes.running} running`,
    overview.processes.zombie > 0 ? `  ⚠️ ゾンビ: ${overview.processes.zombie}` : "",
    "",
    `**MCP**: ${overview.tools.mcp.connected}/${overview.tools.mcp.total} connected`,
    "",
    `**LLM**: ${overview.llm.provider}/${overview.llm.model}`,
  ];

  return lines.filter(Boolean).join("\n");
}

// ==================== 操作パーサー ====================

/** 自然言語から操作をパース */
export function parseOperation(input: string): CrestodianOperation {
  const text = input.trim().toLowerCase();

  // ヘルプ
  if (text === "" || text === "help" || text === "?" || text === "なにできる？") {
    return { kind: "help" };
  }

  // オーバービュー
  if (/^(overview|status|summary|診断|状態|レポート)$/.test(text)) {
    return { kind: "overview" };
  }

  // ドクター
  if (/^(doctor|診断|チェック|check)/.test(text)) {
    if (/(fix|修復|repair|auto)/.test(text)) return { kind: "doctor-fix" };
    return { kind: "doctor" };
  }

  // ヘルス
  if (/^(health|ping|死活)/.test(text)) return { kind: "health" };

  // 設定
  if (/^config\s+validate/.test(text) || /^validate/.test(text)) return { kind: "config-validate" };
  if (/^config\s+set\s+(\S+)\s+(.+)/.test(text)) {
    const m = text.match(/^config\s+set\s+(\S+)\s+(.+)/);
    if (m) return { kind: "config-set", path: m[1]!, value: m[2]!.trim() };
  }

  // ゲートウェイ
  if (/^gateway\s+status/.test(text) || /^gw\s+status/.test(text)) return { kind: "gateway-status" };
  if (/^gateway\s+start/.test(text) || /^gw\s+start/.test(text)) return { kind: "gateway-start" };
  if (/^gateway\s+stop/.test(text) || /^gw\s+stop/.test(text)) return { kind: "gateway-stop" };
  if (/^gateway\s+restart/.test(text) || /^gw\s+restart/.test(text)) return { kind: "gateway-restart" };

  // エージェント
  if (/^(agents|agent\s+list|エージェント)/.test(text)) return { kind: "agents" };

  // モデル
  if (/^(models|model\s+list|モデル)/.test(text)) return { kind: "models" };

  return { kind: "none" };
}

/** 操作を実行 */
export async function executeOperation(
  operation: CrestodianOperation,
  approved = false,
): Promise<CrestodianResult> {
  if (operationInProgress) {
    return { applied: false, message: "⏳ 別の診断が実行中です。", operation };
  }

  operationInProgress = true;

  try {
    switch (operation.kind) {
      case "none":
        return {
          applied: false,
          message: [
            "❓ コマンドが認識できませんでした。",
            "  使えるコマンド: overview, doctor, doctor-fix, health, config validate, config set, gateway status/start/stop/restart, agents, models, help",
          ].join("\n"),
          operation,
        };

      case "help":
        return {
          applied: false,
          message: [
            "🩺 **Crestodian 診断コマンド一覧**",
            "",
            "`overview` - システム全体の診断状態を表示",
            "`doctor` - 簡易診断を実行",
            "`doctor-fix` - 診断＋自動修復",
            "`health` - 死活チェック",
            "`config validate` - 設定ファイル検証",
            "`config set <path> <value>` - 設定変更（承認必要）",
            "`gateway status/start/stop/restart` - ゲートウェイ管理",
            "`agents` - エージェント一覧",
            "`models` - モデル設定表示",
            "",
            "設定変更や再起動には `/crestodian コマンド -y` で承認が必要です。",
          ].join("\n"),
          operation,
        };

      case "overview": {
        const overview = await collectOverview();
        return { applied: false, message: formatOverview(overview), operation };
      }

      case "doctor": {
        const overview = await collectOverview();
        const issues: string[] = [];

        if (!overview.config.exists) issues.push("設定ファイルが存在しません");
        if (!overview.config.valid) issues.push("設定ファイルが破損しています");
        if (!overview.network.reachable["api.openrouter.ai"]) issues.push("OpenRouter APIに到達不可");
        if (overview.hardware.disk.used / Math.max(overview.hardware.disk.total, 1) > 0.9) issues.push("ディスク使用率が90%超");
        if (overview.processes.zombie > 0) issues.push(`ゾンビプロセスが${overview.processes.zombie}個あります`);

        if (issues.length === 0) {
          return { applied: false, message: "✅ **診断**: 問題は見つかりませんでした。", operation };
        }
        return {
          applied: false,
          message: [`⚠️ **診断**: ${issues.length}件の問題`, ...issues.map((i) => `  ❌ ${i}`)].join("\n"),
          operation,
        };
      }

      case "doctor-fix": {
        if (!approved) {
          const hash = createHash("sha256").update(new Date().toISOString()).digest("hex").slice(0, 8);
          pendingOperation = { operation, configHashBefore: hash };
          return {
            applied: false,
            message: "⚠️ 自動修復を実行しますか？ `/crestodian approve -y` で承認してください。",
            operation,
          };
        }

        const overview = await collectOverview();
        const fixes: string[] = [];

        // 自動修復
        if (!overview.network.reachable["api.openrouter.ai"]) {
          try {
            execSync("sudo systemctl restart networking 2>/dev/null || true", { timeout: 5000 });
            fixes.push("ネットワーク再起動試行");
          } catch { /* ignore */ }
        }

        if (overview.processes.zombie > 0) {
          try {
            execSync("ps aux | grep Z | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true", { timeout: 5000 });
            fixes.push(`ゾンビプロセス ${overview.processes.zombie}個を強制終了`);
          } catch { /* ignore */ }
        }

        // MCP再接続
        try {
          const { connectAllMcpServers } = await import("./tools/mcp-client");
          await connectAllMcpServers();
          fixes.push("MCPサーバー再接続");
        } catch { /* ignore */ }

        // ディスククリーンアップ
        if (overview.hardware.disk.used / Math.max(overview.hardware.disk.total, 1) > 0.85) {
          try {
            execSync("find ./data -name '*.log' -mtime +3 -delete 2>/dev/null || true", { timeout: 5000 });
            execSync("find ./data/ocr -name '*.png' -mtime +1 -delete 2>/dev/null || true", { timeout: 5000 });
            fixes.push("古いログ・一時ファイルを削除");
          } catch { /* ignore */ }
        }

        if (fixes.length === 0) {
          return { applied: false, message: "✅ **自動修復**: 特に修復が必要な項目はありませんでした。", operation };
        }

        appendAudit({
          timestamp: new Date().toISOString(),
          operation: "doctor-fix",
          summary: `自動修復: ${fixes.join(", ")}`,
          configHashBefore: pendingOperation?.configHashBefore,
        });
        pendingOperation = null;

        return {
          applied: true,
          message: [`✅ **自動修復完了**: ${fixes.length}件`, ...fixes.map((f) => `  ✅ ${f}`)].join("\n"),
          operation,
        };
      }

      case "health": {
        const healthy = await runHealthCheck();
        return {
          applied: false,
          message: healthy
            ? "✅ **ヘルスチェック**: 正常です"
            : "⚠️ **ヘルスチェック**: 一部のサービスに問題があります",
          operation,
        };
      }

      case "config-validate": {
        const overview = await collectOverview();
        if (overview.config.valid) {
          return { applied: false, message: "✅ **設定検証**: 設定ファイルは正常です。", operation };
        }
        return {
          applied: false,
          message: ["⚠️ **設定検証**: 問題が見つかりました。", ...overview.config.issues.map((i) => `  ❌ ${i}`)].join("\n"),
          operation,
        };
      }

      case "config-set": {
        if (!approved) {
          pendingOperation = { operation, configHashBefore: "" };
          return {
            applied: false,
            message: `⚠️ 設定変更: \`${operation.path} = ${operation.value}\`\n  実行しますか？ \`/crestodian approve -y\` で承認してください。`,
            operation,
          };
        }

        const { configManager } = await import("./config-manager");
        configManager.set(operation.path, operation.value);

        appendAudit({
          timestamp: new Date().toISOString(),
          operation: "config-set",
          summary: `${operation.path} = ${operation.value}`,
          configHashAfter: createHash("sha256").update("config-set").digest("hex").slice(0, 16),
        });
        pendingOperation = null;

        return { applied: true, message: `✅ 設定変更: \`${operation.path} = ${operation.value}\``, operation };
      }

      case "gateway-status":
        return { applied: false, message: "🔌 **ゲートウェイ状態**: 取得中...", operation };

      case "gateway-start":
      case "gateway-stop":
      case "gateway-restart":
        if (!approved) {
          pendingOperation = { operation, configHashBefore: "" };
          return {
            applied: false,
            message: `⚠️ ゲートウェイ${operation.kind === "gateway-start" ? "起動" : operation.kind === "gateway-stop" ? "停止" : "再起動"}しますか？ \`/crestodian approve -y\` で承認してください。`,
            operation,
          };
        }
        pendingOperation = null;
        return { applied: true, message: `🔌 ゲートウェイ${operation.kind === "gateway-start" ? "起動" : operation.kind === "gateway-stop" ? "停止" : "再起動"}しました。`, operation };

      case "agents":
        return { applied: false, message: "👤 **エージェント一覧**: 取得中...", operation };

      case "models":
        return { applied: false, message: "🤖 **モデル設定**: 現在のLLM設定を確認中...", operation };

      default:
        return { applied: false, message: "❓ 未実装の操作です。", operation };
    }
  } finally {
    operationInProgress = false;
  }
}

/** 保留中の操作を承認 */
export function approvePending(): boolean {
  if (!pendingOperation) return false;
  pendingOperation = null;
  return true;
}

/** 保留中の操作情報 */
export function getPendingOperation(): CrestodianOperation | null {
  return pendingOperation?.operation ?? null;
}

// ==================== 監査 ====================

function appendAudit(entry: AuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT) auditLog.shift();

  try {
    const auditDir = resolve(process.env.DATA_DIR || "./data", "audit");
    mkdirSync(auditDir, { recursive: true });
    const auditFile = resolve(auditDir, "crestodian.jsonl");
    writeFileSync(auditFile, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch (e) {
    logger.warn(`[Crestodian] 監査ログ書き込みエラー: ${e}`);
  }
}

export function getAuditLog(limit = 20): AuditEntry[] {
  return auditLog.slice(-limit).reverse();
}

// ==================== LLM診断 ====================

export function setCrestodianLLM(fn: (prompt: string) => Promise<string>): void {
  crestodianLLM = fn;
}

/** LLMに診断を依頼（Natural Language → Operation） */
export async function diagnoseWithLLM(input: string): Promise<CrestodianOperation> {
  if (!crestodianLLM) return { kind: "none" };

  try {
    const overview = await collectOverview();
    const prompt = [
      "あなたはAIエージェントHikamerの診断アシスタントです。",
      "ユーザーの入力を解析し、実行すべき診断操作をJSONで返してください。",
      "",
      "現在のシステム状態:",
      `  設定: ${overview.config.exists ? "存在する" : "なし"} ${overview.config.valid ? "正常" : "問題あり"}`,
      `  CPU: ${overview.hardware.cpu}%`,
      `  メモリ: ${overview.hardware.memory.used}/${overview.hardware.memory.total}MB`,
      `  ディスク: ${((overview.hardware.disk.used / Math.max(overview.hardware.disk.total, 1)) * 100).toFixed(0)}%使用`,
      `  OpenRouter: ${overview.network.reachable["api.openrouter.ai"] ? "接続OK" : "切断"}`,
      `  MCP: ${overview.tools.mcp.connected}/${overview.tools.mcp.total}`,
      "",
      "ユーザー入力: " + input,
      "",
      "以下のJSONのみを返してください: {\"kind\": \"overview\"|\"doctor\"|\"doctor-fix\"|\"config-validate\"|\"gateway-status\"|\"health\"|\"help\"}",
    ].join("\n");

    const result = await crestodianLLM(prompt);
    const parsed = JSON.parse(result);
    return parseOperation(parsed.kind || input);
  } catch {
    // LLM失敗 → 通常パーサー
    return parseOperation(input);
  }
}
