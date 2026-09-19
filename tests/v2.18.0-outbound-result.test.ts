// SECURITY (2.18.0): outbound sends must carry a delivery identity.
//
// OpenClaw's `OutboundDeliveryResult` requires a real `messageId`
// (`resolveReceiptSourceId`).  Returning only `{ ok: true, channel: "xmpp" }`
// made every message-tool send settle as `adapter_returned_no_identity`, and
// the gateway then threw "No delivery result".  The outbound adapter now
// returns a client-generated id plus a matching receipt, and the channel
// declares a proper `message` adapter derived from it.

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

describe('2.18.0: outbound delivery identity', () => {
  it('builds a result with messageId + receipt', async () => {
    const src = await readSource('src/outbound.ts');
    assert.match(src, /function buildDeliveryResult\(/);
    assert.match(src, /messageId/);
    assert.match(src, /primaryPlatformMessageId/);
    assert.match(src, /return buildDeliveryResult\(\);/);
    assert.equal(/return \{ ok: true, channel: "xmpp" \};/.test(src), false);
  });

  it('channel declares a message adapter from the outbound sends', async () => {
    const src = await readSource('src/channel-plugin.ts');
    assert.match(src, /createChannelMessageAdapterFromOutbound/);
    assert.match(src, /message:\s*createChannelMessageAdapterFromOutbound\(\{/);
  });
});
