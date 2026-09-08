// SECURITY (2.11.1, onboarding): regression suite asserting the
// interactive onboarding wizard is present and wired correctly.
//
// The suite is file-based (read source + assert regex) so it runs under
// plain `node --test` without a TS loader, matching the style of the
// passing v2.1.x / v2.11.0 suites.

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

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Fix 2.11.1: onboarding wizard (src/onboarding.ts)', () => {
  it('exports runXmppOnboarding and mergeAccountConfig', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /export\s+async\s+function\s+runXmppOnboarding/);
    assert.match(src, /export\s+function\s+mergeAccountConfig/);
  });

  it('derives the config path from os.homedir() (cross-platform)', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /os\.homedir\(\s*\)/);
    assert.match(src, /path\.join\(\s*homedir\(\s*\)\s*,\s*["']\.openclaw["']\s*,\s*["']openclaw\.json["']\s*\)/);
  });

  it('masks the password prompt (never echoes plaintext)', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /promptSecret/);
    assert.match(src, /output\.write\s*\(\s*["']\*["']\s*\)/, 'secret prompt must write a masked char');
  });

  it('asks Keep / Override / Cancel when a config already exists', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /promptChoice/);
    assert.match(src, /["']keep["']\s*,\s*["']override["']\s*,\s*["']cancel["']/);
  });

  it('encrypts the password via encryptPasswordInConfig', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(
      src,
      /import\s*\{\s*encryptPasswordInConfig\s*\}\s*from\s*["']\.\/security\/encryption\.js["']/,
    );
    assert.match(src, /encryptPasswordInConfig\(\s*accountConfig\s*,\s*password\s*\)/);
  });

  it('preserves unrelated keys and other accounts on merge', async () => {
    const src = await readSource('src/onboarding.ts');
    const body = stripComments(src);
    assert.match(
      body,
      /merged\s*[:=][\s\S]*?\.\.\.\(\s*previous\s*\|\|\s*\{\}\s*\)\s*,\s*\.\.\.incoming/,
      'merge must spread previous account config before the new one to preserve unrelated keys.',
    );
    assert.match(body, /config\.channels\.xmpp\.accounts\[account\]\s*=\s*merged/);
  });
});

describe('Fix 2.11.1: openclaw xmpp setup subcommand (src/commands.ts)', () => {
  it('registers a "setup" subcommand', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.command\(\s*["']setup["']\s*\)/);
    assert.match(src, /description\(\s*["']Interactive onboarding/);
  });

  it('delegates to runXmppOnboarding', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /await\s+import\(\s*["']\.\/onboarding\.js["']\s*\)/);
    assert.match(src, /runXmppOnboarding\(\s*\{/);
  });

  it('exposes --config, --skip-install, and --account flags', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.option\(\s*["']--config <path>["']/);
    assert.match(src, /\.option\(\s*["']--skip-install["']/);
    assert.match(src, /\.option\(\s*["']--account <id>["']/);
  });
});

describe('Fix 2.11.1: secret-contract folds the password secret (src/secret-contract.ts)', () => {
  it('imports the shared channel-secret runtime helper', async () => {
    const src = await readSource('src/secret-contract.ts');
    assert.match(src, /openclaw\/plugin-sdk\/channel-secret-basic-runtime/);
  });

  it('registers the per-account password assignment', async () => {
    const src = await readSource('src/secret-contract.ts');
    assert.match(src, /collectSimpleChannelFieldAssignments\(\s*\{/);
    assert.match(src, /field:\s*["']password["']/);
    assert.match(src, /channelKey:\s*["']xmpp["']/);
  });

  it('keeps the password secretTargetRegistryEntry', async () => {
    const src = await readSource('src/secret-contract.ts');
    assert.match(src, /channels\.xmpp\.accounts\.\*\.password/);
    assert.match(src, /secretShape:\s*["']secret_input["']/);
  });
});

describe('Fix 2.11.1: installers invoke the wizard', () => {
  it('install.sh runs openclaw xmpp setup', async () => {
    const src = await readSource('install.sh');
    assert.match(src, /openclaw xmpp setup/);
  });

  it('install.ps1 runs openclaw xmpp setup with a --config path', async () => {
    const src = await readSource('install.ps1');
    assert.match(src, /openclaw xmpp setup --config \$configPath/);
    assert.match(src, /openclaw.json/);
  });
});
