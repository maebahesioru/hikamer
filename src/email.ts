// ==========================================
// Aikata - メール統合（OpenHuman channels + integrations由来）
// SMTP送信 + IMAP受信 + メール処理
// ==========================================

import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

interface MailConfig {
  /** SMTP設定 */
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  /** IMAP設定 */
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  /** 送信者情報 */
  from: {
    name: string;
    address: string;
  };
}

interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  date: Date;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  read: boolean;
}

// ==================== メールエンジン（軽量実装） ====================

class MailEngine {
  private config: MailConfig | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /** 設定をセット */
  configure(config: MailConfig): void {
    this.config = config;
    logger.info(`[Mail] 設定: ${config.smtp.host}:${config.smtp.port}`);
  }

  /** SMTPでメール送信（sendmail or curlベース） */
  async sendMail(to: string | string[], subject: string, body: string, options?: {
    html?: boolean;
    cc?: string[];
    bcc?: string[];
    attachments?: Array<{ filename: string; content: string }>;
  }): Promise<boolean> {
    if (!this.config) {
      logger.warn("[Mail] 設定なし。sendmailコマンドを試行…");
      return this.sendMailFallback(to, subject, body);
    }

    const recipients = Array.isArray(to) ? to : [to];
    const cfg = this.config;

    try {
      // SMTP直実装（シンプル版）
      const { createTransport } = await importThis();
      if (createTransport) {
        // Nodemailer等がインストールされている場合
        const info = await createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
        }).sendMail({
          from: `"${cfg.from.name}" <${cfg.from.address}>`,
          to: recipients.join(", "),
          cc: options?.cc?.join(", "),
          bcc: options?.bcc?.join(", "),
          subject,
          text: options?.html ? undefined : body,
          html: options?.html ? body : undefined,
        });

        logger.info(`[Mail] 送信完了: ${subject} → ${recipients.join(", ")}`);
        eventBus.publish(createEvent("system", "mailSent", {
          to: recipients, subject,
        }));
        return true;
      }
    } catch (e: any) {
      logger.warn(`[Mail] SMTP送信失敗: ${e.message}`);
    }

    // フォールバック: sendmail / curl
    return this.sendMailFallback(recipients, subject, body);
  }

  /** sendmail/curlフォールバック */
  private async sendMailFallback(to: string | string[], subject: string, body: string): Promise<boolean> {
    const { execSync } = require("child_process");
    const recipients = Array.isArray(to) ? to.join(", ") : to;

    try {
      // sendmailがあれば使う
      execSync(`which sendmail 2>/dev/null || which msmtp 2>/dev/null || which mail 2>/dev/null || true`,
        { timeout: 3000 });

      // 簡易sendmail
      const sendmailPath = execSync("which sendmail 2>/dev/null || echo ''", { timeout: 2000 })
        .toString().trim();

      if (sendmailPath) {
        const emailContent = [
          `To: ${recipients}`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "",
          body,
        ].join("\n");

        execSync(`echo "${emailContent.replace(/"/g, '\\"')}" | ${sendmailPath} -t`, {
          timeout: 10000,
        });
        logger.info(`[Mail] sendmail送信: ${subject}`);
        return true;
      }

      // curlベースのSMTP
      if (this.config) {
        const cfg = this.config;
        // これ以上フォールバックできない
      }

      logger.warn("[Mail] 送信手段なし。メール内容を保存します。");
      const { writeFileSync, existsSync, mkdirSync } = require("fs");
      const { resolve } = require("path");
      const dir = resolve(process.env.DATA_DIR || "./data", "mail-queue");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${Date.now()}.eml`),
        `To: ${recipients}\nSubject: ${subject}\n\n${body}`, "utf-8");
      return false;
    } catch (e: any) {
      logger.warn(`[Mail] フォールバック失敗: ${e.message}`);
      return false;
    }
  }

  /** IMAP受信 */
  async fetchInbox(limit: number = 10): Promise<EmailMessage[]> {
    if (!this.config?.imap) {
      logger.warn("[Mail] IMAP未設定");
      return [];
    }

    const cfg = this.config.imap;

    try {
      // curlベースのIMAP
      const result = await this.fetchViaCurl(cfg, limit);
      if (result.length > 0) return result;
    } catch (e: any) {
      logger.warn(`[Mail] IMAP受信失敗: ${e.message}`);
    }

    return [];
  }

  /** curlでIMAP受信 */
  private async fetchViaCurl(imap: MailConfig["imap"] & { user: string; pass: string }, limit: number): Promise<EmailMessage[]> {
    const { execSync } = require("child_process");

    try {
      const url = `${imap.secure ? "imaps" : "imap"}://${encodeURIComponent(imap.user)}:${encodeURIComponent(imap.pass)}@${imap.host}:${imap.port}/INBOX`;

      const output = execSync(
        `curl -s --url "${url}" -X "FETCH 1:${limit} (BODY[HEADER.FIELDS (SUBJECT FROM DATE)])" 2>/dev/null || true`,
        { timeout: 15000, encoding: "utf-8" },
      ).toString();

      // シンプルパース
      const emails: EmailMessage[] = [];
      const blocks = output.split(/\*\s+\d+\s+FETCH/);

      for (const block of blocks.slice(1)) {
        const subjectMatch = block.match(/SUBJECT:\s*(.+)/i);
        const fromMatch = block.match(/FROM:\s*(.+)/i);
        const dateMatch = block.match(/DATE:\s*(.+)/i);

        emails.push({
          id: `email-${Date.now()}-${emails.length}`,
          from: fromMatch?.[1]?.trim() || "unknown",
          to: [""],
          subject: subjectMatch?.[1]?.trim() || "(no subject)",
          body: "",
          date: dateMatch ? new Date(dateMatch[1]!) : new Date(),
          attachments: [],
          read: true,
        });
      }

      return emails;
    } catch {
      return [];
    }
  }

  /** 定期的受信（新着メールチェック） */
  startPolling(intervalMs: number = 300000): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      try {
        const emails = await this.fetchInbox(5);
        for (const email of emails) {
          logger.info(`[Mail] 新着: ${email.subject} from ${email.from}`);
          eventBus.publish(createEvent("system", "mailReceived", {
            from: email.from,
            subject: email.subject,
            date: email.date.toISOString(),
          }));
        }
      } catch {}
    }, intervalMs);

    logger.info(`[Mail] ポーリング開始: ${intervalMs / 1000}秒間隔`);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

/** 動的importラッパー */
async function importThis(): Promise<{ createTransport: any }> {
  try {
    const nodemailer = await import("nodemailer");
    return nodemailer;
  } catch {
    return { createTransport: null };
  }
}

// ==================== シングルトン ====================

export const mailEngine = new MailEngine();
