// SECURITY (2.17.1): make `npx tsc` clean.
//
// `openclaw/plugin-sdk/*` subpaths resolve through the package `exports` map,
// which needs `moduleResolution: "bundler"` (+ `module: "ESNext"`).  With the
// SDK types resolving, the tool `execute` params (`unknown`) and `promptSnippet`
// surfaced type errors; those are annotated/cast now.

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

describe('2.17.1: tsconfig resolves the OpenClaw SDK', () => {
  it('uses module ESNext + moduleResolution bundler', async () => {
    const cfg = JSON.parse(await readSource('tsconfig.json'));
    assert.equal(cfg.compilerOptions.module, 'ESNext');
    assert.equal(cfg.compilerOptions.moduleResolution, 'bundler');
    assert.equal(cfg.compilerOptions.noEmitOnError, false);
  });

  it('has a best-effort postinstall that links the SDK', async () => {
    const pkg = JSON.parse(await readSource('package.json'));
    assert.equal(pkg.scripts.postinstall, 'node scripts/link-openclaw-sdk.mjs');
    const script = await readSource('scripts/link-openclaw-sdk.mjs');
    assert.match(script, /node_modules.*openclaw|"openclaw"/);
    assert.match(script, /symlinkSync/);
  });
});

describe('2.17.1: tool params are typed (no TS2339)', () => {
  it('declares PresenceToolParams / SftpToolParams', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /interface\s+PresenceToolParams/);
    assert.match(src, /interface\s+SftpToolParams/);
  });

  it('annotates both execute handlers', async () => {
    const src = await readSource('index.ts');
    assert.match(src, /execute:\s*async\s*\([^)]*params:\s*PresenceToolParams/);
    assert.match(src, /execute:\s*async\s*\([^)]*params:\s*SftpToolParams/);
  });

  it('casts the tool objects for promptSnippet', async () => {
    const src = await readSource('index.ts');
    const casts = src.match(/\}\s*as any\)/g) || [];
    assert.ok(casts.length >= 2, `expected >= 2 tool-object casts, found ${casts.length}`);
  });
});

describe('2.17.1: gateway TS2367 addressed without losing the pass-through', () => {
  it('keeps IsSystemMessage: options?.isSystemMessage === true', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /IsSystemMessage:\s*options\?\.isSystemMessage === true/);
  });

  it('suppresses the (by-construction) TS2367 with a scoped directive', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /@ts-expect-error\s+TS2367/);
  });
});
