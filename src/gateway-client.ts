import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { log } from "./lib/logger.js";
import { parseFirstJson } from "./lib/json-extract.js";

// SECURITY (2.15.1): CLI -> gateway RPC transport.
//
// History:
//   - 2.0.15 removed `--token`/`--password` from the spawned argv (they leaked
//     via /proc/<pid>/cmdline and Task Manager) and relied on env-var auth.
//   - That child-spawn path is fragile: the child must resolve `openclaw`,
//     resolve the configured auth (incl. SecretRefs) in the service env, and
//     survive Windows `cmd.exe` arg quoting — failures surfaced as the opaque
//     `exit-code-1`, and the stdout parser mis-handled pretty JSON containing a
//     nested `{` on its own line (`parse-failed: Unexpected non-whitespace
//     character after JSON`).
//
// Fix: prefer OpenClaw's OWN in-process gateway client
// (`openclaw/plugin-sdk/gateway-runtime` -> `callGatewayFromCli`), which speaks
// the Gateway WebSocket protocol directly — no child process, no argv/env
// secret, no stdout parsing, works on Windows and Linux.  The hardened spawn
// path is kept only as a fallback for older hosts that do not expose the SDK.

interface GatewayConfig {
  url: string;
  token?: string;
  password?: string;
}

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const RPC_TIMEOUT_MS = 30_000;

// SECURITY (2.0.15): warn exactly once per process when we have to put
// the gateway auth secret on the spawned child's environment.  Only used by
// the spawn fallback now; the preferred in-process path never spawns.
let _gatewayAuthWarned = false;
function warnGatewayAuthOnce(): void {
  if (_gatewayAuthWarned) return;
  _gatewayAuthWarned = true;
  log.warn(
    "[gateway-client] in-process gateway RPC unavailable; falling back to " +
    "spawning `openclaw gateway call` and passing gateway auth via spawned-child env vars. " +
    "This is visible to other local processes via /proc/<pid>/environ on Linux. " +
    "Update OpenClaw to a build that exposes `openclaw/plugin-sdk/gateway-runtime` " +
    "to avoid the child process.",
  );
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract a human-readable message from an SDK error / gateway response. */
function formatGatewayError(err: any): string {
  const rp = err?.responsePayload;
  if (rp && typeof rp === "object") {
    if (typeof rp.error === "string") return rp.error;
    if (rp.error && typeof rp.error === "object" && typeof rp.error.message === "string") {
      return rp.error.message;
    }
    if (typeof rp.message === "string") return rp.message;
    try { return JSON.stringify(rp); } catch { /* fall through */ }
  }
  if (err && typeof err === "object" && typeof err.message === "string") {
    const code = err.code || err.gatewayCode;
    return code && !err.message.includes(code) ? `${err.message} [${code}]` : err.message;
  }
  return err === undefined || err === null ? "unknown error" : String(err);
}

async function getGatewayConfig(): Promise<GatewayConfig> {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "openclaw.json");
  const url = process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_REMOTE_URL || DEFAULT_GATEWAY_URL;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_REMOTE_TOKEN;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.OPENCLAW_REMOTE_PASSWORD;

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const gwConfig = config.gateway || {};
      const remote = gwConfig.remote || {};
      // SECURITY (2.15.1): also consider gateway.remote.* (the CLI's own
      // precedence) and never surface a non-string SecretRef as a literal.
      return {
        url: url || asString(gwConfig.url) || asString(remote.url) || DEFAULT_GATEWAY_URL,
        token: token || asString(gwConfig.auth?.token) || asString(remote.token),
        password: password || asString(gwConfig.auth?.password) || asString(remote.password),
      };
    } catch {
      return { url, token, password };
    }
  }
  return { url, token, password };
}

// ---------------------------------------------------------------------------
// Preferred: in-process gateway SDK
// ---------------------------------------------------------------------------

