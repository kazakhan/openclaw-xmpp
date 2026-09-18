import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { createInterface } from "node:readline";
import { encryptPasswordInConfig } from "./security/encryption.js";

export interface OnboardingOptions {
  configPath?: string;
  pluginDir?: string;
  account?: string;
  skipInstall?: boolean;
  interactive?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface OnboardingResult {
  ok: boolean;
  account?: string;
  configPath?: string;
  changed?: boolean;
  error?: string;
}

const DEFAULT_ACCOUNT = "default";

function homedir(): string {
  return os.homedir();
}

function resolveConfigPath(configPath?: string): string {
  return configPath || path.join(homedir(), ".openclaw", "openclaw.json");
}

function resolvePluginDir(pluginDir?: string): string {
  return pluginDir || path.join(homedir(), ".openclaw", "extensions", "xmpp");
}

function isTty(stream: NodeJS.ReadableStream | undefined): boolean {
  return !!stream && (stream as any).isTTY === true;
}

function jsonPath(root: any, p: string): any {
  return p.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), root);
}

export interface AccountTemplate {
  service?: string;
  domain?: string;
  jid?: string;
  password?: string;
  dataDir?: string;
  nick?: string;
  resource?: string;
  adminJid?: string;
  enabled?: boolean;
}

/**
 * Pure helper: read and merge an account config into the given openclaw
 * config object, preserving every unrelated key and any other xmpp
 * accounts.  Used by onboaring and testable in isolation.
 */
export function mergeAccountConfig(
  config: any,
  account: string,
  incoming: AccountTemplate,
): { config: any; previous: AccountTemplate | null } {
  if (config == null || typeof config !== "object") config = {};
  if (config.channels == null || typeof config.channels !== "object") config.channels = {};
  if (config.channels.xmpp == null || typeof config.channels.xmpp !== "object") config.channels.xmpp = {};
  if (config.channels.xmpp.accounts == null || typeof config.channels.xmpp.accounts !== "object") {
    config.channels.xmpp.accounts = {};
  }

  const previous: AccountTemplate | null = config.channels.xmpp.accounts[account] ?? null;

  const merged: any = { ...(previous || {}), ...incoming };
  // encryption fields (if any) from incoming must override previous
  if (incoming.password !== undefined) merged.password = incoming.password;
  if ((incoming as any).encryptionKey !== undefined) merged.encryptionKey = (incoming as any).encryptionKey;
  if ((incoming as any).encryptionSalt !== undefined) merged.encryptionSalt = (incoming as any).encryptionSalt;

  config.channels.xmpp.accounts[account] = merged;
  return { config, previous };
}

export async function readOpenclawConfig(configPath: string): Promise<any> {
  let raw = "";
  try {
    raw = await fs.promises.readFile(configPath, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function writeOpenclawConfig(configPath: string, config: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function readConfigItem(config: any, account: string): any {
  return jsonPath(config, `channels.xmpp.accounts.${account}`);
}

// --- interactive prompting -------------------------------------------------

interface PromptState {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  interactive: boolean;
}

function promptLine(
  { stdin, stdout, interactive }: PromptState,
  question: string,
  defaultValue?: string,
): Promise<string> {
  return new Promise((resolve) => {
    if (!interactive || !isTty(stdin)) {
      // non-interactive: honour the default (or empty)
      resolve(defaultValue ?? "");
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      const v = answer.trim();
      resolve(v || defaultValue || "");
    });
  });
}

function promptSecret({ stdin, stdout, interactive }: PromptState, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!interactive || !isTty(stdin)) {
      resolve("");
      return;
    }
    const input = stdin;
    const output = stdout;
    output.write(`  ${question}: `);
    const prevMode = (input as any).isRaw ?? false;
    (input as any).setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (char: string) => {
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Aborted by user (Ctrl-C)"));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        output.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u007f" || char === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      const code = char.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        value += char;
        output.write("*");
      }
    };
    const cleanup = () => {
      input.removeListener("data", onData);
      (input as any).setRawMode?.(prevMode);
      input.pause();
    };
    input.on("data", onData);
  });
}

