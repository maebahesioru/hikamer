// ==========================================
// Aikata - Meetエージェント（OpenHuman meet_agent/ 由来）
// 会議参加エージェント・発言・議事録生成（meet.tsの補完）
// ==========================================

import { logger } from "./utils/logger";
import { meetManager } from "./meet";

// ==================== 型定義 ====================

export interface MeetAgentState {
  meetingId: string;
  isListening: boolean;
  isSpeaking: boolean;
  queue: MeetAction[];
  lastActivityAt: number;
}

export interface MeetAction {
  type: "listen" | "speak" | "analyze" | "summarize" | "respond";
  content: string;
  timestamp: number;
  processed: boolean;
}

export interface MeetAgentResponse {
  text: string;
  confidence: number;
  action: "answer" | "clarify" | "acknowledge" | "suggest";
}

// ==================== Meetエージェント ====================

class MeetAgent {
  private activeMeetings: Map<string, MeetAgentState> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[MeetAgent] initialized");
  }

  /** 会議にエージェントとして参加 */
  async joinAsAgent(meetingUrl: string, name?: string): Promise<boolean> {
    const meeting = await meetManager.joinMeeting(meetingUrl, name);
    if (!meeting) return false;

    this.activeMeetings.set(meeting.id, {
      meetingId: meeting.id,
      isListening: true,
      isSpeaking: false,
      queue: [],
      lastActivityAt: Date.now(),
    });

    logger.info(`[MeetAgent] joined ${meetingUrl} as ${name ?? "agent"}`);
    return true;
  }

  /** 発言を処理 */
  async processUtterance(
    meetingId: string,
    speaker: string,
    text: string
  ): Promise<MeetAgentResponse | null> {
    const state = this.activeMeetings.get(meetingId);
    if (!state || !state.isListening) return null;

    // 文字起こしを追加
    meetManager.addTranscript(speaker, text);
    state.lastActivityAt = Date.now();

    // エージェント宛てか判定
    if (!this.isAddressedToAgent(text)) return null;

    // 応答を生成
    const response = await this.generateResponse(text);

    state.queue.push({
      type: "respond",
      content: response.text,
      timestamp: Date.now(),
      processed: false,
    });

    return response;
  }

  /** エージェントへの発言か判定 */
  private isAddressedToAgent(text: string): boolean {
    const lower = text.toLowerCase();
    const agentNames = ["agent", "aikata", "bot", "エージェント", "アイカタ"];
    return agentNames.some((name) => lower.includes(name)) ||
           text.includes("@");
  }

  /** 応答を生成 */
  private async generateResponse(text: string): Promise<MeetAgentResponse> {
    const apiKey = process.env.AIKATA_LLM_API_KEY || process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return {
        text: "I'm listening. How can I help?",
        confidence: 0.5,
        action: "acknowledge",
      };
    }

    try {
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
            messages: [
              {
                role: "system",
                content:
                  "あなたは会議に参加しているAIアシスタントです。" +
                  "簡潔に、自然に応答してください。50文字以内。",
              },
              { role: "user", content: text },
            ],
            temperature: 0.3,
            max_tokens: 100,
          }),
        }
      );

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const response = data.choices?.[0]?.message?.content?.trim() ?? "";

      return {
        text: response,
        confidence: 0.7,
        action: response.endsWith("?") ? "answer" : "acknowledge",
      };
    } catch {
      return {
        text: "I heard you. Let me think about that.",
        confidence: 0.4,
        action: "acknowledge",
      };
    }
  }

  /** 待機中のアクションを取得 */
  getPendingActions(meetingId: string): MeetAction[] {
    const state = this.activeMeetings.get(meetingId);
    if (!state) return [];
    return state.queue.filter((a) => !a.processed);
  }

  /** アクションを処理済みに */
  markActionProcessed(meetingId: string, actionIndex: number): void {
    const state = this.activeMeetings.get(meetingId);
    if (!state) return;
    if (state.queue[actionIndex]) {
      state.queue[actionIndex]!.processed = true;
    }
  }

  /** 会議から退出 */
  async leaveMeeting(meetingId: string): Promise<void> {
    this.activeMeetings.delete(meetingId);
    await meetManager.leaveMeeting();
    logger.info(`[MeetAgent] left meeting ${meetingId}`);
  }

  /** アクティブな会議一覧 */
  listActiveMeetings(): MeetAgentState[] {
    return Array.from(this.activeMeetings.values());
  }

  formatStatus(): string {
    const active = this.listActiveMeetings();
    return (
      `🤖 **Meetエージェント**\n` +
      `アクティブ会議: ${active.length}\n` +
      (active.length > 0
        ? active
            .map(
              (a) =>
                `- ${a.meetingId.slice(0, 16)}... | 待機アクション: ${a.queue.filter((q) => !q.processed).length}`
            )
            .join("\n")
        : "参加中の会議はありません")
    );
  }
}

// ==================== シングルトン ====================

export const meetAgent = new MeetAgent();

export default MeetAgent;
