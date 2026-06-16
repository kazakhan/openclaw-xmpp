import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// 2.0.16 High-Severity Fixes — test suite
//
// All tests are source-level (no dynamic .js imports) so they run
// in the existing test runtime without a TS runner.
// =====================================================================

async function readSource(rel: string): Promise<string> {
  const raw = await fs.readFile(path.join(__dirname, '..', rel), 'utf8');
  // Strip block comments and line comments so the assertion regex
  // doesn't accidentally match comment text.  Tests that need to
  // assert on a comment use the un-stripped raw source via
  // `readSourceRaw`.
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function readSourceRaw(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

// Re-implement the sanitisation function in-process to test H7
// without needing the .ts file to be loadable.  This MUST stay
// in lockstep with src/security/validation.ts.
function sanitizeFilenameForTest(filename: string): string {
  if (!filename || typeof filename !== 'string') return 'unknown';
  const sanitized = filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .substring(0, 255);
  return sanitized || 'unknown';
}

describe('Fix H1: commands.ts encrypt-password echoes no characters', () => {
  it('does not import readline', async () => {
    const src = await readSource('src/commands.ts');
    assert.equal(
      /from\s+["']readline["']/.test(src),
      false,
      'commands.ts must not import readline (it echoes to the terminal)'
    );
    assert.equal(
      /readline\.createInterface/.test(src),
      false,
      'commands.ts must not call readline.createInterface'
    );
  });

  it('uses stdin for the password', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /for await \(const chunk of process\.stdin\)/);
    assert.match(src, /(?:let|const|var) configPath = path\.join\(/);
  });

  it('warns when password is on argv (deprecation)', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(
      src,
      /\[commands\.ts\] WARNING: passing the password on the command line[\s\S]*is deprecated/,
      'argv-password deprecation warning must be present'
    );
  });
});

describe('Fix H2: xmpp.send() wrapped in safeSend (timeout-safe)', () => {
  it('zero bare `await xmpp.send(` calls remain in startXMPP.ts', async () => {
    const startXmppSrc = await readSource('src/startXMPP.ts');
    const re = /await\s+xmpp\.send\(/g;
    const m = startXmppSrc.match(re);
    assert.equal(
      m,
      null,
      `expected zero matches of 'await xmpp.send('; found ${m?.length ?? 0}`,
    );
  });

  it('safeSend helper exists in src/lib/xmpp-utils.ts and clears its timer in finally', async () => {
    const src = await readSourceRaw('src/lib/xmpp-utils.ts');
    assert.match(src, /export\s+async\s+function\s+safeSend/);
    assert.match(src, /try\s*\{[\s\S]*?await Promise\.race\(/);
    assert.match(src, /finally\s*\{[\s\S]*?clearTimeout\(timer\)/);
  });

  it('safeSend has a default timeout of 30 seconds', async () => {
    const src = await readSourceRaw('src/lib/xmpp-utils.ts');
    assert.match(src, /DEFAULT_SEND_TIMEOUT_MS\s*=\s*30_000/);
  });
});

describe('Fix H3: nonza listener (parent + xmppLog.error)', () => {
  it('checks el.parent !== xmpp.root before treating <sm> as a feature', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /if \(el\?\.parent !== xmpp\.root\) return/,
      'nonza listener must check el.parent !== xmpp.root before SM detection',
    );
  });

  it('catches errors via xmppLog.error, not silently', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /catch\s*\(e\)\s*\{[\s\S]*?xmppLog\.error\(\s*["']nonza listener parse error/,
      'nonza catch must call xmppLog.error, not silently swallow',
    );
  });
});

describe('Fix H4: getQueue singleton → per-dataDir map', () => {
  it('does not have a module-level let messageQueue', async () => {
    const src = await readSource('src/queue-bridge.ts');
    assert.equal(
      /^let\s+messageQueue/m.test(src),
      false,
      'queue-bridge.ts must not have a module-level let messageQueue singleton',
    );
  });

  it('uses a Map keyed by dataDir', async () => {
    const src = await readSource('src/queue-bridge.ts');
    assert.match(src, /queueByDir\s*=\s*new Map/);
    assert.match(src, /queueByDir\.get\(dir\)/);
    assert.match(src, /queueByDir\.set\(dir, q\)/);
  });
});

describe('Fix H5: xmppClient hoisted to let at top of startXmpp', () => {
  it('has let xmppClient: any = null near the top of startXmpp', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /let\s+xmppClient:\s*any\s*=\s*null/);
  });

  it('no longer has `const xmppClient: any = {`', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /const\s+xmppClient:\s*any\s*=\s*\{/.test(src),
      false,
      'xmppClient is no longer a const; it is a let assigned at the bottom',
    );
  });

  it('the online handler still has the null-check guard', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /if\s*\(xmppClient\s*==\s*null\)\s*\{[\s\S]*?online callback: xmppClient not yet initialized/,
      'online handler must keep the null-check guard',
    );
  });
});

