// ==========================================
// Aikata - セキュリティ監査（OpenHuman security/ 由来）
// セキュリティイベントの監査ログ・検出・ポリシー
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type AuditCategory =
  | "auth"
  | "file_access"
  | "command_execution"
  | "network"
  | "data_access"
  | "configuration_change"
  | "tool_execution"
  | "permission_change"
  | "system";

export interface AuditEvent {
  id: string;
  timestamp: number;
  category: AuditCategory;
  severity: Severity;
  action: string;
  actor: string;
  target: string;
  details: string;
  result: "success" | "failure" | "blocked";
  ip?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface SecurityPolicy {
  name: string;
  description: string;
  severity: Severity;
  enabled: boolean;
  /** ポリシールール：イベントが条件に合致した場合に違反 */
  rule: (event: AuditEvent) => boolean;
  /** 違反時のアクション */
  action: "log" | "warn" | "block";
  /** 違反回数 */
  violations: number;
}

export interface AuditReport {
  totalEvents: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  violations: number;
  timeRange: { from: number; to: number };
}

// ==================== 監査ログ ====================

class SecurityAudit {
  private events: AuditEvent[] = [];
  private policies: SecurityPolicy[] = [];
  private violations: number = 0;
  private initialized = false;
  private maxEvents = 10000;

  init(): void {
    if (this.initialized) return;
    this.loadDefaultPolicies();
    this.initialized = true;
    logger.info("[Security] audit initialized with ${this.policies.length} policies");
  }

  /** イベントを記録 */
  record(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
    const auditEvent: AuditEvent = {
      ...event,
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    this.events.push(auditEvent);

    // 最大数を超えたら古いものを削除
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // ポリシーチェック
    this.checkPolicies(auditEvent);

    // 高重要度イベントはブロードキャスト
    if (auditEvent.severity === "high" || auditEvent.severity === "critical") {
      eventBus.emit(createEvent("security:alert", {
        id: auditEvent.id,
        category: auditEvent.category,
        severity: auditEvent.severity,
        action: auditEvent.action,
        details: auditEvent.details,
      }));
    }

    return auditEvent;
  }

  /** ポリシーを追加 */
  addPolicy(policy: SecurityPolicy): void {
    this.policies.push(policy);
  }

  /** 最近のイベントを取得 */
  getRecentEvents(category?: AuditCategory, limit = 50): AuditEvent[] {
    let filtered = this.events;
    if (category) {
      filtered = filtered.filter((e) => e.category === category);
    }
    return filtered.slice(-limit).reverse();
  }

  /** 重大イベントを取得 */
  getCriticalEvents(limit = 20): AuditEvent[] {
    return this.events
      .filter((e) => e.severity === "high" || e.severity === "critical")
      .slice(-limit)
      .reverse();
  }

  /** レポートを生成 */
  generateReport(timeRange?: { from: number; to: number }): AuditReport {
    const from = timeRange?.from ?? Date.now() - 24 * 60 * 60 * 1000;
    const to = timeRange?.to ?? Date.now();

    const inRange = this.events.filter(
      (e) => e.timestamp >= from && e.timestamp <= to
    );

    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const event of inRange) {
      byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
    }

    return {
      totalEvents: inRange.length,
      byCategory,
      bySeverity,
      violations: this.violations,
      timeRange: { from, to },
    };
  }

  /** ポリシー一覧 */
  listPolicies(): SecurityPolicy[] {
    return [...this.policies];
  }

  /** 全イベントをクリア */
  clear(): void {
    this.events = [];
    this.violations = 0;
  }

  /** 簡易的なセキュリティスキャン（ファイルパス等の確認） */
  scanPath(filePath: string): { safe: boolean; reason?: string } {
    // 危険なパスパターン
    const dangerousPatterns = [
      /^\/etc\//,
      /^\/sys\//,
      /^\/proc\//,
      /^\/dev\//,
      /^\/boot\//,
      /^\/root\//,
      /\\\\(?:\\\\[a-z]+\\)?Windows\\\\(?:System32|System|config)/i,
      /^C:\\Windows\\/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(filePath)) {
        return { safe: false, reason: `Dangerous path pattern: ${pattern}` };
      }
    }

    return { safe: true };
  }

