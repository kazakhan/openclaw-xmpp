#!/usr/bin/env node
// SECURITY (2.18.6): build the plugin so OpenClaw's plugin source-capture stays
// small AND the bundle actually loads.
//
// OpenClaw 2026.9.5 added a plugin source-capture step that Babel-parses the
// plugin's entire transitive module graph on load.  Bundling alone is not
// enough (see 2.18.5): the capture walks the *declared* dependency tree, so
// `@xmpp/client` + `typebox` must be moved to devDependencies and node_modules
// pruned, otherwise the capture is still ~12k files / 40 MB (~90 s per load,
// twice per startup, over the 120 s model-runtime build timeout).
//
// 2.18.5 also shipped a bundle that could not load:
//   Error: Dynamic require of "events" is not supported
// esbuild rewrites CJS `require()` in ESM output to its `__require` shim, which
// throws unless a real `require` exists.  The fix is a `createRequire` banner,
// plus a two-phase build so an already-bundled entry is never inlined into
// another (duplicate `__createRequire`).
//
// This script:
//   1. ensures the build toolchain (npm install if devDeps were pruned),
//   2. runs `tsc` (typecheck + emit; also the fallback if bundling fails),
//   3. bundles each entry with esbuild (`createRequire` banner; inlines
//      @xmpp/client + typebox; keeps host-provided/native modules external),
//   4. verifies every bundle has the banner before swapping it in (never ships
//      a `Dynamic require` bundle; keeps the unbundled tsc output otherwise),
//   5. optionally prunes devDependencies (`OPENCLAW_XMPP_PRUNE=1`) so OpenClaw's
//      capture only sees runtime deps (installers/updater prune by default),
//   6. removes stale OpenClaw plugin-build temp dirs.
//
// Every step is best-effort and env-overridable:
//   OPENCLAW_XMPP_PRUNE=1            run `npm prune --omit=dev` after bundling
//   OPENCLAW_XMPP_SKIP_TEMP_CLEAN=1  skip stale temp-dir cleanup
//   OPENCLAW_XMPP_TEMP_GRACE_MS      age threshold for temp cleanup (default 1h)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildSpawnPlan } from "./win-args.mjs";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Entry points that OpenClaw loads (main entry + the bundled sub-entries
// referenced by `defineBundledChannelEntry` specifiers).
const ENTRIES = [
  "index",
  "setup-entry",
  "channel-plugin-api",
  "secret-contract-api",
  "runtime-setter-api",
  "setup-plugin-api",
];

// Host-provided or native modules that must not be inlined.
const EXTERNAL = ["openclaw", "openclaw/*", "@openclaw/*", "ssh2", "cpu-features"];

// SECURITY (2.18.6): esbuild's ESM output turns CJS `require()` into a shim
// that throws `Dynamic require of "x" is not supported` when no real `require`
// exists.  This banner defines one via `createRequire`; the marker text is
// asserted on every bundle before it is swapped in.
const BANNER =
  'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url); /* openclaw-xmpp:createRequire */';
const BANNER_MARKER = "openclaw-xmpp:createRequire";

function envFlag(name) {
  const v = process.env[name];
  return v === "1" || v === "true";
}

