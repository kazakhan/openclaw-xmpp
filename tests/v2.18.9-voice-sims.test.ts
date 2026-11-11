// SECURITY (2.18.9): XMPP voice notes (TTS), SIMS inbound extraction, stanza
// guard, avatar republish, honest restart.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { xml } from '@xmpp/client';

import {
  buildSimsVoiceMessage,
  extractSharedMediaUrls,
  isVoiceMediaPath,
  normalizeSharedMediaUrl,
  withStreamMode,
} from '../src/lib/voice-note-protocol.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

describe('2.18.9: SIMS voice message builder', () => {
  it('emits XEP-0385 SIMS with audio/mpeg, sha-256, stream URL and fallbacks', () => {
    const msg = buildSimsVoiceMessage({
      to: 'user@example.org',
      messageType: 'chat',
      caption: 'Hello there',
      url: 'https://upload.example.org/voice.mp3?mode=stream',
      filename: 'voice.mp3',
      size: 1234,
      sha256Base64: 'BASE64HASH',
      mediaType: 'audio/mpeg',
    });
    const s = msg.toString();
    assert.match(s, /<body>Hello there\nhttps:\/\/upload\.example\.org\/voice\.mp3\?mode=stream<\/body>/);
    assert.match(s, /xmlns="urn:xmpp:reference:0"[^>]*type="data"/);
    assert.match(s, /xmlns="urn:xmpp:sims:1"/);
    assert.match(s, /xmlns="urn:xmpp:jingle:apps:file-transfer:5"/);
    assert.match(s, /<media-type>audio\/mpeg<\/media-type>/);
    assert.match(s, /xmlns="urn:xmpp:hashes:2"[^>]*algo="sha-256">BASE64HASH</);
    assert.match(s, /<sources>.*urn:xmpp:reference:0[^>]*uri="https:\/\/upload\.example\.org\/voice\.mp3\?mode=stream"/);
    assert.match(s, /for="urn:xmpp:sims:1"/);
    assert.match(s, /for="jabber:x:oob"/);
    assert.match(s, /xmlns="jabber:x:oob"><url>https:\/\/upload\.example\.org\/voice\.mp3\?mode=stream<\/url>/);
  });

  it('uses the whole body as the fallback URL when there is no caption', () => {
    const msg = buildSimsVoiceMessage({
      to: 'user@example.org',
      messageType: 'chat',
      url: 'https://x.test/v.mp3',
      filename: 'voice.mp3',
      size: 1,
      sha256Base64: 'H',
      mediaType: 'audio/mpeg',
    });
    const s = msg.toString();
    assert.match(s, /<body>https:\/\/x\.test\/v\.mp3<\/body>/);
  });
});

describe('2.18.9: inbound SIMS/SFS extraction', () => {
  it('extracts the source URI from a Psi+ style SIMS message', () => {
    const stanza = xml('message', { type: 'chat', from: 'alice@example.org' },
      xml('reference', { xmlns: 'urn:xmpp:reference:0', type: 'data' },
        xml('media-sharing', { xmlns: 'urn:xmpp:sims:1' },
          xml('file', { xmlns: 'urn:xmpp:jingle:apps:file-transfer:5' },
            xml('name', {}, 'voice.mp3'),
            xml('media-type', {}, 'audio/mpeg'),
          ),
          xml('sources', {},
            xml('reference', { xmlns: 'urn:xmpp:reference:0', type: 'data', uri: 'https://files.example.org/a.mp3?mode=stream' }),
          ),
        ),
      ),
    );
    assert.deepEqual(extractSharedMediaUrls(stanza), ['https://files.example.org/a.mp3']);
  });

  it('extracts XEP-0447 url-data and OOB urls', () => {
    const stanza = xml('message', { type: 'chat' },
      xml('file', { xmlns: 'urn:xmpp:sfs:0' },
        xml('sources', {}, xml('url-data', { xmlns: 'urn:xmpp:url-data:0', target: 'https://files.example.org/b.ogg' })),
      ),
      xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, 'https://files.example.org/c.wav')),
    );
    assert.deepEqual(extractSharedMediaUrls(stanza).sort(), [
      'https://files.example.org/b.ogg',
      'https://files.example.org/c.wav',
    ]);
  });

  it('normalizes mode=stream and rejects non-http', () => {
    assert.equal(normalizeSharedMediaUrl('https://x.test/v.mp3?mode=stream#frag'), 'https://x.test/v.mp3');
    assert.equal(normalizeSharedMediaUrl('file:///tmp/x.mp3'), null);
    assert.equal(withStreamMode('https://x.test/v.mp3'), 'https://x.test/v.mp3?mode=stream');
  });
});

describe('2.18.9: voice detection', () => {
  it('recognizes OpenClaw TTS output and audio files', () => {
    assert.equal(isVoiceMediaPath('/tmp/tool-speech-synthesis/voice.mp3'), true);
    assert.equal(isVoiceMediaPath('C:\\Users\\a\\.openclaw\\voice-123.ogg'), true);
    assert.equal(isVoiceMediaPath('/tmp/photo.png'), false);
    assert.equal(isVoiceMediaPath(null), false);
  });
});

describe('2.18.9: wiring', () => {
  it('channel advertises voice-note TTS (mp3)', async () => {
    const src = await readSource('src/channel-plugin.ts');
    assert.match(src, /synthesisTarget:\s*"voice-note"/);
    assert.match(src, /transcodesAudio:\s*true/);
    assert.match(src, /audioFileFormats:\s*\["mp3"\]/);
  });

  it('outbound sends TTS audio as a voice note', async () => {
    const src = await readSource('src/outbound.ts');
    assert.match(src, /sendVoiceNote/);
    assert.match(src, /isVoiceMediaPath/);
  });

  it('inbound extracts SIMS/SFS media and downloads it', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /extractSharedMediaUrls/);
    assert.match(src, /shared media download failed/);
  });

  it('guards oversized outbound stanzas', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /outbound stanza too large/);
    assert.match(src, /maxStanzaSize/);
  });

  it('republishes the avatar on connect', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /publishAvatarFromUrl/);
    const srv = await readSource('src/vcard-server.ts');
    assert.match(srv, /publishAvatarFromUrl/);
  });

  it('restart resolves the OpenClaw entry and reports the outcome', async () => {
    const src = await readSource('src/updater.ts');
    assert.match(src, /findOpenclawEntry/);
    assert.match(src, /interface RestartResult/);
    assert.match(src, /openclaw\.mjs/);
  });

  it('exposes /tts and /stt commands', async () => {
    const src = await readSource('src/slash-commands.ts');
    assert.match(src, /case 'tts':/);
    assert.match(src, /case 'stt':/);
    assert.match(src, /lfm3-audio-tts/);
  });
});