function promptChoice(
  state: PromptState,
  question: string,
  choices: string[], // e.g. ["keep", "override", "cancel"]
  defaultChoice: string,
): Promise<string> {
  return new Promise((resolve) => {
    const normalized = choices.map((c) => c.toLowerCase());
    const label = choices.join("/");
    const ask = async (): Promise<void> => {
      const answer = (await promptLine(state, `${question} (${label})`, defaultChoice)).toLowerCase();
      if (normalized.includes(answer)) {
        resolve(answer);
        return;
      }
      // retry
      (state.stdout as any).write("  Invalid choice. ");
      await ask();
    };
    void ask();
  });
}

// --- prerequisite "if needed" install steps --------------------------------

// SECURITY (2.16.5): Node >=18.20.2 (CVE-2024-27980) refuses to spawn
// `.cmd`/`.bat` shims without a shell, so `npm`/`npx` fail on Windows.  Wrap
// with `cmd.exe /d /s /c` explicitly (avoids the `shell: true` DEP0190 warning).
function run(cmd: string, args: string[], cwd: string, label: string): string | null {
  try {
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe";
      return execFileSync(comspec, ["/d", "/s", "/c", cmd, ...args], {
        cwd,
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
      });
    }
    return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", windowsHide: true });
  } catch (err: any) {
    const msg = err?.stderr || err?.stdout || err?.message || String(err);
    throw new Error(`${label} failed: ${String(msg).trim()}`);
  }
}

const REPO_URL = "https://github.com/kazakhan/openclaw-xmpp.git";

/**
 * Idempotently fills the gaps of a partially-installed plugin.  Only
 * performs a step when the artifact is missing.  Throws when a step
 * we MUST run fails (e.g. clone/npm/build), so the caller can surface
 * a clean error.  `findGlobalOpenclaw()` is best-effort and never
 * blocks configuration.
 */
export async function ensurePluginInstalled(
  pluginDir: string,
  opts: { skipInstall?: boolean },
): Promise<string[]> {
  const steps: string[] = [];
  if (opts.skipInstall) return steps;
  const dir = pluginDir;

  // 1. clone (only if the plugin isn't there)
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    run("git", ["clone", REPO_URL, dir], path.dirname(dir), "git clone");
    steps.push("clone");
  }

  // 2. npm install
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    run("npm", ["install"], dir, "npm install");
    steps.push("npm install");
  }

  // 3. link global openclaw SDK into node_modules/openclaw (best-effort)
  const localSdk = path.join(dir, "node_modules", "openclaw");
  if (!fs.existsSync(localSdk)) {
    const resolvedGlobal = findGlobalOpenclaw();
    if (resolvedGlobal) {
      try {
        fs.symlinkSync(resolvedGlobal, localSdk, "junction");
        steps.push("link sdk");
      } catch {
        /* best-effort; runtime resolves openclaw from its own node_modules */
      }
    }
  }

  // 4. build dist if missing
  if (!fs.existsSync(path.join(dir, "dist"))) {
    run("npx", ["tsc"], dir, "tsc build");
    steps.push("build");
  }

  return steps;
}

