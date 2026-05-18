// ==========================================
// Aikata - ANSIターミナルUI
// 出典: claude-pulse (NoobyGains/claude-pulse)
// 10テーマ + 8バースタイル + 5アニメーションモード
// ==========================================

import { logger } from "./utils/logger";

// ==================== ANSI色 ====================

type ANSIColor = string;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",

  // 256色
  color256(code: number): string { return `\x1b[38;5;${code}m`; },
  bg256(code: number): string { return `\x1b[48;5;${code}m`; },
};

// ==================== テーマ（claude-pulse 10 themes） ====================

export interface Theme {
  name: string;
  low: ANSIColor;    // 0-50%
  mid: ANSIColor;    // 50-80%
  high: ANSIColor;   // 80-100%
  accent: ANSIColor;
  bg?: ANSIColor;
}

const THEMES: Theme[] = [
  { name: "default", low: ANSI.green, mid: ANSI.yellow, high: ANSI.red, accent: ANSI.cyan },
  { name: "ocean", low: ANSI.cyan, mid: ANSI.blue, high: ANSI.magenta, accent: ANSI.white },
  { name: "sunset", low: ANSI.yellow, mid: ANSI.magenta, high: ANSI.red, accent: ANSI.color256(208) },
  { name: "mono", low: ANSI.white, mid: ANSI.color256(244), high: ANSI.color256(235), accent: ANSI.bold },
  { name: "neon", low: ANSI.color256(82), mid: ANSI.color256(201), high: ANSI.color256(196), accent: ANSI.color256(51) },
  { name: "pride", low: ANSI.color256(99), mid: ANSI.color256(41), high: ANSI.color256(205), accent: ANSI.color256(226) },
  { name: "frost", low: ANSI.color256(123), mid: ANSI.color256(75), high: ANSI.color256(33), accent: ANSI.color256(195) },
  { name: "ember", low: ANSI.color256(214), mid: ANSI.color256(202), high: ANSI.color256(124), accent: ANSI.color256(220) },
  { name: "candy", low: ANSI.color256(212), mid: ANSI.color256(200), high: ANSI.color256(161), accent: ANSI.color256(225) },
  { name: "rainbow", low: ANSI.color256(196), mid: ANSI.color256(226), high: ANSI.color256(46), accent: ANSI.color256(21) },
];

// ==================== バースタイル（claude-pulse 8 styles） ====================

export type BarStyle = "classic" | "block" | "shade" | "pipe" | "dot" | "square" | "star" | "braille";

const BAR_STYLES: Record<BarStyle, { filled: string; empty: string; gradient?: string[] }> = {
  classic:  { filled: "━", empty: "─" },
  block:    { filled: "█", empty: "░" },
  shade:    { filled: "▓", empty: "▒" },
  pipe:     { filled: "┃", empty: "┆" },
  dot:      { filled: "●", empty: "○" },
  square:   { filled: "■", empty: "□" },
  star:     { filled: "★", empty: "☆" },
  braille:  { filled: "⣿", empty: "⣀", gradient: ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] },
};

// ==================== アニメーションモード（claude-pulse 5 modes） ====================

export type AnimationMode = "off" | "rainbow" | "pulse" | "glow" | "shift";

// ==================== プログレスバー ====================

export interface ProgressbarOptions {
  width?: number;
  theme?: string;
  barStyle?: BarStyle;
  animation?: AnimationMode;
  showPercent?: boolean;
  showLabel?: boolean;
}

const DEFAULT_OPTS: Required<ProgressbarOptions> = {
  width: 20,
  theme: "default",
  barStyle: "block",
  animation: "off",
  showPercent: true,
  showLabel: true,
};

/**
 * プログレスバーを生成
 * claude-pulse: colored progress bars (green→yellow→red)
 */
export function renderProgressBar(
  current: number,
  max: number,
  label?: string,
  options: ProgressbarOptions = {}
): string {
  const opts = { ...DEFAULT_OPTS, ...options };
  const theme = THEMES.find(t => t.name === opts.theme) ?? THEMES[0];
  const barStyle = (opts.barStyle && BAR_STYLES[opts.barStyle]) ?? BAR_STYLES.block;
  const percent = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(percent * opts.width);
  const empty = opts.width - filled;

  // 色選択（閾値ベース）
  const color = percent > 0.8 ? theme.high : percent > 0.5 ? theme.mid : theme.low;

  // バー描画
  const bar = barStyle.gradient
    ? renderGradientBar(filled, empty, barStyle.gradient, opts.width)
    : color + barStyle.filled.repeat(filled) + ANSI.dim + barStyle.empty.repeat(empty) + ANSI.reset;

  // ラベル
  const labelStr = label && opts.showLabel ? ` ${ANSI.dim}${label}${ANSI.reset}` : "";
  const pctStr = opts.showPercent ? ` ${color}${(percent * 100).toFixed(0)}%${ANSI.reset}` : "";

  return `${bar}${pctStr}${labelStr}`;
}

function renderGradientBar(filled: number, empty: number, gradient: string[], width: number): string {
  const parts: string[] = [];
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const gradIdx = Math.floor((i / width) * gradient.length);
      parts.push(ANSI.color256(82 + gradIdx * 20) + gradient[Math.min(gradIdx, gradient.length - 1)] + ANSI.reset);
    } else {
      parts.push(ANSI.dim + gradient[0] + ANSI.reset);
    }
  }
  return parts.join("");
}

// ==================== ステータスバー ====================

export interface StatusBarSegment {
  label: string;
  value: string;
  color?: ANSIColor;
  priority?: number; // 低い＝左に表示
}

/**
 * マルチセグメントステータスバー
 * claude-pulse: widget priority system + reorderable widgets
 */
export function renderStatusBar(segments: StatusBarSegment[], separator: string = " │ "): string {
  const sorted = [...segments]
    .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
    .map(s => {
      const color = s.color ?? ANSI.white;
      return `${color}${s.label}: ${ANSI.bold}${s.value}${ANSI.reset}`;
    });

  return sorted.join(separator);
}

// ==================== テーマ選択 ====================

let currentTheme = THEMES[0];

export function setTheme(name: string): boolean {
  const theme = THEMES.find(t => t.name === name);
  if (!theme) return false;
  currentTheme = theme;
  logger.info(`[ANSITerminal] テーマ変更: ${name}`);
  return true;
}

export function getThemeNames(): string[] {
  return THEMES.map(t => t.name);
}

export function getBarStyleNames(): BarStyle[] {
  return Object.keys(BAR_STYLES) as BarStyle[];
}

export { THEMES, ANSI, BAR_STYLES };
