// SECURITY (2.12.0, auto-update): regression suite asserting the auto-update
// mechanism is present and wired: a periodic GitHub release check that notifies
// the admin (notify-only) plus `openclaw xmpp update-check` / `openclaw xmpp
// update` commands, with config `autoUpdate`.
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

describe('Fix 2.12.0: updater module (src/updater.ts)', () => {
  it('exports the updater functions', async () => {
    const src = await readSource('src/updater.ts');
    for (const fn of [
      'getCurrentVersion',
      'getLatestRelease',
      'isNewer',
      'checkForUpdate',
      'notifyUpdateAvailable',
      'performUpdate',
    ]) {
      assert.match(src, new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}`), `must export ${fn}`);
    }
  });

  it('checks the GitHub releases/latest endpoint for the repo', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /api\.github\.com\/repos\//);
    assert.match(src, /kazakhan\/openclaw-xmpp/);
    assert.match(src, /releases\/latest/);
  });

  it('uses a source tarball to update (works for copied installs too)', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /archive\/refs\/tags\/\$\{tag\}\.tar\.gz/);
    assert.match(src, /tar.*-xzf/);
  });

  it('refuses to update a dirty git tree', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /uncommitted changes; refusing to update/);
    assert.match(src, /isGitDirty/);
  });

  it('snapshots the plugin dir before updating (rollback)', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /snapshotPlugin/);
    assert.match(src, /restoreSnapshot/);
    assert.match(src, /_backups/);
  });

  it('preserves data/ and config by excluding them from copy', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /EXCLUDE_DIRS/);
    assert.match(src, /"data"/);
  });

  it('notifies admins with the update command (notify-only, no auto-install)', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /openclaw xmpp update/);
    assert.match(src, /openclaw xmpp update`/);
  });
});

describe('Fix 2.12.0: CLI commands (src/commands.ts)', () => {
  it('registers update-check and update subcommands', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.command\(\s*["']update-check["']\s*\)/);
    assert.match(src, /\.command\(\s*["']update["']\s*\)/);
  });

  it('delegates to the updater module', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.\/updater\.js/);
    assert.match(src, /performUpdate/);
    assert.match(src, /checkForUpdate/);
  });

  it('supports --yes and --dry-run', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /--yes/);
    assert.match(src, /--dry-run/);
  });
});

describe('Fix 2.12.0: periodic check in gateway (src/startXMPP.ts)', () => {
  it('arms an auto-update interval in the online handler', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /autoUpdateTimer/);
    assert.match(src, /setInterval\(\s*runUpdateCheck/);
    assert.match(src, /\.\/updater\.js/);
  });

  it('clears the timer on offline', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /clearInterval\(\s*autoUpdateTimer\s*\)/);
  });

  it('respects an autoUpdate.enabled=false opt-out', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /autoUpdate\.enabled\s*!==\s*false/);
    assert.match(src, /intervalHours\s*\|\|\s*6/);
  });
});

describe('Fix 2.12.0: autoUpdate config schema', () => {
  it('openclaw.plugin.json exposes autoUpdate on the account', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"autoUpdate"/);
    assert.match(src, /intervalHours/);
  });

  it('channel-plugin.ts exposes autoUpdate in configSchema', async () => {
    const src = await readSource('src/channel-plugin.ts');
    assert.match(src, /autoUpdate:/);
    assert.match(src, /intervalHours:\s*\{\s*type:\s*"number"/);
  });

  it('types.ts declares autoUpdate on XmppConfig', async () => {
    const src = await readSource('src/types.ts');
    assert.match(src, /autoUpdate\?:\s*\{/);
    assert.match(src, /intervalHours\?:/);
  });
});
