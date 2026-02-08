import fs from "fs";
import path from "path";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { MessageStore } from "./src/messageStore.js";
import { validators } from "./src/security/validation.js";
import { secureLog } from "./src/security/logging.js";
import { decryptPasswordFromConfig } from "./src/security/encryption.js";
import { VCard } from "./src/vcard.js";
import { Contacts } from "./src/contacts.js";
import { register, xmppClients, contactsStore, addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages, messageQueue } from "./src/register.js";
import { registerXmppCli } from "./src/commands.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const debugLog = (msg: string) => {
  const sanitizedMsg = sanitize(msg);
  const logFile = path.join(__dirname, 'cli-debug.log');
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${sanitizedMsg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (err) {
  }
};

function sanitize(message: string): string {
  if (!message || typeof message !== 'string') return '';
  let sanitized = message;
  const SENSITIVE_PATTERNS = [
    /password["']?\s*[:=]\s*["']?[^"']+["']?/gi,
    /password[:\s][^\s,"']+/gi,
    /credential[s]?[:\s][^\s,"']+/gi,
    /api[_-]?key[s]?[:\s][^\s,"']+/gi,
  ];
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

debugLog(`XMPP plugin loading at ${new Date().toISOString()}`);

export { VCard, Contacts };
export { register, xmppClients, contactsStore };
export { addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages, messageQueue };
export { registerXmppCli, MessageStore, validators, secureLog, decryptPasswordFromConfig, debugLog, sanitize };
