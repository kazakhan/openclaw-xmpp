import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface AuditEvent {
  id: string;
  timestamp: number;
  type: AuditEventType;
  userId: string;
  source: string;
  action: string;
  result: 'success' | 'failure';
  metadata?: Record<string, any>;
  ipAddress?: string;
}

export enum AuditEventType {
  // Authentication
  LOGIN_SUCCESS = 'auth:login_success',
  LOGIN_FAILURE = 'auth:login_failure',

  // Authorization
  PERMISSION_GRANTED = 'auth:permission_granted',
  PERMISSION_DENIED = 'auth:permission_denied',

  // Commands
  COMMAND_EXECUTED = 'cmd:executed',
  COMMAND_FAILED = 'cmd:failed',

  // File Operations
  FILE_UPLOAD = 'file:upload',
  FILE_DOWNLOAD = 'file:download',
  FILE_DELETE = 'file:delete',

  // Security
  SUSPICIOUS_ACTIVITY = 'security:suspicious',
  RATE_LIMIT_EXCEEDED = 'security:rate_limit',
  INVALID_INPUT = 'security:invalid_input',
  QUOTA_EXCEEDED = 'security:quota_exceeded',

  // Admin Actions
  ADMIN_ADDED = 'admin:added',
  ADMIN_REMOVED = 'admin:removed',
  CONFIG_CHANGED = 'config:changed',
  SUBSCRIPTION_APPROVED = 'admin:subscription_approved',
  SUBSCRIPTION_DENIED = 'admin:subscription_denied',
  INVITE_APPROVED = 'admin:invite_approved',
  INVITE_DENIED = 'admin:invite_denied',

  // Connections
  XMPP_CONNECTED = 'conn:xmpp_connected',
  XMPP_DISCONNECTED = 'conn:xmpp_disconnected',
  ROOM_JOINED = 'conn:room_joined',
  ROOM_LEFT = 'conn:room_left',

  // Data
  MESSAGE_SENT = 'data:message_sent',
  MESSAGE_RECEIVED = 'data:message_received'
}

export interface AuditFilter {
  startDate?: number;
  endDate?: number;
  types?: AuditEventType[];
  userId?: string;
  result?: 'success' | 'failure';
  limit?: number;
  offset?: number;
}

export interface AuditConfig {
  logDir: string;
  maxLogFiles: number;
  maxLogSizeBytes: number;
  retentionDays: number;
  enabled: boolean;
  sensitiveFields: string[];
}

const DEFAULT_CONFIG: AuditConfig = {
  logDir: './logs',
  maxLogFiles: 10,
  maxLogSizeBytes: 10 * 1024 * 1024, // 10MB
  retentionDays: 30,
  enabled: true,
  sensitiveFields: ['password', 'token', 'apiKey', 'credential', 'secret', 'auth']
};

export class AuditLogger {
  private config: AuditConfig;
  private currentLogFile: string;
  private currentLogSize: number = 0;
  private eventBuffer: AuditEvent[] = [];
  private bufferFlushInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<AuditConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }

    this.currentLogFile = this.getLogFilePath();

    this.bufferFlushInterval = setInterval(() => {
      this.flushBuffer();
    }, 5000);
  }

  private getLogFilePath(): string {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0];
    return path.join(this.config.logDir, `audit-${dateStr}.json`);
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  private sanitizeMetadata(metadata: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!metadata) return undefined;

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const lowerKey = key.toLowerCase();

      if (this.config.sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        sanitized[key] = value.substring(0, 1000);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): void {
    if (!this.config.enabled) return;

    const fullEvent: AuditEvent = {
      ...event,
      id: this.generateId(),
      timestamp: Date.now(),
      metadata: this.sanitizeMetadata(event.metadata)
    };

    this.eventBuffer.push(fullEvent);

    if (this.eventBuffer.length >= 100) {
      this.flushBuffer();
    }
  }

  private writeToFile(event: AuditEvent): void {
    try {
      const line = JSON.stringify(event) + '\n';
      const lineBytes = Buffer.byteLength(line);

      if (this.currentLogSize + lineBytes > this.config.maxLogSizeBytes) {
        this.rotateLogs();
      }

      fs.appendFileSync(this.currentLogFile, line);
      this.currentLogSize += lineBytes;
    } catch (err) {
      console.error('Failed to write audit event:', err);
    }
  }

  private rotateLogs(): void {
    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.config.logDir, f),
          mtime: fs.statSync(path.join(this.config.logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime);

      for (let i = this.config.maxLogFiles - 1; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].path);
        } catch {
        }
      }

      this.currentLogFile = this.getLogFilePath();
      this.currentLogSize = 0;
    } catch (err) {
      console.error('Failed to rotate audit logs:', err);
    }
  }

  flushBuffer(): void {
    if (this.eventBuffer.length === 0) return;

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    for (const event of events) {
      this.writeToFile(event);
    }
  }

  private readLogFile(filePath: string): AuditEvent[] {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  private getAllLogFiles(): string[] {
    try {
      return fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.json'))
        .map(f => path.join(this.config.logDir, f))
        .sort((a, b) => {
          return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime();
        });
    } catch {
      return [];
    }
  }

  async query(filter: AuditFilter): Promise<AuditEvent[]> {
    const results: AuditEvent[] = [];

    for (const filePath of this.getAllLogFiles()) {
      const events = this.readLogFile(filePath);

      for (const event of events) {
        if (filter.startDate && event.timestamp < filter.startDate) continue;
        if (filter.endDate && event.timestamp > filter.endDate) continue;
        if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) continue;
        if (filter.userId && event.userId !== filter.userId) continue;
        if (filter.result && event.result !== filter.result) continue;

        results.push(event);

        if (filter.limit && results.length >= filter.limit) {
          return results.slice(0, filter.limit);
        }
      }

      if (filter.limit && results.length >= filter.limit) {
        break;
      }
    }

    if (filter.offset) {
      return results.slice(filter.offset);
    }

    return results;
  }

  async export(startDate: number, endDate?: number): Promise<string> {
    const filter: AuditFilter = {
      startDate,
      endDate: endDate || Date.now(),
      limit: 10000
    };

    const events = await this.query(filter);

    return JSON.stringify({
      exportDate: new Date().toISOString(),
      startDate,
      endDate: endDate || Date.now(),
      totalEvents: events.length,
      events
    }, null, 2);
  }

  cleanup(): number {
    try {
      const cutoff = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
      let deleted = 0;

      for (const filePath of this.getAllLogFiles()) {
        const stats = fs.statSync(filePath);
        if (stats.mtime.getTime() < cutoff) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      }

      return deleted;
    } catch {
      return 0;
    }
  }

  getStats(): {
    enabled: boolean;
    logDir: string;
    currentLogSize: number;
    bufferSize: number;
    retentionDays: number;
  } {
    return {
      enabled: this.config.enabled,
      logDir: this.config.logDir,
      currentLogSize: this.currentLogSize,
      bufferSize: this.eventBuffer.length,
      retentionDays: this.config.retentionDays
    };
  }

  destroy(): void {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
    this.flushBuffer();
  }
}

export function createAuditLogger(config?: Partial<AuditConfig>): AuditLogger {
  return new AuditLogger(config);
}

export const auditLogger = createAuditLogger();

export function logAuditEvent(
  type: AuditEventType,
  userId: string,
  action: string,
  result: 'success' | 'failure',
  options: {
    source?: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
  } = {}
): void {
  auditLogger.log({
    type,
    userId,
    action,
    result,
    source: options.source || 'xmpp-plugin',
    metadata: options.metadata,
    ipAddress: options.ipAddress
  });
}
