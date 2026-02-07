const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const URL_REGEX = /^https?:\/\/[^\s<>"]+$/;
const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export const validators = {
  isValidJid(jid: string): boolean {
    if (!jid || typeof jid !== 'string') return false;
    const bareJid = jid.split('/')[0].trim();
    if (bareJid.length > 3072) return false;
    return EMAIL_REGEX.test(bareJid);
  },

  sanitizeFilename(filename: string): string {
    if (!filename || typeof filename !== 'string') return 'unknown';
    const sanitized = filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.\./g, '_')
      .substring(0, 255);
    return sanitized || 'unknown';
  },

  isSafePath(filePath: string, baseDir: string): boolean {
    if (!filePath || !baseDir || typeof filePath !== 'string' || typeof baseDir !== 'string') return false;
    try {
      const resolved = path.resolve(baseDir, filePath);
      return resolved.startsWith(path.resolve(baseDir));
    } catch {
      return false;
    }
  },

  sanitizeForHtml(input: string): string {
    if (!input || typeof input !== 'string') return '';
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  sanitizeMessage(input: string): string {
    if (!input || typeof input !== 'string') return '';
    return input
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/g, '')
      .replace(/[\r\n]{2,}/g, '\n\n')
      .substring(0, 10000);
  },

  isValidUrl(url: string): boolean {
    if (!url || typeof url !== 'string' || url.length > 2048) return false;
    return URL_REGEX.test(url);
  },

  sanitizeJid(jid: string): string {
    if (!jid || typeof jid !== 'string') return '';
    return jid.split('/')[0].trim().toLowerCase();
  }
};

import path from "path";
