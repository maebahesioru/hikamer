// ==========================================
// Aikata - ローカル推論（OpenHuman inference/local/ 由来）
// ローカルLLM・Whisper音声認識
// ==========================================

import { logger } from "./utils/logger";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ==================== 型定義 ====================

export interface LocalModel {
  name: string;
  path: string;
  type: "llama" | "whisper" | "embedding";
  loaded: boolean;
  contextLength: number;
  quantization: string;
}

export interface InferenceResult {
  text: string;
  tokensUsed: number;
  tokensPerSecond: number;
  durationMs: number;
  model: string;
}

export interface WhisperResult {
  text: string;
  segments: WhisperSegment[];
  durationMs: number;
  language: string;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

// ==================== ローカル推論マネージャー ====================

class LocalInference {
  private models: LocalModel[] = [];
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private initialized = false;

  // 設定
  private llamaCppPath = process.env.LLAMA_CPP_PATH || "";
  private whisperPath = process.env.WHISPER_PATH || "whisper";
  private defaultModel = process.env.LOCAL_MODEL_PATH || "";

  init(): void {
    if (this.initialized) return;
    this.discoverModels();
    this.initialized = true;
    logger.info(`[LocalInference] initialized: ${this.models.length} models`);
  }

  /** 利用可能なモデルを検出 */
  discoverModels(): LocalModel[] {
    this.models = [];

    // llama.cpp モデル
    if (this.llamaCppPath && fs.existsSync(this.llamaCppPath)) {
      this.models.push({
        name: "llama.cpp",
        path: this.llamaCppPath,
        type: "llama",
        loaded: false,
        contextLength: 4096,
        quantization: "Q4_K_M",
      });
    }

    // GGUFモデルファイル
    const modelDir = path.dirname(this.defaultModel);
    if (modelDir && fs.existsSync(modelDir)) {
      try {
        const files = fs.readdirSync(modelDir);
        for (const f of files) {
          if (f.endsWith(".gguf")) {
            this.models.push({
              name: f.replace(/\.gguf$/, ""),
              path: path.join(modelDir, f),
              type: "llama",
              loaded: false,
              contextLength: 4096,
              quantization: f.includes("Q4") ? "Q4_K_M" : f.includes("Q8") ? "Q8_0" : "unknown",
            });
          }
        }
      } catch {}
    }

    // Whisper
    try {
      execSync(`which ${this.whisperPath} 2>/dev/null`, { timeout: 3000 });
      this.models.push({
        name: "whisper",
        path: this.whisperPath,
        type: "whisper",
        loaded: true,
        contextLength: 0,
        quantization: "fp16",
      });
    } catch {}

    return this.models;
  }

  /** ローカルLLMで推論 */
  async generate(
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<InferenceResult | null> {
    const start = Date.now();

    // llama.cpp サーバーが起動していればAPI経由
    if (this.isServerRunning()) {
      return this.inferViaAPI(prompt, options);
    }

    // サーバー未起動 → シミュレーション
    logger.info(`[LocalInference] no server running, simulating inference`);
    return {
      text: `[local inference not available - start llama.cpp server first]`,
      tokensUsed: 0,
      tokensPerSecond: 0,
      durationMs: Date.now() - start,
      model: options?.model ?? "local",
    };
  }

  /** llama.cpp サーバーを起動 */
  async startServer(modelPath?: string): Promise<boolean> {
    if (this.activeProcess) {
      logger.warn("[LocalInference] server already running");
      return true;
    }

    const model = modelPath || this.defaultModel;
    if (!model || !fs.existsSync(model)) {
      logger.error("[LocalInference] model not found:", model);
      return false;
    }

    try {
      this.activeProcess = spawn(
        `${this.llamaCppPath}/llama-server`,
        [
          "-m", model,
          "--host", "127.0.0.1",
          "--port", "8081",
          "-n", "4096",
          "-c", "4096",
        ],
        { stdio: "ignore", detached: true }
      );

      this.activeProcess.unref();
      logger.info(`[LocalInference] server starting with ${model}`);
      return true;
    } catch (err) {
      logger.error("[LocalInference] server start failed:", err);
      return false;
    }
  }

  /** 音声認識（Whisper） */
  async transcribeAudio(
    audioPath: string
  ): Promise<WhisperResult | null> {
    if (!fs.existsSync(audioPath)) return null;

    try {
      const start = Date.now();
      const output = execSync(
        `${this.whisperPath} ${audioPath} --language ja --output_format txt 2>/dev/null`,
        { timeout: 120000 }
      );

      const text = output.toString().trim();
      return {
        text,
        segments: [{ start: 0, end: Date.now() - start, text, confidence: 0.8 }],
        durationMs: Date.now() - start,
        language: "ja",
      };
    } catch (err) {
      logger.error("[LocalInference] whisper failed:", err);
      return null;
    }
  }

  /** 利用可能なモデル一覧 */
  listModels(): LocalModel[] {
    return [...this.models];
  }

  /** サーバー動作確認 */
  isServerRunning(): boolean {
    try {
      const res = execSync(
        "curl -s http://127.0.0.1:8081/health 2>/dev/null || curl -s http://127.0.0.1:8080/health 2>/dev/null",
        { timeout: 3000 }
      );
      return res.toString().length > 0;
    } catch {
      return false;
    }
  }

  /** サーバー停止 */
  stopServer(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
      logger.info("[LocalInference] server stopped");
    }
  }

  // ---- 内部 ----

  private async inferViaAPI(
    prompt: string,
    options?: { model?: string; maxTokens?: number; temperature?: number }
  ): Promise<InferenceResult | null> {
    const start = Date.now();
    const port = 8081;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            max_tokens: options?.maxTokens ?? 512,
            temperature: options?.temperature ?? 0.7,
          }),
          signal: AbortSignal.timeout(60000),
        }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };

      return {
        text: data.choices?.[0]?.message?.content ?? "",
        tokensUsed: data.usage?.total_tokens ?? 0,
        tokensPerSecond: data.usage?.total_tokens
          ? data.usage.total_tokens / ((Date.now() - start) / 1000)
          : 0,
        durationMs: Date.now() - start,
        model: "llama.cpp",
      };
    } catch (err) {
      logger.error("[LocalInference] API inference failed:", err);
      return null;
    }
  }

  formatStatus(): string {
    const serverRunning = this.isServerRunning();
    return (
      `🖥️ **ローカル推論**\n` +
      `llama.cpp: ${this.llamaCppPath ? "✅" : "❌ 未設定"}\n` +
      `Whisper: ${this.models.some((m) => m.type === "whisper") ? "✅" : "❌"}\n` +
      `サーバー: ${serverRunning ? "✅ 稼働中" : "⏹ 停止中"}\n` +
      `モデル数: ${this.models.length}\n` +
      (this.models.length > 0
        ? "\n**モデル一覧**\n" +
          this.models
            .map((m) => `- ${m.type === "llama" ? "🦙" : "🎤"} ${m.name} (${m.quantization})`)
            .join("\n")
        : "")
    );
  }
}

// ==================== シングルトン ====================

export const localInference = new LocalInference();

export default LocalInference;
