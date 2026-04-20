import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { validators } from "../security/validation.js";
import { Config } from "../config.js";
import { log } from "../lib/logger.js";

const SENSITIVE_PATTERNS = [
  /password["']?\s*[:=]\s*["']?[^"']+["']?/gi,
  /password[:\s][^\s,"']+/gi,
  /credential[s]?[:\s][^\s,"']+/gi,
  /api[_-]?key[s]?[:\s][^\s,"']+/gi,
  /xmpp[_-]?password[:\s][^\s,"']+/gi,
  /auth[:\s][^\s,"']+/gi,
];

export function sanitize(message: string): string {
  if (!message || typeof message !== 'string') return '';
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export function sanitizeMeta(meta: any): any {
  if (!meta || typeof meta !== "object") return meta;
  const sanitized: Record<string, any> = {};
  for (const key of Object.keys(meta)) {
    const k = key.toLowerCase();
    if (
      k.includes("password") ||
      k.includes("credential") ||
      k.includes("secret") ||
      k.includes("key")
    ) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof meta[key] === "string") {
      sanitized[key] = sanitize(meta[key]);
    } else {
      sanitized[key] = meta[key];
    }
  }
  return sanitized;
}

export interface DebugLogOptions {
  logDir?: string;
}

let debugLogDir: string | undefined;

export function setDebugLogDir(dir: string | undefined): void {
  debugLogDir = dir;
}

export function debugLog(msg: string): void {
  const sanitizedMsg = sanitize(msg);
  const logFile = debugLogDir
    ? path.join(debugLogDir, 'cli-debug.log')
    : path.join(process.cwd(), 'cli-debug.log');
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${sanitizedMsg}\n`;
  fsp.appendFile(logFile, line).catch(() => {});
}

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export const RATE_LIMIT_MAX_REQUESTS = Config.RATE_LIMIT_MAX_REQUESTS;
export const RATE_LIMIT_WINDOW_MS = Config.RATE_LIMIT_WINDOW_MS;

const rateLimitMap = new Map<string, RateLimitEntry>();

export function checkRateLimit(jid: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(jid);

  if (entry && now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 10) {
    rateLimitMap.delete(jid);
  }

  const fresh = rateLimitMap.get(jid);
  if (!fresh || now - fresh.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(jid, { count: 1, windowStart: now });
    return true;
  }

  if (fresh.count >= RATE_LIMIT_MAX_REQUESTS) {
    log.warn("rate limit hit", { jid, count: fresh.count });
    return false;
  }

  fresh.count++;
  return true;
}

export function clearRateLimitMap(): void {
  rateLimitMap.clear();
}

export function evictStaleRateLimits(): number {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS * 10;
  let evicted = 0;
  for (const [jid, entry] of rateLimitMap.entries()) {
    if (entry.windowStart < cutoff) {
      rateLimitMap.delete(jid);
      evicted++;
    }
  }
  return evicted;
}

export const MAX_FILE_SIZE = Config.MAX_FILE_SIZE;

export interface DownloadFileOptions {
  maxSize?: number;
}

export async function downloadFile(
  url: string,
  tempDir: string,
  options: DownloadFileOptions = {}
): Promise<string> {
  const maxSize = options.maxSize ?? MAX_FILE_SIZE;

  log.debug("download starting", { url });

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Validate URL
  if (!validators.isValidUrl(url)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  let filename = path.basename(pathname) || `file_${Date.now()}.bin`;

  // Sanitize filename using validator
  const safeFilename = validators.sanitizeFilename(filename);
  if (safeFilename !== filename) {
    log.debug("filename sanitized", { original: filename, safe: safeFilename });
    filename = safeFilename;
  }

  // Ensure filename doesn't escape tempDir using validator
  if (!validators.isSafePath(filename, tempDir)) {
    filename = `file_${Date.now()}_${safeFilename}`;
    log.warn("unsafe filename rejected", { filename });
  }

  const filePath = path.join(tempDir, filename);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const fileSize = parseInt(contentLength, 10);
      if (fileSize > maxSize) {
        throw new Error(`File too large: ${fileSize} bytes > ${maxSize} bytes limit`);
      }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxSize) {
      throw new Error(`File too large: ${buffer.byteLength} bytes > ${maxSize} bytes limit`);
    }

    await fs.promises.writeFile(filePath, Buffer.from(buffer));

    log.debug("file downloaded", { size: buffer.byteLength });
    return filePath;
  } catch (err) {
    log.error("File download failed", err);
    throw err;
  }
}

export async function processInboundFiles(
  urls: string[], 
  dataDir: string,
  options: DownloadFileOptions = {}
): Promise<string[]> {
  if (urls.length === 0) return [];

  const tempDir = path.join(dataDir, 'downloads');
  const localPaths: string[] = [];

  for (const url of urls) {
    try {
      const localPath = await downloadFile(url, tempDir, options);
      localPaths.push(localPath);
    } catch (err) {
      log.error("inbound file download failed", { url, error: err });
    }
  }

  return localPaths;
}
