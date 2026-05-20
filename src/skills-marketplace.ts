// ==========================================
// Hikamer - Skills Marketplace Connector (v1.69)
// 出典: skills.sh API + gh skill CLI + npx skills add
// skills.sh のオープンエコシステムと接続
// ==========================================

import { logger } from "./utils/logger";
import { execSync } from "child_process";

// ==================== 型定義 ====================

export interface MarketplaceSkill {
  name: string;
  owner: string;
  repo: string;
  description: string;
  category: string;
  stars: number;
  installs: number;
  updatedAt: string;
  installCommand: string;
}

// ==================== スキルマーケットプレイス ====================

const SKILLS_SH_API = "https://api.skills.sh/v1";
const SKILLS_DIR = "./data/skills-marketplace";

class SkillsMarketplace {
  private cache: MarketplaceSkill[] = [];
  private cacheTime = 0;
  private cacheTTL = 3600_000; // 1時間

  /**
   * skills.sh からトレンドスキルを取得
   */
  async getTrending(limit: number = 10): Promise<MarketplaceSkill[]> {
    if (this.isCacheValid()) return this.cache.slice(0, limit);

    try {
      const res = await fetch(`${SKILLS_SH_API}/skills/trending?limit=${limit}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return this.getFallbackSkills();

      const data = await res.json();
      this.cache = (data.skills || data || []).map(this.normalizeSkill);
      this.cacheTime = Date.now();
      return this.cache.slice(0, limit);
    } catch {
      return this.getFallbackSkills();
    }
  }

  /**
   * スキルを検索
   */
  async search(query: string, limit: number = 10): Promise<MarketplaceSkill[]> {
    try {
      const res = await fetch(`${SKILLS_SH_API}/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return this.localSearch(query, limit);

      const data = await res.json();
      return (data.skills || data || []).map(this.normalizeSkill);
    } catch {
      return this.localSearch(query, limit);
    }
  }

  /**
   * npx skills add でスキルをインストール
   */
  async install(ownerRepo: string): Promise<{ success: boolean; message: string }> {
    try {
      const result = execSync(`npx skills add ${ownerRepo} -y`, {
        cwd: process.cwd(),
        timeout: 30_000,
        encoding: "utf-8",
      });
      logger.info(`[Marketplace] インストール: ${ownerRepo}`);
      return { success: true, message: result.slice(0, 200) || "インストール完了" };
    } catch (e: any) {
      const msg = e.stderr || e.message || "不明なエラー";
      logger.error(`[Marketplace] インストール失敗: ${ownerRepo} - ${msg}`);
      return { success: false, message: msg.slice(0, 200) };
    }
  }

  /**
   * インストール済みスキルをスキャン
   */
  scanInstalled(): string[] {
    const dirs = [
      "./.claude/skills",
      "./.codex/skills",
      "./.opencode/skills",
      "./skills",
    ];

    const results: string[] = [];
    for (const dir of dirs) {
      try {
        const { readdirSync, existsSync } = require("fs");
        if (existsSync(dir)) {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillPath = `${dir}/${entry.name}`;
              if (existsSync(`${skillPath}/SKILL.md`)) {
                results.push(skillPath);
              }
            }
          }
        }
      } catch {}
    }

    return results;
  }

  formatTrending(skills: MarketplaceSkill[]): string {
    if (skills.length === 0) return "📭 トレンドスキルを取得できませんでした。";

    const lines: string[] = ["🔥 **スキルマーケットプレイス** (skills.sh)", ""];
    for (const s of skills.slice(0, 10)) {
      const stars = s.stars > 1000 ? `⭐${(s.stars / 1000).toFixed(1)}K` : `⭐${s.stars}`;
      lines.push(`**${s.name}** ${stars}`);
      lines.push(`  \`${s.installCommand}\``);
      lines.push(`  ${s.description.slice(0, 100)}`);
    }

    lines.push("", "`/skills install <owner/repo>` でインストール");
    return lines.join("\n");
  }

  formatSearch(skills: MarketplaceSkill[]): string {
    if (skills.length === 0) return "🔍 該当するスキルが見つかりませんでした。";

    const lines: string[] = ["🔍 **検索結果**", ""];
    for (const s of skills.slice(0, 10)) {
      lines.push(`**${s.name}** (\`${s.owner}/${s.repo}\`)`);
      lines.push(`  ${s.description.slice(0, 100)}`);
    }

    return lines.join("\n");
  }

  private normalizeSkill(raw: any): MarketplaceSkill {
    return {
      name: raw.name || raw.repo || "unknown",
      owner: raw.owner || raw.repo?.split("/")[0] || "",
      repo: raw.repo || "",
      description: raw.description || "",
      category: raw.category || "general",
      stars: raw.stars || raw.stargazers_count || 0,
      installs: raw.installs || 0,
      updatedAt: raw.updatedAt || raw.updated_at || "",
      installCommand: `npx skills add ${raw.owner || raw.repo?.split("/")[0] || "owner"}/${raw.repo}`,
    };
  }

  private isCacheValid(): boolean {
    return this.cache.length > 0 && (Date.now() - this.cacheTime) < this.cacheTTL;
  }

  /**
   * APIが使えない時のフォールバック: 人気スキルの静的リスト
   */
  private getFallbackSkills(): MarketplaceSkill[] {
    return [
      { name: "academic-research-skills", owner: "Imbad0202", repo: "Imbad0202/academic-research-skills", description: "研究→執筆→レビュー→修正→最終化の5段階パイプライン", category: "research", stars: 12700, installs: 0, updatedAt: "2026", installCommand: "npx skills add Imbad0202/academic-research-skills" },
      { name: "skills-best-practices", owner: "mgechev", repo: "mgechev/skills-best-practices", description: "プロ品質のエージェントスキル作成ガイド", category: "meta", stars: 800, installs: 0, updatedAt: "2026", installCommand: "npx skills add mgechev/skills-best-practices" },
      { name: "resend-skills", owner: "resend", repo: "resend/resend-skills", description: "メール送受信のためのエージェントスキル", category: "email", stars: 500, installs: 0, updatedAt: "2026", installCommand: "npx skills add resend/resend-skills" },
      { name: "last30days", owner: "mvanhorn", repo: "mvanhorn/last30days-skill", description: "Reddit/X/YouTube/Web横断リサーチ", category: "research", stars: 300, installs: 0, updatedAt: "2026", installCommand: "npx skills add mvanhorn/last30days-skill" },
      { name: "reddit-growth", owner: "oh-ashen-one", repo: "oh-ashen-one/reddit-growth-skill", description: "Reddit有機的成長（アンチスパム設計）", category: "marketing", stars: 200, installs: 0, updatedAt: "2026", installCommand: "npx skills add oh-ashen-one/reddit-growth-skill" },
    ];
  }

  private localSearch(query: string, limit: number): MarketplaceSkill[] {
    const lower = query.toLowerCase();
    return this.getFallbackSkills()
      .filter(s => s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower))
      .slice(0, limit);
  }
}

// ==================== シングルトン ====================

export const skillsMarketplace = new SkillsMarketplace();
export default SkillsMarketplace;
