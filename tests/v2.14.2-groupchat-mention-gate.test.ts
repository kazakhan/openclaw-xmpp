// SECURITY (2.14.2, groupchat mention gate): regression suite.
//
// Group messages are dispatched to the agent ONLY when this bot is @mentioned
// (its own nick) — unmentioned/`@othernick` chatter is persisted but never sent
// to the agent (no model call, no reply, no bot-to-bot loop).  A message may
// mention several nicks; only a mention of one of the bot's own names counts.
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

describe('Fix 2.14.2: gateway skips the agent when not mentioned (src/gateway.ts)', () => {
  it('has a mention-only gate that returns before dispatch', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /const mentioned = options\?\.wasMentioned === true/);
    assert.match(src, /if \(!mentioned && !hasControlCommand && policy !== "user_request"\)/);
    assert.match(src, /this\.queue\.markAsProcessed\(messageId\);\s*\n\s*return;/);
  });

  it('builds the gate before finalizeInboundContext/dispatch', async () => {
    const src = await readSource('src/gateway.ts');
    const gateIdx = src.indexOf('skipping AI dispatch');
    const dispatchIdx = src.indexOf('dispatchInboundReplyWithBase', gateIdx);
    assert.ok(gateIdx > -1 && dispatchIdx > -1 && gateIdx < dispatchIdx, 'gate must precede dispatch');
  });

  it('no longer injects BotUsername/GroupMembers/GroupSubject/GroupSystemPrompt/InboundEventKind', async () => {
    const src = await readSource('src/gateway.ts');
    for (const f of ['BotUsername:', 'GroupMembers:', 'GroupSubject:', 'GroupSystemPrompt:', 'InboundEventKind:']) {
      assert.equal(src.includes(f), false, `gateway.ts must not inject ${f}`);
    }
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

describe('Fix 2.14.2: installers default to mention-only', () => {
  it('install.sh sets channels.xmpp.groups.*.requireMention', async () => {
    const src = await readSource('install.sh');
    assert.match(src, /channels\.xmpp\.groups\.\*\.requireMention/);
  });
  it('install.ps1 sets channels.xmpp.groups.*.requireMention', async () => {
    const src = await readSource('install.ps1');
    assert.match(src, /channels\.xmpp\.groups\.\*\.requireMention/);
  });
});
