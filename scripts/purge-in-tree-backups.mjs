#!/usr/bin/env node
// SECURITY (2.18.2): pre-load repair for Windows.
//
// OpenClaw captures plugin source by walking the extension directory.  An
// in-tree `_backups/` snapshot can contain a Windows reserved device entry
// (e.g. `nul`), which fails the whole plugin load:
//   "Cannot capture plugin source ...\\_backups\\...\\nul"
// The plugin cannot self-heal (it fails before any plugin code runs), so this
// runs from `postinstall` and the installers, OUTSIDE the plugin load.
//
// Removes in-tree `_backups`/`_trash` dirs and any Windows reserved-name
// entries, using `\\?\`-prefixed paths so the device names can be deleted.
// Best-effort: always exits 0.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BACKUP_DIRS = new Set(["_backups", "_trash"]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// `\\?\` disables Win32 path parsing, so `nul` is treated as a normal name.
function longPath(p) {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\")) return p;
  return "\\\\?\\" + path.resolve(p);
}

function remove(p) {
  for (const candidate of [longPath(p), p]) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      return true;
    } catch {
      /* try the next form */
    }
  }
  return false;
}

const removed = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (BACKUP_DIRS.has(entry.name) || RESERVED.test(entry.name)) {
        if (remove(full)) removed.push(full);
        continue;
      }
      walk(full, depth + 1);
    } else if (RESERVED.test(entry.name)) {
      if (remove(full)) removed.push(full);
    }
  }
};

walk(pluginDir, 0);

if (removed.length > 0) {
  console.log(`[xmpp] removed in-tree backup/reserved entries that break plugin source capture:`);
  for (const p of removed) console.log(`  - ${p}`);
}
process.exit(0);
