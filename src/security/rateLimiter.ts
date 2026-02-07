export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  blockDurationMs: number;
  maxViolationsBeforeBlock: number;
  maxConcurrentRequests: number;
}

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  slidingWindowCount: number;
  violations: number;
  lastViolation: number;
  blockedUntil?: number;
  requestTimestamps: number[];
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remaining?: number;
  retryAfter?: number;
}

export interface RateLimitStats {
  jid: string;
  count: number;
  windowStart: number;
  violations: number;
  blockedUntil?: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60000,        // 1 minute window
  maxRequests: 10,         // Max requests per window
  blockDurationMs: 300000, // 5 minute block
  maxViolationsBeforeBlock: 3,
  maxConcurrentRequests: 5
};

export class AdvancedRateLimiter {
  private config: RateLimitConfig;
  private limits: Map<string, RateLimitEntry> = new Map();
  private ipLimits: Map<string, RateLimitEntry> = new Map();
  private blockedIdentifiers: Set<string> = new Set();

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  check(identifier: string, ip?: string): RateLimitResult {
    const now = Date.now();

    // Check if blocked
    if (this.isBlocked(identifier)) {
      const blockedUntil = this.getBlockExpiry(identifier);
      return {
        allowed: false,
        reason: `Temporarily blocked. Retry after ${new Date(blockedUntil!).toISOString()}`,
        retryAfter: blockedUntil ? Math.ceil((blockedUntil - now) / 1000) : 300
      };
    }

    // Check IP-based limit first (more restrictive)
    if (ip) {
      const ipResult = this.checkLimit(ip, this.ipLimits, now);
      if (!ipResult.allowed) {
        return ipResult;
      }
    }

    // Check JID-based limit
    return this.checkLimit(identifier, this.limits, now);
  }

  private checkLimit(identifier: string, storage: Map<string, RateLimitEntry>, now: number): RateLimitResult {
    let entry = storage.get(identifier);

    // Clean up expired entries
    if (entry && now - entry.windowStart > this.config.windowMs * 2) {
      storage.delete(identifier);
      entry = undefined;
    }

    if (!entry) {
      entry = {
        count: 1,
        windowStart: now,
        slidingWindowCount: 1,
        violations: 0,
        lastViolation: 0,
        requestTimestamps: [now]
      };
      storage.set(identifier, entry);
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1
      };
    }

    // Sliding window algorithm
    const windowStart = now - this.config.windowMs;
    entry.requestTimestamps = entry.requestTimestamps.filter(ts => ts > windowStart);
    entry.slidingWindowCount = entry.requestTimestamps.length;

    if (entry.slidingWindowCount >= this.config.maxRequests) {
      entry.violations++;
      entry.lastViolation = now;
      storage.set(identifier, entry);

      if (entry.violations >= this.config.maxViolationsBeforeBlock) {
        this.blockIdentifier(identifier, now);
        return {
          allowed: false,
          reason: 'Rate limit exceeded repeatedly. Temporarily blocked.',
          retryAfter: Math.ceil(this.config.blockDurationMs / 1000)
        };
      }

      return {
        allowed: false,
        reason: `Rate limit exceeded (${entry.slidingWindowCount}/${this.config.maxRequests} requests per minute)`,
        remaining: 0
      };
    }

    entry.count++;
    entry.requestTimestamps.push(now);
    entry.windowStart = now;
    storage.set(identifier, entry);

    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.slidingWindowCount
    };
  }

  private isBlocked(identifier: string): boolean {
    const entry = this.limits.get(identifier);
    if (!entry || !entry.blockedUntil) {
      return false;
    }
    return Date.now() < entry.blockedUntil;
  }

  private getBlockExpiry(identifier: string): number | undefined {
    const entry = this.limits.get(identifier);
    return entry?.blockedUntil;
  }

  private blockIdentifier(identifier: string, now: number): void {
    const entry = this.limits.get(identifier);
    if (entry) {
      entry.blockedUntil = now + this.config.blockDurationMs;
      this.limits.set(identifier, entry);
      this.blockedIdentifiers.add(identifier);
    }
  }

  unblock(identifier: string): boolean {
    const entry = this.limits.get(identifier);
    if (entry) {
      entry.blockedUntil = undefined;
      entry.violations = 0;
      entry.count = 0;
      entry.slidingWindowCount = 0;
      entry.requestTimestamps = [];
      this.limits.set(identifier, entry);
      this.blockedIdentifiers.delete(identifier);
      return true;
    }
    return false;
  }

  getStats(identifier: string): RateLimitStats | null {
    const entry = this.limits.get(identifier);
    if (!entry) {
      return null;
    }
    return {
      jid: identifier,
      count: entry.count,
      windowStart: entry.windowStart,
      violations: entry.violations,
      blockedUntil: entry.blockedUntil
    };
  }

  getAllStats(): RateLimitStats[] {
    const stats: RateLimitStats[] = [];
    for (const [jid, entry] of this.limits) {
      stats.push({
        jid,
        count: entry.count,
        windowStart: entry.windowStart,
        violations: entry.violations,
        blockedUntil: entry.blockedUntil
      });
    }
    return stats;
  }

  getBlockedIdentifiers(): string[] {
    return Array.from(this.blockedIdentifiers);
  }

  reset(identifier?: string): void {
    if (identifier) {
      this.limits.delete(identifier);
      this.ipLimits.delete(identifier);
      this.blockedIdentifiers.delete(identifier);
    } else {
      this.limits.clear();
      this.ipLimits.clear();
      this.blockedIdentifiers.clear();
    }
  }

  cleanup(): void {
    const now = Date.now();
    const expiry = now - this.config.windowMs * 3;

    for (const [identifier, entry] of this.limits) {
      if (entry.windowStart < expiry) {
        this.limits.delete(identifier);
      }
    }

    for (const [ip, entry] of this.ipLimits) {
      if (entry.windowStart < expiry) {
        this.ipLimits.delete(ip);
      }
    }
  }
}

export function createRateLimiter(config?: Partial<RateLimitConfig>): AdvancedRateLimiter {
  return new AdvancedRateLimiter(config);
}
