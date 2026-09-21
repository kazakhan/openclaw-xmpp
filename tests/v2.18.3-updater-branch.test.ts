// SECURITY (2.18.3): the updater must not leave the repo in detached HEAD.
//
// `git checkout v<tag>` detaches HEAD, so a later manual `git pull` fails with
// "You are not currently on a branch".  The updater now checks the release out
// on `main` (`git checkout -B main v<tag>`) and sets the upstream best-effort.

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

describe('2.18.3: updater checks out on a branch, not detached HEAD', () => {
  it('uses git checkout -B main v<tag>', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /\["checkout",\s*"-B",\s*"main",\s*`v\$\{latest\}`\]/);
  });

  it('sets the upstream best-effort so git pull works', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /--set-upstream-to=origin\/main/);
  });

  it('keeps a detached-checkout fallback for unusual layouts', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /\["checkout",\s*`v\$\{latest\}`\]/);
  });
});
