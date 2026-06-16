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

describe('Fix L9: vcard-cli uses sendReceive helper, no hard-coded sleeps', () => {
  it('has a sendReceive() helper', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.match(
      src,
      /async\s+function\s+sendReceive/,
      'sendReceive helper must be defined',
    );
  });

  it('sendReceive uses clearTimeout and xmpp.off on every path', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const fnMatch = src.match(/async\s+function\s+sendReceive[\s\S]*?\n\}/);
    if (!fnMatch) return assert.fail('sendReceive not found');
    const body = fnMatch[0];
    assert.match(body, /clearTimeout/);
    assert.match(body, /xmpp\.off\(/g);
  });

  it('no real `setTimeout(r, 800)` after IQ sends in vcard-cli.ts', async () => {
    const src = await readSource('src/vcard-cli.ts');
    // The helper comment may contain the literal string `setTimeout(r, 800)`;
    // strip line comments first so the comment doesn't count.
    const withoutComments = src.replace(/\/\/.*$/gm, '');
    // The string should not appear OUTSIDE of comments/strings.
    const matches = withoutComments.match(/setTimeout\(\s*r\s*,\s*800\s*\)/g);
    assert.equal(
      matches,
      null,
      `expected zero setTimeout(r, 800) outside comments; found ${matches?.length ?? 0}`,
    );
  });

  it('no `setTimeout(r, 300)` after IQ sends in vcard-cli.ts', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const withoutComments = src.replace(/\/\/.*$/gm, '');
    const matches = withoutComments.match(/setTimeout\(\s*r\s*,\s*300\s*\)/g);
    assert.equal(
      matches,
      null,
      `expected zero setTimeout(r, 300) outside comments; found ${matches?.length ?? 0}`,
    );
  });

  it('no `setTimeout(r, 500)` in publishAvatar either', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const withoutComments = src.replace(/\/\/.*$/gm, '');
    const matches = withoutComments.match(/setTimeout\(\s*r\s*,\s*500\s*\)/g);
    assert.equal(
      matches,
      null,
      `expected zero setTimeout(r, 500) outside comments; found ${matches?.length ?? 0}`,
    );
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

describe('Fix L13: vcard-cli saveVCardLocally is async + uses fsp', () => {
  it('saveVCardLocally is declared async', async () => {
    const src = await readSource('src/vcard-cli.ts');
    assert.match(
      src,
      /async\s+function\s+saveVCardLocally/,
      'saveVCardLocally must be async',
    );
  });

  it('uses fsp.writeFile (not fs.writeFileSync)', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const fnMatch = src.match(/async\s+function\s+saveVCardLocally[\s\S]*?\n\}/);
    if (!fnMatch) return assert.fail('saveVCardLocally body not found');
    assert.match(
      fnMatch[0],
      /fsp\.writeFile\(/,
      'must use fsp.writeFile',
    );
    assert.equal(
      /fs\.writeFileSync/.test(src),
      false,
      'fs.writeFileSync must not be used anywhere in vcard-cli.ts',
    );
  });

  it('uses fsp.mkdir with recursive: true (no existsSync guard)', async () => {
    const src = await readSource('src/vcard-cli.ts');
    const fnMatch = src.match(/async\s+function\s+saveVCardLocally[\s\S]*?\n\}/);
    if (!fnMatch) return assert.fail('saveVCardLocally body not found');
    assert.match(
      fnMatch[0],
      /fsp\.mkdir\([^)]*recursive:\s*true/,
      'must use fsp.mkdir with recursive: true',
    );
  });

  it('all 10 call sites are awaited', async () => {
    const src = await readSource('src/vcard-cli.ts');
    // Find every saveVCardLocally( occurrence in code (not the declaration).
    const decl = src.match(/async\s+function\s+saveVCardLocally[\s\S]*?\n\}/);
    if (!decl) return assert.fail('saveVCardLocally declaration not found');
    const withoutDecl = src.replace(decl[0], '');
    // Each call site should be `await saveVCardLocally(`
    const awaited = withoutDecl.match(/await\s+saveVCardLocally\(/g);
    const bare = withoutDecl.match(/(?<!await\s)saveVCardLocally\(/g);
    assert.ok(
      awaited && awaited.length >= 10,
      `expected >= 10 awaited call sites; found ${awaited?.length ?? 0}`,
    );
    assert.equal(
      bare,
      null,
      `expected zero bare (non-awaited) call sites; found ${bare?.length ?? 0}`,
    );
  });
});

describe('Fix L14: withConnection wraps xmpp.start() in try/catch', () => {
  it('has try/catch around xmpp.start() in withConnection', async () => {
    const src = await readSourceRaw('src/vcard-cli.ts');
    const fnIdx = src.indexOf('async function withConnection');
    if (fnIdx < 0) return assert.fail('withConnection function not found');
    // Slice 1500 chars — plenty for a ~30-line function.
    const slice = src.substring(fnIdx, fnIdx + 1500);
    assert.match(
      slice,
      /try\s*\{[\s\S]*?await\s+xmpp\.start\(\)[\s\S]*?\}\s*catch\s*\(/,
      'xmpp.start() must be wrapped in try { ... } catch (...)',
    );
  });

  it('catch block calls xmpp.stop() and rethrows', async () => {
    const src = await readSourceRaw('src/vcard-cli.ts');
    const fnIdx = src.indexOf('async function withConnection');
    if (fnIdx < 0) return assert.fail('withConnection function not found');
    const slice = src.substring(fnIdx, fnIdx + 1500);
    // The catch block body — find it, then check for xmpp.stop() and throw.
    const catchMatch = slice.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\n\s{2}\}/);
    if (!catchMatch) {
      assert.fail('catch block not found');
    }
    assert.match(catchMatch[0], /xmpp\.stop\(\)/, 'catch must call xmpp.stop()');
    assert.match(catchMatch[0], /throw\s+err/, 'catch must rethrow');
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
