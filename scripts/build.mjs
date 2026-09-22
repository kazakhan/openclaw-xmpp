#!/usr/bin/env node
// SECURITY (2.18.5): build the plugin so OpenClaw's plugin source-capture stays
// small.
//
// OpenClaw 2026.9.5 added a plugin source-capture step that Babel-parses the
// plugin's entire transitive module graph on load.  An unbundled `dist` drags
// `typebox` (~1,400 files) and `@xmpp/*` (~180 files) through the parser, which
// takes ~90 s per load and exceeds OpenClaw's 120 s model-runtime build timeout.
//
// This script runs `tsc` (typecheck + emit, also the fallback if bundling fails)
// and then bundles each entry with esbuild, inlining pure-JS dependencies
// (typebox, @xmpp/client) while keeping host-provided/native modules external.
// The capture graph drops from thousands of files to a handful.
//
// Bundling is best-effort: if esbuild is missing or a bundle fails, the
// tsc-emitted output is kept (no regression on hosts without the capture).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function run(cmd, args, label) {
  try {
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe";
      execFileSync(comspec, ["/d", "/s", "/c", cmd, ...args], {
        cwd: pluginDir,
        stdio: "inherit",
        windowsHide: true,
      });
    } else {
      execFileSync(cmd, args, { cwd: pluginDir, stdio: "inherit" });
    }
  } catch (err) {
    throw new Error(`${label} failed: ${err?.message || String(err)}`);
  }
}

// 1. tsc: typecheck + emit.  `noEmitOnError:false` means it still emits a usable
//    dist/ on type-only errors; treat that as a warning when dist/index.js exists.
try {
  run("npx", ["tsc"], "tsc build");
} catch (err) {
  if (!fs.existsSync(path.join(pluginDir, "dist", "index.js"))) throw err;
  console.warn(`[build] tsc reported errors but emitted dist/; continuing. ${err?.message || err}`);
}

// 2. Bundle each entry with esbuild (best-effort).
let esbuild = null;
try {
  esbuild = await import("esbuild");
} catch {
  console.warn("[build] esbuild is not installed; keeping the unbundled tsc output.");
  process.exit(0);
}

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
      logLevel: "warning",
      allowOverwrite: true,
    });
    fs.renameSync(out, entry);
    console.log(`[build] bundled dist/${name}.js`);
  } catch (err) {
    console.warn(`[build] bundling ${name} failed; keeping unbundled output: ${err?.message || err}`);
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
  }
}
