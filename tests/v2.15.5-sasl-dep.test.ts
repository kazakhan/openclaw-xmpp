// SECURITY (2.15.5): `sasl-scram-sha-1` must stay on the synchronous 1.3.0.
//
// 1.4.0 made RESP.challenge async (response() returns a Promise); @xmpp/sasl
// 0.13.x calls it synchronously and only encodes strings, so with 1.4.0 the
// SCRAM <response/> is sent EMPTY and Prosody rejects it with malformed-request.
// These tests fail loudly if a broken version ever lands in node_modules.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

import { inspectSaslScram, REQUIRED_SASL_SCRAM_VERSION } from '../src/lib/sasl-dep.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginDir = path.join(__dirname, '..');

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(pluginDir, rel), 'utf8');
}

describe('2.15.5: sasl-scram-sha-1 pin', () => {
  it('package.json overrides pin sasl-scram-sha-1 to 1.3.0', async () => {
    const pkg = JSON.parse(await read('package.json'));
    assert.equal(pkg.overrides?.['sasl-scram-sha-1'], '1.3.0');
    assert.equal(pkg.dependencies?.['@xmpp/client'], '0.13.6');
  });

  it('package-lock.json resolves sasl-scram-sha-1 to 1.3.0', async () => {
    const lock = JSON.parse(await read('package-lock.json'));
    assert.equal(lock.packages?.['node_modules/sasl-scram-sha-1']?.version, '1.3.0');
  });

  it('the installed sasl-scram-sha-1 is 1.3.0 and its response() is synchronous', async () => {
    const info = inspectSaslScram(pluginDir);
    assert.equal(info.installed, true, info.reason);
    assert.equal(info.version, REQUIRED_SASL_SCRAM_VERSION, `installed ${info.version}`);
    assert.equal(info.compatible, true, info.reason);
  });

  it('response() returns a string at the challenge stage (not a Promise)', () => {
    const requireFrom = createRequire(path.join(pluginDir, 'package.json'));
    const Mechanism = requireFrom('sasl-scram-sha-1');
    const mech = new Mechanism();
    mech.response({ username: 'probe', password: 'probe' }); // -> challenge stage
    mech.challenge('r=probe,s=cHJvYmU=,i=4096');
    const resp = mech.response({ username: 'probe', password: 'probe' });
    assert.equal(typeof resp, 'string');
    assert.match(resp, /,p=/);
  });
});

describe('2.15.5: doctor detects + fixes the dependency', () => {
  it('doctor inspects sasl-scram-sha-1 and can run npm install on --fix', async () => {
    const src = await read('src/commands.ts');
    assert.match(src, /inspectSaslScram/);
    assert.match(src, /sasl-scram-sha-1:/);
    assert.match(src, /npm",\s*\["install"/);
  });
});