// SECURITY (2.16.5): `.cmd`/`.bat` shims (npm/npx) need a shell on Windows
// (CVE-2024-27980).  SECURITY (2.18.7): real executables (process.execPath) are
// spawned directly — routing a spaced absolute path through `cmd /s /c` broke
// Windows ("'C:\Program' is not recognized").  See `win-args.mjs`.
function run(cmd, args, label) {
  try {
    const plan = buildSpawnPlan(cmd, args);
    execFileSync(plan.file, plan.args, {
      cwd: pluginDir,
      stdio: "inherit",
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
  } catch (err) {
    throw new Error(`${label} failed: ${err?.message || String(err)}`);
  }
}

function runBestEffort(cmd, args, label) {
  try {
    run(cmd, args, label);
    return true;
  } catch (err) {
    console.warn(`[build] ${label} failed (continuing): ${err?.message || String(err)}`);
    return false;
  }
}

const has = (rel) => fs.existsSync(path.join(pluginDir, "node_modules", rel));

// 0. Ensure the build toolchain.  A previously-pruned node_modules (see step 5)
//    has neither typescript nor esbuild, so restore devDeps before building.
if (!has("typescript") || !has("esbuild")) {
  console.log("[build] build toolchain missing (pruned?); running npm install...");
  runBestEffort("npm", ["install", "--no-audit", "--no-fund"], "npm install");
}

// 1. tsc: typecheck + emit.  `noEmitOnError:false` means it still emits a usable
//    dist/ on type-only errors; treat that as a warning when dist/index.js exists.
try {
  run("npx", ["tsc"], "tsc build");
} catch (err) {
  if (!fs.existsSync(path.join(pluginDir, "dist", "index.js"))) throw err;
  console.warn(`[build] tsc reported errors but emitted dist/; continuing. ${err?.message || err}`);
}

// 2. Bundle each entry with esbuild (best-effort).  Two-phase: build ALL
//    entries from the unbundled tsc output first, verify them, then swap them
//    in.  `src/outbound.ts` imports `../index.js`, so swapping as we go would
//    inline an already-bundled index.js and duplicate the banner.
let esbuild = null;
try {
  esbuild = await import("esbuild");
} catch {
  console.warn("[build] esbuild is not installed; keeping the unbundled tsc output.");
  esbuild = null;
}

const built = [];
if (esbuild) {
  for (const name of ENTRIES) {
    const entry = path.join(pluginDir, "dist", `${name}.js`);
    if (!fs.existsSync(entry)) continue;
    const out = path.join(pluginDir, "dist", `${name}.bundle.js`);
    try {
      await esbuild.build({
        entryPoints: [entry],
        outfile: out,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        external: EXTERNAL,
        banner: { js: BANNER },
        logLevel: "warning",
        allowOverwrite: true,
      });
      // SECURITY (2.18.6): never ship a bundle without the real `require`.
      const text = fs.readFileSync(out, "utf8");
      if (!text.includes(BANNER_MARKER)) {
        throw new Error("bundle is missing the createRequire banner");
      }
      built.push({ name, entry, out });
    } catch (err) {
      fs.rmSync(out, { force: true });
      console.warn(`[build] bundling ${name} failed; keeping unbundled output: ${err?.message || err}`);
    }
  }

  // Swap in only after every bundle built + verified.
  for (const { name, entry, out } of built) {
    fs.renameSync(out, entry);
    console.log(`[build] bundled dist/${name}.js`);
  }
}

// 3. Prune devDependencies when explicitly requested (`OPENCLAW_XMPP_PRUNE=1`).
//    Now that @xmpp/client + typebox are inlined and devDeps are declared as
//    such, OpenClaw's source-capture only copies `@openclaw/xmpp + ssh2` (a
//    handful of files) instead of the whole toolchain.  The installers/updater
//    run the prune themselves; this env flag is for hosts that build manually.
if (envFlag("OPENCLAW_XMPP_PRUNE") && has("typescript")) {
  if (runBestEffort("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], "npm prune")) {
    // `npm prune` can drop the extraneous `node_modules/openclaw` SDK symlink;
    // restore it (needed only for tsc) so a later rebuild does not re-fetch.
    runBestEffort(process.execPath, [path.join("scripts", "link-openclaw-sdk.mjs")], "link sdk");
  }
}

// 4. Remove stale OpenClaw plugin-build temp dirs (OpenClaw never cleans them).
if (!envFlag("OPENCLAW_XMPP_SKIP_TEMP_CLEAN")) {
  const script = path.join(pluginDir, "scripts", "clean-plugin-build-temp.mjs");
  if (fs.existsSync(script)) {
    runBestEffort(process.execPath, [path.join("scripts", "clean-plugin-build-temp.mjs")], "temp cleanup");
  }
}
