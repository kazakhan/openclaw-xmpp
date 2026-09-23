// SECURITY (2.18.6): bundle dist correctly AND keep OpenClaw's plugin
// source-capture small.
//
// 2.18.5 bundled the entries but the esbuild ESM output could not load:
//   Error: Dynamic require of "events" is not supported
// because CJS `require()` is rewritten to esbuild's `__require` shim unless a
// real `require` exists.  And bundling alone did not shrink the capture: the
// capture walks the *declared* dependency tree, so `@xmpp/client` + `typebox`
// must move to devDependencies and node_modules be pruned.
//
// 2.18.6 fixes both: a `createRequire` banner + two-phase build/swap, inlined
// deps moved to devDependencies, a prune step, and stale plugin-build temp-dir
// cleanup.

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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('2.18.6: bundled build (loadable + small capture)', () => {
  it('build script bundles the entries with the right externals', async () => {
    const src = await readSource('scripts/build.mjs');
    for (const entry of [
      'index',
      'setup-entry',
      'channel-plugin-api',
      'secret-contract-api',
      'runtime-setter-api',
      'setup-plugin-api',
    ]) {
      assert.ok(src.includes(`"${entry}"`), `build must bundle ${entry}`);
    }
    for (const ext of ['openclaw', '@openclaw/*', 'ssh2', 'cpu-features']) {
      assert.ok(src.includes(`"${ext}"`), `build must mark ${ext} external`);
    }
    assert.match(src, /format:\s*"esm"/);
    assert.match(src, /platform:\s*"node"/);
  });

  it('adds a createRequire banner so the ESM bundle can load', async () => {
    const src = await readSource('scripts/build.mjs');
    assert.match(src, /createRequire/);
    assert.match(src, /banner:\s*\{\s*js:/);
    // the banner must be verified before a bundle is swapped in
    assert.match(src, /bundle is missing the createRequire banner/);
  });

  it('builds all entries before swapping any in (two-phase)', async () => {
    const src = await readSource('scripts/build.mjs');
    assert.match(src, /const built\s*=\s*\[\]/);
    assert.match(src, /built\.push\(/);
    assert.match(src, /for \(const \{ name, entry, out \} of built\)/);
  });

  it('moves inlined pure-JS deps out of dependencies', async () => {
    const pkg = JSON.parse(await readSource('package.json'));
    assert.equal(pkg.dependencies.ssh2, '^1.15.0', 'ssh2 stays a runtime dependency');
    assert.ok(!pkg.dependencies['@xmpp/client'], '@xmpp/client must not be a runtime dependency');
    assert.ok(!pkg.dependencies.typebox, 'typebox must not be a runtime dependency');
    assert.ok(pkg.devDependencies['@xmpp/client'], '@xmpp/client must be a devDependency');
    assert.ok(pkg.devDependencies.typebox, 'typebox must be a devDependency');
    assert.ok(pkg.devDependencies.esbuild, 'esbuild must be a devDependency');
    assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
  });

  it('prunes devDeps and cleans plugin-build temp dirs', async () => {
    const build = await readSource('scripts/build.mjs');
    assert.match(build, /npm",\s*\["prune",\s*"--omit=dev"/);
    assert.match(build, /clean-plugin-build-temp\.mjs/);

    const cleanup = await readSource('scripts/clean-plugin-build-temp.mjs');
    assert.match(cleanup, /openclaw-plugin-build-/);
    assert.match(cleanup, /OPENCLAW_XMPP_TEMP_GRACE_MS/);

    const sh = await readSource('install.sh');
    const ps1 = await readSource('install.ps1');
    assert.match(sh, /npm prune --omit=dev/);
    assert.match(ps1, /npm prune --omit=dev/);
    assert.match(sh, /clean-plugin-build-temp\.mjs/);
    assert.match(ps1, /clean-plugin-build-temp\.mjs/);

    const updater = await readSource('src/updater.ts');
    assert.match(updater, /"prune",\s*"--omit=dev"/);
    assert.match(updater, /clean-plugin-build-temp\.mjs/);

    const onboarding = await readSource('src/onboarding.ts');
    assert.match(onboarding, /"prune",\s*"--omit=dev"/);
    assert.match(onboarding, /clean-plugin-build-temp\.mjs/);
  });

  it('installers run the build script (not bare tsc)', async () => {
    const sh = await readSource('install.sh');
    const ps1 = await readSource('install.ps1');
    assert.match(sh, /scripts\/build\.mjs/);
    assert.match(ps1, /scripts\\build\.mjs/);
  });

  it('built dist/index.js inlines typebox/@xmpp, keeps openclaw external, and is loadable', async () => {
    const entry = path.join(ROOT, 'dist', 'index.js');
    if (!(await exists(entry))) return; // not built in this checkout
    const src = await fs.readFile(entry, 'utf8');
    assert.equal(/from "typebox"/.test(src), false, 'typebox must be inlined');
    assert.equal(/from "@xmpp\/client"/.test(src), false, '@xmpp/client must be inlined');
    assert.match(src, /from "openclaw\//, 'openclaw SDK must stay external');
    // SECURITY (2.18.6): the createRequire banner must be present, otherwise the
    // __require shim throws `Dynamic require of "events" is not supported`.
    assert.ok(src.includes('openclaw-xmpp:createRequire'), 'bundle must carry the createRequire banner');
  });
});
