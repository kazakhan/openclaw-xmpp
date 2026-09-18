#!/usr/bin/env node
// SECURITY (2.17.1): best-effort link of the global OpenClaw install into
// `node_modules/openclaw` so `npx tsc` can resolve `openclaw/plugin-sdk/*`
// (those subpaths need the package `exports` map, which requires
// `moduleResolution: "bundler"`).  Never fails the install — if the global
// OpenClaw can't be found we simply exit 0.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linkPath = path.join(pluginDir, "node_modules", "openclaw");

if (fs.existsSync(linkPath)) process.exit(0);

function findGlobalOpenclaw() {
  try {
    const isWin = process.platform === "win32";
    const file = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
    const args = isWin ? ["/d", "/s", "/c", "npm", "root", "-g"] : ["root", "-g"];
    const root = execFileSync(file, args, { encoding: "utf8", windowsHide: true }).trim();
    const cand = path.join(root, "openclaw");
    return fs.existsSync(cand) ? cand : null;
  } catch {
    return null;
  }
}

const target = findGlobalOpenclaw();
if (!target) process.exit(0);

try {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  console.log(`[xmpp] linked OpenClaw SDK: ${linkPath} -> ${target}`);
} catch {
  /* best-effort; typecheck just won't resolve the SDK */
}
process.exit(0);
