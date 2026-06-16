// SECURITY (2.1.4, muc-rejoin-conflict): regression test
// suite that asserts the v2.1.4 fixes for the
// "StreamError: conflict, 'Replaced by new connection'"
// post-reconnect cycle and the "Dispatch SUCCESS for
// stockee@conference but no reply" MUC race are in place.
//
// The tests are file-based (read source + assert on
// regex / string) so they run without spinning up a real
// XMPP server.  Each test describes one of the four
// changes in v2.1.4 and asserts the relevant source
// patterns are present (or absent) as required.

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

describe('Fix 2.1.4 (R1): startXmpp() uses a unique resource per call (prevents the conflict cycle)', () => {
  it('src/startXMPP.ts uses crypto.randomBytes for the default resource', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /crypto\.randomBytes\(\s*\d+\s*\)\.toString\(\s*["']hex["']\s*\)/,
      'startXMPP.ts must use crypto.randomBytes(...).toString("hex") for the default resource, otherwise the XMPP server kicks the new connection with "Replaced by new connection" when the old TCP socket is still half-alive on the server side.',
    );
  });

  it('src/startXMPP.ts honours an explicit cfg.resource (operator opt-in)', async () => {
    const src = await readSource('src/startXMPP.ts');
    // Strip comments so we don't false-positive on the
    // explanatory JSDoc in the same function.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(
      code,
      /if\s*\(\s*cfg\?\.resource\s*\)\s*return\s*cfg\.resource/,
      'getDefaultResource() must check cfg.resource FIRST and honour it verbatim (operator opt-in).',
    );
  });

  it('src/startXMPP.ts does NOT default to cfg.jid.split("@")[0] (the bug)', async () => {
    const code = (await readSource('src/startXMPP.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // The OLD line was: `cfg?.resource || cfg?.jid?.split("@")[0] || "openclaw"`.
    // After v2.1.4, `getDefaultResource()` does NOT contain
    // `cfg?.jid?.split` inside its body (other than
    // unrelated places that still split the JID for the
    // MUC nick).
    const getDefaultResource = code.match(/getDefaultResource\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
    assert.ok(
      getDefaultResource,
      'expected to find getDefaultResource arrow function in startXMPP.ts',
    );
    assert.equal(
      /cfg\?\.jid\?\.split\(\s*["']@["']\s*\)\[0\]/.test(getDefaultResource[1]),
      false,
      'getDefaultResource() must NOT default to cfg.jid.split("@")[0] — that was the stable-resource bug that caused the conflict cycle.',
    );
  });
});

describe('Fix 2.1.4 (R2): xmppClient.stop() uses socket.destroy() fast path (breaks the 30s xmpp.stop() hang)', () => {
  it('src/startXMPP.ts imports findUnderlyingSocket from ./lib/xmpp-utils.js', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /import\s*\{[^}]*findUnderlyingSocket[^}]*\}\s*from\s*["']\.\/lib\/xmpp-utils\.js["']/,
      'startXMPP.ts must import findUnderlyingSocket from ./lib/xmpp-utils.js',
    );
  });

  it('src/startXMPP.ts xmppClient.stop calls findUnderlyingSocket(...).destroy() before xmpp.stop()', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /xmppClient\.stop\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?findUnderlyingSocket\(\s*xmpp\s*\)[\s\S]*?\.destroy\(\s*\)[\s\S]*?xmpp\.stop\(\s*\)/,
      'xmppClient.stop must call findUnderlyingSocket(xmpp).destroy() before xmpp.stop() so a dead TCP socket does not block the framework auto-restart for up to 30 seconds.',
    );
  });

  it('src/lib/xmpp-utils.ts exports findUnderlyingSocket', async () => {
    const src = await readSource('src/lib/xmpp-utils.ts');
    assert.match(
      src,
      /export\s+function\s+findUnderlyingSocket/,
      'src/lib/xmpp-utils.ts must export findUnderlyingSocket',
    );
  });
});

