// SECURITY (2.15.2): `openclaw xmpp vcard set <field>` must accept every field
// the write path supports.
//
// Root cause: the CLI whitelist (src/commands.ts) was never widened when the
// 2.14.6 work made all vCard fields settable, so the CLI rejected
// jabberid/mailer/note/uid/prodid/sortString/categories/geo/bday/tz even though
// its own help text (and chat + the write path) supported them.

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

function validFields(src: string): string[] {
  const m = src.match(/const\s+validFields\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error('validFields array not found');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

const EXPECTED = [
  'fn', 'nickname', 'url', 'desc', 'avatar',
  'bday', 'birthday', 'title', 'role',
  'tz', 'timezone', 'jabberid', 'jabber', 'mailer', 'note',
  'uid', 'prodid',
  'sortString', 'sortstring', 'sort-string', 'sort',
  'categories', 'category', 'geo',
];

describe('2.15.2: CLI vcard set whitelist covers the write path', () => {
  it('accepts every canonical field and alias', async () => {
    const fields = validFields(await readSource('src/commands.ts'));
    for (const f of EXPECTED) {
      assert.ok(fields.includes(f), `vcard set must accept "${f}"`);
    }
  });

  it('covers everything the write path actually maps', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    // Alias map + special-case handling in applySet.
    assert.match(src, /birthday:\s*"bday"/);
    assert.match(src, /timezone:\s*"tz"/);
    assert.match(src, /jabber:\s*"jabberid"/);
    assert.match(src, /"sort-string":\s*"sortString"/);
    assert.match(src, /f\s*===\s*"geo"/);
    assert.match(src, /categories/);
  });

  it('the CLI help text and the whitelist agree', async () => {
    const src = await readSource('src/commands.ts');
    const fields = validFields(src);
    // Every `vcard set <field>` advertised in the help block must be accepted.
    const helpFields = new Set<string>();
    for (const m of src.matchAll(/openclaw xmpp vcard set ([A-Za-z-]+)/g)) {
      helpFields.add(m[1]);
    }
    for (const f of helpFields) {
      if (f === 'avatar') continue; // handled by its own branch, still whitelisted
      assert.ok(fields.includes(f), `help advertises "${f}" but the whitelist rejects it`);
    }
  });
});