type SdkCaller = (
  method: string,
  opts: Record<string, unknown>,
  params?: unknown,
  extra?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// undefined = not attempted yet; null = unavailable.
let _sdkCaller: SdkCaller | null | undefined;

/** Walk up from a file to the `openclaw` package root (package.json name). */
function findOpenclawPackageRoot(startFile: string): string | null {
  let dir = path.dirname(startFile);
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (parsed?.name === "openclaw") return dir;
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the bundled plugin-SDK gateway-runtime module.  First try the normal
 * bare specifier (works when the host's module loader maps `openclaw/*`), then
 * fall back to the absolute file inside the running OpenClaw install (works
 * when the plugin is loaded as native ESM).
 */
async function loadSdkCaller(): Promise<SdkCaller | null> {
  if (_sdkCaller !== undefined) return _sdkCaller;

  // 1) Bare specifier.
  try {
    const spec = "openclaw/plugin-sdk/gateway-runtime";
    const mod: any = await import(spec);
    if (typeof mod?.callGatewayFromCli === "function") {
      _sdkCaller = mod.callGatewayFromCli as SdkCaller;
      return _sdkCaller;
    }
  } catch (err) {
    log.debug("[gateway-client] bare gateway-runtime import failed", err);
  }

  // 2) Absolute path inside the running OpenClaw install.
  const candidates: string[] = [];
  const argv1 = process.argv[1];
  if (argv1) {
    const root = findOpenclawPackageRoot(argv1);
    if (root) candidates.push(path.join(root, "dist", "plugin-sdk", "gateway-runtime.js"));
    const dir = path.dirname(argv1);
    candidates.push(path.join(dir, "plugin-sdk", "gateway-runtime.js"));
    candidates.push(path.join(dir, "dist", "plugin-sdk", "gateway-runtime.js"));
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const mod: any = await import(pathToFileURL(file).href);
      if (typeof mod?.callGatewayFromCli === "function") {
        log.debug("[gateway-client] using absolute gateway-runtime", { file });
        _sdkCaller = mod.callGatewayFromCli as SdkCaller;
        return _sdkCaller;
      }
    } catch (err) {
      log.debug("[gateway-client] absolute gateway-runtime import failed", { file, err });
    }
  }

  _sdkCaller = null;
  return null;
}

async function callGatewayViaSdk<T>(
  method: string,
  params?: Record<string, any>,
  scopes?: string[],
): Promise<{ ok: boolean; data?: T; error?: string } | null> {
  const caller = await loadSdkCaller();
  if (!caller) return null;

  const config = await getGatewayConfig();
  const opts: Record<string, unknown> = { json: true };
  if (config.url) opts.url = config.url;
  if (config.token) opts.token = config.token;
  if (config.password) opts.password = config.password;

  try {
    const data = (await caller(method, opts, params, {
      sharedStateMode: "read-only",
      progress: false,
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
    })) as T;
    return { ok: true, data };
  } catch (err: any) {
    // The in-process path is authoritative: surface the real error (auth,
    // unknown method, validation failure, transport) rather than falling back
    // to the opaque spawn.  `respond(false, {error})` arrives as
    // `err.responsePayload.error`.
    const details = err?.details ?? err?.responsePayload?.error?.details ?? err?.responsePayload?.details;
    return { ok: false, error: formatGatewayError(err), ...(details !== undefined ? { details } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Fallback: spawn `openclaw gateway call`
// ---------------------------------------------------------------------------

/** Resolve the OpenClaw CLI entry so we can spawn it via `node` (no cmd.exe). */
function resolveOpenclawEntry(): string | null {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  const root = findOpenclawPackageRoot(argv1);
  const candidates: string[] = [];
  if (root) {
    candidates.push(path.join(root, "openclaw.mjs"));
    candidates.push(path.join(root, "dist", "index.js"));
  }
  const dir = path.dirname(argv1);
  candidates.push(path.join(dir, "openclaw.mjs"));
  candidates.push(path.join(dir, "..", "openclaw.mjs"));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function buildSpawnTarget(config: GatewayConfig, method: string, params?: Record<string, any>) {
  const callArgs: string[] = ["gateway", "call", method];
  if (params !== undefined) callArgs.push("--params", JSON.stringify(params));
  if (config.url) callArgs.push("--url", config.url);
  callArgs.push("--json"); // no `Gateway call: <method>` heading; structured errors

  // SECURITY (2.15.1): prefer `node <openclaw-entry>` so args (including the
  // JSON `--params`) never pass through `cmd.exe` quoting on Windows.
  const entry = resolveOpenclawEntry();
  if (entry) {
    return { command: process.execPath, args: [entry, ...callArgs] };
  }
  const isWin = process.platform === "win32";
  return isWin
    ? { command: "cmd.exe", args: ["/c", "openclaw", ...callArgs] }
    : { command: "openclaw", args: callArgs };
}

async function callGatewayViaSpawn<T>(method: string, params?: Record<string, any>): Promise<{ ok: boolean; data?: T; error?: string }> {
  const config = await getGatewayConfig();
  const { command, args } = buildSpawnTarget(config, method, params);

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
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
        env: childEnv,
      });
    } catch (err: any) {
      resolve({ ok: false, error: err?.message || String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        resolve({ ok: false, error: "timeout" });
      }
    }, RPC_TIMEOUT_MS);

    proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      // Parse the first complete JSON value, tolerating preamble (older CLIs
      // print `Gateway call: <method>`) and trailing logs.
      const parsed = parseFirstJson<any>(stdout);
      if (parsed && typeof parsed === "object") {
        if (code === 0) {
          resolve({ ok: true, data: parsed as T });
          return;
        }
        resolve({ ok: false, error: formatGatewayError({ responsePayload: parsed }) });
        return;
      }

      if (code === 0) {
        resolve({ ok: false, error: "no-json-in-output" });
        return;
      }
      const detail = (stderr || stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      resolve({ ok: false, error: `exit-code-${code}${detail ? `: ${detail}` : ""}` });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RpcResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Structured gateway error details (e.g. `{ reason: "QUESTION_ALREADY_TERMINAL" }`). */
  details?: any;
}

export async function callGatewayRpc<T = any>(
  method: string,
  params?: Record<string, any>,
  scopes?: string[],
): Promise<RpcResult<T>> {
  // SECURITY (2.15.1): prefer the in-process SDK (no spawn/auth/quoting/parsing).
  const viaSdk = await callGatewayViaSdk<T>(method, params, scopes);
  if (viaSdk) return viaSdk;

  // Fallback for hosts without the plugin-SDK gateway runtime.
  return callGatewayViaSpawn<T>(method, params);
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
