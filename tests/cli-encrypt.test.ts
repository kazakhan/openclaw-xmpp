import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// Fix 1.3: cli-encrypt.ts reads the password from stdin instead of
// argv.  Source-level tests.
// =====================================================================

describe('Fix 1.3: cli-encrypt password via stdin', () => {
  it('cli-encrypt.ts defines a readStdin() helper', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'cli-encrypt.ts'),
      'utf8'
    );
    assert.match(src, /function readStdin/, 'readStdin() helper must be defined');
  });

  it('cli-encrypt.ts emits a deprecation warning when password is on argv', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'cli-encrypt.ts'),
      'utf8'
    );
    assert.match(src, /deprecated/i, 'argv usage should emit a deprecation warning');
    assert.match(
      src,
      /\[cli-encrypt\] WARNING/,
      'the warning should be tagged with [cli-encrypt]'
    );
  });

  it('cli-encrypt.ts errors when stdin is a TTY and no argv password is given', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'cli-encrypt.ts'),
      'utf8'
    );
    assert.match(src, /isTTY\(\)/);
    assert.match(
      src,
      /echo "mypassword" \| npx tsx src\/cli-encrypt\.ts encrypt-password/
    );
  });

  it('cli-encrypt.ts strips the trailing newline from the stdin password', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'cli-encrypt.ts'),
      'utf8'
    );
    assert.ok(
      /replace\([^,]+, ["']["']\)/.test(src),
      'the code should strip a trailing newline before trim()'
    );
    assert.match(src, /\.trim\(\)/);
  });

  it('cli-encrypt.ts supports the --config / -c flag', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'cli-encrypt.ts'),
      'utf8'
    );
    assert.match(src, /--config/);
    assert.match(src, /--config=/);
  });
});
