// SECURITY (2.16.2): ask_user answer parsing + gateway transport.
//
// 2.16.1 hung on answers because it used `runtime.gateway.request`, which has
// no request context in the inbound path.  2.16.2 uses the in-process gateway
// client with the operator.questions scope, and parses the user's real replies.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { parseAnswer, type QuestionSpec } from '../src/lib/questions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

// The exact shape of the reported prompt.
const multi: QuestionSpec[] = [
  {
    questionId: 'timeout_test',
    header: 'Timeout test',
    question: 'Did this render?',
    options: [{ label: 'Yes, this came through' }, { label: 'No, still broken' }, { label: 'Rendered but laggy' }],
  },
  {
    questionId: 'fallback',
    header: 'Fallback',
    question: 'How does it look?',
    options: [{ label: 'It looks right' }, { label: 'Wrong or jumbled' }, { label: 'Not sure' }],
  },
];

describe('2.16.2: parseAnswer handles the reported reply', () => {
  it('parses both answers from a two-line message (q1/q2 prefixes)', () => {
    const parsed = parseAnswer('q1. 1\nq2. 1', multi);
    assert.deepEqual(parsed?.answers, { timeout_test: ['Yes, this came through'], fallback: ['It looks right'] });
    assert.deepEqual(parsed?.remaining, []);
  });

  it('accepts numeric prefixes on one line', () => {
    assert.deepEqual(parseAnswer('1: 1, 2: 2', multi)?.answers, {
      timeout_test: ['Yes, this came through'],
      fallback: ['Wrong or jumbled'],
    });
  });

  it('accepts the real question id as a prefix', () => {
    assert.deepEqual(parseAnswer('timeout_test: 3\nfallback: 3', multi)?.answers, {
      timeout_test: ['Rendered but laggy'],
      fallback: ['Not sure'],
    });
  });

  it('accumulates answers across separate messages', () => {
    const first = parseAnswer('q1. 1', multi);
    assert.deepEqual(first?.answers, { timeout_test: ['Yes, this came through'] });
    assert.deepEqual(first?.remaining.map((q) => q.questionId), ['fallback']);

    const second = parseAnswer('q2. 2', multi, first!.answers);
    assert.deepEqual(second?.answers, {
      timeout_test: ['Yes, this came through'],
      fallback: ['Wrong or jumbled'],
    });
    assert.deepEqual(second?.remaining, []);
  });

  it('accepts a bare value only when exactly one question remains', () => {
    const one = parseAnswer('2', multi, { timeout_test: ['Yes, this came through'] });
    assert.deepEqual(one?.answers, { timeout_test: ['Yes, this came through'], fallback: ['Wrong or jumbled'] });
    assert.deepEqual(one?.remaining, []);
  });

  it('does not guess a bare value while several questions remain', () => {
    assert.equal(parseAnswer('1', multi), null);
    assert.equal(parseAnswer('FUCK', multi), null);
  });

  it('returns null when there are no questions (defensive)', () => {
    assert.equal(parseAnswer('q1. 1', []), null);
  });
});

describe('2.16.2: gateway transport', () => {
  it('ask-user.ts uses the in-process gateway client, not runtime.gateway.request', async () => {
    const src = await readSource('src/lib/ask-user.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /callGatewayRpc/);
    assert.equal(/runtime\??\.gateway\??\.request|getPluginRuntime/.test(code), false);
    assert.match(code, /operator\.questions/);
  });

  it('gateway-client.ts forwards scopes to the SDK caller', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /scopes/);
    assert.match(src, /callGatewayRpc<T = any>\([\s\S]*scopes\?: string\[\]/);
  });

  it('ask-user.ts fetches questions at answer time and enriches in the background', async () => {
    const src = await readSource('src/lib/ask-user.ts');
    assert.match(src, /"question\.get"/);
    assert.match(src, /"question\.resolve"/);
    assert.match(src, /enrichQuestions\(/);
  });
});
