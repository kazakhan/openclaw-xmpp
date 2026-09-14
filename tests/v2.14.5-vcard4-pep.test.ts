// SECURITY (2.14.5, vCard4/XEP-0292 over PEP): regression suite.
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

describe('Fix 2.14.5: vCard4 builder (src/lib/vcard4-protocol.ts)', () => {
  it('exports the namespace, PEP node, build and parse', async () => {
    const src = await readSource('src/lib/vcard4-protocol.ts');
    assert.match(src, /VCARD4_NS\s*=\s*"urn:ietf:params:xml:ns:vcard-4\.0"/);
    assert.match(src, /VCARD4_PEP_NODE\s*=\s*"urn:xmpp:vcard4"/);
    assert.match(src, /export\s+function\s+buildVCard4/);
    assert.match(src, /export\s+function\s+parseVCard4/);
  });

  it('maps all available fields', async () => {
    const src = await readSource('src/lib/vcard4-protocol.ts');
    for (const prop of ['fn', 'n', 'nickname', 'photo', 'bday', 'url', 'note', 'org', 'title', 'role', 'tz', 'tel', 'email', 'adr', 'categories', 'uid', 'rev', 'prodid']) {
      assert.match(src, new RegExp(`"${prop}"`), `vCard4 must map ${prop}`);
    }
  });

  it('publishes the avatar as a URL only (uri)', async () => {
    const src = await readSource('src/lib/vcard4-protocol.ts');
    assert.match(src, /xml\("photo",\s*\{\},\s*xml\("uri",\s*\{\},\s*avatarUrl\)\)/);
  });
});

describe('Fix 2.14.5: PEP publish/query (src/vcard-server.ts)', () => {
  it('exports publishVCard4 and queryVCard4', async () => {
    const src = await readSource('src/vcard-server.ts');
    assert.match(src, /const\s+publishVCard4\s*=/);
    assert.match(src, /const\s+queryVCard4\s*=/);
    assert.match(src, /publishVCard4,\s*queryVCard4/);
  });

  it('publishes to the urn:xmpp:vcard4 node with item id "current"', async () => {
    const src = await readSource('src/vcard-server.ts');
    assert.match(src, /publish",\s*\{\s*node:\s*VCARD4_PEP_NODE/);
    assert.match(src, /xml\("item",\s*\{\s*id:\s*"current"\s*\}/);
  });

  it('republishes vCard4 after a vcard-temp update', async () => {
    const src = await readSource('src/vcard-server.ts');
    assert.match(src, /if\s*\(updateSuccess\)\s*\{[\s\S]*?publishVCard4\(merged\)/);
  });
});

describe('Fix 2.14.5: on-connect publish (src/startXMPP.ts)', () => {
  it('publishes vCard4 unless cfg.vcard4.enabled === false', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /cfg\?\.vcard4\?\.enabled\s*!==\s*false/);
    assert.match(src, /vcardServer\.publishVCard4\(/);
  });
});

describe('Fix 2.14.5: capabilities + config', () => {
  it('config.ts advertises vcard4/avatar +notify', async () => {
    const src = await readSource('src/config.ts');
    assert.match(src, /urn:xmpp:vcard4\+notify/);
    assert.match(src, /urn:xmpp:avatar:metadata\+notify/);
    assert.match(src, /urn:xmpp:avatar:data\+notify/);
  });
  it('openclaw.plugin.json exposes vcard4 config', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"vcard4"/);
  });
  it('types.ts declares vcard4', async () => {
    const src = await readSource('src/types.ts');
    assert.match(src, /vcard4\?:\s*\{/);
  });
});

describe('Fix 2.14.5: CLI (src/commands.ts + src/vcard-cli.ts)', () => {
  it('registers openclaw xmpp vcard4', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.command\(\s*["']vcard4 \[action\]["']\s*\)/);
  });
  it('vcard-cli exports getVCard4/publishVCard4Now and republishes after changes', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.match(src, /export\s+async\s+function\s+getVCard4/);
    assert.match(src, /export\s+async\s+function\s+publishVCard4Now/);
    assert.match(src, /publishVCard4Via\(xmpp, vcard\)/);
  });
});
