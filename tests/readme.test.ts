// SECURITY (2.15.2): README freshness guard.
//
// The README has repeatedly shipped stale (wrong version, non-existent CLI
// commands, wrong XEP references).  This suite fails when it drifts from the
// code, so `node --test` catches it at release time (see AGENTS.md step 3).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.15.2: README is current', () => {
  it('advertises the current package.json version', async () => {
    const pkg = JSON.parse(await read('package.json'));
    const readme = await read('README.md');
    assert.match(
      readme,
      new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`),
      `README must mention the current version v${pkg.version} (Status header)`,
    );
  });

  it('documents the current CLI commands', async () => {
    const readme = await read('README.md');
    for (const cmd of [
      'openclaw xmpp setup',
      'openclaw xmpp doctor',
      'openclaw xmpp presence',
      'openclaw xmpp vcard4',
      'openclaw xmpp sftp',
      'openclaw xmpp update-check',
    ]) {
      assert.ok(readme.includes(cmd), `README must document \`${cmd}\``);
    }
  });

  it('documents the current slash commands and tools', async () => {
    const readme = await read('README.md');
    for (const token of ['/presence', '/status', 'xmpp_setPresence', 'xmpp_sftp']) {
      assert.ok(readme.includes(token), `README must mention ${token}`);
    }
  });

  it('documents the presence config block', async () => {
    const readme = await read('README.md');
    assert.match(readme, /"presence"\s*:\s*\{/);
    assert.ok(readme.includes('thinkingStatus') || readme.includes('thinkingShow'));
  });

  it('does not re-introduce known-wrong/removed content', async () => {
    const readme = await read('README.md');
    const forbidden = [
      'openclaw xmpp upload ', // never existed; it is `xmpp sftp upload`
      'vcard-cli.ts', // deleted in 2.14.7
      'whiteboard-cli.ts', // deleted in 2.14.7
      'XEP-0327', // wrong XEP for Occupant-ID (and no such code)
      'vcard set avatarUrl', // real command is `vcard set avatar <url-or-path>`
      'openclaw xmpp vcard get <jid>', // vcard get takes no jid
    ];
    for (const bad of forbidden) {
      assert.equal(readme.includes(bad), false, `README must not contain stale text: ${bad}`);
    }
  });
});
