// SECURITY (2.14.0, secure SFTP): regression suite asserting SFTP was
// re-added with pinned host-key verification (fail closed).
//
// File-based (read source + assert regex) so it runs under plain `node --test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('Fix 2.14.0: secure SFTP module (src/sftp.ts)', () => {
  it('exports config resolution + fingerprint verification + operations', async () => {
    const src = await readSource('src/sftp.ts');
    for (const fn of [
      'normalizeFingerprint',
      'verifyFingerprint',
      'resolveSftpConfig',
      'loadSftpConfigFromDisk',
      'sftpUpload',
      'sftpDownload',
      'sftpList',
      'sftpRemove',
    ]) {
      assert.match(src, new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}`), `must export ${fn}`);
    }
  });

  it('verifies the host key (never accepts anything)', async () => {
    const src = await readSource('src/sftp.ts');
    assert.match(src, /hostVerifier:\s*\(key:\s*Buffer\)\s*=>\s*verifyFingerprint/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(
      /hostVerifier:\s*\(\s*\)\s*=>\s*true/.test(code),
      false,
      'must NOT disable host key verification',
    );
  });

  it('supports SHA256 and MD5 fingerprints', async () => {
    const src = await readSource('src/sftp.ts');
    assert.match(src, /createHash\("sha256"\)/);
    assert.match(src, /createHash\("md5"\)/);
  });

  it('requires a pinned fingerprint and fails closed', async () => {
    const src = await readSource('src/sftp.ts');
    assert.match(src, /hostKeyFingerprint/);
    assert.match(src, /SFTP requires a pinned host key/);
    assert.match(src, /refusing to connect without host key verification/);
  });

  it('defaults port to 2222 and keeps it configurable', async () => {
    const src = await readSource('src/sftp.ts');
    assert.match(src, /Number\(\s*sftp\.port\s*\|\|\s*2222\s*\)/);
  });
});

describe('Fix 2.14.0: SFTP CLI (src/commands.ts)', () => {
  it('wires upload/download/ls/rm', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /sftpUpload/);
    assert.match(src, /sftpDownload/);
    assert.match(src, /sftpList/);
    assert.match(src, /sftpRemove/);
    assert.match(src, /import\('\.\/sftp\.js'\)/);
  });
});

describe('Fix 2.14.0: agent tool xmpp_sftp (index.ts + manifest)', () => {
  it('registers the xmpp_sftp tool', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /name:\s*"xmpp_sftp"/);
    assert.match(src, /action:\s*Type\.Union/);
    assert.match(src, /import\(\s*["']\.\/src\/sftp\.js["']\s*\)/);
  });

  it('declares xmpp_sftp in contracts.tools', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"xmpp_sftp"/);
  });
});

describe('Fix 2.14.0: sftp config schema', () => {
  it('types.ts', async () => {
    const src = await readSource('src/types.ts');
    assert.match(src, /sftp\?:\s*\{/);
    assert.match(src, /hostKeyFingerprint\?:/);
  });
  it('openclaw.plugin.json has sftp.hostKeyFingerprint', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"sftp"/);
    assert.match(src, /"hostKeyFingerprint"/);
  });
});
