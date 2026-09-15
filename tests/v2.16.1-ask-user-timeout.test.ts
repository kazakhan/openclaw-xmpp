// SECURITY (2.16.1): ask_user timeout floor + synchronous render path.
//
// 2.16.0 rendered the prompt from the delivery path but awaited a gateway RPC
// (`question.get`) first, which blocked delivery until the ask_user timeout.
// 2.16.1 captures synchronously and raises the tool timeout via a hook.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  applyAskUserTimeoutFloor,
  askUserMinTimeoutSeconds,
  DEFAULT_ASK_USER_MIN_TIMEOUT_SECONDS,
} from '../src/lib/ask-user-hooks.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

describe('2.16.1: ask_user timeout floor', () => {
  it('raises a short timeout to the floor', () => {
    assert.deepEqual(applyAskUserTimeoutFloor({ timeoutSeconds: 120 }, 900), { timeoutSeconds: 900 });
  });

  it('leaves a timeout at or above the floor unchanged', () => {
    assert.equal(applyAskUserTimeoutFloor({ timeoutSeconds: 900 }, 900), undefined);
    assert.equal(applyAskUserTimeoutFloor({ timeoutSeconds: 1800 }, 900), undefined);
  });

  it('defaults a missing timeout to the floor (no change needed)', () => {
    assert.equal(applyAskUserTimeoutFloor({}, 900), undefined);
    assert.equal(applyAskUserTimeoutFloor({ questions: [] }, 900), undefined);
  });

  it('ignores non-object params', () => {
    assert.equal(applyAskUserTimeoutFloor(undefined, 900), undefined);
    assert.equal(applyAskUserTimeoutFloor(null, 900), undefined);
  });

  it('default floor is 900', () => {
    assert.equal(DEFAULT_ASK_USER_MIN_TIMEOUT_SECONDS, 900);
    // No askUserMinTimeoutSeconds in this box's config -> default.
    assert.equal(askUserMinTimeoutSeconds(), 900);
  });
});

describe('2.16.1: synchronous capture + hook wiring', () => {
  it('registerAskUser is synchronous (no RPC in the delivery path)', async () => {
    const src = await readSource('src/lib/ask-user.ts');
    assert.match(src, /export\s+function\s+registerAskUser\(/);
    // The delivery-path function body must not fetch the record.
    const body = src.slice(src.indexOf('export function registerAskUser('), src.indexOf('export interface AnswerResult'));
    assert.equal(/gatewayRequest\(/.test(body), false, 'registerAskUser must not call the gateway');
  });

  it('index.ts registers the ask_user hook', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /registerAskUserHooks\(api\)/);
  });

  it('the hook targets before_tool_call with the ask_user matcher', async () => {
    const src = await readSource('src/lib/ask-user-hooks.ts');
    assert.match(src, /"before_tool_call"/);
    assert.match(src, /matcher:\s*\["ask_user"\]/);
  });

  it('late answers dispatch instead of being swallowed', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /answer\.closed/);
  });
});
