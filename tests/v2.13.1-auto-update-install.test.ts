// SECURITY (2.13.1, auto-update ask/install): regression suite asserting the
// auto-updater now ASKS the admin and installs on "yes" (rather than
// notify-only).
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

describe('Fix 2.13.1: updater prompt helpers (src/updater.ts)', () => {
  it('exports the prompt/restart helpers', async () => {
    const src = await readSource('src/updater.ts');
    for (const fn of ['isAffirmative', 'isNegative', 'formatAskMessage', 'restartGateway']) {
      assert.match(src, new RegExp(`export\\s+function\\s+${fn}`), `must export ${fn}`);
    }
  });

  it('the ask message tells the admin to reply yes/no', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /Reply "yes" to install it now, or "no" to skip/);
  });

  it('restartGateway spawns a detached `openclaw gateway restart`', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /spawn\(/);
    assert.match(src, /\["gateway",\s*"restart"\]/);
    assert.match(src, /detached:\s*true/);
  });
});

describe('Fix 2.13.1: gateway asks + installs (src/startXMPP.ts)', () => {
  it('tracks a pendingUpdate prompt', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /let\s+pendingUpdate/);
    assert.match(src, /UPDATE_PROMPT_TTL_MS/);
    assert.match(src, /pendingUpdate\s*=\s*null/);
  });

  it('sends the ask (not a notify-only command) on a newer release', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /formatAskMessage/);
    assert.match(src, /asked admins to install/);
  });

  it('checks shortly after connect as well as on the interval', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /setTimeout\(\s*runUpdateCheck,\s*60\s*\*\s*1000\s*\)/);
  });

  it('intercepts admin yes/no replies before AI dispatch', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /isAffirmative\(text\)/);
    assert.match(src, /isNegative\(text\)/);
    assert.match(src, /performUpdate\(\)/);
    assert.match(src, /isAdminSender/);
  });

  it('installs and restarts the gateway on yes', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /autoUpdate\?\.autoRestart\s*!==\s*false/);
    assert.match(src, /restartGateway\(\)/);
  });

  it('supports mode "auto" (install without asking)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /autoMode/);
    assert.match(src, /mode\s*=\s*auto/);
  });
});

describe('Fix 2.13.1: autoUpdate config gains mode + autoRestart', () => {
  it('types.ts', async () => {
    const src = await readSource('src/types.ts');
    assert.match(src, /mode\?:\s*"ask"\s*\|\s*"auto"/);
    assert.match(src, /autoRestart\?:/);
  });
  it('channel-plugin.ts', async () => {
    const src = await readSource('src/channel-plugin.ts');
    assert.match(src, /enum:\s*\["ask",\s*"auto"\]/);
    assert.match(src, /autoRestart:\s*\{\s*type:\s*"boolean"/);
  });
  it('openclaw.plugin.json', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"autoRestart"/);
    assert.match(src, /"ask",\s*"auto"/);
  });
});
