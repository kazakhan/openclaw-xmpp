// SECURITY (2.13.0, groupchat mentions): regression suite asserting the
// mention-gating + occupant-awareness wiring.
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

describe('Fix 2.13.0: mention helpers (src/mention.ts)', () => {
  it('exports buildMentionTokens and wasBotMentioned', async () => {
    const src = await readSource('src/mention.ts');
    assert.match(src, /export\s+function\s+buildMentionTokens/);
    assert.match(src, /export\s+function\s+wasBotMentioned/);
    assert.match(src, /export\s+function\s+escapeRegex/);
  });

  it('requires an @ prefix with a word boundary', async () => {
    const src = await readSource('src/mention.ts');
    assert.match(src, /@\$\{escapeRegex\(t\)\}/);
    assert.match(src, /\(\?!\[/);
  });

  it('collects tokens from botNick, jid localpart, nickname, and full name', async () => {
    const src = await readSource('src/mention.ts');
    assert.match(src, /add\(sources\.botNick\)/);
    assert.match(src, /add\(sources\.nickname\)/);
    assert.match(src, /add\(sources\.fullName\)/);
    assert.match(src, /split\("@\"\)\[0\]/);
  });
});

describe('Fix 2.13.0: occupant tracking + dispatch (src/startXMPP.ts)', () => {
  it('tracks per-room occupants', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /const\s+roomOccupants\s*=\s*new\s+Map/);
    assert.match(src, /occ\.set\(nick,\s*from\)/);
    assert.match(src, /occ\.delete\(nick\)/);
  });

  it('tracks room subjects', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /const\s+roomSubjects\s*=\s*new\s+Map/);
    assert.match(src, /roomSubjects\.set\(/);
  });

  it('clears occupants + subjects on offline', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /roomOccupants\.clear\(\)/);
    assert.match(src, /roomSubjects\.clear\(\)/);
  });

  it('passes wasMentioned/groupMembers/groupSubject on groupchat dispatch', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /wasMentioned:\s*mentioned/);
    assert.match(src, /groupMembers,/);
    assert.match(src, /groupSubject:\s*roomSubjects\.get\(roomJid\)/);
  });

  it('imports the mention helpers from ./mention.js', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /import\s*\{\s*buildMentionTokens,\s*wasBotMentioned\s*\}\s*from\s*["']\.\/mention\.js["']/);
  });
});

describe('Fix 2.13.0: gateway context wiring (src/gateway.ts)', () => {
  it('sets BotUsername/WasMentioned/ExplicitlyMentionedBot for groups', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /BotUsername:\s*options\?\.botNick/);
    assert.match(src, /WasMentioned:\s*options\?\.wasMentioned\s*===\s*true/);
    assert.match(src, /ExplicitlyMentionedBot:\s*options\?\.wasMentioned\s*===\s*true/);
  });

  it('sets GroupMembers only when non-empty and GroupSubject', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /options\?\.groupMembers\s*\?\s*\{\s*GroupMembers:\s*options\.groupMembers\s*\}/);
    assert.match(src, /GroupSubject:/);
  });

  it('does NOT force GroupRequireMention (per-room flexibility)', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(
      /GroupRequireMention:/.test(src),
      false,
      'gateway.ts must not set GroupRequireMention — per-room channels.xmpp.groups config must stay authoritative',
    );
  });
});

describe('Fix 2.13.0: default group mention gating config', () => {
  it('install.sh sets channels.xmpp.groups.*.requireMention', async () => {
    const src = await readSource('install.sh');
    assert.match(src, /channels\.xmpp\.groups\.\*\.requireMention/);
  });

  it('install.ps1 sets channels.xmpp.groups.*.requireMention', async () => {
    const src = await readSource('install.ps1');
    assert.match(src, /channels\.xmpp\.groups\.\*\.requireMention/);
  });

  it('onboarding wizard writes groups."*".requireMention = true', async () => {
    const src = await readSource('src/onboarding.ts');
    assert.match(src, /channels\.xmpp\.groups/);
    assert.match(src, /requireMention:\s*true/);
  });
});
