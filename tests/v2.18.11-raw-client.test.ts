// SECURITY (2.18.11): the plugin wrapper (stored in xmppClients) exposes the
// raw @xmpp client as `get xmpp()` but has no `.on`/`.off`, and its `send`
// takes (to, body). Voice-note + upload code must normalize to the raw client.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

describe('2.18.11: voice-note uses the raw XMPP client', () => {
  it('normalizes wrapper -> raw client and passes it to the uploader', async () => {
    const src = await readSource('src/lib/voice-note.ts');
    assert.match(src, /typeof xmpp\.on === "function"/);
    assert.match(src, /xmpp\?\.xmpp/);
    assert.match(src, /requestUploadSlot\(\s*raw,/);
  });

  it('sends the SIMS element with safeSend(raw, …) instead of wrapper.send(to, body)', async () => {
    const src = await readSource('src/lib/voice-note.ts');
    assert.match(src, /safeSend\(raw, message\)/);
    assert.equal(/await xmpp\.send\(message\)/.test(src), false);
  });
});

describe('2.18.11: upload-protocol normalizes both client shapes', () => {
  it('defines rawClient() and uses it in discovery/slot/send helpers', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    assert.match(src, /function rawClient\(xmpp: any\)/);
    assert.match(src, /typeof xmpp\.on === "function"/);
    assert.match(src, /xmpp\.xmpp/);
    // All four helpers normalize before touching the client.
    for (const marker of [
      'function discoItems',
      'async function discoInfoHasUpload',
      'export async function requestUploadSlot',
      'export async function sendFileWithHTTPUpload',
    ]) {
      const idx = src.indexOf(marker);
      assert.ok(idx >= 0, `${marker} not found`);
      const body = src.slice(idx, idx + 400);
      assert.match(body, /xmpp = rawClient\(xmpp\)/, `${marker} must normalize the client`);
    }
  });
});
