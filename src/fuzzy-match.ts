// ==========================================
// Hikamer - Fuzzy Match Engine（Hermes Agent fuzzy_match.py 完全移植）
// 9戦略ファジー検索置換＋エスケープドリフト検出＋候補提示
// ==========================================

export interface FuzzyMatchResult {
  matches: Array<{ start: number; end: number }>;
  strategy: string;
}

// ==================== 戦略チェーン ====================

/** 9戦略のファジーマッチングチェーン */
export function fuzzyFind(
  content: string,
  pattern: string,
): FuzzyMatchResult | null {
  if (!pattern) return null;

  const strategies: Array<{ name: string; fn: () => Array<{ start: number; end: number }> }> = [
    { name: "exact", fn: () => strategyExact(content, pattern) },
    { name: "line_trimmed", fn: () => strategyLineTrimmed(content, pattern) },
    { name: "whitespace_normalized", fn: () => strategyWhitespaceNormalized(content, pattern) },
    { name: "indentation_flexible", fn: () => strategyIndentationFlexible(content, pattern) },
    { name: "escape_normalized", fn: () => strategyEscapeNormalized(content, pattern) },
    { name: "trimmed_boundary", fn: () => strategyTrimmedBoundary(content, pattern) },
    { name: "unicode_normalized", fn: () => strategyUnicodeNormalized(content, pattern) },
    { name: "block_anchor", fn: () => strategyBlockAnchor(content, pattern) },
    { name: "context_aware", fn: () => strategyContextAware(content, pattern) },
  ];

  for (const { name, fn } of strategies) {
    try {
      const matches = fn();
      if (matches.length > 0) {
        return { matches, strategy: name };
      }
    } catch { continue; }
  }

  return null;
}

/** ファジー検索置換（1回または全置換） */
export function fuzzyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; count: number; strategy: string | null; error?: string } {
  if (!oldString) return { content, count: 0, strategy: null, error: "old_string cannot be empty" };
  if (oldString === newString) return { content, count: 0, strategy: null, error: "old_string and new_string are identical" };

  const result = fuzzyFind(content, oldString);
  if (!result) {
    return { content, count: 0, strategy: null, error: "Could not find a match for old_string in the file" };
  }

  if (result.matches.length > 1 && !replaceAll) {
    return {
      content, count: 0, strategy: null,
      error: `Found ${result.matches.length} matches for old_string. Provide more context to make it unique, or use replaceAll=true.`,
    };
  }

  // エスケープドリフト検出
  if (result.strategy !== "exact") {
    const driftError = detectEscapeDrift(content, result.matches, oldString, newString);
    if (driftError) {
      return { content, count: 0, strategy: null, error: driftError };
    }
  }

  // 置換実行
  const sorted = [...result.matches].sort((a, b) => b.start - a.start);
  let newContent = content;
  for (const { start, end } of sorted) {
    newContent = newContent.slice(0, start) + newString + newContent.slice(end);
  }

  return { content: newContent, count: result.matches.length, strategy: result.strategy };
}

// ==================== エスケープドリフト検出 ====================

function detectEscapeDrift(
  content: string,
  matches: Array<{ start: number; end: number }>,
  oldString: string,
  newString: string,
): string | null {
  if (!newString.includes("\\'") && !newString.includes('\\"')) return null;

  const matchedRegions = matches.map((m) => content.slice(m.start, m.end)).join("");

  for (const suspect of ["\\'", '\\"']) {
    if (newString.includes(suspect) && oldString.includes(suspect) && !matchedRegions.includes(suspect)) {
      const plain = suspect[1];
      return (
        `Escape-drift detected: old_string and new_string contain ` +
        `the literal sequence ${JSON.stringify(suspect)} but the matched region of ` +
        `the file does not. Re-read the file and pass old_string/new_string ` +
        `without backslash-escaping ${JSON.stringify(plain)} characters.`
      );
    }
  }
  return null;
}

// ==================== 各戦略 ====================

function strategyExact(content: string, pattern: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (true) {
    const idx = content.indexOf(pattern, pos);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + pattern.length });
    pos = idx + 1;
  }
  return matches;
}

function strategyLineTrimmed(content: string, pattern: string): Array<{ start: number; end: number }> {
  const contentLines = content.split("\n");
  const patternLines = pattern.split("\n").map((l) => l.trim());
  const patternNorm = patternLines.join("\n");
  return findNormalizedMatches(content, contentLines, contentLines.map((l) => l.trim()), patternNorm);
}

