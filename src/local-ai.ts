// ==========================================
// Aikata - ローカルAI管理（OpenHuman local_ai由来）
// Ollama/LLMスタックの検出・管理・自動セットアップ
// ==========================================

import { execSync } from "child_process";
import { existsSync } from "fs";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface LocalAIInfo {
  available: boolean;
  name: string;
  version: string;
  models: string[];
  running: boolean;
  apiUrl: string;
}

// ==================== ローカルAI検出 ====================

class LocalAIManager {
  async detectAll(): Promise<LocalAIInfo[]> {
    const results: LocalAIInfo[] = [];

    const ollama = await this.detectOllama();
    if (ollama) results.push(ollama);

    const lmStudio = await this.detectLMStudio();
    if (lmStudio) results.push(lmStudio);

    return results;
  }

  /** Ollama検出 */
  async detectOllama(): Promise<LocalAIInfo | null> {
    try {
      const hasOllama = execSync("which ollama 2>/dev/null || echo ''", { timeout: 3000 }).toString().trim();
      if (!hasOllama) return null;

      let version = "unknown";
      try { version = execSync("ollama --version 2>/dev/null || echo 'unknown'", { timeout: 3000 }).toString().trim(); } catch {}

      let running = false;
      try { running = execSync("curl -s http://localhost:11434/api/tags 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim().length > 0; } catch {}

      let models: string[] = [];
      if (running) {
        try {
          const tags = JSON.parse(execSync("curl -s http://localhost:11434/api/tags", { timeout: 5000, encoding: "utf-8" }).toString());
          models = (tags.models || []).map((m: any) => m.name);
        } catch {}
      }

      return { available: true, name: "Ollama", version, models, running, apiUrl: "http://localhost:11434" };
    } catch { return null; }
  }

  /** LM Studio検出 */
  async detectLMStudio(): Promise<LocalAIInfo | null> {
    try {
      const running = execSync("curl -s http://localhost:1234/v1/models 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim().length > 0;
      if (!running) return null;

      let models: string[] = [];
      try {
        const data = JSON.parse(execSync("curl -s http://localhost:1234/v1/models", { timeout: 5000, encoding: "utf-8" }).toString());
        models = (data.data || []).map((m: any) => m.id);
      } catch {}

      return { available: true, name: "LM Studio", version: "", models, running: true, apiUrl: "http://localhost:1234" };
    } catch { return null; }
  }

  /** Ollamaモデルインストール */
  async installModel(model: string): Promise<boolean> {
    try {
      logger.info(`[LocalAI] Ollamaモデルインストール: ${model}`);
      execSync(`ollama pull ${model}`, { timeout: 600000 }); // 10分
      return true;
    } catch (e: any) {
      logger.error(`[LocalAI] インストール失敗: ${model} — ${e.message}`);
      return false;
    }
  }

  /** デバイス情報 */
  getDeviceInfo(): { cpu: string; memory: string; gpu: string[] } {
    let cpu = "unknown";
    let memory = "unknown";
    const gpu: string[] = [];

    try {
      if (process.platform === "linux") {
        try { cpu = execSync("lscpu | grep 'Model name' | cut -d: -f2 | xargs", { timeout: 3000 }).toString().trim(); } catch {}
        try { memory = execSync("free -h | awk '/^Mem:/{print $2}'", { timeout: 3000 }).toString().trim(); } catch {}
        try {
          const gpuOut = execSync("lspci | grep -i 'vga\\|3d\\|display' | cut -d: -f3 | xargs", { timeout: 5000 }).toString().trim();
          if (gpuOut) gpu.push(gpuOut);
        } catch {}
      }
    } catch {}

    return { cpu, memory, gpu };
  }

  formatInfo(): string {
    return [
      "🖥️ **ローカルAI検出**",
      ...this.getInfoLines(),
    ].join("\n");
  }

  private getInfoLines(): string[] {
    const lines: string[] = [];
    const device = this.getDeviceInfo();
    lines.push(`CPU: ${device.cpu || "不明"}`);
    lines.push(`メモリ: ${device.memory}`);

    // ローカルAIの検出結果をここで使う代わりに非同期実行
    void this.detectAll().then(results => {
      for (const ai of results) {
        logger.info(`[LocalAI] 検出: ${ai.name} v${ai.version} (稼働: ${ai.running})`);
      }
    });

    return lines;
  }
}

export const localAI = new LocalAIManager();
