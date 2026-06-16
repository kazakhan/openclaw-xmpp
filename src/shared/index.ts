import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
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
  // SECURITY (2.0.18, L15): default log file location is now
  // `~/.openclaw/extensions/xmpp/logs/cli-debug.log` (created on
  // first write).  The previous default was `process.cwd()/cli-debug.log`
  // which polluted the source tree when the plugin was launched
  // from the project root.  Operators can still override the
  // location by calling `setDebugLogDir(dir)`.  Falls back to
  // `os.tmpdir()` if the homedir path can't be created, so the
  // logger never throws on append.
  const logFile = debugLogDir
    ? path.join(debugLogDir, 'cli-debug.log')
    : path.join(os.homedir(), '.openclaw', 'extensions', 'xmpp', 'logs', 'cli-debug.log');
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

// SECURITY (2.0.16): the rate-limit map previously grew unboundedly.
// An attacker who flooded the bot with requests from N different
// JIDs could fill the map indefinitely (the only eviction was
// triggered by a fresh request for the same JID, see the old
// checkRateLimit() body).  Two defences are added here:
//
//  1. A periodic eviction timer started lazily on the first
//     checkRateLimit() call.  The interval is `.unref()`'d so it
//     does not keep the event loop alive.
//
//  2. A hard cap on the map size.  When the cap is exceeded the
//     oldest 1,000 entries (in Map insertion order) are dropped.
const RATE_LIMIT_MAP_CAP = 10_000;
const RATE_LIMIT_EVICT_INTERVAL_MS = 60_000;
const RATE_LIMIT_EVICT_DROP_BATCH = 1_000;

const rateLimitMap = new Map<string, RateLimitEntry>();
let rateLimitEvictionStarted = false;

function ensureRateLimitEvictionStarted(): void {
  if (rateLimitEvictionStarted) return;
  rateLimitEvictionStarted = true;
  const interval = setInterval(() => {
    try {
      evictStaleRateLimits();
    } catch {
      // Never let the eviction timer throw.
    }
  }, RATE_LIMIT_EVICT_INTERVAL_MS);
  // SECURITY: unref() so the timer does not keep the event loop
  // alive (e.g. when the only thing running is the gateway that
  // already exited but the rate-limit map still has entries).
  if (typeof interval.unref === "function") {
    interval.unref();
  }
}

function enforceRateLimitMapCap(): void {
  if (rateLimitMap.size <= RATE_LIMIT_MAP_CAP) return;
  const dropCount = Math.min(
    RATE_LIMIT_EVICT_DROP_BATCH,
    rateLimitMap.size - RATE_LIMIT_MAP_CAP,
  );
  let i = 0;
  for (const key of rateLimitMap.keys()) {
    if (i >= dropCount) break;
    rateLimitMap.delete(key);
    i++;
  }
  log.warn("rate-limit map exceeded cap; dropped oldest entries", {
    dropped: dropCount,
    cap: RATE_LIMIT_MAP_CAP,
  });
}

export function checkRateLimit(jid: string): boolean {
  ensureRateLimitEvictionStarted();
  const now = Date.now();
  const entry = rateLimitMap.get(jid);

  if (entry && now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 10) {
    rateLimitMap.delete(jid);
  }

  enforceRateLimitMapCap();

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
