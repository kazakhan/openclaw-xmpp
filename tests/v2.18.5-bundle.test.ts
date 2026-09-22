// SECURITY (2.18.5): bundle dist so OpenClaw's plugin source-capture is small.
//
// OpenClaw 2026.9.5 added a plugin source-capture step that Babel-parses the
// plugin's whole transitive module graph on load.  Unbundled, that drags
// `typebox` (~1,400 files) and `@xmpp/*` (~180 files) through the parser, taking
// ~90 s per load and exceeding the 120 s model-runtime build timeout.  The build
// now bundles each entry with esbuild, inlining pure-JS deps and keeping
// host-provided/native modules external.

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

describe('2.18.5: bundled build', () => {
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

  it('package.json wires the build script + esbuild', async () => {
    const pkg = JSON.parse(await readSource('package.json'));
    assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
    assert.ok(pkg.devDependencies.esbuild, 'esbuild must be a devDependency');
  });

  it('installers run the build script (not bare tsc)', async () => {
    const sh = await readSource('install.sh');
    const ps1 = await readSource('install.ps1');
    assert.match(sh, /scripts\/build\.mjs/);
    assert.match(ps1, /scripts\\build\.mjs/);
  });

  it('built dist/index.js inlines typebox/@xmpp and keeps openclaw external', async () => {
    const entry = path.join(ROOT, 'dist', 'index.js');
    if (!(await exists(entry))) return; // not built in this checkout
    const src = await fs.readFile(entry, 'utf8');
    assert.equal(/from "typebox"/.test(src), false, 'typebox must be inlined');
    assert.equal(/from "@xmpp\/client"/.test(src), false, '@xmpp/client must be inlined');
    assert.match(src, /from "openclaw\//, 'openclaw SDK must stay external');
  });
});
