// SECURITY (2.14.6, all vCard fields): regression suite.
//
// Root cause: the chat/agent write path (`updateVCardOnServer`) hand-built a
// vCard with only FN/NICKNAME/URL/DESC/PHOTO, so EMAIL/TEL/ADR/ORG/... never
// persisted.  File-based (read source + assert regex).

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

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Fix 2.14.6: write path persists ALL fields (src/vcard-server.ts)', () => {
  it('updateVCardOnServer builds via buildVCardStanza', async () => {
    const src = await readSource('src/vcard-server.ts');
    assert.match(src, /import\s*\{[^}]*buildVCardStanza[^}]*\}\s*from\s*["']\.\/lib\/vcard-protocol\.js["']/);
    assert.match(src, /const\s+vcardSet\s*=\s*buildVCardStanza\(\s*merged\s*,\s*vcardId\s*\)/);
  });

  it('no longer hand-builds a limited FN/NICKNAME/URL/DESC stanza', async () => {
    const code = stripComments(await readSource('src/vcard-server.ts'));
    // The old hand-built stanza listed these as direct xml("vCard"...) children.
    assert.equal(
      /xml\("vCard",\s*\{\s*xmlns:\s*"vcard-temp"\s*\}[\s\S]*?xml\("FN"/.test(code),
      false,
      'updateVCardOnServer must not hand-build a vCard with a limited field list',
    );
  });
});

describe('Fix 2.14.6: chat /vcard set covers all fields (src/slash-commands.ts)', () => {
  it('maps every scalar/complex field', async () => {
    const src = await readSource('src/slash-commands.ts');
    for (const f of ['fn', 'nickname', 'url', 'desc', 'bday', 'title', 'role', 'tz', 'jabberid', 'mailer', 'note', 'uid', 'prodid', 'sortString', 'categories', 'geo']) {
      assert.match(src, new RegExp(`updates\\.${f}\\b`), `chat set must map ${f}`);
    }
    assert.match(src, /case 'birthday':/);
    assert.match(src, /case 'timezone':/);
  });

  it('persists locally via vcard.update(updates)', async () => {
    const src = await readSource('src/slash-commands.ts');
    assert.match(src, /await\s+vcard\.update\(\s*updates\s*\)/);
  });
});

describe('Fix 2.14.6: CLI setVCard covers all fields (src/vcard-cli.ts)', () => {
  it('normalizes aliases and handles geo/categories', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.match(src, /birthday:\s*'bday'/);
    assert.match(src, /timezone:\s*'tz'/);
    assert.match(src, /'sort-string':\s*'sortString'/);
    assert.match(src, /vcard as any\)\.geo\s*=\s*\{\s*lat/);
    assert.match(src, /vcard as any\)\.categories\s*=/);
  });
});

describe('Fix 2.14.6: parser reads all ORGUNIT (src/lib/vcard-protocol.ts)', () => {
  it('uses getChildren(ORGUNIT)', async () => {
    const src = await readSource('src/lib/vcard-protocol.ts');
    assert.match(src, /getChildren\('ORGUNIT'\)/);
  });
});

describe('Fix 2.14.6: vCard4 carries geo + jabberid (src/lib/vcard4-protocol.ts)', () => {
  it('maps jabberid -> impp and geo -> geo', async () => {
    const src = await readSource('src/lib/vcard4-protocol.ts');
    assert.match(src, /xml\("impp",\s*\{\},\s*xml\("uri"/);
    assert.match(src, /xml\("geo",\s*\{\},\s*xml\("uri"/);
  });
});
