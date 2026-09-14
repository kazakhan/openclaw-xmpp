import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// 2.0.15 Critical Fixes — test suite
// ---------------------------------------------------------------------
// These tests guard against regressions in the eight critical fixes
// shipped in 2.0.15.  Each `describe` block corresponds to one of
// the fix IDs in docs/CODE_REVIEW.md §1 (Critical Issues).
// =====================================================================

// ---------------------------------------------------------------------
// Fix 1.1 (updated in 2.14.0): SFTP was removed in 2.0.15 for security
// (host key verification disabled).  It is RE-ADDED in 2.14.0 with a
// REQUIRED pinned host-key fingerprint (fail closed).
// ---------------------------------------------------------------------
describe('Fix 1.1 / 2.14.0: SFTP removed then re-added securely', () => {
  it('commands.ts imports the sftp module', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'commands.ts'),
      'utf8'
    );
    assert.ok(
      src.includes("import('./sftp.js')") || src.includes("from './sftp.js'"),
      'commands.ts must use the re-added sftp module'
    );
  });

  it('src/sftp.ts exists and requires a pinned host key', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sftp.ts'), 'utf8');
    assert.ok(src.includes('hostKeyFingerprint'), 'sftp.ts must support hostKeyFingerprint');
    assert.ok(src.includes('hostVerifier'), 'sftp.ts must verify the host key');
    assert.ok(
      src.includes('verifyFingerprint'),
      'sftp.ts must compare the presented key against the pinned fingerprint'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(
      /hostVerifier:\s*\(\s*\)\s*=>\s*true/.test(code),
      false,
      'sftp.ts MUST NOT disable host key verification (the 2.0.15 vulnerability)'
    );
  });

  it('sftp fails closed without a fingerprint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sftp.ts'), 'utf8');
    assert.ok(
      src.includes('refusing to connect without host key verification') ||
        src.includes('SFTP requires a pinned host key'),
      'sftp.ts must refuse to connect without a pinned fingerprint'
    );
  });

  it('package.json depends on ssh2 again', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    const deps = pkg.dependencies || {};
    assert.ok('ssh2' in deps, 'ssh2 dependency should be re-added');
  });

  it('the sftp subcommand is a real command (upload/download/ls/rm)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'commands.ts'),
      'utf8'
    );
    assert.ok(src.includes('.command("sftp <action> [args...]"'), 'sftp subcommand should be registered');
    assert.ok(src.includes('sftpUpload'), 'sftp upload must be wired');
    assert.ok(src.includes('sftpDownload'), 'sftp download must be wired');
    assert.ok(src.includes('sftpList'), 'sftp list must be wired');
    assert.ok(src.includes('sftpRemove'), 'sftp remove must be wired');
  });
});

