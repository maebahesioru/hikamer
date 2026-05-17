// ==========================================
// Aikata - 簡易ロガー
// ==========================================

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = process.env.LOG_LEVEL
  ? (process.env.LOG_LEVEL as LogLevel)
  : "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function format(level: LogLevel, msg: string): string {
  const prefix = {
    debug: "  ",
    info: "📌",
    warn: "⚠️",
    error: "💀",
  }[level];
  return `${prefix} [${timestamp()}] ${msg}\n`;
}

export const logger = {
  debug(msg: string) {
    if (shouldLog("debug")) process.stderr.write(format("debug", msg));
  },
  info(msg: string) {
    if (shouldLog("info")) process.stderr.write(format("info", msg));
  },
  warn(msg: string) {
    if (shouldLog("warn")) process.stderr.write(format("warn", msg));
  },
  error(msg: string) {
    if (shouldLog("error")) process.stderr.write(format("error", msg));
  },
  tool(name: string, args: Record<string, unknown>) {
    if (shouldLog("debug")) {
      const argsStr = JSON.stringify(args);
      const truncated = argsStr.length > 100 ? argsStr.slice(0, 100) + "…" : argsStr;
      process.stderr.write(format("debug", `🔧 ${name}(${truncated})`));
    }
  },
  iteration(n: number) {
    if (shouldLog("debug")) {
      process.stderr.write(format("debug", `🔄 反復 #${n}`));
    }
  },
};
