// SECURITY (2.18.7): Windows spawn planning for paths with spaces + cmd quoting.
//
// 2.18.5 broke every Windows update by running `process.execPath` (e.g.
// `C:\Program Files\nodejs\node.exe`) through `cmd.exe /d /s /c`.  With `/s`,
// cmd strips the outer quotes and splits at the first space, so it tried to run
// `C:\Program`:
//   build failed: 'C:\Program' is not recognized as an internal or external command
// 2.18.7 spawns real executables directly and only uses cmd for shims.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { buildSpawnPlan, quoteWinArg, isWinShellShim } from '../src/lib/win-args.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.18.7: Windows spawn planning (spaces)', () => {
  it('spawns an absolute real executable directly (no cmd)', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const plan = buildSpawnPlan(node, ['scripts\\build.mjs'], 'win32', 'cmd.exe');
    assert.equal(plan.mode, 'direct');
    assert.equal(plan.file, node);
    assert.deepEqual(plan.args, ['scripts\\build.mjs']);
    assert.equal(plan.windowsVerbatimArguments, undefined);
  });

  it('routes bare shims / .cmd through cmd with a pre-quoted line', () => {
    const plan = buildSpawnPlan('npm.cmd', ['run', 'build'], 'win32', 'cmd.exe');
    assert.equal(plan.mode, 'shell');
    assert.equal(plan.file, 'cmd.exe');
    assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(plan.args[3], 'npm.cmd run build');
    assert.equal(plan.windowsVerbatimArguments, true);
  });

  it('quotes arguments containing spaces for cmd', () => {
    const plan = buildSpawnPlan(
      'git',
      ['clone', 'https://x/y.git', 'C:\\Users\\a b\\xmpp'],
      'win32',
      'cmd.exe',
    );
    assert.equal(plan.mode, 'shell');
    assert.equal(plan.args[3], 'git clone https://x/y.git "C:\\Users\\a b\\xmpp"');
  });

  it('spawns directly on posix', () => {
    const plan = buildSpawnPlan('/usr/bin/node', ['x.mjs'], 'linux');
    assert.equal(plan.mode, 'direct');
    assert.equal(plan.file, '/usr/bin/node');
    assert.equal(plan.windowsVerbatimArguments, undefined);
  });

  it('isWinShellShim classifies commands', () => {
    assert.equal(isWinShellShim('npm.cmd'), true);
    assert.equal(isWinShellShim('npx'), true);
    assert.equal(isWinShellShim('git'), true);
    assert.equal(isWinShellShim('C:\\Program Files\\nodejs\\node.exe'), false);
    assert.equal(isWinShellShim('C:\\Program Files\\nodejs\\npm.cmd'), true);
    assert.equal(isWinShellShim('\\\\server\\share\\node.exe'), false);
  });

  it('quoteWinArg follows cmd rules', () => {
    assert.equal(quoteWinArg('plain'), 'plain');
    assert.equal(quoteWinArg('has space'), '"has space"');
    assert.equal(quoteWinArg(''), '""');
    assert.equal(quoteWinArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  });
});

describe('2.18.7: updater/onboarding/build use the safe spawn plan', () => {
  it('updater builds via npm (not process.execPath) and uses buildSpawnPlan', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /buildSpawnPlan/);
    assert.match(src, /run\(exe\("npm"\), \["run", "build"\]/);
    assert.equal(
      /run\(process\.execPath, \[path\.join\("scripts", "build\.mjs"\)\]/.test(src),
      false,
      'must not spawn process.execPath for the build (breaks on spaced Windows paths)',
    );
  });

  it('onboarding builds via npm and uses buildSpawnPlan', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /buildSpawnPlan/);
    assert.match(src, /run\("npm", \["run", "build"\]/);
    assert.equal(
      /run\(process\.execPath, \[path\.join\("scripts", "build\.mjs"\)\]/.test(src),
      false,
      'must not spawn process.execPath for the build',
    );
  });

  it('build.mjs uses the shared win-args helper', async () => {
    const src = await readSource('scripts/build.mjs');
    assert.match(src, /win-args\.mjs/);
    assert.match(src, /buildSpawnPlan/);
  });

  it('scripts/win-args.mjs mirrors src/lib/win-args.ts', async () => {
    const mjs = await readSource('scripts/win-args.mjs');
    assert.match(mjs, /export function buildSpawnPlan/);
    assert.match(mjs, /export function quoteWinArg/);
  });
});
