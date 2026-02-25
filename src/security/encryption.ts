import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const DEFAULT_SALT = 'xmpp-plugin-salt-v1';
const KEY_DERIVATION_ITERATIONS = 100000;
const SALT_FILE_NAME = '.xmpp-plugin-salt';

function getInstallationSalt(dataDir?: string): string {
  if (dataDir) {
    const saltFilePath = path.join(dataDir, SALT_FILE_NAME);
    if (fs.existsSync(saltFilePath)) {
      try {
        return fs.readFileSync(saltFilePath, 'utf8').trim();
      } catch {
        // Fall through to generate new salt
      }
    }
    const newSalt = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(saltFilePath, newSalt, { mode: 0o600 });
    } catch {
      // If we can't write the file, fall back to default
      return DEFAULT_SALT;
    }
    return newSalt;
  }
  return DEFAULT_SALT;
}

export interface EncryptionResult {
  success: boolean;
  encrypted?: string;
  error?: string;
}

export interface DecryptionResult {
  success: boolean;
  decrypted?: string;
  error?: string;
}

export interface XmppAccountConfig {
  service?: string;
  domain?: string;
  jid?: string;
  password?: string;
  resource?: string;
  encryptionKey?: string;
  encryptionSalt?: string;
  dataDir?: string;
  ftpPort?: number;
}

export class PasswordEncryption {
  private key: Buffer;

  constructor(key: string, salt?: string) {
    const usedSalt = salt || DEFAULT_SALT;
    this.key = crypto.pbkdf2Sync(key, usedSalt, KEY_DERIVATION_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  encrypt(plaintext: string): EncryptionResult {
    if (!plaintext || typeof plaintext !== 'string') {
      return { success: false, error: 'Plaintext must be a non-empty string' };
    }

    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      const result = iv.toString('hex') + authTag.toString('hex') + encrypted;
      return { success: true, encrypted: result };
    } catch (err) {
      return { success: false, error: `Encryption failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
    }
  }

  decrypt(encryptedData: string): DecryptionResult {
    if (!encryptedData || typeof encryptedData !== 'string') {
      return { success: false, error: 'Encrypted data must be a non-empty string' };
    }

    try {
      if (encryptedData.length < (IV_LENGTH + TAG_LENGTH) * 2) {
        return { success: false, error: 'Invalid encrypted data format' };
      }

      const iv = Buffer.from(encryptedData.substring(0, IV_LENGTH * 2), 'hex');
      const authTag = Buffer.from(encryptedData.substring(IV_LENGTH * 2, (IV_LENGTH + TAG_LENGTH) * 2), 'hex');
      const encrypted = encryptedData.substring((IV_LENGTH + TAG_LENGTH) * 2);

      if (encrypted.length === 0) {
        return { success: false, error: 'No encrypted content found' };
      }

      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return { success: true, decrypted };
    } catch (err) {
      return { success: false, error: `Decryption failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
    }
  }
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

export function createEncryptor(key: string, salt?: string): PasswordEncryption {
  return new PasswordEncryption(key, salt);
}

export function getOrCreateEncryptionKey(config: XmppAccountConfig): string {
  if (config.encryptionKey && typeof config.encryptionKey === 'string' && config.encryptionKey.length > 0) {
    return config.encryptionKey;
  }
  const newKey = generateEncryptionKey();
  return newKey;
}

export function getOrCreateEncryptionSalt(config: XmppAccountConfig): string {
  // 1. If salt explicitly set in config, use it
  if (config.encryptionSalt && typeof config.encryptionSalt === 'string' && config.encryptionSalt.length > 0) {
    return config.encryptionSalt;
  }

  // 2. If there's an existing encrypted password but no salt in config,
  // use default salt for backward compatibility
  if (config.password && config.password.startsWith('ENC:') && config.encryptionKey) {
    return DEFAULT_SALT;
  }

  // 3. For new encryptions, get or create installation salt
  if (config.dataDir) {
    return getInstallationSalt(config.dataDir);
  }

  return DEFAULT_SALT;
}

export function encryptPasswordWithKey(password: string, key: string, salt?: string): string {
  const encryptor = createEncryptor(key, salt);
  const result = encryptor.encrypt(password);
  if (!result.success) {
    throw new Error(`Failed to encrypt password: ${result.error}`);
  }
  return 'ENC:' + result.encrypted;
}

export function decryptPasswordWithKey(encryptedPassword: string, key: string, salt?: string): string {
  if (!encryptedPassword.startsWith('ENC:')) {
    return encryptedPassword;
  }

  const encryptor = createEncryptor(key, salt);
  const encryptedData = encryptedPassword.substring(4);
  const result = encryptor.decrypt(encryptedData);

  if (!result.success) {
    throw new Error(`Failed to decrypt password: ${result.error}`);
  }

  return result.decrypted || '';
}

export function decryptPasswordFromConfig(config: XmppAccountConfig): string {
  const password = config.password || '';

  if (!password || !isEncryptedPassword(password)) {
    return password;
  }

  const key = config.encryptionKey;
  if (!key) {
    throw new Error('Password is encrypted but no encryptionKey found in config');
  }

  const salt = getOrCreateEncryptionSalt(config);
  return decryptPasswordWithKey(password, key, salt);
}

export function encryptPasswordInConfig(config: XmppAccountConfig, plaintextPassword: string): XmppAccountConfig {
  const key = getOrCreateEncryptionKey(config);
  const salt = getOrCreateEncryptionSalt(config);
  const encrypted = encryptPasswordWithKey(plaintextPassword, key, salt);

  return {
    ...config,
    password: encrypted,
    encryptionKey: key,
    encryptionSalt: salt
  };
}

export function isEncryptedPassword(value: string): boolean {
  return typeof value === 'string' && value.startsWith('ENC:');
}

export function updateConfigWithEncryptedPassword(
  configPath: string,
  plaintextPassword: string
): { success: boolean; error?: string } {
  try {
    const fs = require('fs');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);

    const xmppConfig = config.channels?.xmpp?.accounts?.default;
    if (!xmppConfig) {
      return { success: false, error: 'XMPP account config not found' };
    }

    const updatedConfig = encryptPasswordInConfig(xmppConfig, plaintextPassword);

    config.channels.xmpp.accounts.default = updatedConfig;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export function isEncrypted(value: string): boolean {
  return isEncryptedPassword(value);
}
