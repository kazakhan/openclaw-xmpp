import crypto from "crypto";

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'xmpp-plugin-salt-v1';
const KEY_DERIVATION_ITERATIONS = 100000;

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
  dataDir?: string;
  ftpPort?: number;
}

export class PasswordEncryption {
  private key: Buffer;

  constructor(key: string) {
    this.key = crypto.pbkdf2Sync(key, SALT, KEY_DERIVATION_ITERATIONS, KEY_LENGTH, 'sha512');
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

export function createEncryptor(key: string): PasswordEncryption {
  return new PasswordEncryption(key);
}

export function getOrCreateEncryptionKey(config: XmppAccountConfig): string {
  if (config.encryptionKey && typeof config.encryptionKey === 'string' && config.encryptionKey.length > 0) {
    return config.encryptionKey;
  }
  const newKey = generateEncryptionKey();
  return newKey;
}

export function encryptPasswordWithKey(password: string, key: string): string {
  const encryptor = createEncryptor(key);
  const result = encryptor.encrypt(password);
  if (!result.success) {
    throw new Error(`Failed to encrypt password: ${result.error}`);
  }
  return 'ENC:' + result.encrypted;
}

export function decryptPasswordWithKey(encryptedPassword: string, key: string): string {
  if (!encryptedPassword.startsWith('ENC:')) {
    return encryptedPassword;
  }

  const encryptor = createEncryptor(key);
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

  return decryptPasswordWithKey(password, key);
}

export function encryptPasswordInConfig(config: XmppAccountConfig, plaintextPassword: string): XmppAccountConfig {
  const key = getOrCreateEncryptionKey(config);
  const encrypted = encryptPasswordWithKey(plaintextPassword, key);

  return {
    ...config,
    password: encrypted,
    encryptionKey: key
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
