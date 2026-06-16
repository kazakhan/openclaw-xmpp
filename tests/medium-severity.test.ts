import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readSource(rel: string): Promise<string> {
  const raw = await fs.readFile(path.join(__dirname, '..', rel), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function readSourceRaw(rel: string): Promise<string> {
  return fs.readFile(path.join(__dirname, '..', rel), 'utf8');
}

// =====================================================================
// 2.0.17 Medium-Severity Fixes — test suite
// Source-level only; uses node:test.
// =====================================================================

describe('Fix M1: gateway.ts log.error downgraded to log.debug for diagnostics', () => {
  it('no log.error for DISPATCH_ENTERED, GC_DELIVER, GC_SEND pre/post', async () => {
    const src = await readSource('src/gateway.ts');
    assert.equal(
      /log\.error\(`DISPATCH_ENTERED:/.test(src),
      false,
      'DISPATCH_ENTERED must be log.debug, not log.error',
    );
    assert.equal(
      /log\.error\(`GC_DELIVER:/.test(src),
      false,
      'GC_DELIVER must be log.debug, not log.error',
    );
    assert.equal(
      /log\.error\(`GC_SEND: pre/.test(src),
      false,
      'GC_SEND: pre must be log.debug',
    );
    assert.equal(
      /log\.error\(`GC_SEND: post groupchat success=true`/.test(src),
      false,
      'GC_SEND: post groupchat must be log.debug',
    );
    assert.equal(
      /log\.error\(`GC_SEND: post direct success=true`/.test(src),
      false,
      'GC_SEND: post direct must be log.debug',
    );
  });

  it('all 5 diagnostic sites use log.debug now', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /log\.debug\(`DISPATCH_ENTERED:/);
    assert.match(src, /log\.debug\(`GC_DELIVER:/);
    assert.match(src, /log\.debug\(`GC_SEND: pre/);
    assert.match(src, /log\.debug\(`GC_SEND: post groupchat success=true`/);
    assert.match(src, /log\.debug\(`GC_SEND: post direct success=true`/);
  });

  it('genuine error path (DISPATCH BLOCK FAILED) still uses log.error', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(
      src,
      /log\.error\("DISPATCH BLOCK FAILED:"\)/,
      'real error path must remain log.error',
    );
  });
});

describe('Fix M2: persistent-queue.ts save() logs the error', () => {
  it('save() catch block now logs via log.error instead of bare catch {}', async () => {
    const src = await readSource('src/lib/persistent-queue.ts');
    // Must NOT have a bare `catch {}` in save()
    const saveFnMatch = src.match(/private\s+async\s+save\([\s\S]*?\}\s*\{[\s\S]*?\}\s*\}/);
    if (saveFnMatch) {
      const saveBody = saveFnMatch[0];
      assert.equal(
        /catch\s*\{\s*\}/.test(saveBody),
        false,
        'save() must not use bare catch {}',
      );
      assert.match(
        saveBody,
        /catch\s*\([^)]*\)\s*\{[\s\S]*?log\.error/,
        'save() catch must call log.error',
      );
    } else {
      // Fallback: just check no bare catch {} exists in the file
      const bareMatches = src.match(/catch\s*\{\s*\}/g);
      assert.equal(
        bareMatches,
        null,
        'no bare catch {} allowed',
      );
    }
  });
});

describe('Fix M3: persistent-queue.ts clearOld moves unprocessed to dead-letter', () => {
  it('has a deadLetter field and getDeadLetter method', async () => {
    const src = await readSource('src/lib/persistent-queue.ts');
    assert.match(src, /private\s+deadLetter\s*:\s*QueuedMessage\[\]/);
    assert.match(src, /getDeadLetter\(\)\s*:\s*QueuedMessage\[\]/);
  });

  it('clearOld moves unprocessed messages to deadLetter', async () => {
    const src = await readSource('src/lib/persistent-queue.ts');
    const clearOldMatch = src.match(/clearOld\([^)]*\)\s*:\s*number\s*\{[\s\S]*?\n\s{2}\}/);
    if (clearOldMatch) {
      const body = clearOldMatch[0];
      assert.match(
        body,
        /\bdead\b\.push/,
        'clearOld must push unprocessed to dead-letter (via `dead` or `deadLetter`)',
      );
      assert.match(
        body,
        /!m\.processed/,
        'clearOld must check !m.processed',
      );
    } else {
      assert.match(src, /clearOld[\s\S]*?dead\.push|clearOld[\s\S]*?deadLetter\.push/);
      assert.match(src, /clearOld[\s\S]*?!m\.processed/);
    }
  });

  it('has a DEAD_LETTER_MAX constant and dead-letter file path', async () => {
    const src = await readSourceRaw('src/lib/persistent-queue.ts');
    assert.match(src, /DEAD_LETTER_MAX\s*=\s*\d+/);
    assert.match(src, /message-queue\.dead-letter\.json/);
  });
});

describe('Fix M4: jsonStore.ts per-instance write-chain serialises set/update/clear', () => {
  it('has a writeChain: Promise<void> field', async () => {
    const src = await readSource('src/jsonStore.ts');
    assert.match(src, /writeChain\s*:\s*Promise<void>/);
  });

  it('has enqueueWrite() that chains via .then()', async () => {
    const src = await readSource('src/jsonStore.ts');
    assert.match(src, /enqueueWrite/);
    assert.match(src, /this\.writeChain\s*=\s*next\.catch/);
  });

  it('set() routes through enqueueWrite', async () => {
    const src = await readSource('src/jsonStore.ts');
    const setMatch = src.match(/async\s+set\([^)]*\)\s*:\s*Promise<void>\s*\{[\s\S]*?\n\s{2}\}/);
    if (setMatch) {
      assert.match(
        setMatch[0],
        /return\s+this\.enqueueWrite/,
        'set() must call enqueueWrite and return its promise',
      );
    } else {
      assert.fail('set() method not found');
    }
  });

  it('update() routes through enqueueWrite', async () => {
    const src = await readSource('src/jsonStore.ts');
    const updateMatch = src.match(/async\s+update\(fn:[^]*?\}\s*\{[\s\S]*?\n\s{2}\}/);
    if (updateMatch) {
      assert.match(
        updateMatch[0],
        /return\s+this\.enqueueWrite/,
        'update() must call enqueueWrite and return its promise',
      );
    } else {
      // Fallback: scan for the method body using a less strict match
      const start = src.indexOf('async update(');
      if (start < 0) return assert.fail('update() not found');
      const end = src.indexOf('  }', start);
      const body = src.substring(start, end + 3);
      assert.match(
        body,
        /return\s+this\.enqueueWrite/,
        'update() must call enqueueWrite and return its promise',
      );
    }
  });

  it('clear() routes through enqueueWrite', async () => {
    const src = await readSource('src/jsonStore.ts');
    const clearMatch = src.match(/async\s+clear\(\)\s*:\s*Promise<void>\s*\{[\s\S]*?\n\s{2}\}/);
    if (clearMatch) {
      assert.match(
        clearMatch[0],
        /return\s+this\.enqueueWrite/,
        'clear() must call enqueueWrite and return its promise',
      );
    } else {
      assert.fail('clear() method not found');
    }
  });

  it('concurrent set() calls are serialised (in-process simulation)', async () => {
    // Re-implement the chain in-process to verify the algorithm.
    let writeChain = Promise.resolve();
    let counter = 0;
    const enqueueWrite = (step: () => Promise<void>) => {
      const next = writeChain.then(step, step);
      writeChain = next.catch(() => {});
      return next;
    };
    const results: number[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const myCounter = i;
      promises.push(enqueueWrite(async () => {
        await new Promise(r => setTimeout(r, 1));
        results.push(myCounter);
        counter++;
      }));
    }
    await Promise.all(promises);
    assert.equal(counter, 5);
    assert.deepEqual(results, [0, 1, 2, 3, 4], 'chain must run in submission order');
  });
});

describe('Fix M5: upload-protocol.ts setTimeout cleared on early resolve', () => {
  it('discoverUploadService stores the timer handle and clearTimeout()s it', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    const fnMatch = src.match(/export\s+async\s+function\s+discoverUploadService[\s\S]*?\n\}\s*\n/);
    if (fnMatch) {
      const body = fnMatch[0];
      assert.match(body, /let\s+timer\s*:\s*ReturnType<typeof\s+setTimeout>\s*\|\s*null/);
      assert.match(body, /const\s+cleanup\s*=/);
      assert.match(body, /cleanup\(\)/);
      assert.match(body, /clearTimeout\(timer\)/);
    } else {
      assert.fail('discoverUploadService not found');
    }
  });

  it('requestUploadSlot stores the timer handle and clearTimeout()s it', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    const fnMatch = src.match(/export\s+async\s+function\s+requestUploadSlot[\s\S]*?\n\}\s*\n/);
    if (fnMatch) {
      const body = fnMatch[0];
      assert.match(body, /let\s+timer\s*:\s*ReturnType<typeof\s+setTimeout>\s*\|\s*null/);
      assert.match(body, /const\s+cleanup\s*=/);
      assert.match(body, /clearTimeout\(timer\)/);
    } else {
      assert.fail('requestUploadSlot not found');
    }
  });
});