describe('Fix H6 (superseded by 2.1.3): OLD design restored, liveness.ts removed', () => {
  // SECURITY (2.1.3, restore-old-design): the 2.0.16 H6 liveness
  // extraction was the source of the connection issues the
  // operator was hitting.  Restoring the OLD design from
  // D:\Downloads\xmppOLD means the liveness manager is gone,
  // and safeSend/findUnderlyingSocket are in
  // src/lib/xmpp-utils.ts.  These tests assert the OLD design
  // is in place (no liveness manager, @xmpp/reconnect handles
  // reconnects).

  it('src/liveness.ts is DELETED', async () => {
    const exists = await fs.stat('src/liveness.ts').then(() => true).catch(() => false);
    assert.equal(exists, false, 'src/liveness.ts must be deleted in 2.1.3');
  });

  it('src/lib/xmpp-utils.ts exists and exports safeSend and findUnderlyingSocket', async () => {
    const src = await readSourceRaw('src/lib/xmpp-utils.ts');
    assert.match(src, /export\s+async\s+function\s+safeSend/);
    assert.match(src, /export\s+function\s+findUnderlyingSocket/);
  });

  it('startXMPP.ts imports safeSend from ./lib/xmpp-utils.js', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /import\s*\{[^}]*safeSend[^}]*\}\s*from\s*["']\.\/lib\/xmpp-utils\.js["']/,
      'startXMPP.ts must import safeSend from ./lib/xmpp-utils.js',
    );
  });

  it('startXMPP.ts does NOT import from ./liveness.js (file is deleted)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /from\s+["']\.\/liveness\.js["']/.test(src),
      false,
      'startXMPP.ts must NOT import from ./liveness.js (file is deleted in 2.1.3)',
    );
  });

  it('startXMPP.ts does NOT call liveness.onOnline() (OLD design has no liveness manager)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /liveness\.onOnline\(\)/.test(src),
      false,
      'startXMPP.ts must NOT call liveness.onOnline() — the liveness manager is gone in 2.1.3',
    );
  });

  it('startXMPP.ts does NOT call liveness.onOffline() (OLD design has no liveness manager)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /liveness\.onOffline\(\)/.test(src),
      false,
      'startXMPP.ts must NOT call liveness.onOffline() — the liveness manager is gone in 2.1.3',
    );
  });
});

describe('Fix H7: sanitizeFilename strips leading dots; dangerousExtensions widened', () => {
  it('validation.ts strips leading dots in sanitizeFilename', async () => {
    const validationSrc = await readSource('src/security/validation.ts');
    assert.match(
      validationSrc,
      /\.replace\(\/\^\\\.\+\/,\s*['"]_['"]\)/,
      'sanitizeFilename must include a replace(/^\\.+/, "_") strip',
    );
  });

  it('sanitization round-trip: .htaccess -> _htaccess, ..foo -> _foo, valid -> valid', () => {
    assert.equal(sanitizeFilenameForTest('.htaccess'), '_htaccess');
    assert.equal(sanitizeFilenameForTest('..foo'), '_foo');
    assert.equal(sanitizeFilenameForTest('valid.txt'), 'valid.txt');
    assert.equal(sanitizeFilenameForTest('a.b.c'), 'a.b.c');
    assert.equal(sanitizeFilenameForTest('...bar'), '_.bar');
    assert.equal(sanitizeFilenameForTest('..\..\evil'), '__evil');
  });

  it('fileTransfer.ts dangerousExtensions includes XSS vectors', async () => {
    const ftSrc = await readSource('src/security/fileTransfer.ts');
    assert.match(ftSrc, /dangerousExtensions\s*=\s*\[[\s\S]*?'\.html'/);
    assert.match(ftSrc, /dangerousExtensions\s*=\s*\[[\s\S]*?'\.svg'/);
    assert.match(ftSrc, /dangerousExtensions\s*=\s*\[[\s\S]*?'\.xml'/);
  });
});

describe('Fix H8: rate-limit map has eviction interval and cap', () => {
  it('has the cap constant (10,000)', async () => {
    const src = await readSource('src/shared/index.ts');
    assert.match(src, /RATE_LIMIT_MAP_CAP\s*=\s*10_000/);
  });

  it('has the eviction interval constant (60s)', async () => {
    const src = await readSource('src/shared/index.ts');
    assert.match(src, /RATE_LIMIT_EVICT_INTERVAL_MS\s*=\s*60_000/);
  });

  it('has ensureRateLimitEvictionStarted() called from checkRateLimit()', async () => {
    const src = await readSource('src/shared/index.ts');
    assert.match(src, /ensureRateLimitEvictionStarted\(\);/);
  });

  it('the eviction interval is created with .unref()', async () => {
    const src = await readSource('src/shared/index.ts');
    assert.match(
      src,
      /interval\.unref\(\)/,
      'the eviction interval must be .unref()-ed so it does not keep the event loop alive',
    );
  });
});

describe('Fix H9: isSystemMessage is honoured by the dispatcher', () => {
  it('has the short-circuit: if isSystemMessage then return before dispatch', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(
      src,
      /options\?\.isSystemMessage\s*===\s*true\)/,
      'gateway.ts must check options?.isSystemMessage === true',
    );
    assert.match(
      src,
      /skipping AI dispatch for system message/,
      'gateway.ts must log "skipping AI dispatch for system message" before the short-circuit return',
    );
  });

  it('passes IsSystemMessage through to the ctxPayload', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(
      src,
      /IsSystemMessage:\s*options\?\.isSystemMessage\s*===\s*true/,
      'the ctxPayload object must include IsSystemMessage: options?.isSystemMessage === true',
    );
  });
});
