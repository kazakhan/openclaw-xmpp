// SECURITY (2.11.0, keepalive-rejoin): regression test suite that
// asserts the v2.11.0 changes for the constant dropouts and the
// "agent doesn't respond after reconnect" issue:
//
//   1. A stable, sanitized hostname resource (operator request) —
//      the default resource is no longer a random `openclaw-<hex>`
//      suffix, so the full JID (and the agent's pending state) is
//      predictable across reconnects.
//   2. Re-enabled keepalive (TCP setKeepAlive + XMPP whitespace) so
//      NAT/firewall idle timers stop silently killing the socket
//      every ~15 minutes.
//   3. MUC rooms are re-joined after a transient reconnect so
//      groupchat replies keep working.
//
// Tests are file-based (read source + assert on regex) so they run
// without a real XMPP server.

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

describe('Fix 2.11.0 (Keepalive): the connection no longer idles out', () => {
  it('src/startXMPP.ts sets TCP keepalive via findUnderlyingSocket().setKeepAlive on online', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /findUnderlyingSocket\(\s*xmpp\s*\)[\s\S]*?\.setKeepAlive\(\s*true\s*,\s*Config\.TCP_KEEPALIVE_MS\s*\)/,
      'startXMPP.ts must call setKeepAlive(true, Config.TCP_KEEPALIVE_MS) on the underlying socket in the online handler.',
    );
  });

  it('src/startXMPP.ts arms a whitespace keepalive interval using Config.WHITESPACE_KEEPALIVE_MS', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?xmpp\.write\(\s*["'] ["']\s*\)[\s\S]*?\},\s*Config\.WHITESPACE_KEEPALIVE_MS\s*\)/,
      'startXMPP.ts must write a single space to the stream on a Config.WHITESPACE_KEEPALIVE_MS interval.',
    );
  });

  it('src/startXMPP.ts clears the whitespace timer on offline (no leak across deliberate stop)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /xmpp\.on\(\s*["']offline["'][\s\S]*?clearInterval\(\s*whitespaceKeepaliveTimer\s*\)\s*;/,
      'offline handler must clear the whitespace keepalive timer.',
    );
  });

  it('src/config.ts exports TCP_KEEPALIVE_MS and WHITESPACE_KEEPALIVE_MS', async () => {
    const src = await readSource('src/config.ts');
    assert.match(src, /TCP_KEEPALIVE_MS:\s*20000/, 'config.ts TCP_KEEPALIVE_MS should default to 20000ms');
    assert.match(src, /WHITESPACE_KEEPALIVE_MS:\s*25000/, 'config.ts WHITESPACE_KEEPALIVE_MS should default to 25000ms');
  });
});

describe('Fix 2.11.0 (Resource): stable, sanitized hostname', () => {
  it('src/startXMPP.ts default resource derives from os.hostname() (not a random suffix)', async () => {
    const code = (await readSource('src/startXMPP.ts'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const getDefaultResource = code.match(/const\s+getDefaultResource\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
    assert.ok(getDefaultResource, 'expected to find getDefaultResource in startXMPP.ts');
    assert.match(
      getDefaultResource[1],
      /os\.hostname\(\s*\)/,
      'getDefaultResource() must derive the default resource from os.hostname() (2.11.0 stable resource).',
    );
    assert.equal(
      /crypto\.randomBytes\(\s*\d+\s*\)/.test(getDefaultResource[1]),
      false,
      'getDefaultResource() must NOT use crypto.randomBytes for the resource (2.11.0 stable resource).',
    );
  });

  it('src/lib/xmpp-connect.ts mirrors the sanitized hostname resource (no random suffix)', async () => {
    const src = await readSource('src/lib/xmpp-connect.ts');
    assert.match(src, /sanitizeResource\(\s*os\.hostname\s*\(\)\s*\)/, 'xmpp-connect.ts must sanitize os.hostname()');
    assert.equal(
      /crypto\.randomBytes\(\s*\d+\s*\)/.test(src),
      false,
      'xmpp-connect.ts must NOT use crypto.randomBytes for the resource anymore (2.11.0 stable resource).',
    );
  });
});

describe('Fix 2.11.0 (Reconnect): MUC rooms are re-joined after a transient reconnect', () => {
  it('src/startXMPP.ts re-joins joinedRooms inside the online handler', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /xmpp\.on\(\s*["']online["'][\s\S]*?joinedRooms\.size\s*>\s*0[\s\S]*?for\s*\(\s*const\s+room\s+of\s+Array\.from\(\s*joinedRooms\s*\)\s*\)/,
      'online handler must iterate joinedRooms and re-join each after a reconnect.',
    );
  });

  it('src/startXMPP.ts sends a MUC presence <x urn:muc#...> when re-joining', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /rejoinPresence[\s\S]*?xml\(\s*["']x["']\s*,\s*\{\s*xmlns:\s*["']http:\/\/jabber\.org\/protocol\/muc["']\s*\}/,
      'the MUC re-join must send a <x xmlns="http://jabber.org/protocol/muc"> presence.',
    );
  });
});
