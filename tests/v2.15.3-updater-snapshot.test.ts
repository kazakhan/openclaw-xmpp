// SECURITY (2.15.3): `openclaw xmpp update` snapshot regression.
//
// Root cause: snapshotPlugin copied the plugin into `<pluginDir>/_backups/…`,
// a subdirectory of the copy source.  Node's `fs.cp` rejects that with
// `ERR_FS_CP_EINVAL: Cannot copy <src> to a subdirectory of self` BEFORE the
// EXCLUDE_DIRS filter runs, so `openclaw xmpp update` always failed at the
// snapshot step (update-check / dry-run was unaffected).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { snapshotPlugin } from '../src/updater.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fsp.readFile(path.join(__dirname, '..', rel), 'utf8');
}

async function makePluginDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xmpp-plugin-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "openclaw-xmpp", version: "2.15.2" }));
  await fsp.mkdir(path.join(dir, "src"), { recursive: true });
  await fsp.writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
  for (const d of ["node_modules/pkg", "dist", "data", "_backups/old", "_trash"]) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
    await fsp.writeFile(path.join(dir, d, "junk.txt"), "junk\n");
  }
  return dir;
}

describe('2.15.3: updater snapshot no longer throws EINVAL', () => {
  it('snapshots into <pluginDir>/_backups without ERR_FS_CP_EINVAL', async () => {
    const dir = await makePluginDir();
    const dest = path.join(dir, "_backups", "2.15.2_test");
    try {
      await snapshotPlugin(dir, dest); // threw ERR_FS_CP_EINVAL before the fix
      assert.ok(fs.existsSync(dest), "snapshot directory must exist");
      assert.ok(fs.existsSync(path.join(dest, "package.json")), "snapshot must include package.json");
      assert.ok(fs.existsSync(path.join(dest, "src", "index.ts")), "snapshot must include src/");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('excludes node_modules/dist/data/_backups/_trash from the snapshot', async () => {
    const dir = await makePluginDir();
    const dest = path.join(dir, "_backups", "2.15.2_test");
    try {
      await snapshotPlugin(dir, dest);
      for (const excluded of ["node_modules", "dist", "data", "_backups", "_trash"]) {
        assert.equal(
          fs.existsSync(path.join(dest, excluded)),
          false,
          `snapshot must not include ${excluded}/`,
        );
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('stages outside the source tree before placing the snapshot', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /export\s+async\s+function\s+snapshotPlugin/);
    assert.match(src, /mkdtemp\(/);
    assert.match(src, /rename\(staging,\s*dest\)/);
  });
});
