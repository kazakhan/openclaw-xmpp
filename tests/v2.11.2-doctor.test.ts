// SECURITY (2.11.2, doctor): regression suite asserting the runtime-
// readiness guard is present.  OpenClaw launches a `.ts` extension via
// `node --import tsx`; `tsx` is a dev-only dependency, so a missing
// `dist/` + missing `tsx` crashes OpenClaw at startup with the cryptic
// "Cannot find package 'tsx'".  These helpers make that diagnosable.
//
// File-based (read source + assert regex) so it runs under plain
// `node --test` without a TS loader.

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

describe('Fix 2.11.2: runtime-readiness guard (src/onboarding.ts)', () => {
  it('exports diagnosePluginState and ensureDistBuilt', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /export\s+function\s+diagnosePluginState/);
    assert.match(src, /export\s+async\s+function\s+ensureDistBuilt/);
  });

  it('detects a missing dist/ as a problem', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /distExists\s*=\s*fs\.existsSync\(\s*path\.join\(\s*pluginDir\s*,\s*["']dist["']\s*\)\s*\)/);
    assert.match(src, /!distExists/);
  });

  it('reports the clear fix to rebuild dist/ (build script)', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /run\(process\.execPath, \[path\.join\("scripts", "build\.mjs"\)\]/);
    assert.match(src, /Rebuild the compiled output by running:\s+node scripts\/build\.mjs/);
  });

  it('rebuilds the missing dist when ensureDistBuilt runs the build', async () => {
    const src = await readSource('src/onboarding.ts');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(
      body,
      /ensureDistBuilt[\s\S]*?run\(\s*process\.execPath\s*,\s*\[path\.join\("scripts",\s*"build\.mjs"\)\]\s*,\s*pluginDir\s*,\s*["']build["']\s*\)/,
      'ensureDistBuilt must run scripts/build.mjs in the plugin directory.',
    );
  });

  it('detects tsx availability including the linked global SDK', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /tsxResolvable/);
    assert.match(src, /node_modules["']\s*,\s*["']tsx["']/);
  });
});

describe('Fix 2.11.2: openclaw xmpp doctor (src/commands.ts)', () => {
  it('registers a "doctor" subcommand', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.command\(\s*["']doctor["']\s*\)/);
    assert.match(src, /description\(\s*["']Diagnose the XMPP plugin install/);
  });

  it('delegates to diagnosePluginState / ensureDistBuilt', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /diagnosePluginState/);
    assert.match(src, /ensureDistBuilt/);
  });

  it('exposes --fix and --config flags', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.option\(\s*["']--fix["']/);
    assert.match(src, /\.option\(\s*["']--config <path>["']/);
  });
});

describe('Fix 2.11.2: installers auto-rebuild dist/', () => {
  it('ensurePluginInstalled still builds dist when missing', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(
      src,
      /if\s*\(\s*!fs\.existsSync\(\s*path\.join\(\s*dir\s*,\s*["']dist["'][\s\S]*?run\(process\.execPath, \[path\.join\("scripts", "build\.mjs"\)\]/,
      'ensurePluginInstalled must build dist when it is missing.',
    );
  });
});
