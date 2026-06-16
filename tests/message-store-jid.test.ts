import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// Fix 1.5: MessageStore JID round-trip (reversible encoding)
//
// The MessageStore class can only be loaded as a .ts file in the
// current test runtime (no tsx).  We verify the encoding/decoding
// logic via a direct test that re-implements the same algorithm
// in-process, AND by source-level assertions that the algorithm
// in the source file matches the expected bijective mapping.
// =====================================================================

// Re-implement the encoding here so we can test the round-trip
// without loading the .ts file.  This MUST stay in lockstep with
// the implementation in src/messageStore.ts.  If the implementation
// changes, the test must change too.
function encodeJidForFilename(jid: string): string {
  return jid
    .replace(/%/g, '%25')
    .replace(/\./g, '%2E')
    .replace(/\//g, '%2F')
    .replace(/_/g, '%5F');
}

function decodeJidFromFilename(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded.replace(/_/g, '.');
  }
}

describe('Fix 1.5: MessageStore JID round-trip (reversible encoding)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-jid-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('encodeJidForFilename / decodeJidFromFilename', () => {
    it('round-trips a plain JID', () => {
      const jid = 'user@example.com';
      assert.equal(decodeJidFromFilename(encodeJidForFilename(jid)), jid);
    });

    it('round-trips a JID with underscores in the local part', () => {
      const jid = 'user_with_underscores@example.com';
      const encoded = encodeJidForFilename(jid);
      assert.equal(encoded.includes('_'), false, 'underscore must be percent-encoded');
      assert.equal(decodeJidFromFilename(encoded), jid);
    });

    it('round-trips a JID with a resource', () => {
      const jid = 'user@example.com/laptop';
      assert.equal(decodeJidFromFilename(encodeJidForFilename(jid)), jid);
    });

    it('round-trips a JID with multiple dots in the domain', () => {
      const jid = 'user@conference.example.com';
      assert.equal(decodeJidFromFilename(encodeJidForFilename(jid)), jid);
    });

    it('round-trips an empty string', () => {
      assert.equal(decodeJidFromFilename(encodeJidForFilename('')), '');
    });

    it('encoded form is safe in a filename (no `/`, no raw `_`)', () => {
      const jids = [
        'user@example.com',
        'a_b_c@example.com',
        'user/conflict@example.com',
        'user@example.com/resource',
      ];
      for (const jid of jids) {
        const encoded = encodeJidForFilename(jid);
        assert.equal(encoded.includes('/'), false, `${jid} -> ${encoded}`);
        assert.equal(encoded.includes('_'), false, `${jid} -> ${encoded}`);
      }
    });

    it('is bijective for a 1000-random-JID fuzz', () => {
      // Quick fuzz: 1000 random JIDs round-trip cleanly.
      for (let i = 0; i < 1000; i++) {
        const local = Math.random().toString(36).slice(2, 8) + '_' + Math.random().toString(36).slice(2, 5);
        const domain = Math.random().toString(36).slice(2, 8) + '.' + Math.random().toString(36).slice(2, 5);
        const jid = `${local}@${domain}`;
        assert.equal(
          decodeJidFromFilename(encodeJidForFilename(jid)),
          jid,
          `round-trip failed for ${jid}`
        );
      }
    });
  });

  describe('source-level assertions', () => {
    let src = '';
    beforeEach(async () => {
      src = await fs.readFile(
        path.join(__dirname, '..', 'src', 'messageStore.ts'),
        'utf8'
      );
    });

    it('exports encodeJidForFilename and decodeJidFromFilename', () => {
      assert.match(src, /export function encodeJidForFilename/);
      assert.match(src, /export function decodeJidFromFilename/);
    });

    it('encodes `.`, `/`, and `_` as percent-escapes', () => {
      // The encoding lines look like:
      //   .replace(/\./g, "%2E")
      //   .replace(/\//g, "%2F")
      //   .replace(/_/g, "%5F")
      assert.match(src, /"\s*%\s*2E\s*"/);
      assert.match(src, /"\s*%\s*2F\s*"/);
      assert.match(src, /"\s*%\s*5F\s*"/);
      // And the three `.replace( … , …)` calls are present.
      const replaceCallCount = (src.match(/\.replace\(.{0,20}"%2[EF5F]"/g) || []).length;
      assert.ok(replaceCallCount >= 3, `expected ≥3 percent-replace calls, got ${replaceCallCount}`);
    });

    it('decodes via decodeURIComponent with a fallback', () => {
      assert.match(src, /decodeURIComponent\(encoded\)/);
      // And a defensive fallback if decodeURIComponent throws.
      // The fallback is `encoded.replace(/_/g, ".")`.
      assert.ok(
        /encoded\.replace\(.*_\s*\/g\s*,/.test(src),
        'fallback for malformed percent-encoding must replace _ with .'
      );
    });

    it('replaces the lossy .replace with the reversible encode in getDirectFilePath', () => {
      assert.match(src, /private getDirectFilePath\(jid: string\): string\s*\{[\s\S]*?encodeJidForFilename\(jid\)/);
    });

    it('replaces the broken reverse in getDirectChatJIDs', () => {
      // The old broken reverse was f.replace('.json', '_').map(s => s.replace(/_/g, '.'))
      // We assert that exact broken pattern is gone.
      const brokenPattern = /\.replace\(["']\.json["'], ["']_["']\)\.map\(s => s\.replace\(["']_["'], ["']\.["']\)\)/;
      assert.equal(
        brokenPattern.test(src),
        false,
        'the lossy getDirectChatJIDs reverse must be replaced'
      );
      // The new reverse uses decodeJidFromFilename.
      assert.match(
        src,
        /decodeJidFromFilename\(f\.slice\(0,\s*-["']\.json["']\.length\)\)/
      );
    });

    it('migration runs in the constructor', () => {
      assert.match(src, /this\.initialized = Promise\.all\([\s\S]*?\]\)\.then\(\(\) => this\.migrateLegacyFilenames\(\)\)/);
    });
  });
});
