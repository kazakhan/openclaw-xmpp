import type { PluginRuntime, XmppClient } from "./types.js";
import type { Contacts } from "./contacts.js";

// SECURITY (2.18.8): OpenClaw loads several bundled entries of this plugin
// (`index.js`, `channel-plugin-api.js`, `runtime-setter-api.js`, …).  esbuild
// (2.18.5+) bundles each entry independently, so a plain module-level variable
// exists as a SEPARATE COPY PER BUNDLE: OpenClaw calls
// `setXmppRuntime(runtime)` on the `runtime-setter-api.js` copy while the
// gateway (`channel-plugin-api.js`) reads its own copy, leaving
// `getPluginRuntime()` null and inbound dispatch skipped with
//   WARN runtime.channel not available, cannot dispatch
// so agents stopped replying.  Back the state with a process-wide singleton on
// `globalThis` so every bundle copy shares it (same pattern the plugin already
// uses for `(global as any).whiteboardSessionManager`).
const STATE_KEY = Symbol.for("openclaw.xmpp.state");

interface XmppProcessState {
  clients: Map<string, XmppClient>;
  contacts: Map<string, Contacts>;
  runtime: PluginRuntime | null;
  registered: boolean;
}

const root = globalThis as unknown as Record<symbol, XmppProcessState | undefined>;
const state: XmppProcessState = (root[STATE_KEY] ??= {
  clients: new Map<string, XmppClient>(),
  contacts: new Map<string, Contacts>(),
  runtime: null,
  registered: false,
});

export const xmppClients = state.clients;
export const contactsStore = state.contacts;

export function getPluginRuntime(): PluginRuntime | null {
  return state.runtime;
}

export function isPluginRegistered(): boolean {
  return state.registered;
}

export function markPluginRegistered(): void {
  state.registered = true;
}

export function setXmppRuntime(runtime: PluginRuntime | null): void {
  state.runtime = runtime;
}
