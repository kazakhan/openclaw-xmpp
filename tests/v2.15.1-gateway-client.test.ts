// SECURITY (2.15.1): CLI -> gateway transport regression suite.
//
// Root causes fixed:
//   1. `extractJsonFromOutput` scanned bottom-up and treated ANY lone `{` line
//      as the top-level JSON start, so a pretty-printed vCard containing an
//      object inside `email: [ { ... } ]` produced a fragment and
//      `parse-failed: Unexpected non-whitespace character after JSON`.
//   2. The spawn-only transport surfaced opaque `exit-code-1` errors and
//      depended on the child resolving `openclaw`, auth, and Windows quoting.
//
// Fix: prefer the in-process `openclaw/plugin-sdk/gateway-runtime`
// `callGatewayFromCli` (no child, no stdout parsing), with a hardened spawn
// fallback that passes `--json` and uses the robust extractor.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { extractFirstJson, parseFirstJson, stripAnsi } from '../src/lib/json-extract.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

// A faithful reproduction of the output that broke vcard get: a heading line,
// pretty JSON, and a nested object whose `{` sits alone on a line.
const BAD_VCARD_OUTPUT =
  'Gateway call: xmpp.vcard\n' +
  '{\n' +
  '  "ok": true,\n' +
  '  "data": {\n' +
  '    "fn": "Clawd",\n' +
  '    "email": [\n' +
  '      {\n' +
  '        "types": [\n' +
  '          "WORK",\n' +
  '          "INTERNET"\n' +
  '        ],\n' +
  '        "userid": "taylor@kazakhan.com"\n' +
  '      }\n' +
  '    ]\n' +
  '  }\n' +
  '}\n';

describe('2.15.1: extractFirstJson handles real CLI output', () => {
  it('parses pretty JSON with a lone nested `{` and a preamble (the vcard bug)', () => {
    const parsed = parseFirstJson<any>(BAD_VCARD_OUTPUT);
    assert.ok(parsed, 'must parse');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.fn, 'Clawd');
    assert.equal(parsed.data.email[0].userid, 'taylor@kazakhan.com');
  });

  it('ignores trailing log lines after the JSON', () => {
    const text = 'Gateway call: xmpp.getPresence\n{"ok":true,"presence":{"show":"dnd"}}\n[log] done\n';
    const parsed = parseFirstJson<any>(text);
    assert.equal(parsed.presence.show, 'dnd');
  });

  it('ignores ANSI colour codes in the preamble', () => {
    const text = '\u001b[1mGateway call\u001b[0m: xmpp.vcard\n\u001b[32m{"ok":true,"data":{"a":[{"b":1}]}}\u001b[0m\n';
    const parsed = parseFirstJson<any>(text);
    assert.equal(parsed.data.a[0].b, 1);
  });

  it('parses compact single-line JSON', () => {
    assert.deepEqual(parseFirstJson('{"ok":true,"n":1}'), { ok: true, n: 1 });
  });

  it('parses a top-level JSON array', () => {
    assert.deepEqual(parseFirstJson('[1,2,{"x":3}]'), [1, 2, { x: 3 }]);
  });

  it('is not confused by braces/brackets inside strings', () => {
    const text = '{"ok":true,"s":"a } b ] c { \\" d","n":2}';
    assert.deepEqual(parseFirstJson(text), { ok: true, s: 'a } b ] c { " d', n: 2 });
  });

  it('returns null for text with no JSON and for unterminated JSON', () => {
    assert.equal(extractFirstJson('no json here'), null);
    assert.equal(extractFirstJson('{"ok": true'), null);
    assert.equal(parseFirstJson('garbage'), null);
  });

  it('stripAnsi removes escape sequences', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  });
});

describe('2.15.1: gateway-client prefers the in-process SDK', () => {
  it('loads openclaw/plugin-sdk/gateway-runtime and callGatewayFromCli', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /openclaw\/plugin-sdk\/gateway-runtime/);
    assert.match(src, /callGatewayFromCli/);
    assert.match(src, /sharedStateMode:\s*["']read-only["']/);
  });

  it('uses the robust extractor (not the old bottom-up line scanner)', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /parseFirstJson/);
    assert.equal(/extractJsonFromOutput/.test(src), false);
  });

  it('surfaces the gateway error payload (respond(false, {error}))', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /responsePayload/);
    assert.match(src, /formatGatewayError/);
  });

  it('resolves the OpenClaw entry so the fallback never needs cmd.exe quoting', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /resolveOpenclawEntry/);
    assert.match(src, /process\.execPath/);
    assert.match(src, /openclaw\.mjs/);
  });

  it('the spawn fallback requests --json (no `Gateway call:` heading)', async () => {
    const src = await readSource('src/gateway-client.ts');
    assert.match(src, /callArgs\.push\(\s*["']--json["']\s*\)/);
  });

  it('exposes the same public API for callers', async () => {
    const src = await readSource('src/gateway-client.ts');
    for (const fn of [
      'export async function callGatewayRpc',
      'export async function joinRoom',
      'export async function leaveRoom',
      'export async function getJoinedRooms',
      'export async function inviteToRoom',
      'export async function removeContact',
    ]) {
      assert.ok(src.includes(fn), `must keep ${fn}`);
    }
  });
});

describe('2.15.1: presence CLI accepts `get`/`show`/`status`', () => {
  it('treats get/show/status as a read action (not a show value)', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /showArg\s*===\s*["']get["']/);
    assert.match(src, /showArg\s*===\s*["']show["']/);
    assert.match(src, /showArg\s*===\s*["']status["']/);
  });
});