describe('Fix 2.1.4 (R3): MUC joinRoom() awaits server self-presence (status 110) before marking joinedRooms', () => {
  it('src/startXMPP.ts declares a pendingJoins Map of room JID -> { resolve, reject, nick, timer }', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /const\s+pendingJoins\s*=\s*new\s+Map\s*<\s*string\s*,\s*\{[^}]*resolve\s*:\s*\(\)\s*=>\s*void[^}]*reject\s*:\s*\(err:\s*Error\)\s*=>\s*void[^}]*nick\s*:\s*string[^}]*timer\s*:\s*ReturnType\s*<\s*typeof\s+setTimeout\s*>/,
      'startXMPP.ts must declare pendingJoins as a Map<string, { resolve, reject, nick, timer }> so the wrapper joinRoom() can register a Promise the presence-stanza handler resolves on status 110.',
    );
  });

  it('src/startXMPP.ts presence handler resolves pendingJoins on status code 110', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /if\s*\(\s*code\s*===\s*["']110["']\s*\)/,
      'startXMPP.ts must inspect code === "110" (XEP-0045 self-presence).',
    );
    assert.match(
      src,
      /if\s*\(\s*code\s*===\s*["']110["']\s*\)[\s\S]*?pendingJoins\.get\(\s*room\s*\)[\s\S]*?pending\.resolve\(\s*\)/,
      'startXMPP.ts must resolve the pendingJoins Promise for this room on status code 110.',
    );
    assert.match(
      src,
      /if\s*\(\s*code\s*===\s*["']110["']\s*\)[\s\S]*?joinedRooms\.add\(\s*room\s*\)/,
      'joinedRooms.add(room) must run on status 110, not optimistically in joinRoom().',
    );
  });

  it('src/startXMPP.ts presence handler rejects pendingJoins on <presence type="error">', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /if\s*\(\s*type\s*===\s*["']error["']\s*\)\s*\{[\s\S]*?pendingJoins\.get\(\s*room\s*\)[\s\S]*?pending\.reject\(/,
      'startXMPP.ts must reject the pendingJoins Promise when the server sends <presence type="error"> (e.g. nick conflict, banned, room not found).',
    );
  });

  it('src/startXMPP.ts xmppClient.joinRoom awaits the pendingJoins Promise (does NOT mark joinedRooms optimistically)', async () => {
    const code = (await readSource('src/startXMPP.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Find the joinRoom wrapper body.  The wrapper is
    // followed by leaveRoom; we look for the joinRoom
    // declaration and the next top-level `,` close.
    // After v2.1.4, the wrapper body must NOT call
    // joinedRooms.add() or roomNicks.set() directly —
    // those are the status-110 handler's job.
    const joinRoomMatch = code.match(/joinRoom:\s*async[\s\S]*?=>\s*\{/);
    assert.ok(joinRoomMatch, 'expected to find joinRoom wrapper declaration in startXMPP.ts');
    const startIdx = joinRoomMatch.index! + joinRoomMatch[0].length;
    // Walk braces from the start to find the matching close.
    let depth = 1;
    let i = startIdx;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = code.slice(startIdx, i - 1);
    assert.equal(
      /joinedRooms\.add\(/.test(body),
      false,
      'joinRoom() must NOT call joinedRooms.add() directly — that races with the server self-presence.',
    );
    assert.equal(
      /roomNicks\.set\(/.test(body),
      false,
      'joinRoom() must NOT call roomNicks.set() directly — that races with the server self-presence.',
    );
    assert.match(
      body,
      /await\s+joinPromise/,
      'joinRoom() must await the server\'s self-presence (status 110) before returning.',
    );
  });

  it('src/startXMPP.ts offline handler cleans up pendingJoins (no timer leaks across deliberate stop)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /xmpp\.on\(\s*["']offline["'][\s\S]*?pendingJoins\.clear\(\s*\)/,
      'offline handler must clear pendingJoins so a 5s join-timeout timer does not fire after a deliberate stop.',
    );
  });
});

describe('Fix 2.1.4 (R4): gateway.startAccount no longer reads the dead _lastInboundAt field', () => {
  it('src/gateway.ts does NOT contain _lastInboundAt', async () => {
    const code = (await readSource('src/gateway.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(
      /_lastInboundAt/.test(code),
      false,
      'gateway.ts must NOT read _lastInboundAt — the v2.1.3 liveness-manager removal stopped maintaining it; the guard was dead code.',
    );
  });

  it('src/gateway.ts does NOT contain STALE_CONNECTION_TIMEOUT_MS', async () => {
    const code = (await readSource('src/gateway.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(
      /STALE_CONNECTION_TIMEOUT_MS/.test(code),
      false,
      'gateway.ts must NOT contain STALE_CONNECTION_TIMEOUT_MS — the de-dup guard that used it has been removed.',
    );
  });

  it('src/gateway.ts does NOT call existingXmpp.stop() from startAccount', async () => {
    const code = (await readSource('src/gateway.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(
      /existingXmpp\s*\.stop\(\s*\)/.test(code),
      false,
      'gateway.ts must NOT call existingXmpp.stop() — that was the v2.0.20 dead-code path that could tear down a live connection.',
    );
  });
});

describe('Fix 2.1.4 (R5): xmpp-connect.ts has a JSDoc cross-reference to the startXMPP.ts fix', () => {
  it('src/lib/xmpp-connect.ts contains a v2.1.4 cross-reference comment', async () => {
    const src = await readSource('src/lib/xmpp-connect.ts');
    assert.match(
      src,
      /SECURITY\s*\(\s*2\.1\.4\s*\)/,
      'src/lib/xmpp-connect.ts must contain a SECURITY (2.1.4) comment cross-referencing the startXMPP.ts fix so future contributors do not undo it.',
    );
  });
});
