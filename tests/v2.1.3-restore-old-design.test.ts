// SECURITY (2.1.3, restore-old-design): test suite that asserts
// the OLD design from D:\Downloads\xmppOLD is in place.  The
// OLD design was proven to work on Windows 11 and Linux for
// days/weeks.  The 2.0.16+ code added a liveness manager and
// keepalive mechanisms that broke the connection — this suite
// guards against that regression.

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

describe('Fix 2.1.3: @xmpp/reconnect is enabled with 5s delay (OLD design)', () => {
  it('startXMPP.ts does NOT call xmpp.reconnect.stop()', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /\(xmpp as any\)\.reconnect\.stop\(\)/.test(src),
      false,
      'startXMPP.ts must NOT call (xmpp as any).reconnect.stop() — the OLD design from D:\\Downloads\\xmppOLD relied on the built-in @xmpp/reconnect',
    );
  });

  it('startXMPP.ts sets xmpp.reconnect.delay = 5000', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /\(xmpp as any\)\.reconnect\.delay\s*=\s*5000/,
      'startXMPP.ts must set (xmpp as any).reconnect.delay = 5000 (the OLD design setting)',
    );
  });
});

describe('Fix 2.1.3: NO disconnect handler that triggers reconnection (the bug fix)', () => {
  it('startXMPP.ts has NO xmpp.on("disconnect", ...) handler', async () => {
    const raw = await readSource('src/startXMPP.ts');
    // Strip comments so the test doesn't false-positive on
    // references in the explanatory comments above the deleted
    // handler.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The 2.0.16-era code registered a xmpp.on("disconnect") handler
    // that called liveness.onOffline() and tore down the live
    // connection.  The OLD design from D:\Downloads\xmppOLD did
    // NOT have one.  Assert this.
    assert.equal(
      /xmpp\.on\(\s*["']disconnect["']/.test(src),
      false,
      'startXMPP.ts must NOT register a xmpp.on("disconnect", ...) handler — this is the bug we are fixing.  @xmpp/reconnect handles disconnect internally.',
    );
  });

  it('startXMPP.ts has NO liveness.onOffline() calls', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /liveness\.onOffline\(\)/.test(src),
      false,
      'startXMPP.ts must NOT call liveness.onOffline() — the liveness manager is gone in 2.1.3',
    );
  });

  it('startXMPP.ts has NO liveness.onOnline() calls', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /liveness\.onOnline\(\)/.test(src),
      false,
      'startXMPP.ts must NOT call liveness.onOnline() — the liveness manager is gone in 2.1.3',
    );
  });
});

describe('Fix 2.1.3: NO liveness manager in startXMPP.ts', () => {
  it('startXMPP.ts has NO createLivenessManager call', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /createLivenessManager/.test(src),
      false,
      'startXMPP.ts must NOT call createLivenessManager — the liveness manager is gone in 2.1.3',
    );
  });

  it('src/liveness.ts is DELETED', async () => {
    const exists = await fs.stat('src/liveness.ts').then(() => true).catch(() => false);
    assert.equal(
      exists,
      false,
      'src/liveness.ts must be deleted — the liveness manager is gone in 2.1.3',
    );
  });
});

describe('Fix 2.1.3: safeSend + findUnderlyingSocket moved to src/lib/xmpp-utils.ts', () => {
  it('src/lib/xmpp-utils.ts exists and exports safeSend and findUnderlyingSocket', async () => {
    const src = await readSource('src/lib/xmpp-utils.ts');
    assert.match(
      src,
      /export\s+async\s+function\s+safeSend/,
      'src/lib/xmpp-utils.ts must export safeSend',
    );
    assert.match(
      src,
      /export\s+function\s+findUnderlyingSocket/,
      'src/lib/xmpp-utils.ts must export findUnderlyingSocket',
    );
  });

  it('startXMPP.ts imports safeSend from xmpp-utils', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /import\s*\{[^}]*safeSend[^}]*\}\s*from\s*["']\.\/lib\/xmpp-utils\.js["']/,
      'startXMPP.ts must import safeSend from ./lib/xmpp-utils.js',
    );
  });
});

describe('Fix 2.1.3: NO keepalive config in config.ts (OLD design had none)', () => {
  it('config.ts has no TCP_KEEPALIVE_* config', async () => {
    const src = await readSource('src/config.ts');
    assert.equal(
      /TCP_KEEPALIVE/.test(src),
      false,
      'config.ts must NOT have TCP_KEEPALIVE_* — the OLD design had no TCP keepalive',
    );
  });

  it('config.ts has no SM_KEEPALIVE_* config', async () => {
    const src = await readSource('src/config.ts');
    assert.equal(
      /SM_KEEPALIVE/.test(src),
      false,
      'config.ts must NOT have SM_KEEPALIVE_* — the OLD design had no SM keepalive',
    );
  });

  it('config.ts has no IQ_PING_* config', async () => {
    const src = await readSource('src/config.ts');
    assert.equal(
      /IQ_PING/.test(src),
      false,
      'config.ts must NOT have IQ_PING_* — the operator confirmed the XEP-0199 ping is unnecessary',
    );
  });

  it('config.ts has no WHITESPACE_KEEPALIVE_* config', async () => {
    const src = await readSource('src/config.ts');
    assert.equal(
      /WHITESPACE_KEEPALIVE/.test(src),
      false,
      'config.ts must NOT have WHITESPACE_KEEPALIVE_* — the OLD design had no whitespace keepalive',
    );
  });

  it('config.ts has no SOCKET_IDLE_TIMEOUT_MS config', async () => {
    const src = await readSource('src/config.ts');
    assert.equal(
      /SOCKET_IDLE_TIMEOUT_MS/.test(src),
      false,
      'config.ts must NOT have SOCKET_IDLE_TIMEOUT_MS — the OLD design had no socket-idle watchdog',
    );
  });

  it('config.ts still has RECONNECT_* config (kept for custom scheduleReconnect fallback in xmppClient.stop and gateway)', async () => {
    const src = await readSource('src/config.ts');
    assert.match(
      src,
      /RECONNECT_BASE_MS:\s*1000/,
      'config.ts must still have RECONNECT_BASE_MS: 1000 (the OLD design value)',
    );
    assert.match(
      src,
      /RECONNECT_MAX_MS:\s*60000/,
      'config.ts must still have RECONNECT_MAX_MS: 60000 (the OLD design value)',
    );
    assert.match(
      src,
      /RECONNECT_BACKOFF_FACTOR:\s*2/,
      'config.ts must still have RECONNECT_BACKOFF_FACTOR: 2 (the OLD design value)',
    );
  });
});
