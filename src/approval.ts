// ==========================================
// Aikata - 危険コマンド検出（Hermes Agent由来）
// terminal実行前に危険コマンドをチェックしてブロック
// ==========================================

import { logger } from "./utils/logger";

// ==================== 絶対ブロックパターン ====================

/** どうやっても通らない最強ブロック（--yolo不可） */
const HARDLINE_PATTERNS: RegExp[] = [
  // rm -rf /
  /rm\s+(-rf?|--recursive\s+--force)\s+\/\s*$/im,
  /rm\s+(-rf?|--recursive\s+--force)\s+--no-preserve-root/im,
  // mkfs / mke2fs etc.
  /\b(?:mkfs|mke2fs|mkfs\.\w+|fdisk|parted|dd)\b.*\s+\/dev\/(?:sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z])\d*\s/im,
  // dd to raw block device
  /\bdd\b.*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|vd[a-z])\b/im,
  // fork bomb
  /:\(\)\s*\{[^}]*\};\s*:/im,
  /\{:\|:\s*&\};:/im,
  // shutdown / reboot / halt / poweroff
  /^sudo\s+(?:shutdown|reboot|halt|poweroff)/im,
  /^\s*(?:shutdown|reboot|halt|poweroff)\s+(?:-h|-r|-P|now)/im,
  // kill -1 (init)
  /\bkill\s+-[19]\s+1\b/im,
  // chmod -R 000
  /chmod\s+-R\s+0{3,4}\s+\//im,
  // rm -r / (non-force variant)
  /\brm\s+-r\s+\/\s*$/im,
];

// ==================== 承認が必要な危険パターン ====================

