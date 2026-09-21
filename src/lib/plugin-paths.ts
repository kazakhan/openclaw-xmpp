import fs from "fs";
import path from "path";

// SECURITY (2.18.1): in-tree backup/trash dirs break plugin loading on Windows.
//
// OpenClaw captures plugin source by walking the extension directory.  A
// rollback snapshot created inside it can contain a Windows reserved device
// entry (e.g. `nul`), and reading that fails the whole plugin load:
//   "Cannot capture plugin source ...\\_backups\\...\\nul"
// New snapshots live outside the extension dir (see updater.defaultBackupRoot);
// this detects/removes any leftovers.
//
// Dependency-free (fs/path only) so it can be unit-tested under `node --test`.
export const IN_TREE_BACKUP_DIRS = ["_backups", "_trash"] as const;

const BACKUP_SCAN_EXCLUDE = new Set(["node_modules", "dist", ".git"]);

export function findStaleInTreeBackupDirs(pluginDir: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (BACKUP_SCAN_EXCLUDE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if ((IN_TREE_BACKUP_DIRS as readonly string[]).includes(entry.name)) {
        found.push(full);
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(pluginDir, 0);
  return found;
}

// `\\?\` disables Win32 path parsing, so a reserved device entry (`nul`) can
// be deleted; plain `fs.rm` can fail on the device name.
function longPath(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\")) return p;
  return "\\\\?\\" + path.resolve(p);
}

export async function removeStaleInTreeBackups(pluginDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of findStaleInTreeBackupDirs(pluginDir)) {
    for (const candidate of [longPath(dir), dir]) {
      try {
        await fs.promises.rm(candidate, { recursive: true, force: true });
        removed.push(dir);
        break;
      } catch {
        /* try the next form */
      }
    }
  }
  return removed;
}

// SECURITY (2.18.4): group replies must be OPTIONAL (the agent decides).
//
// OpenClaw requires an explicit silent-reply opt-in for accepted group/channel
// requests: without `surfaces.xmpp.silentReply.group = "allow"` every room
// message REQUIRES a reply, so the agent answers every message — including the
// other bot's — and rooms loop.  Mentions and authorized commands still require
// a response; only unaddressed requests may finish silently.
export function isGroupSilentRepliesEnabled(config: any): boolean {
  return config?.surfaces?.xmpp?.silentReply?.group === "allow";
}

export function enableGroupSilentReplies(config: any): any {
  if (config == null || typeof config !== "object") config = {};
  if (config.surfaces == null || typeof config.surfaces !== "object") config.surfaces = {};
  if (config.surfaces.xmpp == null || typeof config.surfaces.xmpp !== "object") {
    config.surfaces.xmpp = {};
  }
  if (
    config.surfaces.xmpp.silentReply == null ||
    typeof config.surfaces.xmpp.silentReply !== "object"
  ) {
    config.surfaces.xmpp.silentReply = {};
  }
  config.surfaces.xmpp.silentReply.group = "allow";
  if (config.surfaces.xmpp.silentReply.internal === undefined) {
    config.surfaces.xmpp.silentReply.internal = "allow";
  }
  return config;
}

// SECURITY (2.18.1): OpenClaw blocks the `before_agent_run`/`agent_end`
// conversation hooks for non-bundled plugins unless
// `plugins.entries.xmpp.hooks.allowConversationAccess=true` is set.  Without
// it the presence auto-activity hooks are dropped with a warning.
export function isConversationAccessEnabled(config: any): boolean {
  return (
    config?.plugins?.entries?.xmpp?.hooks?.allowConversationAccess === true
  );
}

export function enableConversationAccess(config: any): any {
  if (config == null || typeof config !== "object") config = {};
  if (config.plugins == null || typeof config.plugins !== "object") config.plugins = {};
  if (config.plugins.entries == null || typeof config.plugins.entries !== "object") {
    config.plugins.entries = {};
  }
  if (config.plugins.entries.xmpp == null || typeof config.plugins.entries.xmpp !== "object") {
    config.plugins.entries.xmpp = {};
  }
  if (
    config.plugins.entries.xmpp.hooks == null ||
    typeof config.plugins.entries.xmpp.hooks !== "object"
  ) {
    config.plugins.entries.xmpp.hooks = {};
  }
  config.plugins.entries.xmpp.hooks.allowConversationAccess = true;
  return config;
}
