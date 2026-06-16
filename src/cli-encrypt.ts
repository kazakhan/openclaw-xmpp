#!/usr/bin/env node
import { updateConfigWithEncryptedPassword } from './security/encryption.js';

interface CliArgs {
  positional: string[];
  flags: { config?: string };
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags: { config?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      const v = argv[++i];
      if (typeof v === 'string') flags.config = v;
    } else if (a.startsWith('--config=')) {
      flags.config = a.substring('--config='.length);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function isTTY(): boolean {
  return !!process.stdin.isTTY;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const configPath = flags.config || 'openclaw.json';

  if (positional[0] !== 'encrypt-password') {
    console.log('Usage: npx tsx src/cli-encrypt.ts encrypt-password [password] [--config <path>]');
    console.log('  or:  echo "mypassword" | npx tsx src/cli-encrypt.ts encrypt-password --config openclaw.json');
    process.exit(0);
  }

  let password = positional[1];

  if (password) {
    // Backwards-compat: password on argv.  Emit a deprecation warning
    // because argv is visible to any local process via ps / Task
    // Manager.  Operators should switch to the stdin form.
    process.stderr.write(
      '[cli-encrypt] WARNING: passing the password on the command line ' +
      'is deprecated and exposes the password to any process on the ' +
      'machine.  Pipe the password via stdin instead.  (Removed in 2.1.0.)\n'
    );
  } else {
    if (isTTY()) {
      console.error('No password provided on stdin and stdin is a TTY.');
      console.error('Usage: echo "mypassword" | npx tsx src/cli-encrypt.ts encrypt-password --config openclaw.json');
      process.exit(1);
    }
    const raw = await readStdin();
    password = raw.replace(/\r?\n$/, '').trim();
    if (!password) {
      console.error('Empty password read from stdin.');
      process.exit(1);
    }
  }

  updateConfigWithEncryptedPassword(configPath, password);
  console.log('Password encrypted successfully!');
  console.log(`Config file: ${configPath}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
