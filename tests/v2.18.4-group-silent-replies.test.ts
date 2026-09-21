// SECURITY (2.18.4): group replies must be OPTIONAL.
//
// OpenClaw requires an explicit silent-reply opt-in for accepted group/channel
// requests.  Without `surfaces.xmpp.silentReply.group = "allow"` every room
// message requires a reply, so the agent answers everything (including the
// other bot's messages) and rooms loop.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  isGroupSilentRepliesEnabled,
  enableGroupSilentReplies,
} from '../src/lib/plugin-paths.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

describe('2.18.4: group silent-reply policy', () => {
  it('enables surfaces.xmpp.silentReply.group = allow', () => {
    const cfg: any = {};
    enableGroupSilentReplies(cfg);
    assert.equal(cfg.surfaces.xmpp.silentReply.group, 'allow');
    assert.equal(cfg.surfaces.xmpp.silentReply.internal, 'allow');
    assert.equal(isGroupSilentRepliesEnabled(cfg), true);
  });

  it('detects a missing policy', () => {
    assert.equal(isGroupSilentRepliesEnabled({}), false);
    assert.equal(isGroupSilentRepliesEnabled({ surfaces: { xmpp: {} } }), false);
    assert.equal(
      isGroupSilentRepliesEnabled({ surfaces: { xmpp: { silentReply: { group: 'disallow' } } } }),
      false,
    );
  });

  it('does not clobber unrelated surfaces/config', () => {
    const cfg: any = { surfaces: { telegram: { silentReply: { group: 'disallow' } } }, foo: 1 };
    enableGroupSilentReplies(cfg);
    assert.equal(cfg.surfaces.telegram.silentReply.group, 'disallow');
    assert.equal(cfg.foo, 1);
  });
});

describe('2.18.4: setup / doctor / installers wire the policy', () => {
  it('onboarding enables it on setup', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /enableGroupSilentReplies\(merged\)/);
    assert.match(src, /groupSilentRepliesAllowed/);
  });

  it('doctor reports and fixes it', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /isGroupSilentRepliesEnabled/);
    assert.match(src, /enableGroupSilentReplies/);
  });

  it('the plugin registers a config migration', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /registerConfigMigration/);
    assert.match(src, /enableGroupSilentReplies/);
  });

  it('installers set the policy', async () => {
    const sh = await readSource('install.sh');
    const ps1 = await readSource('install.ps1');
    assert.match(sh, /surfaces\.xmpp\.silentReply\.group allow/);
    assert.match(ps1, /surfaces\.xmpp\.silentReply\.group allow/);
  });
});
