import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encryptPasswordWithKey, decryptPasswordWithKey, generateEncryptionKey } from '../src/security/encryption.js';
import { sanitize } from '../src/shared/index.js';

describe('encryption', () => {
  const testKey = 'dGhpc0lzcy1zZXN0a2V5' + 'A'.repeat(16); // base64 of 32 bytes
  const testSalt = 'testsalt12345678901'; // fixed salt for tests

  describe('round-trip encrypt/decrypt', () => {
    it('encrypts and decrypts a password correctly', () => {
      const plaintext = 'mySecretPassword123!';
      const encrypted = encryptPasswordWithKey(plaintext, testKey, testSalt);
      assert.ok(encrypted.startsWith('ENC:'), 'should have ENC: prefix');
      
      const decrypted = decryptPasswordWithKey(encrypted, testKey, testSalt);
      assert.equal(decrypted, plaintext);
    });

    it('produces different ciphertext for same password (random IV)', () => {
      const plaintext = 'samePassword';
      const enc1 = encryptPasswordWithKey(plaintext, testKey, testSalt);
      const enc2 = encryptPasswordWithKey(plaintext, testKey, testSalt);
      assert.notEqual(enc1, enc2, 'different IVs should produce different output');
    });
  });

  describe('invalid input handling', () => {
    it('returns non-ENC strings unchanged', () => {
      const result = decryptPasswordWithKey('not-encrypted', testKey, testSalt);
      assert.equal(result, 'not-encrypted');
    });

    it('returns empty string unchanged', () => {
      const result = decryptPasswordWithKey('', testKey, testSalt);
      assert.equal(result, '');
    });

    it('rejects truncated ENC: string', () => {
      assert.throws(() => decryptPasswordWithKey('ENC:tooshort', testKey, testSalt));
    });
  });

  describe('key generation', () => {
    it('generates a valid base64 key of correct length', () => {
      const key = generateEncryptionKey();
      assert.ok(key.length >= 32, 'key should be at least 32 chars');
      // Should be valid base64
      Buffer.from(key, 'base64');
    });

    it('generates different keys each time', () => {
      const k1 = generateEncryptionKey();
      const k2 = generateEncryptionKey();
      assert.notEqual(k1, k2);
    });
  });
});

describe('sanitize - extended coverage', () => {
  it('redacts multiple password patterns in one string', () => {
    const input = 'password=secret123 and password=adminpass';
    const result = sanitize(input);
    assert.ok(!result.includes('secret123'));
    assert.ok(!result.includes('adminpass'));
  });

  it('handles empty/null input gracefully', () => {
    assert.equal(sanitize(''), '');
    assert.equal(sanitize(null as any), '');
    assert.equal(sanitize(undefined as any), '');
  });

  it('preserves normal text with no sensitive patterns', () => {
    const msg = 'Hello from user@domain.com about the weather today';
    assert.equal(sanitize(msg), msg);
  });
});
