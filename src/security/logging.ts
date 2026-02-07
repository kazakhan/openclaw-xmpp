const SENSITIVE_PATTERNS = [
  /password["']?\s*[:=]\s*["']?([^"'\s]+)["']?/gi,
  /password[:\s][^\s,"']+/gi,
  /credential[s]?[:\s][^\s,"']+/gi,
  /api[_-]?key[s]?[:\s][^\s,"']+/gi,
  /token["']?\s*[:=]\s*["']?([^"'\s]+)["']?/gi,
  /auth["']?\s*[:=]\s*["']?([^"'\s]+)["']?/gi,
  /secret["']?\s*[:=]\s*["']?([^"'\s]+)["']?/gi,
];

const JID_PATTERN = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export interface LogOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  redactJids?: boolean;
  redactIps?: boolean;
  maxLength?: number;
}

const DEFAULT_OPTIONS: LogOptions = {
  level: 'info',
  redactJids: true,
  redactIps: true,
  maxLength: 10000,
};

function sanitizeMessage(message: string): string {
  let sanitized = message;

  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

function sanitizeMeta(meta: any): string {
  if (!meta || typeof meta !== 'object') {
    return String(meta);
  }

  const clone = { ...meta };

  const sensitiveKeys = [
    'password', 'credentials', 'apiKey', 'token', 'auth', 'secret',
    'pwd', 'passwd', 'pass', 'key', 'privateKey', 'accessToken'
  ];

  for (const key of Object.keys(clone)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      clone[key] = '[REDACTED]';
    }
  }

  return JSON.stringify(clone);
}

export const secureLog = {
  debug(message: string, meta?: any, options?: LogOptions): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sanitizedMsg = sanitizeMessage(message);
    const sanitizedMeta = meta !== undefined ? sanitizeMeta(meta) : '';

    if (process.env.DEBUG === 'true' || process.env.DEBUG_XMPP === 'true') {
      const prefix = `[DEBUG]`;
      if (sanitizedMeta) {
        console.log(`${prefix} ${sanitizedMsg}`, sanitizedMeta);
      } else {
        console.log(`${prefix} ${sanitizedMsg}`);
      }
    }
  },

  info(message: string, meta?: any, options?: LogOptions): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sanitizedMsg = sanitizeMessage(message);
    const sanitizedMeta = meta !== undefined ? sanitizeMeta(meta) : '';

    const prefix = `[INFO]`;
    if (sanitizedMeta) {
      console.log(`${prefix} ${sanitizedMsg}`, sanitizedMeta);
    } else {
      console.log(`${prefix} ${sanitizedMsg}`);
    }
  },

  warn(message: string, meta?: any, options?: LogOptions): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sanitizedMsg = sanitizeMessage(message);
    const sanitizedMeta = meta !== undefined ? sanitizeMeta(meta) : '';

    const prefix = `[WARN]`;
    if (sanitizedMeta) {
      console.warn(`${prefix} ${sanitizedMsg}`, sanitizedMeta);
    } else {
      console.warn(`${prefix} ${sanitizedMsg}`);
    }
  },

  error(message: string, error?: any, options?: LogOptions): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sanitizedMsg = sanitizeMessage(message);

    let errorInfo = '';
    if (error) {
      const sanitizedError = sanitizeMessage(String(error));
      errorInfo = sanitizedError;
    }

    const prefix = `[ERROR]`;
    if (errorInfo) {
      console.error(`${prefix} ${sanitizedMsg}`, errorInfo);
    } else {
      console.error(`${prefix} ${sanitizedMsg}`);
    }
  },

  security(message: string, details?: any): void {
    const sanitizedMsg = sanitizeMessage(message);
    const sanitizedDetails = details ? sanitizeMeta(details) : '';

    const prefix = `[SECURITY]`;
    if (sanitizedDetails) {
      console.log(`${prefix} ${sanitizedMsg}`, sanitizedDetails);
    } else {
      console.log(`${prefix} ${sanitizedMsg}`);
    }
  },

  audit(event: string, data?: any): void {
    const sanitizedEvent = sanitizeMessage(event);
    const sanitizedData = data ? sanitizeMeta(data) : '';

    const timestamp = new Date().toISOString();
    const prefix = `[AUDIT]`;
    if (sanitizedData) {
      console.log(`${prefix} [${timestamp}] ${sanitizedEvent}`, sanitizedData);
    } else {
      console.log(`${prefix} [${timestamp}] ${sanitizedEvent}`);
    }
  },

  redactJid(jid: string): string {
    if (!jid || !DEFAULT_OPTIONS.redactJids) {
      return jid;
    }
    return jid.replace(JID_PATTERN, '[JID]');
  },

  redactIp(ip: string): string {
    if (!ip || !DEFAULT_OPTIONS.redactIps) {
      return ip;
    }
    return ip.replace(IP_PATTERN, '[IP]');
  }
};
