import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawn } from "child_process";

import { buildSpawnPlan } from "./lib/win-args.ts";

const REPO = "kazakhan/openclaw-xmpp";
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ARCHIVE = (tag: string) => `https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`;

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "data",
  "_backups",
  "_trash",
  ".opencode",
]);

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseBody?: string;
  error?: string;
}

export interface UpdateResult {
  ok: boolean;
  fromVersion: string;
  toVersion?: string;
  message: string;
}

function pluginDirFallback(): string {
  return path.join(os.homedir(), ".openclaw", "extensions", "xmpp");
}

// SECURITY (2.18.1): rollback snapshots must live OUTSIDE the extension
// directory.  OpenClaw captures plugin source by walking the extension dir;
// an in-tree `_backups/` snapshot can contain a Windows reserved device entry
// (e.g. `nul`) and fail the whole plugin load ("Cannot capture plugin source
// ...\\_backups\\...\\nul").
export function defaultBackupRoot(): string {
  return path.join(os.homedir(), ".openclaw", "_backups", "xmpp");
}

// Windows reserves these device names at every path level; a file/dir with one
// of these names cannot be read back and breaks recursive scans/copies.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME.test(name);
}

// SECURITY (2.18.2): remove any in-tree backup/trash dirs before snapshotting.
// A leftover in-tree `_backups/` dir can break plugin source capture on Windows
// (a `nul` entry), so updates clean it as well as writing new snapshots
// out-of-tree.  Uses `\\?\` on win32 so a reserved device entry can be deleted.
export function purgeInTreeBackups(pluginDir: string): string[] {
  const removed: string[] = [];
  for (const name of ["_backups", "_trash"]) {
    const target = path.join(pluginDir, name);
    if (!fs.existsSync(target)) continue;
    const candidates =
      process.platform === "win32" ? ["\\\\?\\" + path.resolve(target), target] : [target];
    for (const candidate of candidates) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed.push(target);
        break;
      } catch {
        /* try the next form */
      }
    }
  }
  return removed;
}

// --- version helpers -------------------------------------------------------

function parseSemver(v: string): number[] {
  const m = (v || "")
    .replace(/^v/i, "")
    .match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : [0, 0, 0];
}

