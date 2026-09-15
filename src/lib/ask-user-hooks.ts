// SECURITY (2.16.1): raise the ask_user timeout floor.
//
// `ask_user` defaults to 900s but the model may pass a short `timeoutSeconds`
// (e.g. 120), which is too tight for an XMPP round-trip: the prompt renders,
// the user answers, but the tool has already returned `no_answer`.  A
// `before_tool_call` hook can override the tool params, so we enforce a floor.

import fs from "fs";
import path from "path";

// Dependency-free logger (this module is unit-tested directly under node:test).
const log = {
  debug: (...args: any[]): void => {
    try {
      console.debug("[xmpp ask-user-hooks]", ...args);
    } catch {
      /* ignore */
    }
  },
};

export const DEFAULT_ASK_USER_MIN_TIMEOUT_SECONDS = 900;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;

/** Read `channels.xmpp.accounts.default.askUserMinTimeoutSeconds` (default 900). */
export function askUserMinTimeoutSeconds(): number {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const v = cfg?.channels?.xmpp?.accounts?.default?.askUserMinTimeoutSeconds;
      if (typeof v === "number" && Number.isFinite(v)) {
        return Math.min(MAX_ASK_USER_TIMEOUT_SECONDS, Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, Math.floor(v)));
      }
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_ASK_USER_MIN_TIMEOUT_SECONDS;
}

/**
 * Return overridden params when `timeoutSeconds` is below `floor`, else
 * undefined (no change).  Pure — unit tested.
 */
export function applyAskUserTimeoutFloor(params: any, floor: number): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const current =
    typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : DEFAULT_ASK_USER_MIN_TIMEOUT_SECONDS;
  if (current >= floor) return undefined;
  return { ...params, timeoutSeconds: floor };
}

export function registerAskUserHooks(api: any): void {
  if (!api || typeof api.on !== "function") return;
  try {
    api.on(
      "before_tool_call",
      (event: any) => {
        if (event?.toolName !== "ask_user") return;
        const params = applyAskUserTimeoutFloor(event?.params, askUserMinTimeoutSeconds());
        return params ? { params } : undefined;
      },
      { matcher: ["ask_user"], registrationId: "xmpp.ask-user.timeout" },
    );
  } catch (err) {
    log.debug("ask_user hook registration failed", err);
  }
}