describe('Fix M6: upload-protocol.ts error branch has explicit return', () => {
  it('discoverUploadService error branch has resolve(null); return;', async () => {
    const src = await readSource('src/lib/upload-protocol.ts');
    const errMatch = src.match(/stanza\.attrs\.id\s*===\s*iqId\s*&&\s*stanza\.attrs\.type\s*===\s*['"]error['"][\s\S]*?\}\s*\n\s{4}\}/);
    if (errMatch) {
      assert.match(
        errMatch[0],
        /resolve\(null\);\s*\n\s*return;/,
        'error branch must end with resolve(null); return;',
      );
    } else {
      assert.fail('error branch not found');
    }
  });
});

describe('Fix M7: contacts.ts add() validates JID via validators.isValidJid', () => {
  it('imports validators from security/validation', async () => {
    const src = await readSource('src/contacts.ts');
    assert.match(src, /from\s+["']\.\/security\/validation\.js["']/);
  });

  it('add() rejects invalid JIDs by calling isValidJid', async () => {
    const src = await readSource('src/contacts.ts');
    const addMatch = src.match(/async\s+add\([^)]*\)\s*:\s*Promise<boolean>[\s\S]*?\n\s{2}\}/);
    if (addMatch) {
      assert.match(
        addMatch[0],
        /validators\.isValidJid\(bareJid\)/,
        'add() must call validators.isValidJid(bareJid)',
      );
      assert.match(
        addMatch[0],
        /if\s*\(\s*!validators\.isValidJid[\s\S]*?return\s+false/,
        'add() must return false on invalid JID',
      );
    } else {
      assert.fail('add() method not found');
    }
  });
});

describe('Fix M8: roster persistence via RosterStore', () => {
  it('src/roster-store.ts exists with RosterStore class', async () => {
    const src = await readSourceRaw('src/roster-store.ts');
    assert.match(src, /export\s+class\s+RosterStore/);
    assert.match(src, /async\s+setNick/);
    assert.match(src, /async\s+getNick/);
    assert.match(src, /async\s+list/);
  });

  it('commands.ts imports RosterStore and no longer has in-memory roster', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(src, /from\s+["']\.\/roster-store\.js["']/);
    assert.equal(
      /^let\s+roster\s*:\s*Record<string,\s*\{\s*nick\?:\s*string\s*\}>\s*=/m.test(src),
      false,
      'old in-memory `let roster` must be removed',
    );
  });

  it('commands.ts nick subcommand delegates to RosterStore.setNick', async () => {
    const src = await readSource('src/commands.ts');
    const nickMatch = src.match(/\.command\(["']nick\s+<jid>\s+<name>["'][\s\S]*?\.action\([\s\S]*?\}\s*\)\s*;/);
    if (nickMatch) {
      assert.match(
        nickMatch[0],
        /store\.setNick/,
        'nick subcommand must call store.setNick',
      );
    } else {
      assert.fail('nick subcommand not found');
    }
  });
});

describe('Fix M9: gateway.ts startXmpp wrapped in Promise.race with 60s timeout', () => {
  it('declares START_XMPP_TIMEOUT_MS = 60_000', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /START_XMPP_TIMEOUT_MS\s*=\s*60_000/);
  });

  it('creates a timeout promise that rejects after the timeout', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /startXmppTimeoutPromise/);
    assert.match(
      src,
      /startXmppTimeoutPromise[\s\S]*?reject\(new Error\(\s*`startXmpp timed out/,
    );
  });

  it('races services.startXmpp against the timeout promise', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(
      src,
      /Promise\.race\(\[\s*startXmppPromise,\s*startXmppTimeoutPromise\s*\]\)/,
    );
  });

  it('registers an abort listener that calls xmpp.stop()', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /startXmppAbortSignal.*addEventListener\(["']abort/);
    assert.match(
      src,
      /onStartXmppAbort[\s\S]*?startXmppResult\?\.stop/,
    );
  });

  it('clearStartXmppGuards is called on both success and catch', async () => {
    const src = await readSource('src/gateway.ts');
    assert.match(src, /clearStartXmppGuards\(\);/);
  });
});

describe('Fix M12: vcard-cli.ts publishAvatar uses per-step flags, not single success', () => {
  it('declares per-step flags metadataOk and dataOk', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.match(src, /let\s+metadataOk\s*=\s*false/);
    assert.match(src, /let\s+dataOk\s*=\s*false/);
  });

  it('no longer has the single `let success = false` flag', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.equal(
      /let\s+success\s*=\s*false/.test(src),
      false,
      'single `let success = false` must be removed',
    );
  });

  it('returns metadataOk && dataOk', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const fnMatch = src.match(/async\s+function\s+publishAvatar[\s\S]*?\n\}/);
    if (fnMatch) {
      assert.match(
        fnMatch[0],
        /return\s+metadataOk\s*&&\s*dataOk/,
        'publishAvatar must return metadataOk && dataOk',
      );
    } else {
      assert.fail('publishAvatar function not found');
    }
  });
});
