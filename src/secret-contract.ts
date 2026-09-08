// SECURITY (2.11.1): the channelSecrets contract is what makes
// openclaw's secrets engine recognise the stored per-account password
// as a secret input (for plan / configure / audit).  Two halves:
//
//   1. secretTargetRegistryEntries — declares the field type and where
//      it lives in openclaw.json.  This is what lets the audit/plan
//      tooling see `channels.xmpp.accounts.*.password` as a secret.
//
//   2. collectRuntimeConfigAssignments — walks the live config and
//      registers the per-account password assignment for enabled
//      accounts so the engine knows it is *configured* (vs. missing).
//      This is the onboaring "fold the secret input into the config
//      write" behaviour: the password the wizard stores (as an `ENC:`
//      value produced by `encryptPasswordInConfig`) is picked up here.
//
// @ts-ignore — moduleResolution:"node" cannot resolve this package
// exports subpath, but Node's runtime ESM loader can (the same
// limitation as the other `openclaw/plugin-sdk/*` imports here).
import { getChannelSurface, collectSimpleChannelFieldAssignments } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = {
  secretTargetRegistryEntries: [
    {
      id: "channels.xmpp.accounts.*.password",
      targetType: "channels.xmpp.accounts.*.password",
      configFile: "openclaw.json",
      pathPattern: "channels.xmpp.accounts.*.password",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
  ],
  collectRuntimeConfigAssignments: (params: {
    config?: Record<string, unknown>;
    defaults?: unknown;
    context?: unknown;
  }): void => {
    try {
      const config = params?.config ?? {};
      const resolved: any = getChannelSurface(config, "xmpp");
      if (!resolved) return;
      const { channel, surface } = resolved;
      collectSimpleChannelFieldAssignments({
        channelKey: "xmpp",
        field: "password",
        channel,
        surface,
        defaults: params?.defaults,
        context: params?.context,
        topInactiveReason:
          "no enabled XMPP surface inherits a top-level password (the password is per-account).",
        accountInactiveReason: "XMPP account is disabled.",
      } as any);
    } catch {
      // Best-effort: if the helper is unavailable in this openclaw
      // build, degrade to a no-op.  The registry entry above still
      // recognises the field for plan/configure/audit.
    }
  },
};
