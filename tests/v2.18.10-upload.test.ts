// SECURITY (2.18.10): XEP-0363 upload discovery + explicit service config, and
// voice-note failures are surfaced (never silently downgraded to a file
// transfer, which Psi+ shows as a download prompt).

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

describe('2.18.10: HTTP upload service resolution', () => {
  it('exports resolveUploadService and verifies the upload feature', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    assert.match(src, /export async function resolveUploadService/);
    assert.match(src, /urn:xmpp:http:upload:0/);
    assert.match(src, /discoInfoHasUpload/);
  });

  it('prefers the configured service, then upload.<domain>/httpupload.<domain>', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    assert.match(src, /using configured service/);
    assert.match(src, /upload\.\$\{domain\}/);
    assert.match(src, /httpupload\.\$\{domain\}/);
    assert.match(src, /no HTTP Upload service found/);
  });

  it('requestUploadSlot uses resolveUploadService and logs slot/PUT outcomes', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    assert.match(src, /resolveUploadService\(xmpp, domain, cachedServiceJid/);
    assert.match(src, /requesting slot from/);
    assert.match(src, /slot obtained/);
    assert.match(src, /PUT ok/);
  });

  it('startXMPP reads the configured httpUpload.service', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /cfg\?\.httpUpload\?\.service/);
  });

  it('channel + manifest expose httpUpload.service', async () => {
    const plugin = await readSource('src/channel-plugin.ts');
    assert.match(plugin, /httpUpload:\s*\{/);
    assert.match(plugin, /service:\s*\{\s*type:\s*"string"\s*\}/);
    const manifest = JSON.parse(await readSource('openclaw.plugin.json'));
    const props =
      manifest?.openclaw?.channel?.configSchema?.properties?.accounts ??
      manifest?.configSchema?.properties?.accounts ??
      null;
    // Accept either layout; the schema must contain httpUpload somewhere.
    assert.match(JSON.stringify(manifest), /"httpUpload"/);
    assert.ok(props === null || JSON.stringify(props).includes('httpUpload'));
  });
});

describe('2.18.10: voice-note failures are surfaced', () => {
  it('outbound logs the real reason and does not fall back to sendFile', async () => {
    const src = await readSource('src/outbound.ts');
    assert.match(src, /voice note send failed \(not falling back to file transfer\)/);
    assert.match(src, /Voice note could not be sent as an inline message/);
    // The voice branch must return before the generic sendFile path.
    const voiceIdx = src.indexOf('sendVoiceNote({');
    const fallbackIdx = src.indexOf('sendFile(to, localFilePath');
    assert.ok(voiceIdx > 0 && fallbackIdx > voiceIdx);
  });
});
