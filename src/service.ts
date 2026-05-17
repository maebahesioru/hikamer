// ==========================================
// Aikata - システムサービス管理（OpenHuman service/由来）
// systemd/launchd/Windowsサービスとしての運用管理
// ==========================================

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type ServicePlatform = "systemd" | "launchd" | "windows" | "docker" | "none";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: ServicePlatform;
  pid?: number;
  uptime?: number;
  memory?: string;
}

// ==================== サービス管理 ====================

class ServiceManager {
  private serviceName: string;
  private scriptPath: string;

  constructor(serviceName?: string) {
    this.serviceName = serviceName || "aikata";
    this.scriptPath = resolve(process.cwd(), "src/index.ts");
  }

  /** プラットフォーム検出 */
  detectPlatform(): ServicePlatform {
    if (process.platform === "linux") {
      try {
        if (execSync("which systemctl 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) return "systemd";
      } catch {}
      try {
        if (execSync("which docker 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) return "docker";
      } catch {}
    }
    if (process.platform === "darwin") return "launchd";
    if (process.platform === "win32") return "windows";
    return "none";
  }

  /** systemdサービスインストール */
  installSystemd(user?: string): boolean {
    const username = user || process.env.USER || "root";
    const workdir = process.cwd();
    const nodePath = process.execPath;

    const serviceContent = `[Unit]
Description=Aikata AI Agent
After=network.target

[Service]
Type=simple
User=${username}
WorkingDirectory=${workdir}
ExecStart=${nodePath} ${resolve(workdir, "src/index.ts")}
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

    const servicePath = `/etc/systemd/system/${this.serviceName}.service`;
    try {
      writeFileSync(servicePath, serviceContent, "utf-8");
      execSync(`systemctl daemon-reload && systemctl enable ${this.serviceName}`, { timeout: 10000 });
      logger.info(`[Service] systemdインストール: ${servicePath}`);
      return true;
    } catch (e: any) {
      logger.error(`[Service] systemdインストール失敗: ${e.message}`);
      return false;
    }
  }

  /** Docker Compose生成 */
  generateDockerCompose(port?: number): string {
    const p = port || 9720;
    return `version: '3.8'
services:
  aikata:
    build: .
    container_name: aikata
    restart: unless-stopped
    ports:
      - "${p}:${p}"
    volumes:
      - ./data:/app/data
      - ./config.yaml:/app/config.yaml
    environment:
      - NODE_ENV=production
      - DISCORD_TOKEN=\${DISCORD_TOKEN}
      - TELEGRAM_TOKEN=\${TELEGRAM_TOKEN}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${p}/health"]
      interval: 30s
      timeout: 10s
      retries: 3
`;
  }

  /** Dockerfile生成 */
  generateDockerfile(): string {
    return `FROM node:20-slim
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 9720 9723
CMD ["npx", "tsx", "src/index.ts"]
`;
  }

  /** サービス状態取得 */
  getStatus(): ServiceStatus {
    const platform = this.detectPlatform();
    const result: ServiceStatus = { installed: false, running: false, platform };

    try {
      switch (platform) {
        case "systemd": {
          const status = execSync(`systemctl is-active ${this.serviceName} 2>/dev/null || echo 'inactive'`, { timeout: 5000 }).toString().trim();
          result.installed = execSync(`systemctl is-enabled ${this.serviceName} 2>/dev/null || echo 'disabled'`, { timeout: 5000 }).toString().trim() !== "disabled";
          result.running = status === "active";

          try {
            const pid = execSync(`systemctl show -p MainPID ${this.serviceName} 2>/dev/null | cut -d= -f2`, { timeout: 3000 }).toString().trim();
            if (pid && pid !== "0") result.pid = parseInt(pid, 10);
          } catch {}

          try {
            const uptime = execSync(`systemctl show -p ActiveEnterTimestamp ${this.serviceName} 2>/dev/null | cut -d= -f2`, { timeout: 3000 }).toString().trim();
            if (uptime) result.uptime = Math.floor((Date.now() - new Date(uptime).getTime()) / 1000);
          } catch {}
          break;
        }
        case "docker": {
          const container = execSync(`docker ps --filter name=${this.serviceName} --format '{{.Status}}' 2>/dev/null || echo ''`, { timeout: 5000 }).toString().trim();
          result.running = container.length > 0;
          result.installed = container.length > 0 || execSync(`docker ps -a --filter name=${this.serviceName} --format '{{.Names}}' 2>/dev/null || echo ''`, { timeout: 5000 }).toString().trim().length > 0;
          break;
        }
      }
    } catch {}

    return result;
  }

  /** サービス開始 */
  start(): boolean {
    const platform = this.detectPlatform();
    try {
      switch (platform) {
        case "systemd":
          execSync(`systemctl start ${this.serviceName}`, { timeout: 10000 });
          return true;
        case "docker":
          execSync(`docker start ${this.serviceName}`, { timeout: 10000 });
          return true;
      }
    } catch {}
    return false;
  }

  /** サービス停止 */
  stop(): boolean {
    const platform = this.detectPlatform();
    try {
      switch (platform) {
        case "systemd":
          execSync(`systemctl stop ${this.serviceName}`, { timeout: 10000 });
          return true;
        case "docker":
          execSync(`docker stop ${this.serviceName}`, { timeout: 10000 });
          return true;
      }
    } catch {}
    return false;
  }

  /** Docker Compose生成と保存 */
  saveDockerFiles(): void {
    const dockerDir = resolve(process.cwd(), "deploy");
    if (!existsSync(dockerDir)) mkdirSync(dockerDir, { recursive: true });

    writeFileSync(resolve(dockerDir, "Dockerfile"), this.generateDockerfile(), "utf-8");
    writeFileSync(resolve(dockerDir, "docker-compose.yml"), this.generateDockerCompose(), "utf-8");
    writeFileSync(resolve(dockerDir, ".env.example"), `DISCORD_TOKEN=your-token-here\nTELEGRAM_TOKEN=your-token-here\nOPENAI_API_KEY=your-key-here`, "utf-8");

    logger.info(`[Service] Dockerファイル生成: ${dockerDir}`);
  }

  formatStatus(): string {
    const status = this.getStatus();
    const icon = status.running ? "✅" : status.installed ? "⏸️" : "❌";

    const lines = [
      `${icon} **サービス状態**`,
      `プラットフォーム: ${status.platform}`,
      `インストール: ${status.installed ? "✅" : "❌"}`,
      `稼働: ${status.running ? "✅" : "❌"}`,
    ];

    if (status.pid) lines.push(`PID: ${status.pid}`);
    if (status.uptime) {
      const d = Math.floor(status.uptime / 86400);
      const h = Math.floor((status.uptime % 86400) / 3600);
      const m = Math.floor((status.uptime % 3600) / 60);
      lines.push(`稼働時間: ${d}d ${h}h ${m}m`);
    }
    if (status.platform === "none") {
      lines.push("", "💡 systemd/dockerのインストールを推奨: /service install");
    }

    return lines.join("\n");
  }
}

// ==================== シングルトン ====================

export const serviceManager = new ServiceManager();
