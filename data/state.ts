import type { PluginApi } from "clawdbot";

export const state = {
  api: null as PluginApi | null,
  xmpp: null as any,
  agents: new Set<string>()
};
