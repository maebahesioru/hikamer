// ==========================================
// Aikata - リファラル/招待（OpenHuman referral由来）
// 招待コード生成・共有・追跡
// ==========================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export interface InviteCode {
  code: string;
  createdBy: string;
  createdAt: number;
  maxUses: number;
  useCount: number;
  expiresAt: number | null;
  permissions: string[];
  usedBy: string[];
  label?: string;
  active: boolean;
}

export interface ReferralEntry {
  referrerId: string;
  referredId: string;
  code: string;
  timestamp: number;
  rewardClaimed: boolean;
}

// ==================== 招待管理 ====================

class ReferralManager {
  private invites = new Map<string, InviteCode>();
  private referrals: ReferralEntry[] = [];
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = resolve(dataDir, "referrals.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
        if (data.invites) for (const i of data.invites) this.invites.set(i.code, i);
        if (data.referrals) this.referrals = data.referrals;
        logger.info(`[Referral] 復元: ${this.invites.size}招待, ${this.referrals.length}紹介`);
      }
    } catch (e) {
      logger.warn(`[Referral] 読込失敗: ${e}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({
        invites: Array.from(this.invites.values()),
        referrals: this.referrals,
      }, null, 2), "utf-8");
    } catch (e) {
      logger.error(`[Referral] 保存失敗: ${e}`);
    }
  }

  /** 招待コード生成 */
  createInvite(createdBy: string, options?: {
    maxUses?: number;
    expiresInHours?: number;
    permissions?: string[];
    label?: string;
  }): InviteCode {
    const code = this.generateCode();

    const invite: InviteCode = {
      code,
      createdBy,
      createdAt: Date.now(),
      maxUses: options?.maxUses || 1,
      useCount: 0,
      expiresAt: options?.expiresInHours ? Date.now() + options.expiresInHours * 3600000 : null,
      permissions: options?.permissions || [],
      usedBy: [],
      label: options?.label,
      active: true,
    };

    this.invites.set(code, invite);
    this.save();
    logger.info(`[Referral] 招待作成: ${code} by ${createdBy}`);
    return invite;
  }

  /** 招待コード使用 */
  useInvite(code: string, userId: string): { valid: boolean; reason?: string; invite?: InviteCode } {
    const invite = this.invites.get(code);
    if (!invite) return { valid: false, reason: "無効なコード" };
    if (!invite.active) return { valid: false, reason: "無効化されたコード" };
    if (invite.useCount >= invite.maxUses) return { valid: false, reason: "使用回数上限" };
    if (invite.expiresAt && Date.now() > invite.expiresAt) return { valid: false, reason: "期限切れ" };
    if (invite.usedBy.includes(userId)) return { valid: false, reason: "既に使用済み" };

    invite.useCount++;
    invite.usedBy.push(userId);

    // 紹介記録
    this.referrals.push({
      referrerId: invite.createdBy,
      referredId: userId,
      code,
      timestamp: Date.now(),
      rewardClaimed: false,
    });

    this.save();
    logger.info(`[Referral] 使用: ${code} by ${userId} (${invite.useCount}/${invite.maxUses})`);
    return { valid: true, invite };
  }

  /** 紹介報酬請求 */
  claimReward(referrerId: string): ReferralEntry[] {
    const unclaimed = this.referrals.filter(r => r.referrerId === referrerId && !r.rewardClaimed);
    for (const r of unclaimed) r.rewardClaimed = true;
    this.save();
    return unclaimed;
  }

  /** 招待無効化 */
  deactivate(code: string): boolean {
    const invite = this.invites.get(code);
    if (!invite) return false;
    invite.active = false;
    this.save();
    return true;
  }

  /** 自分の招待一覧 */
  getMyInvites(userId: string): InviteCode[] {
    return Array.from(this.invites.values())
      .filter(i => i.createdBy === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 紹介統計 */
  getReferralStats(userId: string): { sent: number; used: number; pending: number; rewardReady: number } {
    const myInvites = this.getMyInvites(userId);
    const myReferrals = this.referrals.filter(r => r.referrerId === userId);
    return {
      sent: myInvites.length,
      used: myReferrals.length,
      pending: myInvites.filter(i => i.active && i.useCount < i.maxUses && (!i.expiresAt || Date.now() < i.expiresAt)).length,
      rewardReady: myReferrals.filter(r => !r.rewardClaimed).length,
    };
  }

  private generateCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字除外
    let code = "";
    const bytes = randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i]! % chars.length];
    }
    if (this.invites.has(code)) return this.generateCode();
    return code;
  }

  formatInvites(invites: InviteCode[]): string {
    if (invites.length === 0) return "📨 招待コードはありません。";

    return [
      "📨 **招待コード一覧**",
      "",
      ...invites.map(i => {
        const status = i.active ? "✅" : "❌";
        const used = `${i.useCount}/${i.maxUses}`;
        const expiry = i.expiresAt ? ` 期限: ${new Date(i.expiresAt).toLocaleDateString("ja-JP")}` : "";
        const label = i.label ? ` (${i.label})` : "";
        return `${status} \`${i.code}\`${label} ${used}${expiry}`;
      }),
    ].join("\n");
  }
}

// ==================== シングルトン ====================

const DATA_DIR = process.env.DATA_DIR || "./data";
export const referralManager = new ReferralManager(DATA_DIR);
