import { xmppClients } from "./state.js";
import { child } from "./lib/logger.js";

// SECURITY (2.15.0): map OpenClaw agent-lifecycle hooks onto the XMPP bot's
// presence ("busy/thinking" while a run is active).  This is a thin adapter:
// all state/precedence/throttling lives in PresenceManager (src/presence.ts).
//
// Only runs bound to the XMPP channel (or to a configured XMPP account) affect
// presence, so a Discord/other-channel run never flips the XMPP bot offline.

const log = child("presence-hooks");

export function registerPresenceHooks(api: any): void {
  if (!api || typeof api.on !== "function") {
    return; // older host without the plugin hook surface
  }

  // runId -> accountId (only for runs we accepted as XMPP-bound).
  const presenceRuns = new Map<string, string>();

  const clientById = (accountId?: string) => (accountId ? xmppClients.get(accountId) : undefined);
  const defaultClient = () => xmppClients.get("default") || xmppClients.values().next().value;
  const clientForRun = (runId?: string) => {
    if (!runId || !presenceRuns.has(runId)) return undefined;
    return clientById(presenceRuns.get(runId)) || defaultClient();
  };

  const notify = (client: any, event: any) => {
    try {
      client?.notifyActivity?.(event);
    } catch (err) {
      log.debug("notifyActivity failed", err);
    }
  };

  const safeRegister = (name: string, handler: (...args: any[]) => void) => {
    try {
      api.on(name, handler, { registrationId: `xmpp.presence.${name}` });
    } catch (err) {
      log.debug(`hook registration failed: ${name}`, err);
    }
  };

  safeRegister("before_agent_run", (event: any, ctx: any) => {
    const accountId = ctx?.accountId;
    const channel = ctx?.channel || ctx?.channelId;
    let client = clientById(accountId);
    if (!client && channel === "xmpp") client = defaultClient();
    if (!client) return;
    const runId = ctx?.runId || event?.runId;
    if (runId) presenceRuns.set(runId, accountId || "default");
    notify(client, { type: "run-start", runId });
  });

  safeRegister("model_call_started", (_event: any, ctx: any) => {
    notify(clientForRun(ctx?.runId), { type: "thinking-start", runId: ctx?.runId });
  });

  safeRegister("model_call_ended", (_event: any, ctx: any) => {
    notify(clientForRun(ctx?.runId), { type: "thinking-end", runId: ctx?.runId });
  });

  safeRegister("before_tool_call", (event: any, ctx: any) => {
    notify(clientForRun(ctx?.runId), { type: "tool-start", runId: ctx?.runId, toolName: event?.toolName });
  });

  safeRegister("after_tool_call", (_event: any, ctx: any) => {
    notify(clientForRun(ctx?.runId), { type: "tool-end", runId: ctx?.runId });
  });

  safeRegister("agent_end", (event: any, ctx: any) => {
    const runId = event?.runId || ctx?.runId;
    const client = clientForRun(runId) || (ctx?.channel === "xmpp" ? defaultClient() : undefined);
    notify(client, { type: "run-end", runId });
    if (runId) presenceRuns.delete(runId);
  });

  safeRegister("session_end", (event: any) => {
    const reason = event?.reason;
    if (["shutdown", "restart", "reset", "deleted"].includes(reason)) {
      notify(defaultClient(), { type: "clear" });
    }
  });
}
