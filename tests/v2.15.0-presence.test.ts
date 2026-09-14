// SECURITY (2.15.0): presence/status feature suite.
//
// Behavioural tests import src/presence.ts directly (it is dependency-free so
// `node --test` can load it).  Source-level tests cover the wiring in
// startXMPP.ts / index.ts / commands.ts / slash-commands.ts / manifest.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { PresenceManager, normalizeShow, PRESENCE_SHOWS } from '../src/presence.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager(overrides: any = {}) {
  const sends: Array<{ show?: string; status?: string; priority?: number }> = [];
  const dataDir = overrides.dataDir || path.join(os.tmpdir(), `xmpp-presence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mgr = new PresenceManager({
    dataDir,
    cfg: overrides.cfg || {},
    send: async (show, status, priority) => {
      sends.push({ show, status, priority });
    },
  });
  return { mgr, sends, dataDir };
}

describe('2.15.0: presence show aliases', () => {
  it('normalizes built-in names and friendly aliases', () => {
    assert.equal(normalizeShow('online'), 'available');
    assert.equal(normalizeShow('BUSY'), 'dnd');
    assert.equal(normalizeShow('free'), 'chat');
    assert.equal(normalizeShow('extended-away'), 'xa');
    assert.equal(normalizeShow('dnd'), 'dnd');
    assert.equal(normalizeShow('away'), 'away');
  });
  it('rejects unknown values', () => {
    assert.equal(normalizeShow('nope'), null);
    assert.equal(normalizeShow(''), null);
    assert.equal(normalizeShow(undefined), null);
  });
  it('exposes the canonical shows', () => {
    assert.deepEqual(PRESENCE_SHOWS, ['available', 'chat', 'away', 'xa', 'dnd']);
  });
});

describe('2.15.0: manual override precedence', () => {
  it('defaults to available', () => {
    const { mgr } = makeManager();
    assert.equal(mgr.getSnapshot().show, 'available');
    assert.equal(mgr.getSnapshot().source, 'default');
  });

  it('a manual status wins over auto-activity', async () => {
    const { mgr } = makeManager();
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    assert.equal(mgr.getSnapshot().source, 'auto');
    await mgr.setManual('away', 'Back in 5');
    const snap = mgr.getSnapshot();
    assert.equal(snap.source, 'manual');
    assert.equal(snap.show, 'away');
    assert.equal(snap.status, 'Back in 5');
    assert.equal(snap.autoActive, true, 'auto activity still tracked underneath');
  });

  it('clearManual reverts to auto while a run is active', async () => {
    const { mgr } = makeManager();
    await mgr.setManual('dnd', 'Working');
    assert.equal(mgr.getSnapshot().source, 'manual');
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    const eff = await mgr.clearManual();
    assert.equal(eff.source, 'auto');
  });

  it('rejects an invalid show', async () => {
    const { mgr } = makeManager();
    await assert.rejects(mgr.setManual('bogus'), /Invalid presence show/);
  });
});

describe('2.15.0: auto-activity (thinking / tool)', () => {
  it('thinking while a model call is in flight', async () => {
    const { mgr, sends } = makeManager({ cfg: { minIntervalSeconds: 0 } });
    mgr.notifyActivity({ type: 'thinking-start' });
    await sleep(5);
    assert.equal(mgr.getSnapshot().source, 'auto');
    assert.equal(mgr.getSnapshot().status, 'Thinking…');
    assert.equal(sends.at(-1)?.show, 'dnd');
  });

  it('shows the tool name while a tool runs', async () => {
    const { mgr, sends } = makeManager({ cfg: { minIntervalSeconds: 0 } });
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    mgr.notifyActivity({ type: 'tool-start', runId: 'r1', toolName: 'exec' });
    await sleep(5);
    assert.equal(mgr.getSnapshot().source, 'auto');
    assert.equal(mgr.getSnapshot().status, 'Running exec…');
    assert.equal(sends.at(-1)?.show, 'dnd');
  });

  it('reverts to default after all runs end', async () => {
    const { mgr } = makeManager({ cfg: { minIntervalSeconds: 0 } });
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    mgr.notifyActivity({ type: 'thinking-start', runId: 'r1' });
    mgr.notifyActivity({ type: 'thinking-end', runId: 'r1' });
    mgr.notifyActivity({ type: 'run-end', runId: 'r1' });
    await sleep(5);
    assert.equal(mgr.getSnapshot().source, 'default');
  });
});

describe('2.15.0: throttling / coalescing', () => {
  it('coalesces rapid auto transitions (min interval)', async () => {
    const { mgr, sends } = makeManager({ cfg: { minIntervalSeconds: 5 } });
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    await sleep(10);
    const afterFirst = sends.length;
    assert.equal(afterFirst, 1, 'first transition sent immediately');
    mgr.notifyActivity({ type: 'tool-start', runId: 'r1', toolName: 'exec' });
    await sleep(10);
    assert.equal(sends.length, afterFirst, 'second transition is deferred, not sent');
    mgr.dispose();
  });

  it('emits on every change when the interval is 0', async () => {
    const { mgr, sends } = makeManager({ cfg: { minIntervalSeconds: 0 } });
    mgr.notifyActivity({ type: 'run-start', runId: 'r1' });
    await sleep(5);
    mgr.notifyActivity({ type: 'tool-start', runId: 'r1', toolName: 'exec' });
    await sleep(5);
    assert.equal(sends.length, 2);
  });
});

describe('2.15.0: TTL + persistence', () => {
  it('manual override expires after ttlSeconds', async () => {
    const { mgr } = makeManager();
    await mgr.setManual('dnd', 'Short lived', undefined, 0.05);
    assert.equal(mgr.getSnapshot().source, 'manual');
    await sleep(120);
    assert.equal(mgr.getSnapshot().source, 'default');
    mgr.dispose();
  });

  it('persists the manual override across restarts', async () => {
    const { mgr, dataDir } = makeManager();
    await mgr.setManual('xa', 'Gone fishing');
    mgr.dispose();
    await sleep(20);

    const { mgr: mgr2, sends } = makeManager({ dataDir });
    await mgr2.announce();
    const snap = mgr2.getSnapshot();
    assert.equal(snap.source, 'manual');
    assert.equal(snap.show, 'xa');
    assert.equal(snap.status, 'Gone fishing');
    assert.equal(sends.at(-1)?.show, 'xa');
    mgr2.dispose();
  });
});

describe('2.15.0: wiring (source-level)', () => {
  it('startXMPP.ts constructs the manager, announces on connect and handles probes', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /import\s*\{\s*PresenceManager,\s*readPresenceConfig\s*\}\s*from\s*["']\.\/presence\.js["']/);
    assert.match(src, /new PresenceManager\(/);
    assert.match(src, /presenceManager\.announce\(\)/);
    assert.match(src, /presenceManager\.getSnapshot\(\)/);
    // wrapper surface
    assert.match(src, /getPresence:\s*\(\)\s*=>\s*presenceManager\.getSnapshot\(\)/);
    assert.match(src, /clearPresence:\s*async\s*\(\)\s*=>/);
    assert.match(src, /notifyActivity:\s*\(event:\s*any\)/);
  });

  it('index.ts registers presence hooks + gateway methods', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /registerPresenceHooks\(api\)/);
    assert.match(src, /api\.registerGatewayMethod\(\s*["']xmpp\.setPresence["']/);
    assert.match(src, /api\.registerGatewayMethod\(\s*["']xmpp\.getPresence["']/);
    assert.match(src, /api\.registerGatewayMethod\(\s*["']xmpp\.clearPresence["']/);
  });

  it('presence-hooks.ts maps the lifecycle hooks and gates on the xmpp channel', async () => {
    const src = await readSource('src/presence-hooks.ts');
    for (const hook of [
      'before_agent_run',
      'model_call_started',
      'model_call_ended',
      'before_tool_call',
      'after_tool_call',
      'agent_end',
      'session_end',
    ]) {
      assert.match(src, new RegExp(`["']${hook}["']`), `must register ${hook}`);
    }
    assert.match(src, /channel\s*===\s*["']xmpp["']/);
    assert.match(src, /notifyActivity/);
  });

  it('commands.ts exposes a presence subcommand routed through the gateway', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /\.command\(\s*["']presence \[show\] \[status\.\.\.\]["']\s*\)/);
    assert.match(src, /runPresence\(/);
    assert.match(src, /["']xmpp\.setPresence["']/);
    assert.match(src, /["']xmpp\.getPresence["']/);
    assert.match(src, /["']xmpp\.clearPresence["']/);
  });

  it('slash-commands.ts handles /presence and /status', async () => {
    const src = await readSource('src/slash-commands.ts');
    assert.match(src, /'presence',\s*'status'/);
    assert.match(src, /case\s+'presence':/);
    assert.match(src, /case\s+'status':/);
    assert.match(src, /presence\.setManual\(/);
    assert.match(src, /presence\.clearManual\(/);
  });

  it('openclaw.plugin.json declares the presence config block', async () => {
    const src = await readSource('openclaw.plugin.json');
    assert.match(src, /"presence":\s*\{/);
    assert.match(src, /"thinkingStatus"/);
    assert.match(src, /"toolStatus"/);
    assert.match(src, /"minIntervalSeconds"/);
  });

  it('config.ts exposes PRESENCE defaults', async () => {
    const src = await readSource('src/config.ts');
    assert.match(src, /PRESENCE:\s*\{/);
    assert.match(src, /thinkingStatus:\s*"Thinking…"/);
    assert.match(src, /toolStatus:\s*"Running \{tool\}…"/);
  });
});
