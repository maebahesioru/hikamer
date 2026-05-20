// ==========================================
// Hikamer - ANSIエスケープ除去（Hermes Agent由来）
// ターミナル出力から制御コードを除去
// ==========================================

/** ANSIエスケープシーケンス有無の簡易チェック */
const HAS_ESCAPE = /[\x1b\x80-\x9f]/;

/** ANSIエスケープシーケンス除去 */
const ANSI_RE = new RegExp(
  [
    // CSI (Control Sequence Introducer): ESC [ params... intermediates... final
    '\x1b\\[ [\\x30-\\x3f]* [\\x20-\\x2f]* [\\x40-\\x7e]',
    // OSC (Operating System Command): ESC ] ... (ST: \x07 or ESC \)
    '\x1b\\] [\\s\\S]*? (?:\\x07|\x1b\\\\)',
    // DCS/SOS/PM/APC: ESC P/X/^/_ ... ESC \
    '\x1b[PX^_] [\\s\\S]*? \x1b\\\\',
    // nF (intermediate/final without parameter): ESC space... final
    '\x1b [\\x20-\\x2f]+ [\\x30-\\x7e]',
    // Fp/Fe/Fs: ESC single final byte
    '\x1b [\\x30-\\x7e]',
    // 8-bit C1 CSI
    '\\x9b [\\x30-\\x3f]* [\\x20-\\x2f]* [\\x40-\\x7e]',
    // 8-bit C1 OSC
    '\\x9d [\\s\\S]*? (?:\\x07|\\x9c)',
    // その他のC1制御文字 (8-bit)
    '[\\x80-\\x9a\\x9c\\x9e\\x9f]',
  ].map(r => r.replace(/\s+/g, '')).join('|'),
  'gs'
);

/**
 * ANSIエスケープシーケンスを除去
 * 高速パス: ESC/C1バイトがなければ即時return
 */
export function stripAnsi(text: string): string {
  if (!HAS_ESCAPE.test(text)) return text;
  return text.replace(ANSI_RE, "");
}

/**
 * ターミナル出力をLLMに渡す前にクリーニング
 * ANSI除去 + 超長行トリミング
 */
export function cleanTerminalOutput(text: string, maxLineLen = 5000): string {
  let cleaned = stripAnsi(text);
  // 超長行をトリミング
  const lines = cleaned.split("\n");
  const trimmed = lines.map(line => {
    if (line.length > maxLineLen) {
      return line.slice(0, maxLineLen) + `…[${line.length - maxLineLen}文字省略]`;
    }
    return line;
  });
  return trimmed.join("\n");
}
