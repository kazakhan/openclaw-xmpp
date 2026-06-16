import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "./lib/logger.js";

interface GatewayConfig {
  url: string;
  token?: string;
  password?: string;
}

// SECURITY (2.0.15): warn exactly once per process when we have to put
// the gateway auth secret on the spawned child's environment.  This is
// the best we can do while `openclaw gateway call` does not accept
// --stdin or env-var auth.  The warning is intentionally a one-time
// `warn` (not `error`) so it does not flood the log on every RPC.
let _gatewayAuthWarned = false;
function warnGatewayAuthOnce(): void {
  if (_gatewayAuthWarned) return;
  _gatewayAuthWarned = true;
  log.warn(
    "[gateway-client] passing gateway auth via spawned-child env vars; " +
    "this is visible to other local processes via /proc/<pid>/environ on " +
    "Linux.  Upstream `openclaw` CLI is expected to add env-var auth in a " +
    "future release to close this.  See CHANGELOG 2.0.15."
  );
}

async function getGatewayConfig(): Promise<GatewayConfig> {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "openclaw.json");
  const url = process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_REMOTE_URL || "ws://127.0.0.1:18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_REMOTE_TOKEN;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.OPENCLAW_REMOTE_PASSWORD;

  if (fs.existsSync(configPath)) {
    try {
      const configData = fs.readFileSync(configPath, "utf8");
      const config = JSON.parse(configData);
      const gwConfig = config.gateway || {};
      return {
        url: gwConfig.url || url,
        token: token || gwConfig.auth?.token,
        password: password || gwConfig.auth?.password
      };
    } catch {
      return { url, token, password };
    }
  }
  return { url, token, password };
}

function extractJsonFromOutput(output: string): string | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      return line;
    }
    if (line === '}' || line === '{') {
      const jsonLines = lines.slice(i).map(l => l.trim()).join('');
      if (jsonLines.startsWith('{') && jsonLines.endsWith('}')) {
        return jsonLines;
      }
    }
  }
  return null;
}

export interface RpcResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

const RPC_TIMEOUT_MS = 30_000;

export async function callGatewayRpc<T = any>(method: string, params?: Record<string, any>): Promise<RpcResult<T>> {
  const config = await getGatewayConfig();
  const isWindows = process.platform === "win32";

  // SECURITY (2.0.15): the previous implementation appended
  //   --token <token>   or   --password <password>
  // to the spawned argv.  Command-line arguments are visible to any
  // local process via `wmic process get commandline` (Windows),
  // `ps aux` (Linux), `/proc/<pid>/cmdline` (Linux), or Task Manager
  // (Windows, Details column).  Any other process on the same host
  // could read the gateway auth token in plaintext.
  //
  // The new implementation never puts the token or password on argv.
  // They are passed through the spawn's environment so that the
  // OpenClaw CLI may pick them up (current versions of `openclaw
  // gateway call` do not, but the env-var path is the correct
  // direction and avoids the argv leak).  See CHANGELOG 2.0.15 for
  // the rollout plan.
  const args = ["gateway", "call", method];
  if (params) {
    args.push("--params", JSON.stringify(params));
  }
  if (config.url && config.url !== "ws://127.0.0.1:18789") {
    args.push("--url", config.url);
  }

  // We do NOT pass --token or --password.  We do, however, set them
  // as env vars on the spawned process so that any future CLI version
  // that supports env-var auth will receive them.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (config.token) {
    childEnv.OPENCLAW_GATEWAY_TOKEN = config.token;
    warnGatewayAuthOnce();
  }
  if (config.password) {
    childEnv.OPENCLAW_GATEWAY_PASSWORD = config.password;
    warnGatewayAuthOnce();
  }

  return new Promise((resolve) => {
    let proc;
    if (isWindows) {
      proc = spawn("cmd.exe", ["/c", "openclaw", ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        env: childEnv,
      });
    } else {
      proc = spawn("openclaw", args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: childEnv,
      });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; proc.kill('SIGTERM'); resolve({ ok: false, error: 'timeout' }); }
    }, RPC_TIMEOUT_MS);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const output = stdout.trim();
      if (code === 0 && output) {
        try {
          const json = extractJsonFromOutput(output);
          if (json) {
            const parsed = JSON.parse(json);
            resolve({ ok: true, data: parsed as T });
          } else {
            resolve({ ok: false, error: 'no-json-in-output' });
          }
        } catch (e: any) {
          resolve({ ok: false, error: `parse-failed: ${e.message}` });
        }
      } else {
        resolve({ ok: false, error: `exit-code-${code}` });
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
    });
  });
}

export async function joinRoom(room: string, nick?: string): Promise<boolean> {
  const result = await callGatewayRpc<{ ok: boolean; room?: string; nick?: string }>("xmpp.joinRoom", { room, nick });
  if (result?.ok && result.data?.ok) {
    log.debug("room joined", { room: result.data.room, nick: result.data.nick });
    return true;
  }
  return false;
}

export async function leaveRoom(room: string, nick?: string): Promise<boolean> {
  const result = await callGatewayRpc<{ ok: boolean }>("xmpp.leaveRoom", { room, nick });
  return (result?.ok && result.data?.ok) || false;
}

export async function getJoinedRooms(): Promise<Array<{ room: string; nick?: string }>> {
  const result = await callGatewayRpc<{ rooms: Array<{ room: string; nick?: string }> }>("xmpp.getJoinedRooms");
  return result?.data?.rooms || [];
}

export async function inviteToRoom(contact: string, room: string, reason?: string): Promise<boolean> {
  const result = await callGatewayRpc<{ ok: boolean }>("xmpp.inviteToRoom", { contact, room, reason });
  if (result?.ok && result.data?.ok) {
    log.debug("room invite sent", { contact, room });
    return true;
  }
  return false;
}

export async function removeContact(jid: string): Promise<boolean> {
  const result = await callGatewayRpc<{ ok: boolean }>("xmpp.removeContact", { jid });
  if (result?.ok && result.data?.ok) {
    log.debug("contact removed", { jid });
    return true;
  }
  return false;
}
