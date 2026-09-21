// SECURITY (2.18.2): pre-load repair for a bricked Windows install.
//
// OpenClaw captures plugin source by walking the extension dir; an in-tree
// `_backups/` snapshot with a Windows reserved device entry (`nul`) fails the
// whole plugin load, so the plugin cannot self-heal.  The repair must run
// OUTSIDE the plugin load: the postinstall script and the installers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { purgeInTreeBackups } from '../src/updater.ts';
import { removeStaleInTreeBackups } from '../src/lib/plugin-paths.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('2.18.2: updater purges in-tree backups', () => {
  it('purgeInTreeBackups removes _backups and _trash', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-purge-'));
    try {
      await fs.mkdir(path.join(root, '_backups', '2.16.4_x'), { recursive: true });
      await fs.mkdir(path.join(root, '_trash'), { recursive: true });
      await fs.writeFile(path.join(root, '_backups', '2.16.4_x', 'nul'), 'device');
      const removed = purgeInTreeBackups(root).sort();
      assert.equal(removed.length, 2, `expected 2, got ${JSON.stringify(removed)}`);
      assert.equal(await exists(path.join(root, '_backups')), false);
      assert.equal(await exists(path.join(root, '_trash')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('plugin-paths removeStaleInTreeBackups handles a nested _backups with nul', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-purge-'));
    try {
      await fs.mkdir(path.join(root, 'tests', '_backups'), { recursive: true });
      await fs.writeFile(path.join(root, 'tests', '_backups', 'nul'), 'device');
      const removed = await removeStaleInTreeBackups(root);
      assert.equal(removed.length, 1);
      assert.equal(await exists(path.join(root, 'tests', '_backups')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('2.18.2: postinstall purge script', () => {
  it('is wired into postinstall before the SDK link', async () => {
    const pkg = JSON.parse(await readSource('package.json'));
    assert.match(pkg.scripts.postinstall, /purge-in-tree-backups\.mjs/);
    assert.ok(
      pkg.scripts.postinstall.indexOf('purge-in-tree-backups.mjs') <
        pkg.scripts.postinstall.indexOf('link-openclaw-sdk.mjs'),
      'purge must run before the SDK link',
    );
  });

  it('removes an in-tree _backups/nul when run (end to end)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-script-'));
    try {
      await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
      await fs.copyFile(
        path.join(ROOT, 'scripts', 'purge-in-tree-backups.mjs'),
        path.join(root, 'scripts', 'purge-in-tree-backups.mjs'),
      );
      await fs.mkdir(path.join(root, '_backups', '2.16.4_x'), { recursive: true });
      await fs.writeFile(path.join(root, '_backups', '2.16.4_x', 'nul'), 'device');
      await fs.writeFile(path.join(root, 'nul'), 'device');
      execFileSync(process.execPath, [path.join(root, 'scripts', 'purge-in-tree-backups.mjs')], {
        stdio: 'pipe',
      });
      assert.equal(await exists(path.join(root, '_backups')), false, '_backups must be removed');
      assert.equal(await exists(path.join(root, 'nul')), false, 'root nul must be removed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses the \\\\?\\ prefix on win32', async () => {
    const src = await readSource('scripts/purge-in-tree-backups.mjs');
    assert.match(src, /\\\\\\\\\?\\\\/);
  });
});

describe('2.18.2: installers repair before install', () => {
  it('install.sh purges in-tree backups', async () => {
    const src = await readSource('install.sh');
    assert.match(src, /_backups/);
    assert.match(src, /_trash/);
    assert.match(src, /allowConversationAccess/);
  });

  it('install.ps1 purges in-tree backups with the \\\\?\\ prefix', async () => {
    const src = await readSource('install.ps1');
    assert.match(src, /_backups/);
    assert.match(src, /cmd \/c rd \/s \/q "\\\\\?\\/);
    assert.match(src, /allowConversationAccess/);
  });

  it('fix-openclaw-xmpp scripts purge too', async () => {
    const ps1 = await readSource('fix-openclaw-xmpp.ps1');
    const mjs = await readSource('fix-openclaw-xmpp.mjs');
    assert.match(ps1, /_backups/);
    assert.match(mjs, /purgeInTreeBackups/);
  });
});
