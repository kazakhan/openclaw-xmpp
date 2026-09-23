// SECURITY (2.18.7): Windows spawn planning (ESM mirror of src/lib/win-args.ts
// for the build script, which runs before tsc emits anything).
//
// `cmd.exe /c` mangles absolute paths with spaces (e.g. `process.execPath` =
// `C:\Program Files\nodejs\node.exe`): with `/s`, cmd strips the outer quotes
// and splits at the first space -> "'C:\Program' is not recognized".  Real
// executables are spawned directly; only `.cmd`/`.bat` shims and bare PATH
// lookups go through `cmd.exe`, with the line pre-quoted.

import path from "node:path";

export function isWinShellShim(cmd) {
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  return !path.win32.isAbsolute(cmd);
}

export function quoteWinArg(arg) {
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

export function buildSpawnPlan(cmd, args, platform = process.platform, comspec = process.env.ComSpec || "cmd.exe") {
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
