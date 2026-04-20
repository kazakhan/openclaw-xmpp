import { sanitize, sanitizeMeta } from "../shared/index.js";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
type Level = keyof typeof LEVELS;

let currentLevelNum: number =
  LEVELS[(process.env.XMPP_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export function setLogLevel(level: string): void {
  const n = LEVELS[level as Level];
  if (n !== undefined) currentLevelNum = n;
}

export function getLogLevel(): string {
  for (const [name, val] of Object.entries(LEVELS)) {
    if (val === currentLevelNum) return name;
  }
  return "info";
}

function shouldLog(level: Level): boolean {
  return currentLevelNum >= LEVELS[level];
}

function redactMessage(msg: string): string {
  return sanitize(msg);
}

export const log = {
  debug(message: string, meta?: any): void {
    if (!shouldLog("debug")) return;
    console.log(`[DEBUG] ${redactMessage(message)}`, meta !== undefined ? sanitizeMeta(meta) : "");
  },

  info(message: string, meta?: any): void {
    if (!shouldLog("info")) return;
    console.log(`[INFO] ${redactMessage(message)}`, meta !== undefined ? sanitizeMeta(meta) : "");
  },

  warn(message: string, meta?: any): void {
    if (!shouldLog("warn")) return;
    console.warn(`[WARN] ${redactMessage(message)}`, meta !== undefined ? sanitizeMeta(meta) : "");
  },

  error(message: string, error?: any): void {
    if (!shouldLog("error")) return;
    console.error(`[ERROR] ${redactMessage(message)}`, error !== undefined ? sanitizeMeta(error) : "");
  },
};

export function child(prefix: string): typeof log {
  return {
    debug(message: string, meta?: any): void { log.debug(`[${prefix}] ${message}`, meta); },
    info(message: string, meta?: any): void { log.info(`[${prefix}] ${message}`, meta); },
    warn(message: string, meta?: any): void { log.warn(`[${prefix}] ${message}`, meta); },
    error(message: string, error?: any): void { log.error(`[${prefix}] ${message}`, error); },
  };
}
