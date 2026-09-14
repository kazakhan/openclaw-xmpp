// SECURITY (2.14.1, groupchat gating): regression suite for the fix that
// restores "only respond when @mentioned" in group chats.
//
// Root cause: the plugin never set InboundEventKind, so OpenClaw's generic
// dispatch defaulted every group message to "user_request" and woke the agent
// for all of them. This asserts the plugin now classifies group events and
// defaults unmentioned chatter to "room_event".
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

describe('Fix 2.14.1: groupchat inbound event classification (src/gateway.ts)', () => {
  it('sets InboundEventKind on the group context', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /InboundEventKind:\s*inboundEventKind/);
    assert.match(src, /InboundEventKind:\s*"user_request"/); // direct branch
  });

  it('classifies unmentioned group messages as room_event', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /let\s+inboundEventKind:\s*"user_request"\s*\|\s*"room_event"/);
    assert.match(src, /:\s*"room_event"/);
  });

  it('treats a mention or control command as user_request', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /mentioned\s*\|\|\s*hasControlCommand/);
  });

  it('defaults the XMPP unmentioned policy to room_event, overridable by config', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /function\s+resolveXmppUnmentionedPolicy/);
    assert.match(src, /messages\?\.groupChat\?\.unmentionedInbound/);
    assert.match(src, /return\s+"room_event"/);
  });

  it('no longer injects the per-message GroupSystemPrompt (caused meta replies)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(
      /GroupSystemPrompt:\s*\n?\s*"Occupants can be addressed/.test(src),
      false,
      'GroupSystemPrompt injection must be removed',
    );
  });
});

describe('Fix 2.14.1: default unmentionedInbound=room_event', () => {
  it('install.sh sets messages.groupChat.unmentionedInbound', async () => {
    const src = await readSource('install.sh');
    assert.match(src, /messages\.groupChat\.unmentionedInbound\s+room_event/);
  });
  it('install.ps1 sets messages.groupChat.unmentionedInbound', async () => {
    const src = await readSource('install.ps1');
    assert.match(src, /messages\.groupChat\.unmentionedInbound\s+room_event/);
  });
  it('onboarding wizard writes unmentionedInbound=room_event', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /unmentionedInbound\s*=\s*"room_event"/);
  });
});
