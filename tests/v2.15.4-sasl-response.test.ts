// SECURITY (2.15.4): @xmpp/sasl 0.13.6 emits an illegal `mechanism` attribute
// on the SASL <response/> stanza (RFC 6120 §6.4.2 allows only `xmlns`), which
// Prosody rejects with `malformed-request`, breaking SCRAM-SHA-1 auth.  The
// plugin sanitizes the outgoing stanza instead of patching node_modules.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { stripSaslResponseMechanism, installSaslResponseFix, SASL_NS } from '../src/lib/sasl-response.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.15.4: SASL <response/> sanitizer', () => {
  it('strips the illegal mechanism attribute', () => {
    const el: any = { name: 'response', attrs: { xmlns: SASL_NS, mechanism: 'SCRAM-SHA-1' } };
    assert.equal(stripSaslResponseMechanism(el), true);
    assert.equal(el.attrs.mechanism, undefined);
    assert.equal(el.attrs.xmlns, SASL_NS);
  });

  it('leaves <auth> and unrelated stanzas untouched', () => {
    const auth: any = { name: 'auth', attrs: { xmlns: SASL_NS, mechanism: 'SCRAM-SHA-1' } };
    assert.equal(stripSaslResponseMechanism(auth), false);
    assert.equal(auth.attrs.mechanism, 'SCRAM-SHA-1');

    const msg: any = { name: 'message', attrs: { to: 'x@y', mechanism: 'nope' } };
    assert.equal(stripSaslResponseMechanism(msg), false);
    assert.equal(msg.attrs.mechanism, 'nope');
  });

  it('is a no-op when there is no mechanism attribute', () => {
    const el: any = { name: 'response', attrs: { xmlns: SASL_NS } };
    assert.equal(stripSaslResponseMechanism(el), false);
  });

  it('never throws on malformed input', () => {
    assert.equal(stripSaslResponseMechanism(undefined), false);
    assert.equal(stripSaslResponseMechanism(null), false);
    assert.equal(stripSaslResponseMechanism('nope'), false);
    assert.equal(stripSaslResponseMechanism({ name: 'response' }), false);
  });

  it('produces valid XML with a real @xmpp/xml element', async () => {
    const xml = (await import('@xmpp/xml')).default as any;
    const el = xml('response', { xmlns: SASL_NS, mechanism: 'SCRAM-SHA-1' }, 'YWJj');
    assert.ok(el.toString().includes('mechanism'), 'precondition: bug is present');
    stripSaslResponseMechanism(el);
    const out = el.toString();
    assert.equal(out.includes('mechanism'), false, 'mechanism must be gone');
    assert.match(out, /<response[^>]*xmlns="urn:ietf:params:xml:ns:xmpp-sasl"[^>]*>YWJj<\/response>/);
  });
});

describe('2.15.4: installSaslResponseFix wraps send', () => {
  it('sanitizes before delegating and forwards the return value', async () => {
    const sent: any[] = [];
    const xmpp: any = {
      send(el: any) {
        sent.push(el);
        return 'ok';
      },
    };
    installSaslResponseFix(xmpp);
    const el: any = { name: 'response', attrs: { xmlns: SASL_NS, mechanism: 'SCRAM-SHA-1' } };
    const r = xmpp.send(el);
    assert.equal(r, 'ok');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].attrs.mechanism, undefined);
  });

  it('is idempotent (does not double-wrap)', () => {
    const xmpp: any = { send() { return 1; } };
    installSaslResponseFix(xmpp);
    const first = xmpp.send;
    installSaslResponseFix(xmpp);
    assert.equal(xmpp.send, first);
    assert.equal(xmpp.__saslResponseFixed, true);
  });

  it('is a no-op when send is missing', () => {
    assert.doesNotThrow(() => installSaslResponseFix({}));
    assert.doesNotThrow(() => installSaslResponseFix(undefined));
  });
});

describe('2.15.4: wiring', () => {
  it('startXMPP installs the fix right after creating the client', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(src, /import\s*\{\s*installSaslResponseFix\s*\}\s*from\s*["']\.\/lib\/sasl-response\.js["']/);
    const idx = src.indexOf('const xmpp = client({');
    assert.ok(idx > 0, 'client creation must exist');
    const after = src.slice(idx, idx + 900);
    assert.match(after, /installSaslResponseFix\(xmpp\)/, 'must install immediately after client()');
  });

  it('xmpp-connect also installs the fix', async () => {
    const src = await readSource('src/lib/xmpp-connect.ts');
    assert.match(src, /installSaslResponseFix\(xmpp\)/);
  });
});
