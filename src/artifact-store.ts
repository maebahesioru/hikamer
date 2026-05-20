// ==========================================
// Hikamer - Artifact Store + MECE Classifier（toprank openclaw/bin/ 由来）
// イミュータブル実行アーティファクト + MECE分類 + 優先度スコアリング
// ==========================================

import { logger } from "./utils/logger";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";

// ==================== 型定義 ====================

export type ArtifactType =
  | "audit" | "action_plan" | "verification" | "proposal"
  | "feedback" | "goal" | "learning_log" | "patch_set" | "state_snapshot";

export interface Artifact {
  id: string;
  type: ArtifactType;
  data: Record<string, unknown>;
  timestamp: string;
  runDir: string;
}

export interface AuditEntry {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  evidence: string;
  score: number;
}

export interface ActionPlan {
  priority: number;
  action: string;
  expectedImpact: string;
  approvalGate: "auto" | "review";
}

// ==================== MECE分類 ====================

export type MeceLane =
  | "search_eligibility"
  | "demand_intent"
  | "content_usefulness"
  | "onpage_serp"
  | "technical_ux"
  | "authority"
  | "local"
  | "measurement";

const MECE_LANES: Record<MeceLane, string> = {
  search_eligibility: "検索エリジビリティ（インデックス/クロール）",
  demand_intent: "需要/インテント（キーワード戦略）",
  content_usefulness: "コンテンツ有用性（品質/独自性）",
  onpage_serp: "オンページ/SERP（タイトル/メタ/構造）",
  technical_ux: "技術/UX（表示速度/モバイル/CWV）",
  authority: "権威性（リンク/被リンク）",
  local: "ローカルSEO（MAP/NAP）",
  measurement: "測定/データ品質（GSC設定/タグ）",
};

/** 回帰パターンを分類 */
export function classifyRegressionPattern(
  positionChange: number,
  ctrChange: number,
  impressionChange: number,
): { lane: MeceLane; reason: string } {
  // ポジション低下が先
  if (Math.abs(positionChange) > Math.abs(ctrChange) && positionChange < -5) {
    return { lane: "technical_ux", reason: "ポジション低下が支配的: Core Web Vitals/技術的問題の可能性" };
  }
  // CTR低下が先
  if (Math.abs(ctrChange) > Math.abs(impressionChange) && ctrChange < -10) {
    return { lane: "onpage_serp", reason: "CTR低下が支配的: タイトル/メタ/リッチリザルトの問題" };
  }
  // インプレッション低下が先
  if (impressionChange < -20) {
    return { lane: "search_eligibility", reason: "インプレッション低下が支配的: インデックス/クロールの問題" };
  }
  return { lane: "measurement", reason: "複合的要因: 詳細分析が必要" };
}

/** MECEレーンにマッピング */
export function classifyToMeceLane(issue: string): MeceLane {
  const lower = issue.toLowerCase();

  const lanePatterns: Array<{ lane: MeceLane; patterns: string[] }> = [
    { lane: "search_eligibility", patterns: ["index", "crawl", "discover", "noindex", "robots", "sitemap", "404", "not found"] },
    { lane: "demand_intent", patterns: ["keyword", "search volume", "intent", "topic gap", "semantic"] },
    { lane: "content_usefulness", patterns: ["content", "quality", "thin", "duplicate", "unique", "helpful", "eeat"] },
    { lane: "onpage_serp", patterns: ["title", "meta", "heading", "snippet", "schema", "rich result", "ctr"] },
    { lane: "technical_ux", patterns: ["speed", "core web vitals", "mobile", "lcp", "cls", "inp", "responsive"] },
    { lane: "authority", patterns: ["backlink", "referral", "domain authority", "link"] },
    { lane: "local", patterns: ["local", "map", "google business", "nap", "gmb"] },
    { lane: "measurement", patterns: ["analytics", "gsc", "tag", "tracking", "measure"] },
  ];

  for (const { lane, patterns } of lanePatterns) {
    if (patterns.some((p) => lower.includes(p))) return lane;
  }
  return "measurement";
}

// ==================== 優先度スコアリング ====================

export interface PriorityFactors {
  impact: number;       // 0-100
  confidence: number;   // 0-1
  goalAlignment: number; // 0-1
  actionability: number; // 0-1
  urlQuality: number;    // 0-1
  businessIntent: number; // 0-1
}

export function scorePriority(factors: PriorityFactors): number {
  return Math.round(
    factors.impact *
    factors.confidence *
    factors.goalAlignment *
    factors.actionability *
    factors.urlQuality *
    factors.businessIntent *
    100,
  ) / 100;
}

// ==================== アーティファクトストア ====================

const REQUIRED_ARTIFACT_KEYS: Record<ArtifactType, string[]> = {
  audit: ["severity", "category", "description", "evidence"],
  action_plan: ["actions", "expected_impact", "priority"],
  verification: ["checks", "passed", "followup_due"],
  proposal: ["title", "changes", "rationale"],
  feedback: ["outcome", "baseline", "observed", "score"],
  goal: ["target", "metric", "deadline"],
  learning_log: ["insight", "source", "confidence"],
  patch_set: ["files", "diff", "description"],
  state_snapshot: ["version", "config", "metrics"],
};

/** イミュータブル実行ディレクトリを作成 */
export function createRunDir(baseDir: string, runId?: string): string {
  const id = runId || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve(baseDir, "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** アーティファクトを保存 */
export function saveArtifact(
  runDir: string,
  type: ArtifactType,
  data: Record<string, unknown>,
): Artifact {
  const artifact: Artifact = {
    id: `${type}_${Date.now().toString(36)}`,
    type,
    data,
    timestamp: new Date().toISOString(),
    runDir,
  };

  const path = join(runDir, `${type}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2), "utf-8");

  // latest-state.jsonを更新
  const latestPath = resolve(runDir, "..", "latest-state.json");
  writeFileSync(latestPath, JSON.stringify({ lastRun: runDir, lastUpdated: artifact.timestamp, artifacts: [type] }), "utf-8");

  logger.info(`[Artifact] 保存: ${type} → ${path}`);
  return artifact;
}

/** アーティファクトを検証 */
export function validateArtifact(type: ArtifactType, data: Record<string, unknown>): string[] {
  const required = REQUIRED_ARTIFACT_KEYS[type];
  if (!required) return ["Unknown artifact type"];
  return required.filter((key) => !(key in data));
}

/** 最新の実行ディレクトリを取得 */
export function getLatestRunDir(baseDir: string): string | null {
  const runsDir = resolve(baseDir, "runs");
  if (!existsSync(runsDir)) return null;

  const dirs = readdirSync(runsDir)
    .map((d) => ({ name: d, path: join(runsDir, d), time: new Date(readdirSync(join(runsDir, d)).length > 0 ? 0 : 0) }))
    .sort((a, b) => b.name.localeCompare(a.name));

  return dirs.length > 0 ? dirs[0]!.path : null;
}

/** 状態をフォーマット */
export function formatArtifactStatus(baseDir: string): string {
  const latest = getLatestRunDir(baseDir);

  return [
    "📦 **Artifact Store**",
    `  ベース: ${baseDir}`,
    `  最新実行: ${latest || "なし"}`,
    `  アーティファクト型: ${Object.keys(REQUIRED_ARTIFACT_KEYS).length}`,
    "",
    "**MECE Classification Lanes:**",
    ...Object.entries(MECE_LANES).map(([lane, desc]) => `  • **${lane}**: ${desc}`),
  ].join("\n");
}