function findGlobalOpenclaw(): string | null {
  try {
    const out = run("npm", ["root", "-g"], process.cwd(), "npm root -g")?.trim() || "";
    const candidate = path.join(out, "openclaw");
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// --- runtime-readiness guard (2.11.2) --------------------------------------
//
// OpenClaw launches a `.ts` extension with `node --import tsx <entry>`
// (see openclaw's resolveRuntimeWorkerArgv).  `tsx` is only a
// devDependency of openclaw, so it is NOT guaranteed to be installed.
// If `dist/` is absent, OpenClaw falls back to `index.ts` and needs
// tsx; without both it crashes with the cryptic:
//   "Cannot find package 'tsx'"
//
// These helpers make that condition diagnosable and self-healing:
//   - `ensureDistBuilt()` rebuilds `dist/` when it is missing.
//   - `diagnosePluginState()` returns a readable report + fix.
//   - `openclaw xmpp doctor` prints the report (see src/commands.ts).

export interface PluginDiagnostics {
  pluginDir: string;
  distExists: boolean;
  tsxAvailable: boolean;
  entryKind: "dist" | "ts";
  problems: string[];
  fixes: string[];
  ready: boolean;
}

function tsxResolvable(pluginDir: string): boolean {
  const local = path.join(pluginDir, "node_modules", "tsx");
  if (fs.existsSync(local)) return true;
  // openclaw might provide tsx via the global npm tree that the plugin
  // links against (node_modules/openclaw is a symlink to the global one).
  const sdk = findGlobalOpenclaw();
  if (sdk) {
    const viaSdk = path.join(path.dirname(sdk), "tsx");
    if (fs.existsSync(viaSdk)) return true;
  }
  return false;
}

export function diagnosePluginState(
  pluginDir: string = resolvePluginDir(),
  configPath: string = resolveConfigPath(),
): PluginDiagnostics {
  const distExists = fs.existsSync(path.join(pluginDir, "dist"));
  const tsxAvailable = tsxResolvable(pluginDir);
  const entryKind: "dist" | "ts" = distExists ? "dist" : "ts";
  const problems: string[] = [];
  const fixes: string[] = [];

  if (!distExists) {
    problems.push(
      `The compiled output was not found (${path.join(pluginDir, "dist")} does not exist). ` +
        "OpenClaw must load compiled JS. Without it, it falls back to the TypeScript " +
        "entry (index.ts), which is launched with `node --import tsx`.",
    );
    if (tsxAvailable) {
      fixes.push(
        "Rebuild the compiled output by running:  npx tsc   (recommended).",
      );
      fixes.push(
        "Or install tsx to run directly from source:  npm install tsx@4.23.12",
      );
    } else {
      fixes.push(
        "Rebuild the compiled output by running:  npx tsc   (recommended, does not require tsx).",
      );
    }
    fixes.push("You can also run:  openclaw xmpp setup   (it rebuilds dist/ automatically).");
  }

  if (distExists && entryKind === "dist") {
    problems.push("No issues found: the compiled dist/ is present, so OpenClaw loads the plugin as plain JS.");
  }

  return {
    pluginDir,
    distExists,
    tsxAvailable,
    entryKind,
    problems,
    fixes,
    ready: distExists,
  };
}

/**
 * Ensure `dist/` exists; if it is missing (or stale) rebuild it.
 * Returns whether a build ran.  Throws on rebuild failure so callers
 * surface a clean error instead of the cryptic "Cannot find package
 * 'tsx'" OpenClaw otherwise throws at startup.
 */
export async function ensureDistBuilt(pluginDir: string = resolvePluginDir()): Promise<{ built: boolean }> {
  if (fs.existsSync(path.join(pluginDir, "dist"))) {
    return { built: false };
  }
  try {
    run("npx", ["tsc"], pluginDir, "tsc build");
  } catch (tscErr) {
    // SECURITY (2.16.5): tsc exits non-zero on type-only errors but still emits
    // (noEmitOnError:false).  Only fail when no build output was produced.
    if (!fs.existsSync(path.join(pluginDir, "dist", "index.js"))) throw tscErr;
    console.warn(
      `[onboarding] tsc reported type errors but emitted dist/; continuing. ${tscErr instanceof Error ? tscErr.message : String(tscErr)}`,
    );
  }
  return { built: true };
}

// --- main onboaring --------------------------------------------------------

export async function runXmppOnboarding(options: OnboardingOptions = {}): Promise<OnboardingResult> {
  const configPath = resolveConfigPath(options.configPath);
  const pluginDir = resolvePluginDir(options.pluginDir);
  const account = options.account || DEFAULT_ACCOUNT;
  const interactive = options.interactive ?? true;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  // 0. Fill install gaps (only if requested / needed)
  if (!options.skipInstall) {
    try {
      await ensurePluginInstalled(pluginDir, { skipInstall: false });
    } catch (err) {
      return { ok: false, account, configPath, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 1. Locate config + existing account
  let config: any;
  try {
    config = await readOpenclawConfig(configPath);
  } catch (err) {
    return { ok: false, account, configPath, error: err instanceof Error ? err.message : String(err) };
  }

  const existing = readConfigItem(config, account);
  const state: PromptState = { stdin, stdout, interactive };

  // 2. Keep / Override / Cancel
  let reuse = false;
  if (existing) {
    const choice = await promptChoice(
      state,
      `An XMPP account (${existing.jid || account}) already exists in ${configPath}`,
      ["keep", "override", "cancel"],
      "keep",
    );
    if (choice === "cancel") {
      return { ok: true, account, configPath, changed: false };
    }
    reuse = choice === "keep";
  }

  // 3. Collect connection details
  const out = existing && reuse ? { ...existing } : {};
  const svc = await promptLine(state, "Server (service URL)", out.service || "xmpp://host:5222");
  const domain = await promptLine(state, "Domain", out.domain || domainFromService(svc));
  const jid = await promptLine(state, "JID (user@domain)", out.jid || "");
  const dataDir = await promptLine(
    state,
    "Data directory (used for encryption salt + message logs)",
    out.dataDir || path.join(pluginDir, "data"),
  );
  const nick = await promptLine(state, "Bot nickname (optional)", promote(out.nick));
  const resource = await promptLine(state, "Resource (optional)", promote(out.resource));
  const adminJid = await promptLine(state, "Admin JID (optional)", promote(out.adminJid));

  const password = await promptSecret(state, "Account password (hidden)");

  if (!jid || !svc) {
    return { ok: false, account, configPath, error: "Missing required fields: JID and server are required" };
  }

  const base: AccountTemplate = {
    service: svc,
    domain,
    jid,
    dataDir,
    ...(nick ? { nick } : {}),
    ...(resource ? { resource } : {}),
    ...(adminJid ? { adminJid } : {}),
    enabled: true,
  };

  // 4. Encrypt the password (requires dataDir for the salt file).
  let accountConfig: any = { ...base };
  if (password) {
    try {
      await fs.promises.mkdir(dataDir, { recursive: true });
      accountConfig = encryptPasswordInConfig(accountConfig, password);
    } catch (err) {
      return {
        ok: false,
        account,
        configPath,
        error: `Failed to encrypt password: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 5. Merge into config (preserve other keys/accounts)
  const { config: merged } = mergeAccountConfig(config, account, accountConfig);

  // SECURITY (2.17.0): the plugin sets `InboundEventKind` directly (all room
  // messages are delivered; unmentioned ones are passive `room_event`, mentions
  // are `user_request`), so onboarding no longer writes the old mention-only
  // toggles (`channels.xmpp.groups.*.requireMention`,
  // `messages.groupChat.unmentionedInbound`).

  try {
    await writeOpenclawConfig(configPath, merged);
  } catch (err) {
    return { ok: false, account, configPath, error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` };
  }

  stdout.write(`\nXMPP account "${account}" configured.\n`);
  stdout.write(`  JID:      ${jid}\n`);
  stdout.write(`  Server:   ${svc}\n`);
  stdout.write(`  Domain:   ${domain}\n`);
  stdout.write(`  dataDir:  ${dataDir}\n`);
  if (password) stdout.write(`  Password: encrypted (ENC:...) with per-install salt\n`);
  stdout.write(`\nConfig file: ${configPath}\n`);
  stdout.write(`Next: restart the gateway (openclaw gateway restart) to connect.\n`);

  return { ok: true, account, configPath, changed: true };
}

function domainFromService(service: string): string {
  try {
    const u = new URL(service);
    return u.hostname || "";
  } catch {
    return "";
  }
}

function promote(v: string | undefined): string {
  return v || "";
}
