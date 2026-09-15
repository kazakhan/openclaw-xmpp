// SECURITY (2.16.0): ask_user over XMPP — pure logic + wiring.
//
// The ask_user tool blocks the run until `question.resolve`; a text-only
// channel must render the prompt and turn the reply into a resolve call.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  formatPrompt,
  parseAnswer,
  buildResolveParams,
  registerPending,
  getPending,
  clearPending,
  makePending,
  _resetPendingForTests,
  type QuestionSpec,
} from '../src/lib/questions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

const single: QuestionSpec[] = [
  {
    questionId: 'q1',
    header: 'Deploy',
    question: 'Proceed with the deploy?',
    options: [{ label: 'Yes' }, { label: 'No', description: 'abort' }],
    isOther: true,
  },
];

const multi: QuestionSpec[] = [
  { questionId: 'q1', header: 'Env', question: 'Which env?', options: [{ label: 'prod' }, { label: 'staging' }], isOther: true },
  { questionId: 'q2', header: 'Time', question: 'When?', options: [{ label: 'now' }, { label: 'later' }], isOther: true },
];

describe('2.16.0: formatPrompt', () => {
  it('renders a single question with numbered options and a type-your-own line', () => {
    const out = formatPrompt(single);
    assert.match(out, /Agent needs input:/);
    assert.match(out, /Proceed with the deploy\?/);
    assert.match(out, /1\. Yes/);
    assert.match(out, /2\. No — abort/);
    assert.match(out, /3\. Type your own answer/);
    assert.match(out, /Reply with a number/);
  });

  it('numbers questions when there are several', () => {
    const out = formatPrompt(multi);
    assert.match(out, /1\. Env/);
    assert.match(out, /2\. Time/);
    assert.match(out, /"1: 2, 2: 1"/);
  });
});

describe('2.16.0: parseAnswer', () => {
  it('maps a number to the option label', () => {
    const parsed = parseAnswer('2', single);
    assert.deepEqual(parsed?.answers, { q1: ['No'] });
    assert.equal(parsed?.summary, 'No');
  });

  it('maps option text (case-insensitive)', () => {
    assert.deepEqual(parseAnswer('yes', single)?.answers, { q1: ['Yes'] });
  });

  it('treats unmatched text as a custom answer', () => {
    assert.deepEqual(parseAnswer('do it tomorrow', single)?.answers, { q1: ['do it tomorrow'] });
  });

  it('handles multi-select comma lists', () => {
    const q: QuestionSpec[] = [{ questionId: 'q', question: 'Pick', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true, isOther: true }];
    assert.deepEqual(parseAnswer('1, 3', q)?.answers, { q: ['a', 'c'] });
  });

  it('parses compound multi-question answers', () => {
    const parsed = parseAnswer('1: 2, 2: 1', multi);
    assert.deepEqual(parsed?.answers, { q1: ['staging'], q2: ['now'] });
  });

  it('returns null for an unparseable multi-question reply', () => {
    assert.equal(parseAnswer('nonsense', multi), null);
  });

  it('masks secret answers in the summary', () => {
    const q: QuestionSpec[] = [{ questionId: 'q', question: 'Password', options: [], isSecret: true }];
    assert.equal(parseAnswer('hunter2', q)?.summary, '••••');
  });
});

describe('2.16.0: pending store', () => {
  it('registers, reads, clears, and expires', () => {
    _resetPendingForTests();
    const now = 1000;
    registerPending(makePending({ recordId: 'ask_x', questions: single, accountId: 'default', conversation: 'u@x', ttlMs: 100, now }));
    assert.ok(getPending('default', 'u@x', now + 50));
    assert.equal(getPending('default', 'u@x', now + 200), undefined);
    registerPending(makePending({ recordId: 'ask_y', questions: single, accountId: 'default', conversation: 'u@x', now }));
    clearPending('default', 'u@x');
    assert.equal(getPending('default', 'u@x', now), undefined);
  });

  it('builds question.resolve params', () => {
    const params = buildResolveParams('ask_abc', { q1: ['Yes'] }, 'u@x');
    assert.equal(params.id, 'ask_abc');
    assert.deepEqual(params.answers, { answers: { q1: ['Yes'] } });
    assert.equal(params.resolvedBy, 'u@x');
  });
});

describe('2.16.0: wiring', () => {
  it('gateway intercepts answers and captures prompts', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /tryAnswerPending\(/);
    assert.match(src, /captureAskUser\(/);
  });

  it('outbound adapter renders ask_user prompts', async () => {
    const src = await readSource('src/channel-plugin.ts');
    assert.match(src, /renderPresentation:/);
    assert.match(src, /beforeDeliverPayload:/);
    assert.match(src, /captureAskUser\(/);
  });

  it('ask-user resolves via the gateway question API', async () => {
    const src = await readSource('src/lib/ask-user.ts');
    assert.match(src, /question\.get/);
    assert.match(src, /question\.resolve/);
  });
});
