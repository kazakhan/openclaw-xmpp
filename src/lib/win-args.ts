// SECURITY (2.18.7): Windows spawn planning.
//
// `cmd.exe /c` mangles absolute paths that contain spaces.  With `/s`, cmd
// strips the outer quotes and splits the command at the first space, so
//   cmd /d /s /c "C:\Program Files\nodejs\node.exe" "scripts\build.mjs"
// is parsed as the command `C:\Program` ->
//   'C:\Program' is not recognized as an internal or external command
// A real executable (node.exe, i.e. `process.execPath`) must therefore be
// spawned directly.  Only `.cmd`/`.bat` shims (npm, npx, openclaw) and bare
// PATH lookups need a shell — and then the whole line must be quoted so spaces
// in *arguments* also survive.
//
// This module is dependency-free (only `node:path`), so it is unit-testable
// under `node --test`.  `scripts/win-args.mjs` mirrors it for the build script.

import path from "node:path";

export interface SpawnPlan {
  mode: "direct" | "shell";
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** True when `cmd` must be launched through `cmd.exe` (bare name or .cmd/.bat). */
export function isWinShellShim(cmd: string): boolean {
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  return !path.win32.isAbsolute(cmd);
}

/**
 * Quote one argument for a `cmd.exe` command line (CommandLineToArgvW rules):
 * only wraps when needed and escapes backslashes that precede a quote.
 */
export function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      out += ch;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes) + '\\"';
      backslashes = 0;
    } else {
      backslashes = 0;
      out += ch;
    }
  }
  out += "\\".repeat(backslashes) + '"';
  return out;
}

/**
 * Decide how to spawn `cmd`/`args`.
 *
 * - posix: spawn directly.
 * - win32 + absolute real executable (e.g. `C:\Program Files\nodejs\node.exe`):
 *   spawn directly, so Node quotes the path correctly (no `cmd` involved).
 * - win32 + bare name / `.cmd` / `.bat`: go through `cmd.exe /d /s /c <line>`
 *   with the line pre-quoted and `windowsVerbatimArguments` so Node passes it
 *   through unchanged.
 */
export function buildSpawnPlan(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform | string = process.platform,
  comspec: string = process.env.ComSpec || "cmd.exe",
): SpawnPlan {
  if (platform !== "win32") return { mode: "direct", file: cmd, args };
  if (!isWinShellShim(cmd)) return { mode: "direct", file: cmd, args };
  const line = [cmd, ...args].map(quoteWinArg).join(" ");
  return {
    mode: "shell",
    file: comspec,
    args: ["/d", "/s", "/c", line],
    windowsVerbatimArguments: true,
  };
}
