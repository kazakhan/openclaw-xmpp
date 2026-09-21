// SECURITY (2.18.1): Windows path hardening.
//
// 1. The message queue must never fall back to process.cwd() (the Windows
//    scheduled task's cwd is C:\Windows\System32 -> EPERM).
// 2. Rollback snapshots must live outside the extension dir; an in-tree
//    `_backups/` dir is walked by OpenClaw's plugin source capture and a
//    Windows reserved device entry (e.g. `nul`) fails the whole plugin load.
// 3. Non-bundled plugins need plugins.entries.xmpp.hooks.allowConversationAccess.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';

import { copyTree, isWindowsReservedName, defaultBackupRoot } from '../src/updater.ts';
import {
  findStaleInTreeBackupDirs,
  removeStaleInTreeBackups,
  enableConversationAccess,
  isConversationAccessEnabled,
} from '../src/lib/plugin-paths.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.18.1: queue never uses process.cwd()', () => {
  it('queue-bridge defaults to a homedir path, not cwd', async () => {
    const src = await readSource('src/queue-bridge.ts');
    assert.match(src, /export function defaultQueueDir\(\)/);
    assert.match(src, /os\.homedir\(\)/);
    assert.match(src, /const dir = dataDir \|\| defaultQueueDir\(\)/);
    assert.equal(/dataDir \|\| process\.cwd\(\)/.test(src), false);
  });

  it('gateway passes the account dataDir to the queue and never cwd', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /addToQueue\(\{[\s\S]*?\}, dataDir\)/);
    assert.match(src, /markAsProcessed\(messageId, dataDir\)/);
    assert.equal(/config\.dataDir \|\| path\.join\(process\.cwd\(\)/.test(src), false);
  });
});

describe('2.18.1: snapshots live outside the extension dir', () => {
  it('defaultBackupRoot is not inside the plugin dir', () => {
    const root = defaultBackupRoot();
    assert.match(root, /_backups/);
    assert.equal(root.includes(path.join('.openclaw', 'extensions')), false);
  });

  it('copyTree skips Windows reserved device names', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-reserved-src-'));
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-reserved-dest-'));
    try {
      await fs.writeFile(path.join(src, 'package.json'), '{}');
      await fs.writeFile(path.join(src, 'nul'), 'device');
      await fs.writeFile(path.join(src, 'con.txt'), 'device');
      await copyTree(src, dest, new Set(['node_modules']));
      assert.ok(await fs.stat(path.join(dest, 'package.json')));
      assert.equal(await exists(path.join(dest, 'nul')), false, 'nul must be skipped');
      assert.equal(await exists(path.join(dest, 'con.txt')), false, 'con.txt must be skipped');
    } finally {
      await fs.rm(src, { recursive: true, force: true });
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('isWindowsReservedName matches device names only', () => {
    for (const n of ['nul', 'NUL', 'con', 'aux', 'prn', 'com1', 'lpt9', 'nul.json', 'nul.txt.bak']) {
      assert.equal(isWindowsReservedName(n), true, `${n} should be reserved`);
    }
    for (const n of ['null', 'console', 'com0', 'lpt10', 'src', 'nulabc']) {
      assert.equal(isWindowsReservedName(n), false, `${n} should be allowed`);
    }
  });
});

describe('2.18.1: doctor finds/removes stale in-tree backups', () => {
  it('finds nested _backups/_trash dirs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-stale-'));
    try {
      await fs.mkdir(path.join(root, '_backups', '2.16.4_x'), { recursive: true });
      await fs.mkdir(path.join(root, 'tests', '_backups'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules', '_backups'), { recursive: true });
      const found = findStaleInTreeBackupDirs(root).sort();
      assert.equal(found.length, 2, `expected 2, got ${JSON.stringify(found)}`);
      assert.ok(found.some((p) => p.includes(path.join('tests', '_backups'))));
      assert.equal(found.some((p) => p.includes('node_modules')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removeStaleInTreeBackups deletes them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-stale-'));
    try {
      await fs.mkdir(path.join(root, '_backups', 'x'), { recursive: true });
      const removed = await removeStaleInTreeBackups(root);
      assert.equal(removed.length, 1);
      assert.equal(await exists(path.join(root, '_backups')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('2.18.1: conversation-access hook flag', () => {
  it('enableConversationAccess sets the nested flag', () => {
    const cfg: any = {};
    enableConversationAccess(cfg);
    assert.equal(cfg.plugins.entries.xmpp.hooks.allowConversationAccess, true);
    assert.equal(isConversationAccessEnabled(cfg), true);
    assert.equal(isConversationAccessEnabled({}), false);
  });

  it('doctor --fix wires the cleanup + flag', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /removeStaleInTreeBackups/);
    assert.match(src, /enableConversationAccess/);
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
