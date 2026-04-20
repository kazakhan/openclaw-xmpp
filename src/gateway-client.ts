import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "./lib/logger.js";

interface GatewayConfig {
  url: string;
  token?: string;
  password?: string;
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

  const args = ["gateway", "call", method];
  if (params) {
    args.push("--params", JSON.stringify(params));
  }
  if (config.url && config.url !== "ws://127.0.0.1:18789") {
    args.push("--url", config.url);
  }
  if (config.token) {
    args.push("--token", config.token);
  } else if (config.password) {
    args.push("--password", config.password);
  }

  return new Promise((resolve) => {
    let proc;
    if (isWindows) {
      proc = spawn("cmd.exe", ["/c", "openclaw", ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true
      });
    } else {
      proc = spawn("openclaw", args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
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
