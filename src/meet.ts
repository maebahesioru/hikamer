// ==========================================
// Aikata - Google Meet統合（OpenHuman meet/ 由来）
// 会議参加・音声キャプチャ・字幕生成
// ==========================================

import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface MeetingInfo {
  id: string;
  url: string;
  title: string;
  startedAt: number;
  participants: number;
  durationMs: number;
  status: "idle" | "joining" | "in_meeting" | "ended";
  recording?: boolean;
  captionsEnabled?: boolean;
}

export interface TranscriptEntry {
  timestamp: number;
  speaker: string;
  text: string;
  confidence: number;
}

export interface MeetingSummary {
  meetingId: string;
  durationMs: number;
  participants: string[];
  topics: string[];
  actionItems: string[];
  fullTranscript: string;
  keyPoints: string[];
}

// ==================== Meetマネージャー ====================

class MeetManager {
  private currentMeeting: MeetingInfo | null = null;
  private transcript: TranscriptEntry[] = [];
  private meetings: MeetingInfo[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Meet] integration initialized");
  }

  /** 会議に参加 */
  async joinMeeting(url: string, title?: string): Promise<MeetingInfo | null> {
    const meetBotPath = process.env.MEET_BOT_PATH;
    if (!meetBotPath) {
      logger.warn("[Meet] MEET_BOT_PATH not configured");
      return null;
    }

    const meeting: MeetingInfo = {
      id: `meet-${Date.now()}`,
      url,
      title: title ?? `Meeting ${new Date().toLocaleString("ja-JP")}`,
      startedAt: Date.now(),
      participants: 0,
      durationMs: 0,
      status: "joining",
    };

    this.currentMeeting = meeting;
    this.meetings.push(meeting);

    logger.info(`[Meet] joining: ${url}`);
    meeting.status = "in_meeting";

    return meeting;
  }

  /** 会議を退出 */
  async leaveMeeting(): Promise<void> {
    if (this.currentMeeting) {
      this.currentMeeting.status = "ended";
      this.currentMeeting.durationMs = Date.now() - this.currentMeeting.startedAt;
      logger.info(`[Meet] left meeting (${(this.currentMeeting.durationMs / 1000 / 60).toFixed(0)} minutes)`);
      this.currentMeeting = null;
    }
  }

  /** 字幕を追加 */
  addTranscript(speaker: string, text: string, confidence?: number): TranscriptEntry {
    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      speaker,
      text,
      confidence: confidence ?? 0.9,
    };
    this.transcript.push(entry);

    // 上限
    if (this.transcript.length > 10000) {
      this.transcript = this.transcript.slice(-5000);
    }

    return entry;
  }

  /** 文字起こしを取得 */
  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** 会議のサマリーを生成 */
  async generateSummary(): Promise<MeetingSummary | null> {
    if (!this.currentMeeting && this.transcript.length === 0) return null;

    const fullTranscript = this.transcript
      .map((t) => `[${t.speaker}] ${t.text}`)
      .join("\n");

    const speakers = [...new Set(this.transcript.map((t) => t.speaker))];
    const duration = this.currentMeeting?.durationMs ?? 0;

    // LLMでサマリー生成
    let summary: Omit<MeetingSummary, "meetingId" | "durationMs" | "participants"> = {
      topics: [],
      actionItems: [],
      fullTranscript,
      keyPoints: [],
    };

    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (apiKey && this.transcript.length > 5) {
      try {
        const prompt =
          `会議の文字起こしを分析し、議事録を生成してください。\n\n` +
          `参加者: ${speakers.join(", ")}\n\n` +
          `文字起こし:\n${fullTranscript.slice(0, 3000)}\n\n` +
          `以下のJSON形式で出力:\n` +
          `{"topics":["..."], "actionItems":["..."], "keyPoints":["..."]}`;

        const res = await fetch(
          process.env.AIKATA_LLM_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "deepseek/deepseek-v4-flash",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.1,
              max_tokens: 1000,
            }),
            signal: AbortSignal.timeout(15000),
          }
        );

        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? "";
          try {
            const parsed = JSON.parse(text) as {
              topics?: string[];
              actionItems?: string[];
              keyPoints?: string[];
            };
            summary = {
              topics: parsed.topics ?? [],
              actionItems: parsed.actionItems ?? [],
              fullTranscript,
              keyPoints: parsed.keyPoints ?? [],
            };
          } catch {
            // parse error → raw text
          }
        }
      } catch {}
    }

    return {
      meetingId: this.currentMeeting?.id ?? "unknown",
      durationMs: duration,
      participants: speakers,
      ...summary,
    };
  }

  /** 現在の会議情報 */
  getCurrentMeeting(): MeetingInfo | null {
    return this.currentMeeting;
  }

  /** 会議履歴 */
  getMeetings(): MeetingInfo[] {
    return [...this.meetings];
  }

  /** 履歴をクリア */
  clearHistory(): void {
    this.transcript = [];
    this.meetings = [];
  }

  formatSummary(summary: MeetingSummary): string {
    return (
      `📝 **会議サマリー**\n\n` +
      `参加者: ${summary.participants.join(", ") || "不明"}\n` +
      `所要時間: ${(summary.durationMs / 1000 / 60).toFixed(0)}分\n\n` +
      (summary.topics.length > 0
        ? `**トピック**\n${summary.topics.map((t) => `- ${t}`).join("\n")}\n\n`
        : "") +
      (summary.keyPoints.length > 0
        ? `**重要ポイント**\n${summary.keyPoints.map((p) => `- ${p}`).join("\n")}\n\n`
        : "") +
      (summary.actionItems.length > 0
        ? `**アクションアイテム**\n${summary.actionItems.map((a) => `- ${a}`).join("\n")}`
        : "")
    );
  }

  formatStatus(): string {
    const meeting = this.currentMeeting;
    if (!meeting) return "📭 アクティブな会議はありません";

    return (
      `🎥 **Meet会議**\n` +
      `タイトル: ${meeting.title}\n` +
      `URL: ${meeting.url}\n` +
      `状態: ${meeting.status === "in_meeting" ? "🟢 参加中" : meeting.status}\n` +
      `経過時間: ${((Date.now() - meeting.startedAt) / 1000 / 60).toFixed(0)}分\n` +
      `字幕: ${this.transcript.length}行`
    );
  }
}

// ==================== シングルトン ====================

export const meetManager = new MeetManager();

export default MeetManager;