function strategyWhitespaceNormalized(content: string, pattern: string): Array<{ start: number; end: number }> {
  const normalize = (s: string) => s.replace(/[ \t]+/g, " ");
  const contentNorm = normalize(content);
  const patternNorm = normalize(pattern);
  if (contentNorm === content && patternNorm === pattern) return [];
  return mapNormalizedPositions(content, contentNorm, strategyExact(contentNorm, patternNorm));
}

function strategyIndentationFlexible(content: string, pattern: string): Array<{ start: number; end: number }> {
  const contentLines = content.split("\n");
  const contentStripped = contentLines.map((l) => l.trimStart());
  const patternLines = pattern.split("\n").map((l) => l.trimStart());
  return findNormalizedMatches(content, contentLines, contentStripped, patternLines.join("\n"));
}

function strategyEscapeNormalized(content: string, pattern: string): Array<{ start: number; end: number }> {
  const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  const patternUnescaped = unescape(pattern);
  if (patternUnescaped === pattern) return [];
  return strategyExact(content, patternUnescaped);
}

function strategyTrimmedBoundary(content: string, pattern: string): Array<{ start: number; end: number }> {
  const patternLines = pattern.split("\n");
  if (patternLines.length < 1) return [];

  patternLines[0] = patternLines[0]!.trim();
  if (patternLines.length > 1) patternLines[patternLines.length - 1] = patternLines[patternLines.length - 1]!.trim();
  const modifiedPattern = patternLines.join("\n");

  const contentLines = content.split("\n");
  const matches: Array<{ start: number; end: number }> = [];

  for (let i = 0; i <= contentLines.length - patternLines.length; i++) {
    const block = contentLines.slice(i, i + patternLines.length);
    block[0] = block[0]!.trim();
    if (block.length > 1) block[block.length - 1] = block[block.length - 1]!.trim();
    if (block.join("\n") === modifiedPattern) {
      const { start, end } = calcLinePositions(contentLines, i, i + patternLines.length, content.length);
      matches.push({ start, end });
    }
  }
  return matches;
}

function strategyUnicodeNormalized(content: string, pattern: string): Array<{ start: number; end: number }> {
  const normContent = unicodeNormalize(content);
  const normPattern = unicodeNormalize(pattern);
  if (normContent === content && normPattern === pattern) return [];

  let normMatches = strategyExact(normContent, normPattern);
  if (normMatches.length === 0) {
    normMatches = strategyLineTrimmed(normContent, normPattern);
  }

  return mapNormalizedPositions(content, normContent, normMatches);
}

function strategyBlockAnchor(content: string, pattern: string): Array<{ start: number; end: number }> {
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  const patternLines = normPattern.split("\n");
  if (patternLines.length < 2) return [];

  const firstLine = patternLines[0]!.trim();
  const lastLine = patternLines[patternLines.length - 1]!.trim();
  const normContentLines = normContent.split("\n");
  const origContentLines = content.split("\n");

  const matches: Array<{ start: number; end: number }> = [];
  const potential: number[] = [];

  for (let i = 0; i <= normContentLines.length - patternLines.length; i++) {
    if (normContentLines[i]!.trim() === firstLine &&
        normContentLines[i + patternLines.length - 1]!.trim() === lastLine) {
      potential.push(i);
    }
  }

  const threshold = potential.length === 1 ? 0.5 : 0.7;

  for (const i of potential) {
    let similarity = 1.0;
    if (patternLines.length > 2) {
      const contentMiddle = normContentLines.slice(i + 1, i + patternLines.length - 1).join("\n");
      const patternMiddle = patternLines.slice(1, -1).join("\n");
      similarity = computeSimilarity(contentMiddle, patternMiddle);
    }
    if (similarity >= threshold) {
      const { start, end } = calcLinePositions(origContentLines, i, i + patternLines.length, content.length);
      matches.push({ start, end });
    }
  }
  return matches;
}

function strategyContextAware(content: string, pattern: string): Array<{ start: number; end: number }> {
  const patternLines = pattern.split("\n");
  const contentLines = content.split("\n");
  if (patternLines.length === 0) return [];

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= contentLines.length - patternLines.length; i++) {
    const block = contentLines.slice(i, i + patternLines.length);
    let highSim = 0;
    for (let j = 0; j < patternLines.length; j++) {
      if (computeSimilarity(patternLines[j]!.trim(), block[j]!.trim()) >= 0.8) {
        highSim++;
      }
    }
    if (highSim >= patternLines.length * 0.5) {
      const { start, end } = calcLinePositions(contentLines, i, i + patternLines.length, content.length);
      matches.push({ start, end });
    }
  }
  return matches;
}

