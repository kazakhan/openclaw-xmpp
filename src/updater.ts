import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

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

export function notifyUpdateAvailable(xmpp: any, adminJids: string[], info: UpdateInfo): void {
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
      const p = xmpp.send(jid, text);
      if (p && typeof p.then === "function") p.then(() => {}, () => {});
    } catch {
      /* best-effort */
    }
  }
}

// --- shell + fs helpers ----------------------------------------------------

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(cmd: string, args: string[], cwd: string, label: string): string {
  try {
    return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", windowsHide: true });
  } catch (err: any) {
    const msg = err?.stderr || err?.stdout || err?.message || String(err);
    throw new Error(`${label} failed: ${String(msg).trim()}`);
  }
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
    const out = execFileSync(exe("npm"), ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
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

async function copyTree(src: string, dest: string, exclude: Set<string>): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  await fs.promises.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      const parts = rel.split(path.sep).filter(Boolean);
      if (parts.length === 0) return true;
      return !exclude.has(parts[0]);
    },
  });
}

async function snapshotPlugin(pluginDir: string, dest: string): Promise<void> {
  await copyTree(pluginDir, dest, EXCLUDE_DIRS);
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

  // Snapshot for rollback (private, gitignored).
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapDest = path.join(dir, "_backups", `${current}_${ts}`);
  await snapshotPlugin(dir, snapDest);

  let installed = false;
  try {
    if (isGitRepo(dir)) {
      if (isGitDirty(dir)) {
        throw new Error("Plugin directory has uncommitted changes; refusing to update. Commit or stash them first.");
      }
      run("git", ["fetch", "--tags", "origin"], dir, "git fetch");
      run("git", ["checkout", `v${latest}`], dir, "git checkout");
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
    run(exe("npx"), ["tsc"], dir, "tsc build");
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
    message: `Updated v${current} -> v${latest}. Restart the gateway (openclaw gateway restart) to apply.`,
  };
}
