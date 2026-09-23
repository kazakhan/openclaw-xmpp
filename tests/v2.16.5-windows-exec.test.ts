// SECURITY (2.16.5): Windows / Node >=18.20.2 updater fixes.
//
// 1. `.cmd`/`.bat` shims (npm.cmd/npx.cmd/openclaw.cmd) can't be spawned without
//    a shell (CVE-2024-27980) → EINVAL.  Use `cmd.exe /d /s /c`.
//    SECURITY (2.18.7): real executables (process.execPath) are spawned
//    directly — see `src/lib/win-args.ts`.
// 2. tsc exits non-zero on type-only errors but still emits (noEmitOnError:false)
//    → treat as non-fatal when dist/index.js exists.
// 3. The release tag goes into a shell command line → validate it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { isSafeUpdateTag } from '../src/updater.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.16.5: release tag validation', () => {
  it('accepts normal semver tags', () => {
    for (const tag of ['2.16.5', 'v2.16.5', '2.16.5-rc.1', '2.0.0_beta', '1.2.3.4']) {
      assert.equal(isSafeUpdateTag(tag), true, `expected safe: ${tag}`);
    }
  });

  it('rejects shell metacharacters / whitespace / empty', () => {
    for (const tag of ['', '  ', '2.16.5; rm -rf /', 'a b', '$(id)', '`id`', 'a|b', 'a&b', 'a>b', '"x"', "a'b"]) {
      assert.equal(isSafeUpdateTag(tag), false, `expected unsafe: ${JSON.stringify(tag)}`);
    }
  });
});

describe('2.16.5: Windows-safe exec', () => {
  it('updater.run plans a Windows-safe spawn (cmd only for shims)', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /process\.platform === "win32"/);
    assert.match(src, /buildSpawnPlan/);
    assert.match(src, /windowsVerbatimArguments/);
  });

  it('updater.restartGateway uses cmd.exe on win32 (no bare .cmd spawn)', async () => {
    const src = await readSource('src/updater.ts');
    assert.equal(/spawn\(\s*"openclaw\.cmd"/.test(src), false);
    assert.match(src, /spawn\(comspec,\s*\["\/d",\s*"\/s",\s*"\/c",\s*"openclaw",\s*"gateway",\s*"restart"\]/);
  });

  it('onboarding.run plans a Windows-safe spawn (cmd only for shims)', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /process\.platform === "win32"/);
    assert.match(src, /buildSpawnPlan/);
    assert.match(src, /windowsVerbatimArguments/);
  });
});

describe('2.16.5/2.18.6: build non-zero is tolerated when dist is emitted', () => {
  it('updater tolerates build failure with dist/index.js', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /if\s*\(!fs\.existsSync\(path\.join\(dir,\s*"dist",\s*"index\.js"\)\)\)\s*throw buildErr/);
    assert.match(src, /\["run",\s*"build"\]/);
  });

  it('onboarding tolerates build failure with dist/index.js', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /if\s*\(!fs\.existsSync\(path\.join\(pluginDir,\s*"dist",\s*"index\.js"\)\)\)\s*throw buildErr/);
    assert.match(src, /\["run",\s*"build"\]/);
  });

  it('updater validates the tag before use', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /if\s*\(!isSafeUpdateTag\(latest\)\)/);
  });
});
