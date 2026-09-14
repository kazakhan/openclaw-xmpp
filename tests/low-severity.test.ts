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
// 2.0.18 Low-Severity Fixes — test suite
// Source-level only; uses node:test.
// =====================================================================

describe('Fix L1: xmppClientModule hoisted to const at top of startXmpp', () => {
  it('no module-level let xmppClientModule remains', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /^let\s+xmppClientModule/m.test(src),
      false,
      'module-level `let xmppClientModule` must be removed',
    );
  });

  it('const xmppClientModule declared at top of startXmpp', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.match(
      src,
      /const\s+xmppClientModule\s*=\s*await\s+import\(["']@xmpp\/client["']\)/,
      'const xmppClientModule = await import("@xmpp/client") must be present',
    );
  });

  it('the lazy-init `if (!xmppClientModule)` block is removed', async () => {
    const src = await readSource('src/startXMPP.ts');
    assert.equal(
      /if\s*\(\s*!xmppClientModule\s*\)/.test(src),
      false,
      'lazy-init `if (!xmppClientModule)` block must be removed',
    );
  });
});

describe('Fix L2: liveness uses xml() builder for SM <r/>', () => {
  it('no string `<r xmlns=` write remains', async () => {
    const src = await readSource('src/liveness.ts');
    assert.equal(
      /\.write\(["']<r\s+xmlns=/.test(src),
      false,
      'no string `<r xmlns=` write should remain',
    );
  });

  it('xml() builder is used for the SM <r/> stanza', async () => {
    const src = await readSource('src/liveness.ts');
    assert.match(
      src,
      /xmppXml\(["']r["'],\s*\{\s*xmlns:\s*["']urn:xmpp:sm:3["']\s*\}\)/,
      'xml("r", { xmlns: "urn:xmpp:sm:3" }) must be used',
    );
  });

  it('@xmpp/client is imported as `xml` in liveness.ts', async () => {
    const src = await readSourceRaw('src/liveness.ts');
    assert.match(src, /import\s+\{[^}]*\bxml\b[^}]*\}\s+from\s+["']@xmpp\/client["']/);
  });
});

describe('Fix L3: comment explaining conservative _setLastInboundAt', () => {
  it('has a comment near _setLastInboundAt about conservative reset', async () => {
    const src = await readSourceRaw('src/liveness.ts');
    // Find the .write() that holds the SM <r/> stanza and look
    // backwards/upwards ~2000 chars for a comment about the
    // conservative reset.
    const writeIdx = src.indexOf('SM keepalive: sending <r/>');
    if (writeIdx < 0) {
      assert.fail('SM keepalive comment not found');
    }
    const slice = src.substring(writeIdx, writeIdx + 2500);
    assert.match(
      slice,
      /conservative|outbound|reset|watchdog/i,
      'comment should explain why we reset on outbound write',
    );
  });
});

describe('Fix L4: fileTransfer absolute paths for quarantineDir and tempDir', () => {
  it('quarantineDir default uses os.homedir()', async () => {
    const src = await readSourceRaw('src/security/fileTransfer.ts');
    // Look inside DEFAULT_CONFIG only.
    const defaultConfigMatch = src.match(/const\s+DEFAULT_CONFIG[\s\S]*?\n\};/);
    if (!defaultConfigMatch) return assert.fail('DEFAULT_CONFIG block not found');
    const body = defaultConfigMatch[0];
    const qMatch = body.match(/quarantineDir:\s*[^,\n]+/);
    if (!qMatch) return assert.fail('quarantineDir default not found');
    assert.match(
      qMatch[0],
      /os\.homedir\(\)/,
      'quarantineDir default must use os.homedir() for absolute path',
    );
    assert.equal(
      /quarantineDir:\s*['"]\.\/quarantine['"]/.test(src),
      false,
      'old CWD-relative ./quarantine must be gone',
    );
  });

  it('tempDir default uses os.homedir()', async () => {
    const src = await readSourceRaw('src/security/fileTransfer.ts');
    const defaultConfigMatch = src.match(/const\s+DEFAULT_CONFIG[\s\S]*?\n\};/);
    if (!defaultConfigMatch) return assert.fail('DEFAULT_CONFIG block not found');
    const body = defaultConfigMatch[0];
    const tMatch = body.match(/tempDir:\s*[^,\n]+/);
    if (!tMatch) return assert.fail('tempDir default not found');
    assert.match(
      tMatch[0],
      /os\.homedir\(\)/,
      'tempDir default must use os.homedir()',
    );
    assert.equal(
      /tempDir:\s*['"]\.\/temp['"]/.test(src),
      false,
      'old CWD-relative ./temp must be gone',
    );
  });

  it('os is imported in fileTransfer.ts', async () => {
    const src = await readSourceRaw('src/security/fileTransfer.ts');
    assert.match(src, /import\s+os\s+from\s+["']os["']/);
  });
});

describe('Fix L5: SSD comment on secureDeleteFile', () => {
  it('has a comment about SSD / wear-leveling / journaling', async () => {
    const src = await readSourceRaw('src/security/fileTransfer.ts');
    const fnIdx = src.indexOf('async secureDeleteFile');
    if (fnIdx < 0) return assert.fail('secureDeleteFile function not found');
    // Grab the first 1200 chars (well past the comment + the body).
    const slice = src.substring(fnIdx, fnIdx + 1200);
    assert.match(
      slice,
      /SSD|wear-?leveling|journaling|best-effort/i,
      'function body must document the SSD limitation',
    );
  });
});

describe('Fix L6: whiteboard newAttr const before push', () => {
  it('attrEdits.push is preceded by a const declaration', async () => {
    const src = await readSourceRaw('src/whiteboard.ts');
    // Find the function start and a fixed-size window after.
    const fnIdx = src.indexOf('export function convertSxeToWhiteboardData');
    if (fnIdx < 0) return assert.fail('convertSxeToWhiteboardData not found');
    // The function is ~120 lines; take 3000 chars to be safe.
    const slice = src.substring(fnIdx, fnIdx + 3000);
    const constDecls = slice.match(/const\s+newAttr\s*=\s*\{/g);
    const pushes = slice.match(/attrEdits\.push\(/g);
    assert.ok(
      constDecls && constDecls.length >= 1,
      'expected at least one `const newAttr = { ... }` declaration',
    );
    assert.ok(
      pushes && pushes.length >= 1,
      'expected at least one attrEdits.push call',
    );
  });
});

describe('Fix L7: whiteboard rawPaths field and standalonePaths removed', () => {
  it('WhiteboardData type no longer has rawPaths', async () => {
    const src = await readSource('src/whiteboard.ts');
    assert.equal(
      /rawPaths\?:\s*string\[\]/.test(src),
      false,
      'rawPaths field must be removed from the return type',
    );
  });

  it('no standalonePaths variable in convertSxeToWhiteboardData', async () => {
    const src = await readSource('src/whiteboard.ts');
    assert.equal(
      /\bstandalonePaths\b/.test(src),
      false,
      'standalonePaths variable must be removed',
    );
  });

  it('no `rawPaths:` in any return statement', async () => {
    const src = await readSource('src/whiteboard.ts');
    assert.equal(
      /return\s*\{[^}]*rawPaths:/.test(src),
      false,
      'return statements must not set rawPaths',
    );
  });
});

describe('Fix L9 + 2.14.7: vCard ops have no hard-coded IQ sleeps (src/lib/vcard-ops.ts)', () => {
  it('the old vcard-cli sendReceive helper is gone', async () => {
    await assert.rejects(readSource('src/vcard-cli.ts'), /ENOENT/);
  });

  it('no real `setTimeout(r, 800|300|500)` fixed sleeps remain', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.equal(src.match(/setTimeout\(\s*r\s*,\s*800\s*\)/g), null);
    assert.equal(src.match(/setTimeout\(\s*r\s*,\s*300\s*\)/g), null);
    assert.equal(src.match(/setTimeout\(\s*r\s*,\s*500\s*\)/g), null);
  });

  it('delegates IQ send/await to the live vcardServer helpers', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.match(src, /vcardServer\.updateVCardOnServer\(/);
    assert.match(src, /vcardServer\.queryVCardFromServer\(/);
  });
});

describe('Fix L10: gateway log.warn when recordInboundSession is missing', () => {
  it('has an else branch with log.warn for missing session', async () => {
    const src = await readSource('src/gateway.ts');
    // The `if (runtime?.channel?.session?.recordInboundSession)` block
    // should be followed by an `else { log.warn(...) }`.
    const ifBlock = src.match(/if\s*\(runtime\?\.channel\?\.session\?\.recordInboundSession\)\s*\{[\s\S]*?\n\s{6}\}\s*else\s*\{[\s\S]*?\n\s{6}\}/);
    if (!ifBlock) {
      assert.fail('expected if(recordInboundSession) { ... } else { ... } block');
    }
    assert.match(
      ifBlock[0],
      /log\.warn\(/,
      'else branch must call log.warn',
    );
    assert.match(
      ifBlock[0],
      /recordInboundSession is unavailable|not recorded/i,
      'else branch must explain why we skipped',
    );
  });
});

describe('Fix L11: state.ts uses Map<string, XmppClient> and Map<string, Contacts>', () => {
  it('xmppClients is Map<string, XmppClient>', async () => {
    const src = await readSource('src/state.ts');
    assert.match(
      src,
      /xmppClients\s*=\s*new\s+Map<string,\s*XmppClient>\(/,
    );
  });

  it('contactsStore is Map<string, Contacts>', async () => {
    const src = await readSource('src/state.ts');
    assert.match(
      src,
      /contactsStore\s*=\s*new\s+Map<string,\s*Contacts>\(/,
    );
  });

  it('XmppClient and Contacts are imported as types', async () => {
    const src = await readSourceRaw('src/state.ts');
    assert.match(src, /import\s+type\s+\{[^}]*\bXmppClient\b[^}]*\}\s+from\s+["']\.\/types\.js["']/);
    assert.match(src, /import\s+type\s+\{[^}]*\bContacts\b[^}]*\}\s+from\s+["']\.\/contacts\.js["']/);
  });
});

describe('Fix L12: commands.ts extracts requireJid() helper', () => {
  it('has a requireJid helper function', async () => {
    const src = await readSource('src/commands.ts');
    assert.match(
      src,
      /function\s+requireJid\(/,
      'requireJid() helper must exist',
    );
  });

  it('requireJid returns false on missing @ and prints usage', async () => {
    const src = await readSource('src/commands.ts');
    const match = src.match(/function\s+requireJid\([\s\S]*?\n\}/);
    if (!match) return assert.fail('requireJid body not found');
    assert.match(match[0], /!jid\.includes\(['"]@['"]\)/);
    assert.match(match[0], /console\.error\(/);
    assert.match(match[0], /return false/);
  });

  it('no remaining bare `if (!jid || !jid.includes(\'@\'))` outside the helper', async () => {
    const src = await readSource('src/commands.ts');
    // The helper itself contains `!jid.includes('@')`.  Count
    // occurrences OUTSIDE the helper.
    const helperMatch = src.match(/function\s+requireJid\([\s\S]*?\n\}/);
    if (!helperMatch) return assert.fail('requireJid body not found');
    const helperBody = helperMatch[0];
    const outsideHelper = src.replace(helperBody, '');
    const matches = outsideHelper.match(/!jid\s*\|\|\s*!jid\.includes\(['"]@['"]\)/g);
    assert.equal(
      matches,
      null,
      `expected zero bare !jid.includes('@') outside requireJid helper; found ${matches?.length ?? 0}`,
    );
  });
});

describe('Fix L13 + 2.14.7: vCard local persistence is async (src/lib/vcard-ops.ts)', () => {
  it('the old vcard-cli saveVCardLocally helper is gone', async () => {
    await assert.rejects(readSource('src/vcard-cli.ts'), /ENOENT/);
  });

  it('persists locally via the async VCard.update() (never sync writes)', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.match(src, /vcard\.update\(/);
    assert.equal(/fs\.writeFileSync/.test(src), false);
    assert.equal(/saveVCardLocally/.test(src), false);
  });

  it('avatar writes use fsp (async), not fs.promises sync APIs', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.match(src, /fsp\.readFile\(/);
    assert.match(src, /fsp\.stat\(/);
  });
});

describe('Fix L14 + 2.14.7: vCard ops never open/modify an XMPP connection', () => {
  it('the old withConnection helper is gone', async () => {
    await assert.rejects(readSourceRaw('src/vcard-cli.ts'), /ENOENT/);
  });

  it('src/lib/vcard-ops.ts does not start or stop an XMPP connection', async () => {
    const src = await readSource('src/lib/vcard-ops.ts');
    assert.equal(/xmpp\.start\(/.test(src), false, 'must not call xmpp.start()');
    assert.equal(/xmpp\.stop\(/.test(src), false, 'must not call xmpp.stop()');
  });
});

describe('Fix L15: debugLog default + cli-debug.log files removed + .gitignore', () => {
  it('debugLog default uses os.homedir() and ~/.openclaw/extensions/xmpp/logs/', async () => {
    // Use readSource (strips comments) so the comment "previous
    // default was process.cwd()" doesn't trigger a false positive.
    const src = await readSource('src/shared/index.ts');
    const fnIdx = src.indexOf('export function debugLog');
    if (fnIdx < 0) return assert.fail('debugLog function not found');
    const slice = src.substring(fnIdx, fnIdx + 1500);
    assert.match(
      slice,
      /os\.homedir\(\)/,
      'default location must use os.homedir()',
    );
    assert.match(
      slice,
      /['"]\.openclaw['"],\s*['"]extensions['"],\s*['"]xmpp['"],\s*['"]logs['"],\s*['"]cli-debug\.log['"]/,
      'default location must end in .openclaw/extensions/xmpp/logs/cli-debug.log',
    );
    assert.equal(
      /process\.cwd\(\)/.test(slice),
      false,
      'default location must NOT be process.cwd()',
    );
  });

  it('cli-debug.log and src/cli-debug.log are deleted from the source tree', async () => {
    let rootExists = false;
    let srcExists = false;
    try { await fs.stat(path.join(__dirname, '..', 'cli-debug.log')); rootExists = true; } catch { /* absent */ }
    try { await fs.stat(path.join(__dirname, '..', 'src', 'cli-debug.log')); srcExists = true; } catch { /* absent */ }
    assert.equal(rootExists, false, './cli-debug.log must be deleted');
    assert.equal(srcExists, false, './src/cli-debug.log must be deleted');
  });

  it('.gitignore has explicit cli-debug.log entries', async () => {
    const src = await readSource('.gitignore');
    assert.match(src, /^\/?cli-debug\.log$/m, '.gitignore must explicitly ignore cli-debug.log');
    assert.match(src, /^\/?src\/cli-debug\.log$/m, '.gitignore must explicitly ignore src/cli-debug.log');
  });
});
