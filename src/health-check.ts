// ==========================================
// Hikamer - Subsystem Health Check (v1.75)
// 全サブシステムの健全性をチェックする自己診断
// ==========================================

import { logger } from "./utils/logger";

// ==================== ヘルスチェック結果 ====================

export interface HealthStatus {
  name: string;
  status: "ok" | "degraded" | "down" | "unknown";
  message: string;
  latencyMs?: number;
}

export interface HealthReport {
  timestamp: number;
  overall: "healthy" | "degraded" | "unhealthy";
  subsystems: HealthStatus[];
}

// ==================== ヘルスチェッカー ====================

class HealthChecker {
  async checkAll(): Promise<HealthReport> {
    const start = Date.now();
    const subsystems: HealthStatus[] = [];

    // 並列チェック
    const checks = [
      this.checkMemory(),
      this.checkTelemetry(),
      this.checkBrowser(),
      this.checkDisk(),
      this.checkNetwork(),
      this.checkAgentLoop(),
      this.checkSkills(),
    ];

    const results = await Promise.allSettled(checks);
    for (const r of results) {
      if (r.status === "fulfilled") subsystems.push(r.value);
      else subsystems.push({ name: "unknown", status: "down", message: String(r.reason) });
    }

    // 総合判定
    const downCount = subsystems.filter(s => s.status === "down").length;
    const degradedCount = subsystems.filter(s => s.status === "degraded").length;
    const overall = downCount > 0 ? "unhealthy" : degradedCount > 0 ? "degraded" : "healthy";

    logger.info(`[HealthCheck] ${overall} (${subsystems.length} subsystems, ${Date.now() - start}ms)`);

    return { timestamp: Date.now(), overall, subsystems };
  }

  private async checkMemory(): Promise<HealthStatus> {
    try {
      const { getDefaultPipeline } = await import("./memory-pipeline");
      const pipeline = getDefaultPipeline();
      const entries = pipeline.getAllEntries();
      return { name: "memory", status: "ok", message: `${entries.length} entries` };
    } catch (e: any) {
      return { name: "memory", status: "degraded", message: e.message };
    }
  }

  private async checkTelemetry(): Promise<HealthStatus> {
    try {
      const { telemetry } = await import("./telemetry");
      telemetry.init();
      const report = telemetry.getReport();
      return { name: "telemetry", status: "ok", message: `${report.globalStats.totalTurns} turns tracked` };
    } catch (e: any) {
      return { name: "telemetry", status: "degraded", message: e.message };
    }
  }

  private async checkBrowser(): Promise<HealthStatus> {
    try {
      const camofoxUrl = process.env.CAMOFOX_URL || "http://localhost:9377";
      const res = await fetch(`${camofoxUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { name: "browser", status: "ok", message: "camofox alive" };
      return { name: "browser", status: "degraded", message: "camofox not responding, playwright fallback available" };
    } catch {
      return { name: "browser", status: "degraded", message: "camofox unreachable, playwright fallback available" };
    }
  }

  private async checkDisk(): Promise<HealthStatus> {
    try {
      const { existsSync, writeFileSync, unlinkSync } = await import("fs");
      const testPath = "./data/.healthcheck_test";
      writeFileSync(testPath, "ok", "utf-8");
      unlinkSync(testPath);
      return { name: "disk", status: "ok", message: "read/write OK" };
    } catch (e: any) {
      return { name: "disk", status: "down", message: `disk error: ${e.message}` };
    }
  }

  private async checkNetwork(): Promise<HealthStatus> {
    try {
      const res = await fetch("https://api.github.com", { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { name: "network", status: "ok", message: "GitHub API reachable" };
      return { name: "network", status: "degraded", message: `HTTP ${res.status}` };
    } catch {
      return { name: "network", status: "degraded", message: "no internet or DNS issue" };
    }
  }

  private async checkAgentLoop(): Promise<HealthStatus> {
    try {
      const { getRuntimeConfig } = await import("./utils/config");
      const config = getRuntimeConfig();
      return { name: "agent", status: "ok", message: `maxIter=${config.maxIterations}` };
    } catch (e: any) {
      return { name: "agent", status: "down", message: e.message };
    }
  }

  private async checkSkills(): Promise<HealthStatus> {
    try {
      const { skillSystem } = await import("./skills-system");
      const skills = skillSystem.listSkills();
      return { name: "skills", status: "ok", message: `${skills.length} skills loaded` };
    } catch (e: any) {
      return { name: "skills", status: "degraded", message: e.message };
    }
  }

  formatReport(report: HealthReport): string {
    const icon = report.overall === "healthy" ? "✅" : report.overall === "degraded" ? "⚠️" : "❌";
    const lines: string[] = [
      `${icon} **Hikamer ヘルスチェック** — ${report.overall.toUpperCase()}`,
      `実行: ${new Date(report.timestamp).toLocaleString("ja-JP")}`,
      "",
    ];

    for (const s of report.subsystems) {
      const sIcon = s.status === "ok" ? "🟢" : s.status === "degraded" ? "🟡" : s.status === "down" ? "🔴" : "⚪";
      lines.push(`${sIcon} **${s.name}**: ${s.status} — ${s.message}`);
    }

    // 推奨アクション
    const degraded = report.subsystems.filter(s => s.status !== "ok");
    if (degraded.length > 0) {
      lines.push("", "**🔧 推奨アクション**");
      for (const s of degraded) {
        if (s.name === "browser" && s.status === "degraded") {
          lines.push("• camofoxが起動していません。`camofox-browser` を起動するか、Playwrightフォールバックを使用します");
        } else if (s.name === "network" && s.status === "degraded") {
          lines.push("• ネットワーク接続を確認してください。オフラインモードでも基本機能は使えます");
        } else if (s.status === "down") {
          lines.push(`• ${s.name}: ${s.message}`);
        }
      }
    }

    return lines.join("\n");
  }
}

// ==================== シングルトン ====================

export const healthChecker = new HealthChecker();
export default HealthChecker;
