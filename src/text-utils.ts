// ==========================================
// Aikata - Text Utilities（OpenClaw shared/text/ + HA redact由来）
// コード領域検出・タグ除去・CJKトークン推定・JSON抽出
// ==========================================

// ==================== コード領域検出 ====================

export interface CodeRegion {
  start: number;
  end: number;
  type: "fenced" | "inline";
}

/** コードブロック領域を検出 */
export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  // フェンスドコードブロック (``` または ~~~)
  const fencedRe = /(```|~~~)/g;
  let match: RegExpExecArray | null;
  const fences: { index: number; char: string }[] = [];

  while ((match = fencedRe.exec(text)) !== null) {
    const char = match[1]!;
    const prevFence = fences[fences.length - 1];
    if (prevFence && prevFence.char === char) {
      regions.push({ start: prevFence.index, end: match.index + 3, type: "fenced" });
      fences.pop();
    } else {
      fences.push({ index: match.index, char });
    }
  }

  // インラインコード (`code`)
  const inlineRe = /`([^`]+)`/g;
  while ((match = inlineRe.exec(text)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length, type: "inline" });
  }

  // ソート
  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/** 位置がコード領域内か判定 */
export function isInsideCode(text: string, pos: number): boolean {
  return findCodeRegions(text).some((r) => pos >= r.start && pos < r.end);
}

// ==================== タグ除去 ====================

/** reasoningタグ／thinkタグを除去（コード領域を保護） */
export function stripReasoningTags(text: string): string {
  const regions = findCodeRegions(text);
  const isInCode = (pos: number) => regions.some((r) => pos >= r.start && pos < r.end);

  let result = "";
  let i = 0;
  while (i < text.length) {
    if (isInCode(i)) {
      result += text[i];
      i++;
      continue;
    }

    // <reasoning>, <think>, <thinking> とその閉じタグ
    const openMatch = text.slice(i).match(/^<(reasoning|think|thinking)>/i);
    if (openMatch) {
      const tag = openMatch[1]!;
      const closeTag = `</${tag}>`;
      const closeIdx = text.indexOf(closeTag, i + openMatch[0].length);
      if (closeIdx !== -1) {
        i = closeIdx + closeTag.length;
        continue;
      }
      // 閉じタグなし → 開きタグだけ除去
      i += openMatch[0].length;
      continue;
    }

    // 閉じタグ単体（対応する開きタグなし）
    const closeMatch = text.slice(i).match(/^<\/(reasoning|think|thinking)>/i);
    if (closeMatch) {
      i += closeMatch[0].length;
      continue;
    }

    result += text[i];
    i++;
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/** マークダウン書式を除去 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")  // bold
    .replace(/\*(.+?)\*/g, "$1")         // italic
    .replace(/~~(.+?)~~/g, "$1")          // strikethrough
    .replace(/^#{1,6}\s+/gm, "")          // headings
    .replace(/^>\s+/gm, "")               // blockquotes
    .replace(/`([^`]+)`/g, "$1")          // inline code
    .replace(/^[-*+]\s+/gm, "")           // list markers
    .replace(/\n{3,}/g, "\n\n")        // normalize whitespace
    .trim();
}

// ==================== JSON抽出 ====================

/** テキストから均衡の取れたJSONオブジェクトを抽出 */
export function extractBalancedJson(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") i++; // skip escaped char
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        result.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return result;
}

// ==================== CJKトークン推定 ====================

/** CJK文字を考慮した文字数カウント */
export function estimateStringChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // CJK統一漢字・拡張A/B・仮名・ハングル → 4x weight
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK統合漢字
      (code >= 0x3040 && code <= 0x30FF) ||   // ひらがな・カタカナ
      (code >= 0xAC00 && code <= 0xD7AF) ||   // ハングル
      (code >= 0x3400 && code <= 0x4DBF)      // CJK拡張A
    ) {
      count += 4;
    } else if (code > 0x7F) {
      count += 2; // その他非ASCII
    } else {
      count += 1; // ASCII
    }
  }
  return count;
}

/** 推定トークン数 */
export function estimateTokens(text: string): number {
  return Math.ceil(estimateStringChars(text) / 4);
}

// ==================== 文字列操作 ====================

/** UTF-8セーフな文字列切り詰め */
export function truncateWithEllipsis(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + "…";
}

/** 文字列正規化（null/undefined/空白処理） */
export function normalizeOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

/** トリミングされた文字列リストに正規化 */
export function normalizeTrimmedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 人間が読めるリスト表記（a, b, or c） */
export function formatHumanList(items: string[], conjunction = "or"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  const first = items.slice(0, -1).join(", ");
  return `${first}, ${conjunction} ${items[items.length - 1]}`;
}