export function isNewer(current: string, latest: string): boolean {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export function getCurrentVersion(pluginDir?: string): string {
  const dir = pluginDir || pluginDirFallback();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

// --- github ----------------------------------------------------------------

export async function getLatestRelease(): Promise<{ tag: string; body: string; url?: string }> {
  const res = await fetch(API_LATEST, {
    headers: { "User-Agent": "openclaw-xmpp-updater", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API responded ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { tag: data.tag_name || "", body: data.body || "", url: data.html_url };
}

export async function checkForUpdate(pluginDir?: string): Promise<UpdateInfo> {
  const current = getCurrentVersion(pluginDir);
  try {
    const { tag, body } = await getLatestRelease();
    const latest = (tag || "").replace(/^v/i, "");
    return { current, latest, updateAvailable: isNewer(current, latest), releaseBody: body };
  } catch (err) {
    return {
      current,
      latest: current,
      updateAvailable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * SECURITY (2.16.4): takes a `send(jid, text)` callback rather than the raw
 * @xmpp/client.  The raw client's `send(element)` expects an XML element;
 * passing a JID string threw `Cannot create property 'parent' on string '<jid>'`
 * as an (uncaught) rejected promise and crashed the gateway.
 */
export function notifyUpdateAvailable(
  send: (jid: string, text: string) => void,
  adminJids: string[],
  info: UpdateInfo,
): void {
  if (!info.updateAvailable) return;
  const lines = [
    `[XMPP Update] New version v${info.latest} is available (you are on v${info.current}).`,
    `To update, run: openclaw xmpp update`,
  ];
  if (info.releaseBody) {
    lines.push("", "Release notes:", info.releaseBody.slice(0, 800));
  }
  const text = lines.join("\n");
  for (const jid of adminJids) {
    try {
      send(jid, text);
    } catch {
      /* best-effort */
    }
  }
}

// --- shell + fs helpers ----------------------------------------------------

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

// SECURITY (2.16.5): Node >=18.20.2/20.12.2/21.7.3 (CVE-2024-27980) refuses to
// spawn `.cmd`/`.bat` shims without a shell, so `execFileSync("npm.cmd", …)`
// throws EINVAL on Windows.  Wrap with `cmd.exe /d /s /c` explicitly (rather
// than `shell: true`, which emits Node's DEP0190 deprecation warning).
// SECURITY (2.18.7): real executables (process.execPath) are spawned directly —
// routing an absolute path with spaces through `cmd /s /c` broke every Windows
// update ("'C:\Program' is not recognized").  See `./lib/win-args.js`.
function run(cmd: string, args: string[], cwd: string, label: string): string {
  const opts = {
    cwd,
    stdio: "pipe" as const,
    encoding: "utf8" as const,
    windowsHide: true,
  };
  try {
    if (process.platform === "win32") {
      const plan = buildSpawnPlan(cmd, args);
      // `windowsVerbatimArguments` is a spawn option that `execFileSync`'s type
      // does not list; assign to a variable so TS's excess-property check
      // (literals only) does not reject it.
      const execOpts = { ...opts, windowsVerbatimArguments: plan.windowsVerbatimArguments };
      try {
        return execFileSync(plan.file, plan.args, execOpts);
      } catch (spawnErr: any) {
        // SECURITY (2.18.1): some locked-down Windows environments reject the
        // cmd.exe wrapper.  EINVAL/ENOENT here means the process never started,
        // so retrying through the shell is safe (no double execution).
        if (spawnErr?.code === "EINVAL" || spawnErr?.code === "ENOENT") {
          return execFileSync(cmd, args, { ...opts, shell: true });
        }
        throw spawnErr;
      }
    }
    return execFileSync(cmd, args, opts);
  } catch (err: any) {
    const msg = err?.stderr || err?.stdout || err?.message || String(err);
    throw new Error(`${label} failed: ${String(msg).trim()}`);
  }
}

/** Validate a release tag before it is used in a shell command line. */
export function isSafeUpdateTag(tag: string): boolean {
  return /^[0-9A-Za-z._-]+$/.test(tag || "");
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

function isGitDirty(dir: string): boolean {
  try {
    const out = run("git", ["status", "--porcelain"], dir, "git status");
    return out.trim().length > 0;
  } catch {
    return true;
  }
}

function findGlobalOpenclaw(): string | null {
  try {
    const out = run(exe("npm"), ["root", "-g"], process.cwd(), "npm root -g").trim();
    const cand = path.join(out, "openclaw");
    return fs.existsSync(cand) ? cand : null;
  } catch {
    return null;
  }
}

function ensureSdkLink(dir: string): void {
  const localSdk = path.join(dir, "node_modules", "openclaw");
  if (fs.existsSync(localSdk)) return;
  const global = findGlobalOpenclaw();
  if (global) {
    try {
      fs.symlinkSync(global, localSdk, "junction");
    } catch {
      /* best-effort */
    }
  }
}

// Exported for tests (the updater is otherwise a private CLI helper).
export async function copyTree(src: string, dest: string, exclude: Set<string>): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  await fs.promises.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      const parts = rel.split(path.sep).filter(Boolean);
      if (parts.length === 0) return true;
      if (exclude.has(parts[0])) return false;
      // SECURITY (2.18.1): never copy Windows reserved device names.
      return !parts.some((part) => isWindowsReservedName(part));
    },
  });
}

// SECURITY (2.15.3): snapshot the plugin for rollback.
//
// `fs.cp` refuses to copy a directory into a subdirectory of itself
// (`ERR_FS_CP_EINVAL: Cannot copy <src> to a subdirectory of self`), and the
// snapshot destination (`<pluginDir>/_backups/<ver>_<ts>`) is exactly that.
// The `EXCLUDE_DIRS`/`_backups` filter does NOT help: Node validates
// `dest` is not inside `src` BEFORE running the filter, so
// `openclaw xmpp update` always failed at the snapshot step.  Stage the copy
// OUTSIDE the source tree, then move it into place (falling back to a copy
// when staging and the destination are on different filesystems, e.g. tmpfs).
export async function snapshotPlugin(pluginDir: string, dest: string): Promise<void> {
  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xmpp-snap-"));
  try {
    await copyTree(pluginDir, staging, EXCLUDE_DIRS);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.promises.rename(staging, dest);
    } catch (err: any) {
      if (err?.code !== "EXDEV") throw err;
      await copyTree(staging, dest, EXCLUDE_DIRS);
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function restoreSnapshot(pluginDir: string, snapDest: string): Promise<void> {
  await copyTree(snapDest, pluginDir, EXCLUDE_DIRS);
}

function findArchiveRoot(tmpDir: string): string | null {
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(tmpDir, e.name));
  return dirs.find((d) => {
    return fs.existsSync(path.join(d, "package.json")) || fs.existsSync(path.join(d, "src"));
  }) || dirs[0] || null;
}

async function applyTarball(pluginDir: string, latest: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xmpp-upd-"));
  try {
    const tarPath = path.join(tmp, `v${latest}.tar.gz`);
    const res = await fetch(ARCHIVE(`v${latest}`));
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${ARCHIVE(`v${latest}`)}`);
    fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
    run("tar", ["-xzf", tarPath, "-C", tmp], tmp, "tar extract");
    const root = findArchiveRoot(tmp);
    if (!root) throw new Error("Could not locate extracted source directory");
    await copyTree(root, pluginDir, new Set([...EXCLUDE_DIRS, ".git"]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- main ------------------------------------------------------------------

export async function performUpdate(
  opts: { pluginDir?: string; dryRun?: boolean } = {},
): Promise<UpdateResult> {
  const dir = opts.pluginDir || pluginDirFallback();
  // SECURITY (2.18.2): clear any in-tree backup/trash dirs (a `nul` entry there
  // can break plugin loading on Windows) before doing anything else.
  purgeInTreeBackups(dir);
  const current = getCurrentVersion(dir);

  let latest: string;
  let releaseBody: string | undefined;
  try {
    const rel = await getLatestRelease();
    latest = (rel.tag || "").replace(/^v/i, "");
    releaseBody = rel.body;
  } catch (err) {
    return { ok: false, fromVersion: current, message: err instanceof Error ? err.message : String(err) };
  }

  // SECURITY (2.16.5): the tag goes into a git checkout / shell command line.
  if (!isSafeUpdateTag(latest)) {
    return { ok: false, fromVersion: current, message: `Refusing to update: unsafe release tag "${latest}".` };
  }

  if (!isNewer(current, latest)) {
    return { ok: true, fromVersion: current, message: `Already up to date (v${current}).` };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      fromVersion: current,
      toVersion: latest,
      message: `Would update v${current} -> v${latest}. (dry-run)`,
    };
  }

  // Snapshot for rollback (private, outside the extension dir).
  // SECURITY (2.18.1): an in-tree `_backups/` dir is walked by OpenClaw's
  // plugin source capture and can break plugin loading on Windows.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapDest = path.join(defaultBackupRoot(), `${current}_${ts}`);
  await snapshotPlugin(dir, snapDest);

  let installed = false;
  try {
    if (isGitRepo(dir)) {
      if (isGitDirty(dir)) {
        throw new Error("Plugin directory has uncommitted changes; refusing to update. Commit or stash them first.");
      }
      run("git", ["fetch", "--tags", "origin"], dir, "git fetch");
      // SECURITY (2.18.3): check out the release ON A BRANCH, not a detached
      // HEAD.  `git checkout v<tag>` left the repo detached, so a later manual
      // `git pull` failed with "You are not currently on a branch".  `-B main`
      // resets/creates `main` at the tag and checks it out; the upstream is set
      // best-effort so `git pull` works afterwards.
      try {
        run("git", ["checkout", "-B", "main", `v${latest}`], dir, "git checkout");
        try {
          run("git", ["branch", "--set-upstream-to=origin/main", "main"], dir, "git upstream");
        } catch {
          /* best-effort (no origin/main, or already tracking) */
        }
      } catch {
        // Fallback for unusual branch layouts: keep the previous behaviour.
        run("git", ["checkout", `v${latest}`], dir, "git checkout");
      }
      installed = true;
    } else {
      await applyTarball(dir, latest);
      installed = true;
    }
  } catch (err) {
    await restoreSnapshot(dir, snapDest).catch(() => {});
    return {
      ok: false,
      fromVersion: current,
      message: err instanceof Error ? err.message : `Update failed: ${String(err)}`,
    };
  }

  if (!installed) {
    return { ok: false, fromVersion: current, message: "Update did not install any files." };
  }

  // Dependencies + build.
  try {
    run(exe("npm"), ["install"], dir, "npm install");
    ensureSdkLink(dir);
    fs.rmSync(path.join(dir, "dist"), { recursive: true, force: true });
    try {
      // SECURITY (2.18.5/2.18.7): `npm run build` runs `scripts/build.mjs` (tsc
      // then esbuild bundle) so OpenClaw 2026.9.5+'s plugin source-capture only
      // sees a handful of files (not typebox/@xmpp's thousands).  Launching npm
      // (a bare `.cmd` shim) also avoids the Windows `cmd /c` quoting bug that
      // broke spawning `process.execPath` (a path containing spaces).
      run(exe("npm"), ["run", "build"], dir, "build");
    } catch (buildErr) {
      // `noEmitOnError:false` means tsc still emits a usable dist/ on type-only
      // errors, and bundling is best-effort; treat that as a warning and only
      // fail when no build output was produced.
      if (!fs.existsSync(path.join(dir, "dist", "index.js"))) throw buildErr;
      console.warn(
        `[updater] build reported errors but emitted dist/; continuing. ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`,
      );
    }

    // SECURITY (2.18.6): prune devDependencies so OpenClaw 2026.9.5+'s plugin
    // source-capture only copies the runtime deps (@openclaw/xmpp + ssh2), and
    // clear stale plugin-build temp dirs.  Both are best-effort.
    try {
      run(exe("npm"), ["prune", "--omit=dev", "--no-audit", "--no-fund"], dir, "npm prune");
    } catch {
      /* prune is best-effort */
    }
    try {
      run(process.execPath, [path.join("scripts", "clean-plugin-build-temp.mjs")], dir, "temp cleanup");
    } catch {
      /* temp cleanup is best-effort */
    }
  } catch (err) {
    await restoreSnapshot(dir, snapDest).catch(() => {});
    return {
      ok: false,
      fromVersion: current,
      message: `Build failed; restored previous version. ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    fromVersion: current,
    toVersion: latest,
    message: `Updated v${current} -> v${latest}.`,
  };
}

// --- auto-update prompt helpers (2.13.1) -----------------------------------

const AFFIRMATIVE = new Set([
  "yes", "y", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm",
  "update", "install", "do it", "go ahead", "please do", "/update",
]);
const NEGATIVE = new Set([
  "no", "n", "nope", "skip", "later", "cancel", "not now", "nevermind",
  "never mind", "do not", "don't", "/skip",
]);

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.has((text || "").trim().toLowerCase());
}

export function isNegative(text: string): boolean {
  return NEGATIVE.has((text || "").trim().toLowerCase());
}

export function formatAskMessage(info: UpdateInfo): string {
  const lines = [
    `[XMPP Update] v${info.latest} is available (you are on v${info.current}).`,
    `Reply "yes" to install it now, or "no" to skip.`,
  ];
  if (info.releaseBody) lines.push("", "Release notes:", info.releaseBody.slice(0, 800));
  return lines.join("\n");
}

/**
 * Restart the managed OpenClaw gateway (detached, best-effort).  Used after a
 * successful auto-update so the new build is loaded without manual steps.
 * The child is detached and unref'd so it survives this process exiting.
 */
export function restartGateway(): void {
  try {
    if (process.platform === "win32") {
      // SECURITY (2.16.5): spawning `openclaw.cmd` without a shell throws
      // EINVAL on Node >=18.20.2 (CVE-2024-27980); go through cmd.exe.
      const comspec = process.env.ComSpec || "cmd.exe";
      const child = spawn(comspec, ["/d", "/s", "/c", "openclaw", "gateway", "restart"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
    const child = spawn("openclaw", ["gateway", "restart"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // best-effort; operator can restart manually
  }
}

