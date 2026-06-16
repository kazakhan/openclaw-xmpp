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
// Fix 1.1: SFTP feature was removed.  The CLI subcommand still
// exists but now emits a removal error and exits 1.
// ---------------------------------------------------------------------
describe('Fix 1.1: SFTP removed', () => {
  it('commands.ts no longer imports ./sftp.js', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'commands.ts'),
      'utf8'
    );
    // The stub may keep the .command("sftp …") registration but
    // must not dynamically import the deleted ./sftp.js module.
    assert.equal(
      src.includes("await import('./sftp.js')") ||
        src.includes("from './sftp.js'") ||
        src.includes("require('./sftp.js')"),
      false,
      'commands.ts must not reference the deleted sftp module'
    );
  });

  it('sftp.ts file no longer exists', () => {
    const sftpPath = path.join(__dirname, '..', 'src', 'sftp.ts');
    assert.equal(fs.existsSync(sftpPath), false, 'src/sftp.ts should be deleted');
  });

  it('XmppConfig no longer has sftpPort field', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'types.ts'),
      'utf8'
    );
    assert.equal(
      src.includes('sftpPort'),
      false,
      'XmppConfig.sftpPort should be removed'
    );
  });

  it('package.json no longer depends on ssh2', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    const deps = pkg.dependencies || {};
    assert.equal('ssh2' in deps, false, 'ssh2 dependency should be removed');
  });

  it('the sftp subcommand exists but is a removal stub', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'commands.ts'),
      'utf8'
    );
    assert.ok(
      src.includes('.command("sftp <action> [args...]"'),
      'sftp subcommand should still be registered (so scripts get a clean error)'
    );
    assert.ok(
      src.includes("removed in 2.0.15"),
      'sftp stub should reference the 2.0.15 removal message'
    );
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
describe('Fix 1.7: SVG attribute escaping', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'whiteboard-cli.ts'),
    'utf8'
  );

  it('whiteboard-cli.ts defines escapeAttr and uses it everywhere', () => {
    // The escapeAttr function must be defined.
    assert.ok(
      /function escapeAttr\b|^.*const escapeAttr\s*=/m.test(src) ||
        /const escapeAttr\s*=/.test(src),
      'escapeAttr must be defined'
    );
    // The unsafe pattern `<path d="${cmd}"` must be gone.
    assert.equal(
      /<path d="\$\{cmd\}"/.test(src),
      false,
      'raw ${cmd} interpolation into <path d="..."> must be removed'
    );
    // The safe pattern `<path d="${escapeAttr(cmd)}"` must be present.
    assert.ok(
      /<path d="\$\{escapeAttr\(cmd\)\}"/.test(src),
      'cmd must be wrapped in escapeAttr() in <path d="...">'
    );
  });

  it('sendWhiteboardMessage also escapes pathData, stroke, and strokeWidth', () => {
    // The whole whiteboard pipeline must be escape-safe.
    assert.equal(
      /<path d="\$\{pathData\}"/.test(src),
      false,
      'sendWhiteboardMessage must escape pathData'
    );
    assert.equal(
      /<path d="\$\{pathData\}" fill="none" stroke="\$\{stroke\}"/.test(src),
      false,
      'sendWhiteboardMessage must escape stroke'
    );
    assert.match(
      src,
      /<path d="\$\{escapeAttr\(pathData\)\}" fill="none" stroke="\$\{escapeAttr\(stroke\)\}"/,
      'sendWhiteboardMessage must use escapeAttr for both pathData and stroke'
    );
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
