// SECURITY (2.18.8): shared (process-wide) state must survive per-entry bundling.
//
// OpenClaw loads several bundled entries of this plugin (`index.js`,
// `channel-plugin-api.js`, `runtime-setter-api.js`, …).  esbuild (2.18.5+)
// bundles each entry independently, so plain module-level variables became
// separate copies per bundle: OpenClaw called `setXmppRuntime(runtime)` on the
// `runtime-setter-api.js` copy while the gateway read its own, leaving
// `getPluginRuntime()` null and inbound dispatch skipped
// ("runtime.channel not available, cannot dispatch"), so agents stopped
// replying.  2.18.8 backs the shared state with a `globalThis` singleton.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('2.18.8: shared state is a globalThis singleton', () => {
  it('state.ts keys its state on globalThis via Symbol.for', async () => {
    const src = await readSource('src/state.ts');
    assert.match(src, /Symbol\.for\("openclaw\.xmpp\.state"\)/);
    assert.match(src, /globalThis/);
    // no bare module-level runtime variable left
    assert.equal(/^let pluginRuntime/m.test(src), false);
  });

  it('queue-bridge.ts keys its queue map on globalThis via Symbol.for', async () => {
    const src = await readSource('src/queue-bridge.ts');
    assert.match(src, /Symbol\.for\("openclaw\.xmpp\.queues"\)/);
    assert.match(src, /globalThis/);
    assert.equal(/^const queueByDir = new Map/m.test(src), false);
  });

  it('all state accessors go through the shared object', async () => {
    const src = await readSource('src/state.ts');
    for (const fn of ['getPluginRuntime', 'setXmppRuntime', 'isPluginRegistered', 'markPluginRegistered']) {
      assert.ok(src.includes(fn), `state.ts must export ${fn}`);
    }
    assert.match(src, /return state\.runtime/);
  });
});

describe('2.18.8: runtime set through one bundled copy is visible to another', () => {
  it('setXmppRuntime (runtime-setter-api.js) reaches another copy of state', async () => {
    const setter = path.join(ROOT, 'dist', 'runtime-setter-api.js');
    const other = path.join(ROOT, 'dist', 'src', 'state.js');
    if (!(await exists(setter)) || !(await exists(other))) return; // not built in this checkout

    const mod = await import(setter);
    const sentinel = { sentinel: 'openclaw-xmpp-2.18.8' };
    mod.setXmppRuntime(sentinel);

    const mirrored = await import(other);
    assert.deepEqual(
      mirrored.getPluginRuntime(),
      sentinel,
      'setXmppRuntime must be visible to other bundle copies (globalThis singleton)',
    );

    // restore so a shared process is not polluted
    mod.setXmppRuntime(null);
  });
});
