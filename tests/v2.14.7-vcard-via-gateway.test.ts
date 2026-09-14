// SECURITY (2.14.7): regression suite for the "vCard CLI must not open a
// second XMPP connection" fix.
//
// Root cause: `openclaw xmpp vcard …` / `vcard4` imported `vcard-cli.js`,
// which opened its OWN XMPP connection with the same JID + resource as the
// gateway.  Prosody (and other servers) then killed the gateway's session
// with `StreamError: condition='conflict', text='Replaced by new connection'`,
// so the bot flapped offline every time a CLI command ran.
//
// Fix: vCard operations are exposed on the live client wrapper
// (`src/startXMPP.ts` -> `src/lib/vcard-ops.ts`) and over the `xmpp.vcard`
// gateway RPC (`index.ts`).  The CLI (`src/commands.ts`) routes through
// `getXmppClient()` (in-process) or `callGatewayRpc("xmpp.vcard", …)`.
//
// File-based (read source + assert regex), matching the rest of the suite.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { existsSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

function srcPath(rel: string): string {
  return path.join(__dirname, '..', rel);
}

describe('Fix 2.14.7: dead direct-connect vCard CLIs removed', () => {
  it('src/vcard-cli.ts and src/whiteboard-cli.ts are deleted', () => {
    assert.equal(existsSync(srcPath('src/vcard-cli.ts')), false);
    assert.equal(existsSync(srcPath('src/whiteboard-cli.ts')), false);
  });
});

describe('Fix 2.14.7: vCard ops run on the live connection (src/lib/vcard-ops.ts)', () => {
  it('exports runVCardOp', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.match(src, /export\s+async\s+function\s+runVCardOp\s*\(/);
  });

  it('covers every CLI action', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    for (const action of [
      'get',
      'set',
      'avatar',
      'name',
      'phone-add',
      'phone-remove',
      'email-add',
      'email-remove',
      'address-add',
      'address-remove',
      'org',
      'vcard4-get',
      'vcard4-publish',
    ]) {
      assert.match(src, new RegExp(`case\\s+["']${action}["']`), `missing action: ${action}`);
    }
  });

  it('never opens or stops its own XMPP connection', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.equal(/createXmppClient/.test(src), false);
    assert.equal(/xmpp\.start\(/.test(src), false);
    assert.equal(/xmpp\.stop\(/.test(src), false);
  });

  it('delegates to the live vcardServer', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.match(src, /vcardServer\.queryVCardFromServer\(/);
    assert.match(src, /vcardServer\.updateVCardOnServer\(/);
    assert.match(src, /vcardServer\.publishVCard4\(/);
  });
});

describe('Fix 2.14.7: live wrapper exposes vcard(action, args) (src/startXMPP.ts)', () => {
  it('imports runVCardOp', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /import\s*\{\s*runVCardOp\s*\}\s*from\s*["']\.\/lib\/vcard-ops\.js["']/);
  });

  it('adds a vcard method to the client wrapper backed by runVCardOp', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /vcard:\s*\(action:\s*string,\s*args:\s*string\[\]\s*=\s*\[\]\)\s*=>/);
    assert.match(src, /runVCardOp\(\s*\{[\s\S]*?xmpp,[\s\S]*?vcardServer,[\s\S]*?vcard,/);
  });

  it('logs a distinct warning on a `conflict` StreamError', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /condition\s*===\s*["']conflict["']/);
    assert.match(src, /already in use by another session/i);
  });

  it('keeps the bot resource as the sanitized hostname (unchanged)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /return\s+sanitizeResource\(os\.hostname\(\)\)\s*\|\|\s*["']openclaw["']/);
  });
});

describe('Fix 2.14.7: xmpp.vcard gateway method (index.ts)', () => {
  it('registers xmpp.vcard', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /api\.registerGatewayMethod\(\s*["']xmpp\.vcard["']/);
  });

  it('resolves the live client and awaits client.vcard(action, args)', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /xmppClients\.get\(["']default["']\)/);
    assert.match(src, /await\s+client\.vcard\(\s*action,\s*args\s*\)/);
  });

  it('fails closed when no client is connected', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /missing required parameter:\s*action/i);
    assert.match(src, /XMPP client not connected/);
  });
});

describe('Fix 2.14.7: CLI routes vCard through the gateway (src/commands.ts)', () => {
  it('defines a runVCard helper that prefers the in-process client', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /async\s+function\s+runVCard\s*\(/);
    assert.match(src, /typeof\s+local\.vcard\s*===\s*["']function["']/);
    assert.match(src, /getXmppClient\(\)/);
  });

  it('falls back to the xmpp.vcard gateway RPC and fails closed', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /callGatewayRpc[\s\S]*?["']xmpp\.vcard["']/);
    assert.match(src, /gateway not running or unreachable/);
  });

  it('no longer imports the old direct-connect vcard-cli', async () => {
    const src = await readSource('src/commands.ts');
    assert.equal(/import\(\s*['"]\.\/vcard-cli\.js['"]\s*\)/.test(src), false);
    assert.equal(/from\s+['"]\.\/vcard-cli\.js['"]/.test(src), false);
  });

  it('every vcard/vcard4 branch calls runVCard', async () => {
    const src = await readSource('src/commands.ts');
    for (const action of [
      'get',
      'set',
      'avatar',
      'name',
      'phone-add',
      'phone-remove',
      'email-add',
      'email-remove',
      'address-add',
      'address-remove',
      'org',
      'vcard4-get',
      'vcard4-publish',
    ]) {
      assert.match(
        src,
        new RegExp(`runVCard\\(\\s*['"]${action}['"]`),
        `CLI branch must call runVCard('${action}', …)`,
      );
    }
  });
});
