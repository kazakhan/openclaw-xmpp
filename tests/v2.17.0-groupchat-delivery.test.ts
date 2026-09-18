// SECURITY (2.17.0): deliver ALL room messages; reply only when mentioned.
//
// Previously the plugin dropped unmentioned group messages (its own mention
// gate) and never set `InboundEventKind`, so nothing reached the agent and
// dispatched messages defaulted to "user_request".  Now every room message is
// delivered: unmentioned => "room_event" (passive context), mentioned/control
// => "user_request" (reply).  Mentions are per-bot, so only the intended
// recipient replies.

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

describe('2.17.0: groupchat delivery', () => {
  it('gateway sets InboundEventKind (room_event vs user_request)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /const inboundEventKind:\s*"user_request"\s*\|\s*"room_event"/);
    assert.match(src, /isGroup && !mentioned && !hasControlCommand \? "room_event" : "user_request"/);
    assert.match(src, /InboundEventKind:\s*inboundEventKind/);
  });

  it('gateway no longer drops unmentioned room messages', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(/resolveXmppUnmentionedPolicy/.test(src), false);
    assert.equal(/not @mentioned .* skipping AI dispatch/.test(src), false);
  });

  it('room dispatch stays groupchat (ChatType channel)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /ChatType:\s*\(roomJid \|\| isGroupChat\) \? "channel" : "direct"/);
  });

  it('onboarding no longer writes the mention-only toggles', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.equal(/requireMention:\s*true/.test(src), false);
    assert.equal(/unmentionedInbound\s*=\s*"room_event"/.test(src), false);
  });
});

describe('2.17.0: queue CLI null fix', () => {
  it('queue-bridge.getMessageQueue returns a queue, not null', async () => {
    const src = await readSource('src/queue-bridge.ts');
    assert.match(src, /export function getMessageQueue\(dataDir\?: string\): PersistentQueue/);
    assert.equal(/getMessageQueue\([^)]*\): PersistentQueue \| null/.test(src), false);
  });

  it('commands.ts resolves the dataDir and uses queue.all', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /function resolveCliDataDir\(\)/);
    assert.match(src, /getMessageQueue\(dataDir\)/);
    assert.match(src, /queue\.all\.length/);
    assert.equal(/messageQueue\.length/.test(src), false);
  });

  it('cli-metadata no longer passes a null messageQueue', async () => {
    const src = await readSource('src/cli-metadata.ts');
    assert.equal(/messageQueue:\s*getMessageQueue\(\)/.test(src), false);
  });
});
