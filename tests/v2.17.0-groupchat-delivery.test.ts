// SECURITY (2.18.0): groupchat delivery uses OpenClaw's own dispatch.
//
// The plugin no longer hardcodes a mention gate.  It dispatches inbound events
// through OpenClaw's shared channel inbound runner
// (`runtime.channel.inbound.run`) and classifies the turn with OpenClaw's
// `classifyChannelInboundEvent` + the configured unmentioned-group policy
// (default "user_request"), so the AGENT decides whether to answer.

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

describe('2.18.0: groupchat delivery via OpenClaw dispatch', () => {
  it('classifies with OpenClaw (classifyChannelInboundEvent + policy)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /classifyChannelInboundEvent\(\{/);
    assert.match(src, /resolveUnmentionedGroupInboundPolicy\(\{/);
    assert.match(src, /InboundEventKind:\s*inboundEventKind/);
  });

  it('no longer hardcodes the mention gate (room_event)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(/isGroup && !mentioned && !hasControlCommand \? "room_event"/.test(src), false);
    assert.equal(/resolveXmppUnmentionedPolicy/.test(src), false);
    assert.equal(/not @mentioned .* skipping AI dispatch/.test(src), false);
  });

  it('dispatches through runtime.channel.inbound.run, not the deprecated shim', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /channelRuntime\.inbound\.run\(\{/);
    assert.equal(/dispatchInboundReplyWithBase/.test(src), false);
    assert.equal(/plugin-sdk\/inbound-reply-dispatch/.test(src), false);
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
