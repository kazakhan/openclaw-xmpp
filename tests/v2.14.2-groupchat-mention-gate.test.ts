// SECURITY (2.14.2, revised 2.17.0): groupchat delivery.
//
// 2.14.2 introduced a mention-only gate that DROPPED unmentioned room messages.
// 2.17.0 reverses that: every room message is delivered to the agent.  The
// plugin sets `InboundEventKind` explicitly — unmentioned => "room_event"
// (passive context, no reply), @mentioned/control => "user_request" (reply).
// Because each bot computes its own mention, a message that @mentions one bot
// is user_request only for that bot, so only the intended recipient replies.
//
// File-based (read source + assert regex) so it runs under plain `node --test`.

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

describe('Fix 2.14.2: mention detection (src/mention.ts)', () => {
  it('exports buildMentionTokens / wasBotMentioned / escapeRegex', async () => {
    const src = await readSource('src/mention.ts');
    assert.match(src, /export\s+function\s+buildMentionTokens/);
    assert.match(src, /export\s+function\s+wasBotMentioned/);
    assert.match(src, /export\s+function\s+escapeRegex/);
  });

  it('requires an @ prefix and a boundary (so @othernick never matches the bot)', async () => {
    const src = await readSource('src/mention.ts');
    assert.match(src, /@\$\{escapeRegex\(t\)\}/);
    assert.match(src, /\(\?!\[/);
  });
});

describe('Fix 2.18.0: gateway uses OpenClaw dispatch, no mention gate (src/gateway.ts)', () => {
  it('classifies with OpenClaw (classifyChannelInboundEvent + policy)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /classifyChannelInboundEvent\(\{/);
    assert.match(src, /resolveUnmentionedGroupInboundPolicy\(\{/);
    assert.match(src, /InboundEventKind:\s*inboundEventKind/);
  });

  it('dispatches through runtime.channel.inbound.run', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /channelRuntime\.inbound\.run\(\{/);
    assert.equal(/dispatchInboundReplyWithBase/.test(src), false);
  });

  it('no longer skips unmentioned room messages', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(/skipping AI dispatch for .*not @mentioned/.test(src), false);
    assert.equal(/resolveXmppUnmentionedPolicy/.test(src), false);
    assert.equal(/isGroup && !mentioned && !hasControlCommand \? "room_event"/.test(src), false);
  });

  it('room dispatch stays groupchat (ChatType channel)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /ChatType:\s*\(roomJid \|\| isGroupChat\) \? "channel" : "direct"/);
  });
});

describe('Fix 2.14.2: startXMPP passes the mention signal (src/startXMPP.ts)', () => {
  it('computes and passes wasMentioned for group messages', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /wasBotMentioned\(body \|\| '', mentionTokens\)/);
    assert.match(src, /wasMentioned:\s*mentioned/);
  });

  it('no longer tracks occupants/subjects (reverted)', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(src.includes('roomOccupants'), false, 'roomOccupants must be removed');
    assert.equal(src.includes('roomSubjects'), false, 'roomSubjects must be removed');
    assert.equal(src.includes('groupMembers'), false, 'groupMembers must not be passed');
  });
});

describe('Fix 2.17.0: installers no longer set mention-only toggles', () => {
  it('install.sh has no requireMention/unmentionedInbound', async () => {
    const src = await readSource('install.sh');
    assert.equal(/requireMention/.test(src), false);
    assert.equal(/unmentionedInbound/.test(src), false);
  });
  it('install.ps1 has no requireMention/unmentionedInbound', async () => {
    const src = await readSource('install.ps1');
    assert.equal(/requireMention/.test(src), false);
    assert.equal(/unmentionedInbound/.test(src), false);
  });
});
