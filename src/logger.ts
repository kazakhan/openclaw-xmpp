import fs from "fs";
import path from "path";

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export function createLogger(prefix: string, level: LogLevel = 'info'): Logger {
  const logFile = path.join(process.cwd(), 'cli-debug.log');
  
  const shouldLog = (logLevel: LogLevel): boolean => {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    return levels[logLevel] >= levels[level];
  };
  
  const writeToFile = (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${prefix}] ${msg}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch (err) {
      console.error('Failed to write debug log:', err);
    }
  };
  
  return {
    debug: (...args: any[]) => {
      if (shouldLog('debug')) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.log(`[DEBUG] ${msg}`);
        writeToFile(msg);
      }
    },
    info: (...args: any[]) => {
      if (shouldLog('info')) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.log(`[INFO] ${msg}`);
        writeToFile(msg);
      }
    },
    warn: (...args: any[]) => {
      if (shouldLog('warn')) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.warn(`[WARN] ${msg}`);
        writeToFile(msg);
      }
    },
    error: (...args: any[]) => {
      if (shouldLog('error')) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.error(`[ERROR] ${msg}`);
        writeToFile(msg);
      }
    }
  };
}

export function createDebugLog(): (msg: string) => void {
  const logFile = path.join(process.cwd(), 'cli-debug.log');
  return (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch (err) {
      console.error('Failed to write debug log:', err);
    }
  };
}
