import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validators } from '../src/security/validation.js';
import { sanitize } from '../src/shared/index.js';

describe('validators', () => {
  describe('isValidJid', () => {
    it('accepts valid JIDs', () => {
      assert.equal(validators.isValidJid('user@example.com'), true);
      assert.equal(validators.isValidJid('user@conference.example.com'), true);
      assert.equal(validators.isValidJid('user@example.com/resource'), true);
    });

    it('rejects invalid JIDs', () => {
      assert.equal(validators.isValidJid(''), false);
      assert.equal(validators.isValidJid('not-a-jid'), false);
      assert.equal(validators.isValidJid('@example.com'), false);
      assert.equal(validators.isValidJid('user@'), false);
    });
  });

  describe('sanitizeFilename', () => {
    it('removes path traversal characters', () => {
      const result = validators.sanitizeFilename('../../../etc/passwd');
      assert.ok(!result.includes('..'));
      assert.ok(!result.includes('/'));
      assert.ok(!result.includes('\\'));
    });

    it('limits filename length to 255', () => {
      const longName = 'a'.repeat(300);
      const result = validators.sanitizeFilename(longName);
      assert.ok(result.length <= 255);
    });

    it('preserves safe filenames', () => {
      assert.equal(validators.sanitizeFilename('photo.jpg'), 'photo.jpg');
      assert.equal(validators.sanitizeFilename('document.pdf'), 'document.pdf');
    });
  });

  describe('isSafePath', () => {
    it('blocks path traversal', () => {
      assert.equal(validators.isSafePath('../secret.txt', '/tmp'), false);
      assert.equal(validators.isSafePath('/etc/passwd', '/tmp'), false);
    });

    it('allows safe paths within base', () => {
      assert.equal(validators.isSafePath('file.txt', '/tmp'), true);
      assert.equal(validators.isSafePath('subdir/file.txt', '/tmp'), true);
    });
  });

  describe('isValidUrl', () => {
    it('accepts http/https URLs', () => {
      assert.equal(validators.isValidUrl('https://example.com/file.png'), true);
      assert.equal(validators.isValidUrl('http://example.com/file.png'), true);
    });

    it('rejects non-http URLs', () => {
      assert.equal(validators.isValidUrl('ftp://example.com/file'), false);
      assert.equal(validators.isValidUrl('javascript:alert(1)'), false);
    });
  });
});

describe('sanitize', () => {
  it('redacts passwords', () => {
    const input = 'password=secret123 and api_key=abc123';
    const result = sanitize(input);
    assert.ok(!result.includes('secret123'));
    assert.ok(!result.includes('abc123'));
  });

  it('redacts credentials in various formats', () => {
    assert.ok(!sanitize('password=secret123 and api_key=abc123').includes('secret123'));
    assert.ok(!sanitize('password=secret123 and api_key=abc123').includes('abc123'));
  });

  it('preserves non-sensitive content', () => {
    const input = 'Hello world, this is a normal message';
    assert.equal(sanitize(input), input);
  });
});
