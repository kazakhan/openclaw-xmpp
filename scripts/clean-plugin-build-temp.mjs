#!/usr/bin/env node
// SECURITY (2.18.6): remove stale OpenClaw plugin source-capture temp dirs.
//
// OpenClaw 2026.9.5+ copies each plugin's source into a scratch dir named
// `openclaw-plugin-build-*` under the OS temp dir (`%TEMP%` on Windows,
// `$TMPDIR` elsewhere) and does not always clean them up.  On a busy host these
// accumulate (observed: 324 dirs / 26.7 GB) until the disk is starved, which
// can stop channel plugins from loading at all.
//
// The plugin itself cannot fix this at load time (it fails before loading), so
// this runs from the build/install flow.  It is deliberately conservative:
// only direct children of the OS temp dir whose name starts with a known
// prefix AND whose mtime is older than a grace period are removed, so a
// concurrent OpenClaw capture is never disturbed.
//
// Env overrides:
//   OPENCLAW_XMPP_TEMP_GRACE_MS       age threshold ms (default 3600000 = 1h)
//   OPENCLAW_XMPP_TEMP_PREFIXES       comma-separated name prefixes
//   OPENCLAW_XMPP_SKIP_TEMP_CLEAN=1   no-op

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.env.OPENCLAW_XMPP_SKIP_TEMP_CLEAN === "1") process.exit(0);

const GRACE_MS = Number(process.env.OPENCLAW_XMPP_TEMP_GRACE_MS || 60 * 60 * 1000);
const PREFIXES = (process.env.OPENCLAW_XMPP_TEMP_PREFIXES || "openclaw-plugin-build-")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const tmp = os.tmpdir();

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    if (process.platform !== "win32") return false;
  }
  // Windows: reserved device names (e.g. `nul`) inside the tree need the \\?\
  // prefix, which `fs.rmSync` cannot apply.
  try {
    const comspec = process.env.ComSpec || "cmd.exe";
    execFileSync(comspec, ["/d", "/s", "/c", "rd", "/s", "/q", `\\\\?\\${dir}`], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

let removed = 0;
let freed = 0;
let skipped = 0;

let names = [];
try {
  names = fs.readdirSync(tmp);
} catch {
  process.exit(0);
}

for (const name of names) {
  if (!PREFIXES.some((p) => name.startsWith(p))) continue;
  const full = path.join(tmp, name);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    continue;
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) continue;
  if (Date.now() - st.mtimeMs < GRACE_MS) {
    skipped++;
    continue;
  }
  const size = st.isDirectory() ? dirSize(full) : 0;
  if (removeDir(full)) {
    removed++;
    freed += size;
    console.log(`[cleanup] removed ${full} (${(size / 1048576).toFixed(1)} MB)`);
  } else {
    console.warn(`[cleanup] could not remove ${full}`);
  }
}

if (removed > 0 || skipped > 0) {
  console.log(
    `[cleanup] removed ${removed} stale plugin-build temp dir(s), freed ${(freed / 1048576).toFixed(1)} MB` +
      (skipped ? `; kept ${skipped} recent dir(s)` : ""),
  );
}
process.exit(0);
