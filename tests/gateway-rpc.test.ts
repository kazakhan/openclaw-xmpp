import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// Fix 1.2: gateway-client.ts no longer puts the gateway auth secret
// on the spawned argv.  Source-level tests.
// =====================================================================

describe('Fix 1.2: gateway RPC auth no longer on argv', () => {
  it('gateway-client.ts does not push --token or --password into args', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'gateway-client.ts'),
      'utf8'
    );
    // The two unsafe lines were:
    //   args.push("--token", config.token);
    //   args.push("--password", config.password);
    // The fixed code sets env vars instead.
    assert.equal(
      /args\.push\(\s*"--token"\s*,\s*config\.token\s*\)/.test(src),
      false,
      'args.push("--token", config.token) must be removed'
    );
    assert.equal(
      /args\.push\(\s*"--password"\s*,\s*config\.password\s*\)/.test(src),
      false,
      'args.push("--password", config.password) must be removed'
    );
  });

  it('gateway-client.ts sets OPENCLAW_GATEWAY_TOKEN as an env var on the child', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'gateway-client.ts'),
      'utf8'
    );
    assert.ok(
      /childEnv\.OPENCLAW_GATEWAY_TOKEN\s*=/.test(src),
      'OPENCLAW_GATEWAY_TOKEN must be set on the spawned child env'
    );
    assert.ok(
      /childEnv\.OPENCLAW_GATEWAY_PASSWORD\s*=/.test(src),
      'OPENCLAW_GATEWAY_PASSWORD must be set on the spawned child env'
    );
  });

  it('emits a one-time warning about env-var auth (Linux /proc/<pid>/environ)', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '..', 'src', 'gateway-client.ts'),
      'utf8'
    );
    assert.ok(
      /passing gateway auth via spawned-child env vars/.test(src),
      'warning text must mention the env-var auth path'
    );
    assert.ok(
      /\/proc\/<pid>\/environ/.test(src),
      'warning must mention /proc/<pid>/environ so operators understand the residual risk'
    );
  });
});
