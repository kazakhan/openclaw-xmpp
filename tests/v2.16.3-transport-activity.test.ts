// SECURITY (2.16.3): report transport activity to the channel health monitor.
//
// The monitor restarts an account whose `lastTransportActivityAt` is older than
// 30 min (stale-socket).  The plugin only updated it on connect + outbound
// replies, so idle bots were restarted every ~35 min.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { createThrottledReporter, ACTIVITY_REPORT_INTERVAL_MS } from '../src/lib/activity.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.16.3: throttled activity reporter', () => {
  it('reports at most once per interval', () => {
    let now = 1_000_000;
    let calls = 0;
    const report = createThrottledReporter(() => calls++, 60_000, () => now);

    assert.equal(report(), true);
    assert.equal(report(), false); // within the interval
    assert.equal(calls, 1);

    now += 59_999;
    assert.equal(report(), false);
    assert.equal(calls, 1);

    now += 1; // 60s elapsed
    assert.equal(report(), true);
    assert.equal(calls, 2);
  });

  it('defaults to a 60s interval', () => {
    assert.equal(ACTIVITY_REPORT_INTERVAL_MS, 60_000);
  });

  it('is a no-op without a callback', () => {
    const report = createThrottledReporter(undefined);
    assert.equal(report(), false);
  });

  it('never throws when the callback throws', () => {
    const report = createThrottledReporter(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => report());
  });
});

describe('2.16.3: wiring', () => {
  it('startXMPP reports activity on stanzas, sends, and keepalive', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /onTransportActivity\?: \(\) => void/);
    assert.match(src, /createThrottledReporter\(onTransportActivity\)/);
    // stanza handler + keepalive + send wrapper
    const calls = src.match(/reportTransportActivity\(\)/g) || [];
    assert.ok(calls.length >= 3, `expected >= 3 activity reports, found ${calls.length}`);
    assert.match(src, /xmpp\.write\(" "\)\.then\(\(\) => reportTransportActivity\(\)\)/);
  });

  it('gateway.ts passes lastTransportActivityAt into startXmpp', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /onTransportActivity\?: \(\) => void/);
    assert.match(src, /ctx\.setStatus\(\{ lastTransportActivityAt: Date\.now\(\) \}\)/);
  });
});