  /** コマンドの安全性をチェック */
  scanCommand(command: string): { safe: boolean; reason?: string } {
    const dangerousCommands = [
      /^rm\s+-rf\s+\//,
      /^dd\s+/,
      /^:\(\)\s*\{/,
      /^mkfs/,
      /^fdisk/,
      /^chmod\s+-777/,
      /^wget\s+.*\|\s*bash/,
      /^curl\s+.*\|\s*bash/,
    ];

    for (const pattern of dangerousCommands) {
      if (pattern.test(command)) {
        return { safe: false, reason: `Dangerous command pattern detected` };
      }
    }

    return { safe: true };
  }

  // ---- 内部実装 ----

  private checkPolicies(event: AuditEvent): void {
    for (const policy of this.policies) {
      if (!policy.enabled) continue;
      try {
        if (policy.rule(event)) {
          policy.violations++;
          this.violations++;

          const msg = `[Security] Policy violation: ${policy.name} - ${event.action} by ${event.actor}`;

          if (policy.action === "warn") {
            logger.warn(msg);
          } else if (policy.action === "block") {
            logger.error(msg);
            event.result = "blocked";
          } else {
            logger.info(msg);
          }
        }
      } catch {
        // ルール評価エラーは無視
      }
    }
  }

  private loadDefaultPolicies(): void {
    this.addPolicy({
      name: "sensitive-file-access",
      description: "機密ファイルへのアクセスを監視",
      severity: "high",
      enabled: true,
      action: "warn",
      violations: 0,
      rule: (e) =>
        e.category === "file_access" &&
        (e.target.includes("/etc/shadow") ||
          e.target.includes(".env") ||
          e.target.includes("id_rsa") ||
          e.target.includes("credentials")),
    });

    this.addPolicy({
      name: "dangerous-command",
      description: "危険なシェルコマンドを検出",
      severity: "critical",
      enabled: true,
      action: "block",
      violations: 0,
      rule: (e) =>
        e.category === "command_execution" &&
        (e.details.includes("rm -rf /") ||
          e.details.includes("dd if=") ||
          e.details.includes("> /dev/sda")),
    });
  }
}

// ==================== シングルトン ====================

export const securityAudit = new SecurityAudit();

// ==================== システムコマンド ====================

export function getSecurityCommands(): Record<string, (args: string[]) => string> {
  return {
    "/audit": (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "recent":
        case "log": {
          const category = args[1] as AuditCategory | undefined;
          const events = securityAudit.getRecentEvents(category);
          if (events.length === 0) return "📭 監査イベントはありません";
          return (
            `📋 **監査ログ (直近${events.length}件)**\n\n` +
            events
              .map((e, i) => {
                const icon =
                  e.severity === "critical"
                    ? "🔴"
                    : e.severity === "high"
                      ? "🟠"
                      : e.severity === "medium"
                        ? "🟡"
                        : "⚪";
                return `${i + 1}. ${icon} [${e.category}] ${e.action}\n   ${e.details.slice(0, 100)} — ${e.actor}`;
              })
              .join("\n\n")
          );
        }

        case "critical":
        case "alerts": {
          const events = securityAudit.getCriticalEvents();
          if (events.length === 0) return "✅ 重大なセキュリティイベントはありません";
          return (
            `🚨 **重大イベント (${events.length}件)**\n\n` +
            events
              .map(
                (e) =>
                  `🔴 [${e.category}] ${e.action}\n   ${e.details} — ${e.actor}`
              )
              .join("\n\n")
          );
        }

        case "report": {
          const report = securityAudit.generateReport();
          return (
            `📊 **セキュリティレポート (24h)**\n` +
            `総イベント: ${report.totalEvents}\n` +
            `違反: ${report.violations}\n\n` +
            `**カテゴリ別**\n` +
            Object.entries(report.byCategory)
              .map(([cat, count]) => `- ${cat}: ${count}`)
              .join("\n") +
            `\n\n**重要度別**\n` +
            Object.entries(report.bySeverity)
              .map(([sev, count]) => `- ${sev}: ${count}`)
              .join("\n")
          );
        }

        case "policies": {
          const policies = securityAudit.listPolicies();
          if (policies.length === 0) return "📭 ポリシーがありません";
          return (
            `📋 **セキュリティポリシー (${policies.length})**\n\n` +
            policies
              .map(
                (p, i) =>
                  `${i + 1}. ${p.enabled ? "✅" : "⛔"} **${p.name}** (${p.severity})\n` +
                  `   ${p.description} | アクション: ${p.action} | 違反: ${p.violations}`
              )
              .join("\n\n")
          );
        }

        default:
          return (
            `📋 **セキュリティ監査コマンド**\n` +
            `/audit recent [category] - 最近のイベント\n` +
            `/audit alerts — 重大イベント\n` +
            `/audit report — レポート\n` +
            `/audit policies — ポリシー一覧`
          );
      }
    },
  };
}

export default SecurityAudit;