const DANGEROUS_PATTERNS: RegExp[] = [
  // chmod 777 / 755 recursive
  /chmod\s+-R?\s+7[0-7][0-7]\s/im,
  /chmod\s+-R?\s+0[0-7][0-7]\s/im,
  // chown 操作
  /\bchown\s+-R/im,
  // sudo -S (stdin password)
  /\bsudo\s+-S/im,
  /\bsudo\s+-s\b/im,
  // curl/wget | sh/bash
  /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh|dash)\b/im,
  /\bbash\s+[<(<]\s*[\s\S]*?(?:curl|wget|http)/im,
  /\bsh\s+-c\s+["'](?:curl|wget|http)/im,
  // system config files overwrite
  />\s*\/etc\//im,
  />>?\s*\/etc\//im,
  /tee\s+\/etc\//im,
  // ssh key overwrite
  />\s*~?\/\.ssh\//im,
  />>?\s*~?\/\.ssh\//im,
  // git force push
  /\bgit\s+push\s+-f/im,
  /\bgit\s+push\s+--force/im,
  // pkill / killall (除く特定パターン)
  /\bpkill\s+-[9f]/im,
  /\bkillall\s+-9/im,
  // find -exec rm
  /\bfind\b.*\b-exec\b.*\brm\b/im,
  // dd (危険引数あり)
  /\bdd\b.*\bif=\/dev\/(?:zero|random|urandom)\b.*\bof=/im,
  // wget -O / curl -o (上書き)
  /\b(?:wget|curl)\b.*-[oO]\s+\//im,
  // rm -rf specific dirs
  /\brm\s+-rf?\s+\/\w+/im,
  // chmod -R 777 on home
  /chmod\s+-R?\s+777\s+~[/\s]/im,
  // apt remove / dpkg -r
  /apt\s+(remove|purge|autoremove)\s/im,
  /dpkg\s+-[rP]\s/im,
  // pip uninstall system packages
  /pip\s+uninstall\s+--\s*$/im,
  // npm uninstall global
  /npm\s+uninstall\s+-g/im,
  // ネットワーク設定変更
  /ip\s+link\s+(set|delete)\s+.*\s+down/im,
  /ifconfig\s+\w+\s+down/im,
  /iptables\s+-[AF]\s/im,
  // docker rm / kill / stop (running containers)
  /docker\s+(rm|kill|stop)\s+[^-]/im,
  /docker\s+system\s+prune/im,
  // systemctl disable / mask
  /systemctl\s+(disable|mask|stop)\s+/im,
  // init / rc.d operations
  /update-rc\.d\s+\w+\s+remove/im,
  /rc-update\s+delete/im,
  // passwd (root)
  /passwd\s+root/im,
  // usermod / groupmod
  /usermod\s+/im,
  /groupmod\s+/im,
  // fsck without -n
  /\bfsck\b(?!\s+-[nN])/im,
  // mount / umount operations
  /\bmount\s+\/dev\//im,
  /\bumount\s+\/dev\//im,
  // crypt for files
  /openssl\s+enc\s+-aes/im,
  /gpg\s+[-\s]*[se]/im,
  // move / rename system files
  /mv\s+\/etc\//im,
  /mv\s+\/bin\//im,
  /mv\s+\/usr\//im,
  // cp overwrite system files
  /cp\s+-[rfR]?\s+\/etc\//im,
  // 環境変数設定
  /export\s+\w+=/im,
  // nohup background
  /nohup\s+/im,
];

// ==================== 正規化 ====================

/** コマンド文字列を正規化（ANSI除去+ヌルバイト除去+Unicode正規化） */
function normalizeCommand(cmd: string): string {
  // ANSI除去
  let s = cmd.replace(/[\x1b\x80-\x9f][\s\S]*?[\x40-\x7e]|[\x00]/g, "");
  // ヌルバイト除去
  s = s.replace(/\x00/g, "");
  // NFKC Unicode正規化
  s = s.normalize("NFKC");
  return s.trim();
}

// ==================== チェック結果 ====================

export interface CommandCheckResult {
  safe: boolean;
  /** "hardline" | "dangerous" | "safe" */
  level: "hardline" | "dangerous" | "safe";
  matchedPattern?: string;
  message?: string;
}

// ==================== セッション承認キャッシュ ====================

/** セッション単位での承認キャッシュ（"once"モード用） */
const sessionAllowed = new Map<string, Set<string>>();

export function resetSessionApprovals(sessionKey?: string): void {
  if (sessionKey) {
    sessionAllowed.delete(sessionKey);
  } else {
    sessionAllowed.clear();
  }
}

// ==================== メインチェック ====================

/**
 * コマンドの危険性をチェック
 * returns: { safe, level, matchedPattern, message }
 */
export function checkCommand(command: string, sessionKey?: string): CommandCheckResult {
  const normalized = normalizeCommand(command);

  // Phase 1: 絶対ブロックパターン
  for (const pattern of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      logger.warn(`絶対ブロック: "${command.slice(0, 80)}" → ${pattern}`);
      return {
        safe: false,
        level: "hardline",
        matchedPattern: pattern.source.slice(0, 100),
        message: "このコマンドはセキュリティ上の理由から実行できません（ハードライン）",
      };
    }
  }

  // Phase 2: 危険パターン（セッション承認キャッシュをチェック）
  const sessionKey_ = sessionKey || "default";
  const allowedSet = sessionAllowed.get(sessionKey_) || new Set();

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      // セッション内で既に承認済みか？
      const patternStr = pattern.source;
      if (allowedSet.has(patternStr)) {
        continue; // 承認済み → スキップ
      }

      logger.warn(`危険コマンド検出: "${command.slice(0, 80)}" → ${pattern}`);
      return {
        safe: false,
        level: "dangerous",
        matchedPattern: pattern.source.slice(0, 100),
        message: `このコマンドは危険な可能性があります:\nパターン: /${pattern.source.slice(0, 60)}/\n実行するには承認が必要です。`,
      };
    }
  }

  return { safe: true, level: "safe" };
}

/**
 * 危険コマンドを承認する（セッション単位）
 */
export function approveCommand(command: string, sessionKey?: string): void {
  const normalized = normalizeCommand(command);
  const sessionKey_ = sessionKey || "default";

  if (!sessionAllowed.has(sessionKey_)) {
    sessionAllowed.set(sessionKey_, new Set());
  }

  // マッチする全パターンを承認
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      sessionAllowed.get(sessionKey_)!.add(pattern.source);
    }
  }
}