// ==================== ユーティリティ ====================

const UNICODE_MAP: Record<string, string> = {
  "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'",
  "\u2014": "--", "\u2013": "-", "\u2026": "...", "\u00a0": " ",
};

function unicodeNormalize(text: string): string {
  let result = text;
  for (const [char, repl] of Object.entries(UNICODE_MAP)) {
    result = result.replace(new RegExp(char, "g"), repl);
  }
  return result;
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function calcLinePositions(
  lines: string[],
  startLine: number,
  endLine: number,
  contentLength: number,
): { start: number; end: number } {
  const start = lines.slice(0, startLine).reduce((sum, l) => sum + l.length + 1, 0);
  const end = Math.min(contentLength, lines.slice(0, endLine).reduce((sum, l) => sum + l.length + 1, 0) - 1);
  return { start, end };
}

function findNormalizedMatches(
  content: string,
  contentLines: string[],
  contentNormalizedLines: string[],
  patternNormalized: string,
): Array<{ start: number; end: number }> {
  const patternLines = patternNormalized.split("\n");
  const matches: Array<{ start: number; end: number }> = [];

  for (let i = 0; i <= contentNormalizedLines.length - patternLines.length; i++) {
    const block = contentNormalizedLines.slice(i, i + patternLines.length).join("\n");
    if (block === patternNormalized) {
      const { start, end } = calcLinePositions(contentLines, i, i + patternLines.length, content.length);
      matches.push({ start, end });
    }
  }
  return matches;
}

function mapNormalizedPositions(
  original: string,
  normalized: string,
  normMatches: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (normMatches.length === 0) return [];

  // Build character mapping
  const origToNorm: number[] = [];
  let oi = 0;
  let ni = 0;
  while (oi < original.length && ni < normalized.length) {
    if (original[oi] === normalized[ni]) {
      origToNorm.push(ni);
      oi++;
      ni++;
    } else if (/[ \t]/.test(original[oi]) && normalized[ni] === " ") {
      origToNorm.push(ni);
      oi++;
    } else if (/[ \t]/.test(original[oi])) {
      origToNorm.push(ni);
      oi++;
    } else {
      origToNorm.push(ni);
      oi++;
    }
  }
  while (oi < original.length) { origToNorm.push(normalized.length); oi++; }

  // Invert mapping
  const normToOrigStart: Record<number, number> = {};
  const normToOrigEnd: Record<number, number> = {};
  for (let op = 0; op < origToNorm.length; op++) {
    const np = origToNorm[op]!;
    if (!(np in normToOrigStart)) normToOrigStart[np] = op;
    normToOrigEnd[np] = op;
  }

  return normMatches.map(({ start: ns, end: ne }) => {
    const origStart = ns in normToOrigStart ? normToOrigStart[ns]! : 0;
    const origEnd = (ne - 1) in normToOrigEnd ? normToOrigEnd[ne - 1]! + 1 : origStart + (ne - ns);
    return { start: origStart, end: Math.min(origEnd, original.length) };
  });
}

// ==================== 候補提示 ====================

/** 類似行を検索して候補提示 */
export function findClosestLines(
  oldString: string,
  content: string,
  contextLines = 2,
  maxResults = 3,
): string {
  const oldLines = oldString.split("\n").filter((l) => l.trim());
  const contentLines = content.split("\n");
  if (oldLines.length === 0 || contentLines.length === 0) return "";

  const anchor = oldLines[0]!.trim();
  if (!anchor) return "";

  const scored: Array<[number, number]> = [];
  for (let i = 0; i < contentLines.length; i++) {
    const stripped = contentLines[i]!.trim();
    if (!stripped) continue;
    const sim = computeSimilarity(anchor, stripped);
    if (sim > 0.3) scored.push([sim, i]);
  }

  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, maxResults);
  if (top.length === 0) return "";

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [, lineIdx] of top) {
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = contentLines.slice(start, end).map((l, j) => `${start + j + 1}| ${l}`).join("\n");
    parts.push(snippet);
  }

  return parts.length > 0 ? "\n\nDid you mean one of these sections?\n" + parts.join("\n---\n") : "";
}
