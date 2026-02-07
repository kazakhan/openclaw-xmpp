const SENSITIVE_PATTERNS = [
  /password["']?\s*[:=]\s*["']?[^"']+["']?/gi,
  /password[:\s][^\s,"']+/gi,
  /credential[s]?[:\s][^\s,"']+/gi,
  /api[_-]?key[s]?[:\s][^\s,"']+/gi,
  /xmpp[_-]?password[:\s][^\s,"']+/gi,
  /auth[:\s][^\s,"']+/gi,
];

function sanitize(message: string): string {
  if (!message || typeof message !== 'string') return '';
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

function sanitizeMeta(meta: any): any {
  if (!meta || typeof meta !== 'object') return meta;
  const sanitized = { ...meta };
  for (const key in sanitized) {
    if (key.toLowerCase().includes('password') || 
        key.toLowerCase().includes('credential') ||
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('key')) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'string') {
      sanitized[key] = sanitize(sanitized[key]);
    }
  }
  return sanitized;
}

export const secureLog = {
  info(message: string, meta?: any) {
    console.log(`[INFO] ${sanitize(message)}`, sanitizeMeta(meta));
  },
  
  debug(message: string, meta?: any) {
    if (process.env.DEBUG === 'true') {
      console.log(`[DEBUG] ${sanitize(message)}`, sanitizeMeta(meta));
    }
  },
  
  error(message: string, error?: any) {
    console.error(`[ERROR] ${sanitize(message)}`, sanitizeMeta(error));
  },
  
  warn(message: string, meta?: any) {
    console.warn(`[WARN] ${sanitize(message)}`, sanitizeMeta(meta));
  }
};
