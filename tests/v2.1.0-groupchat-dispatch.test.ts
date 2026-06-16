import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  const raw = await fs.readFile(path.join(__dirname, '..', rel), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function readSourceRaw(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

// =====================================================================
// 2.1.0 groupchat dispatch hygiene — test suite
//
// v2.0.16 H9 added the `isSystemMessage: true` skip-dispatch guard at
// `src/gateway.ts:282-285`.  The intent: don't pollute the LLM context
// with system-generated messages (room subject changes, SXE
// negotiation frames, etc.).  But the v2.0.16 patch only set this flag
// on a subset of `onMessage(` call sites in `src/startXMPP.ts`.  The
// room-subject path at line 1011 was overlooked.
//
// Operator's symptom: groupchat dispatch is intermittent.  DMs work.
// Root cause from logs: at 08:36:46 a 297-char "room subject" message
// is dispatched to the agent (no `nick`, bodyLen=297).  The agent's
// LLM consumes that slot, then the actual user message (Jamie's 9-char
// "Jamie" at 08:36:52) either times out (LLM idle = 120s for gemma4:e4b)
// or shares the slot and the response to the room subject is sent
// instead.  The user sees no reply for the actual user message.
//
// v2.1.0 fix: in `src/startXMPP.ts:1011`, the room-subject onMessage
// call now passes `isSystemMessage: true`.  The existing
// `gateway.ts:282-285` guard then skips the AI dispatch and only
// persists the message.  The agent's LLM is no longer polluted with
// MUC subject metadata.
// =====================================================================

describe('Fix v2.1.0: room subject change is marked isSystemMessage', () => {
  it('startXMPP.ts:1011 — room subject onMessage call has isSystemMessage: true', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    const line1011 = lines[1010];
    assert.ok(line1011, 'line 1011 must exist');
    assert.match(
      line1011,
      /\[Room Subject:/,
      'line 1011 should be the room subject onMessage call',
    );
    assert.match(
      line1011,
      /isSystemMessage:\s*true/,
      'room subject onMessage call MUST set isSystemMessage: true so the gateway.ts:282 skip-dispatch guard fires',
    );
  });

  it('startXMPP.ts:1056 — SXE whiteboard session instructions still set isSystemMessage: true', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    // Find the line that contains "SXE whiteboard session established" — the
    // onMessage call is on the very next line (instructions = `...`; is one
    // mega-line, so the onMessage call is i+1, not i+5).
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (/SXE whiteboard session established/.test(lines[i] || '')) {
        for (let j = i; j < i + 5 && j < lines.length; j++) {
          if (/onMessage\(fromBareJid,\s*instructions/.test(lines[j])) {
            const block = lines.slice(j, j + 10).join('\n');
            assert.match(
              block,
              /isSystemMessage:\s*true/,
              'SXE negotiation instructions must keep isSystemMessage: true',
            );
            found = true;
            break;
          }
        }
        break;
      }
    }
    assert.ok(found, 'SXE whiteboard session instructions block not found');
  });

  it('startXMPP.ts:1281 — whiteboard session instructions still set isSystemMessage: true', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    let found = false;
    for (let i = 1270; i < 1300 && i < lines.length; i++) {
      if (/Whiteboard session established with/.test(lines[i - 1] || '')) {
        for (let j = i; j < i + 20 && j < lines.length; j++) {
          if (/onMessage\(fromBareJid,\s*instructions/.test(lines[j])) {
            const block = lines.slice(j, j + 10).join('\n');
            assert.match(
              block,
              /isSystemMessage:\s*true/,
              'Whiteboard session instructions must keep isSystemMessage: true',
            );
            found = true;
            break;
          }
        }
        break;
      }
    }
    assert.ok(found, 'Whiteboard session instructions block not found');
  });
});

describe('Fix v2.1.0: real user message paths do NOT set isSystemMessage', () => {
  it('startXMPP.ts:2338 — groupchat user message is NOT marked isSystemMessage', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    const line = lines[2337];
    assert.ok(line, 'line 2338 must exist');
    assert.match(
      line,
      /onMessage\(roomJid/,
      'line 2338 should be the groupchat onMessage call',
    );
    assert.doesNotMatch(
      line,
      /isSystemMessage/,
      'real groupchat user messages must NOT be marked isSystemMessage',
    );
  });

  it('startXMPP.ts:2345 — DM user message is NOT marked isSystemMessage', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    const line = lines[2344];
    assert.ok(line, 'line 2345 must exist');
    assert.match(
      line,
      /onMessage\(fromBareJid/,
      'line 2345 should be the DM onMessage call',
    );
    assert.doesNotMatch(
      line,
      /isSystemMessage/,
      'real DM user messages must NOT be marked isSystemMessage',
    );
  });

  it('startXMPP.ts:1151 — SXE timer whiteboard update is a real user action (NOT marked isSystemMessage)', async () => {
    const src = await readSourceRaw('src/startXMPP.ts');
    const lines = src.split('\n');
    let found = false;
    for (let i = 1140; i < 1170 && i < lines.length; i++) {
      if (/SXE timer: calling onMessage/.test(lines[i] || '')) {
        const callLine = lines[i + 1];
        if (callLine) {
          assert.doesNotMatch(
            callLine,
            /isSystemMessage:\s*true/,
            'SXE timer whiteboard update represents user drawing action; must NOT be isSystemMessage',
          );
          found = true;
        }
        break;
      }
    }
    assert.ok(found, 'SXE timer onMessage call not found');
  });
});

describe('Fix v2.1.0: gateway.ts skip-dispatch guard remains in place', () => {
  it('gateway.ts:282 — isSystemMessage skip-dispatch guard is unchanged', async () => {
    const src = await readSource('src/gateway.ts');
    const lines = src.split('\n');
    // Find the guard by pattern
    let found = false;
    for (let i = 275; i < 295 && i < lines.length; i++) {
      if (/isSystemMessage === true/.test(lines[i] || '')) {
        const block = lines.slice(i, i + 5).join('\n');
        assert.match(
          block,
          /markAsProcessed/,
          'guard must call markAsProcessed',
        );
        assert.match(
          block,
          /return/,
          'guard must return early',
        );
        found = true;
        break;
      }
    }
    assert.ok(found, 'isSystemMessage skip-dispatch guard not found in gateway.ts');
  });
});

describe('Fix v2.1.0: version bumped to 2.1.0', () => {
  it('package.json version is 2.1.0', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8');
    assert.match(
      src,
      /"version":\s*"2\.1\.0"/,
      'package.json version must be bumped to 2.1.0',
    );
  });
});
