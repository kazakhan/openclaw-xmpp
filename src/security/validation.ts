import path from "path";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

const JID_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

const SAFE_URL_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export const validators = {
  isValidJid(jid: string): ValidationResult {
    if (!jid || typeof jid !== 'string') {
      return { valid: false, error: 'JID must be a non-empty string' };
    }

    const bareJid = jid.split('/')[0];

    if (bareJid.length > 3072) {
      return { valid: false, error: 'JID exceeds maximum length' };
    }

    if (!JID_REGEX.test(bareJid)) {
      return { valid: false, error: 'Invalid JID format' };
    }

    return { valid: true };
  },

  sanitizeJid(jid: string): ValidationResult {
    if (!jid || typeof jid !== 'string') {
      return { valid: false, error: 'JID must be a non-empty string' };
    }

    const bareJid = jid.split('/')[0];
    const resource = jid.includes('/') ? '/' + jid.split('/')[1] : '';

    const sanitizedBare = bareJid.toLowerCase().trim();

    if (!JID_REGEX.test(sanitizedBare)) {
      return { valid: false, error: 'Invalid JID format after sanitization' };
    }

    return { valid: true, sanitized: sanitizedBare + resource };
  },

  sanitizeFilename(filename: string): ValidationResult {
    if (!filename || typeof filename !== 'string') {
      return { valid: false, error: 'Filename must be a non-empty string' };
    }

    if (filename.length > 255) {
      return { valid: false, error: 'Filename exceeds maximum length of 255 characters' };
    }

    const basename = path.basename(filename);
    if (basename.length === 0) {
      return { valid: false, error: 'Filename cannot be empty after path resolution' };
    }

    let sanitized = basename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/^_+/g, '')
      .replace(/_+$/g, '');

    if (sanitized.length === 0) {
      sanitized = 'file_' + Date.now();
    }

    return {
      valid: true,
      sanitized
    };
  },

  isSafePath(filePath: string, baseDir: string): ValidationResult {
    if (!filePath || typeof filePath !== 'string') {
      return { valid: false, error: 'Path must be a non-empty string' };
    }

    if (!baseDir || typeof baseDir !== 'string') {
      return { valid: false, error: 'Base directory must be a non-empty string' };
    }

    try {
      const resolved = path.resolve(baseDir, filePath);
      const resolvedBase = path.resolve(baseDir);

      if (!resolved.startsWith(resolvedBase)) {
        return { valid: false, error: 'Path traversal attempt detected' };
      }

      const parentDir = path.dirname(resolved);
      if (!parentDir.startsWith(resolvedBase)) {
        return { valid: false, error: 'Path escapes base directory' };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: 'Invalid path' };
    }
  },

  sanitizeForXmpp(input: string): ValidationResult {
    if (!input || typeof input !== 'string') {
      return { valid: false, error: 'Input must be a non-empty string' };
    }

    if (input.length > 10000) {
      return { valid: false, error: 'Input exceeds maximum length' };
    }

    let sanitized = input
      .replace(CONTROL_CHARS_REGEX, '')
      .replace(/\0/g, '');

    return {
      valid: true,
      sanitized
    };
  },

  sanitizeMessageBody(body: string): ValidationResult {
    if (!body || typeof body !== 'string') {
      return { valid: false, error: 'Message body must be a non-empty string' };
    }

    if (body.length > 50000) {
      return { valid: false, error: 'Message body exceeds maximum length' };
    }

    let sanitized = body
      .replace(CONTROL_CHARS_REGEX, '')
      .replace(/\0/g, '');

    return {
      valid: true,
      sanitized: sanitized.substring(0, 50000)
    };
  },

  isValidUrl(url: string): ValidationResult {
    if (!url || typeof url !== 'string') {
      return { valid: false, error: 'URL must be a non-empty string' };
    }

    if (url.length > 2048) {
      return { valid: false, error: 'URL exceeds maximum length' };
    }

    try {
      const parsed = new URL(url);

      if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(parsed.protocol)) {
        return { valid: false, error: 'Invalid URL protocol' };
      }

      const localhostPatterns = ['localhost', '127.0.0.1', '::1'];
      if (localhostPatterns.includes(parsed.hostname)) {
        return { valid: false, error: 'Localhost URLs are not allowed' };
      }

      const privateIpPatterns = [
        /^10\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,
        /^::1$/,
        /^fe80:/,
        /^fc00:/
      ];
      if (privateIpPatterns.some(pattern => pattern.test(parsed.hostname))) {
        return { valid: false, error: 'Private IP addresses are not allowed' };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: 'Invalid URL format' };
    }
  },

  sanitizeRoomName(room: string): ValidationResult {
    if (!room || typeof room !== 'string') {
      return { valid: false, error: 'Room name must be a non-empty string' };
    }

    let sanitized = room.trim();

    if (sanitized.includes('@')) {
      const parts = sanitized.split('@');
      const roomName = parts[0];
      const server = parts[1];

      if (!JID_REGEX.test(server)) {
        return { valid: false, error: 'Invalid room server part' };
      }

      sanitized = roomName + '@' + server.toLowerCase();
    } else {
      const roomName = sanitized
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 100);

      if (roomName.length === 0) {
        return { valid: false, error: 'Invalid room name' };
      }

      sanitized = roomName;
    }

    return {
      valid: true,
      sanitized
    };
  },

  sanitizeNickname(nick: string): ValidationResult {
    if (!nick || typeof nick !== 'string') {
      return { valid: false, error: 'Nickname must be a non-empty string' };
    }

    if (nick.length > 100) {
      return { valid: false, error: 'Nickname exceeds maximum length' };
    }

    let sanitized = nick
      .replace(CONTROL_CHARS_REGEX, '')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .trim()
      .substring(0, 100);

    if (sanitized.length === 0) {
      sanitized = 'user';
    }

    return {
      valid: true,
      sanitized
    };
  },

  isValidFileSize(size: number, maxBytes: number = 10 * 1024 * 1024): ValidationResult {
    if (typeof size !== 'number' || isNaN(size)) {
      return { valid: false, error: 'File size must be a valid number' };
    }

    if (size < 0) {
      return { valid: false, error: 'File size cannot be negative' };
    }

    if (size > maxBytes) {
      return {
        valid: false,
        error: `File too large: ${(size / 1024 / 1024).toFixed(2)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit`
      };
    }

    return { valid: true };
  },

  sanitizeForHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};
