// SECURITY (2.16.4): never pass a JID string to the raw @xmpp/client send().
//
// `xmpp.send(element)` expects an XML element; a JID string makes
// `Connection.send` do `element.parent = ...` and throw
// `Cannot create property 'parent' on string '<jid>'`.  Because that throw is a
// rejected promise, a surrounding try/catch does not catch it and the
// unhandled rejection crashes the gateway (→ restart-loop breaker).

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

describe('2.16.4: no JID passed to the raw xmpp.send', () => {
  it('startXMPP.ts never calls xmpp.send with a JID string', async () => {
    const src = await readSource('src/startXMPP.ts');
    const bad = src.match(/xmpp\.send\(\s*(?:jid|from|to|admins|adminJid|fromJidStr|fromBareJid|senderBareJid)\b/g) || [];
    assert.equal(bad.length, 0, `raw xmpp.send(<jid>) calls remain: ${bad.join(", ")}`);
  });

  it('defines and uses sendChatNotice for notices', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /const\s+sendChatNotice\s*=\s*async\s*\(to:\s*string,\s*text:\s*string\)/);
    assert.match(src, /safeXmppSend\(xmpp,\s*xml\("message",\s*\{\s*type:\s*"chat",\s*to\s*\}/);
    const uses = src.match(/sendChatNotice\(/g) || [];
    assert.ok(uses.length >= 7, `expected >= 7 sendChatNotice uses, found ${uses.length}`);
  });

  it('updater notifyUpdateAvailable takes a send callback, not the raw client', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /export\s+function\s+notifyUpdateAvailable\(\s*send:\s*\(jid:\s*string,\s*text:\s*string\)\s*=>\s*void/);
    assert.equal(/xmpp\.send\(/.test(src), false);
  });
});