// ---------------------------------------------------------------------
// Fix 1.4: `xmpp start` spawns the right process.  We test the source
// directly because the dynamic-import path is broken in the test
// runtime (no tsx/ts-node).  The source-level assertions verify
// every behavior of the previous (broken) implementation is gone
// and every behavior of the new (correct) implementation is in
// place.
// ---------------------------------------------------------------------
describe('Fix 1.4: xmpp start spawn', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands.ts'),
    'utf8'
  );

  it('startGateway function is exported', () => {
    assert.match(src, /export function startGateway\(\)/);
  });

  it('startGateway is wrapped in try/catch and returns ok:false on throw', () => {
    assert.match(src, /try\s*\{[\s\S]*?gatewayProcess\.unref\(\);[\s\S]*?\} catch \(err: any\)/);
    assert.match(src, /return\s*\{\s*ok:\s*false\s*,\s*error:\s*err\?\.message\s*\|\| String\(err\)/);
  });

  it('startGateway argv on linux is ["gateway"]', () => {
    // Strip comments first, then look for the linux argv literal.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The linux argv is the right side of the ternary: ["gateway"]
    const linuxArgvLiteral = /\[\s*"gateway"\s*\]/;
    assert.match(
      codeOnly,
      linuxArgvLiteral,
      'the linux argv ["gateway"] literal must be present in startGateway'
    );
  });

  it('startGateway command on linux is "openclaw", on win32 is "cmd.exe"', () => {
    assert.match(src, /const command = isWin \? "cmd\.exe" : "openclaw"/);
  });

  it('startGateway never references process.execPath or process.argv[0] in code', () => {
    // The old comment block on lines 27-30 mentions these for
    // historical context.  We only assert that they are not used
    // as live code (i.e. not on a line that contains `=` or `(` or
    // `,` or `push` in the position of an actual argument).
    // Strip the comment block first, then assert.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(
      /process\.execPath/.test(codeOnly),
      false,
      'process.execPath must not appear in code (only in comments)'
    );
    assert.equal(
      /process\.argv\[0\]/.test(codeOnly),
      false,
      'process.argv[0] must not appear in code (only in comments)'
    );
  });

  it('startGateway is called by the xmpp start subcommand action', () => {
    // The new .action handler should call startGateway() instead of
    // running the old broken spawn.
    assert.match(src, /const result = startGateway\(\)/);
    assert.match(
      src,
      /if \(result\.ok === false\) \{[\s\S]*?console\.error\(`Failed to start gateway/
    );
  });

  it('startGateway supports a _setSpawnForTests injection hook', () => {
    assert.match(src, /export function _setSpawnForTests\(fn: SpawnFn \| null\): void/);
  });
});

// ---------------------------------------------------------------------
// Fix 1.6: HTTPS preserved for XEP-0363 uploads.  We assert the
// source does not contain the old `https://` -> `http://` rewrite
// and that `fetch` is called with the slot URL as-is.
// ---------------------------------------------------------------------
describe('Fix 1.6: HTTPS preserved in upload', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'upload-protocol.ts'),
    'utf8'
  );

  it('does not rewrite https:// to http://', () => {
    // The old code was: const httpPutUrl = putUrl.replace(/^https:\/\//, 'http://');
    // We assert that exact pattern is gone.
    const hasRewrite = /putUrl\.replace\(\s*\/\^https:/.test(src);
    assert.equal(hasRewrite, false, 'putUrl.replace(/^https:...) must be removed');
    // And the local variable `httpPutUrl` is gone too.
    assert.equal(
      /\bconst\s+httpPutUrl\s*=/.test(src),
      false,
      'the httpPutUrl local variable must be removed'
    );
  });

  it('calls fetch with the putUrl argument directly (no local rename)', () => {
    assert.match(
      src,
      /await fetch\(putUrl,\s*\{[\s\S]*?method:\s*['"]PUT['"]/,
      'fetch must be called with putUrl as the first arg'
    );
  });

  it('contains a SECURITY comment explaining the change', () => {
    assert.match(
      src,
      /SECURITY[\s\S]{0,200}no longer rewrite https/,
      'the security comment must be present'
    );
  });
});

// ---------------------------------------------------------------------
// Fix 1.7: SVG escape in whiteboard-cli.ts.  parseSvgPath is not
// exported, so we test via the file source — assert that every
// template-literal interpolation of `cmd` and `args[0]` goes through
// the `escapeAttr` helper.
// ---------------------------------------------------------------------
describe('Fix 1.7 + 2.14.7: dead direct-connect CLIs removed', () => {
  it('whiteboard-cli.ts and vcard-cli.ts are gone', () => {
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', 'src', 'whiteboard-cli.ts')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', 'src', 'vcard-cli.ts')),
      false
    );
  });

  it('no vCard CLI path opens a direct XMPP connection', () => {
    // SECURITY (2.14.7): a second connection with the same JID+resource
    // makes the server kick the gateway (`conflict`).  The vCard CLI must
    // route through the live client / `xmpp.vcard` RPC instead.
    for (const rel of ['src/commands.ts', 'src/lib/vcard-ops.ts', 'src/startXMPP.ts']) {
      const s = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.equal(
        /createXmppClient\s*\(/.test(s),
        false,
        `${rel} must not call createXmppClient()`
      );
    }
    const ops = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'vcard-ops.ts'), 'utf8');
    assert.match(ops, /vcardServer\.updateVCardOnServer\(/);
  });
});

// ---------------------------------------------------------------------
// Fix 1.8: index.ts awaits the async gateway methods.  Source-level
// assertion that the four handlers are now `async ({ params, respond })`
// and call `await client.…`.
// ---------------------------------------------------------------------
describe('Fix 1.8: index.ts awaits async gateway methods', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'index.ts'),
    'utf8'
  );
  it('xmpp.joinRoom is async and awaits', () => {
    assert.ok(
      /xmpp\.joinRoom",\s*async \(\{ params, respond \}\) => \{[\s\S]*?await client\.joinRoom/.test(src),
      'xmpp.joinRoom handler must be async and await client.joinRoom'
    );
  });
  it('xmpp.leaveRoom is async and awaits', () => {
    assert.ok(
      /xmpp\.leaveRoom",\s*async \(\{ params, respond \}\) => \{[\s\S]*?await client\.leaveRoom/.test(src),
      'xmpp.leaveRoom handler must be async and await client.leaveRoom'
    );
  });
  it('xmpp.inviteToRoom is async and awaits', () => {
    assert.ok(
      /xmpp\.inviteToRoom",\s*async \(\{ params, respond \}\) => \{[\s\S]*?await client\.inviteToRoom/.test(src),
      'xmpp.inviteToRoom handler must be async and await client.inviteToRoom'
    );
  });
  it('xmpp.sendMessage is async and awaits', () => {
    assert.ok(
      /xmpp\.sendMessage",\s*async \(\{ params, respond \}\) => \{[\s\S]*?await client\.send/.test(src),
      'xmpp.sendMessage handler must be async and await client.send'
    );
  });
});
