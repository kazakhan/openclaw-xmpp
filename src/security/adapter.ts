import type { ChannelSecurityAdapter } from "openclaw/plugin-sdk";

export interface XmppSecurityContext {
  accountId?: string | null;
  account: {
    config?: {
      password?: string;
      dmPolicy?: string;
      allowFrom?: Array<string>;
    };
  };
}

function normalizeXmppEntry(raw: string): string {
  return raw
    .trim()
    .replace(/^(xmpp|jabber):/i, "");
}

export const xmppSecurityAdapter: ChannelSecurityAdapter = {
  collectWarnings(ctx: XmppSecurityContext): string[] {
    const warnings: string[] = [];
    const pw = ctx.account?.config?.password;
    if (pw && typeof pw === "string" && !pw.startsWith("ENC:") && pw.length > 0) {
      warnings.push(
        "XMPP account stores plaintext password. " +
        "Encrypt it with: openclaw xmpp encrypt-password"
      );
    }
    return warnings;
  },

  collectAuditFindings(ctx: XmppSecurityContext & {
    sourceConfig?: any;
  }): Array<{ checkId: string; severity: string; title: string; detail: string; remediation?: string }> {
    const findings: Array<{ checkId: string; severity: string; title: string; detail: string; remediation?: string }> = [];

    const pw = ctx.account?.config?.password;
    if (pw && typeof pw === "string" && !pw.startsWith("ENC:") && pw.length > 0) {
      findings.push({
        checkId: "channels.xmpp.plaintext_password",
        severity: "warn",
        title: "XMPP account stores plaintext password",
        detail: "Password should be encrypted via: openclaw xmpp encrypt-password",
        remediation: "Run: openclaw xmpp encrypt-password",
      });
    }

    const policy = ctx.account?.config?.dmPolicy;
    if (!policy || policy === "open") {
      findings.push({
        checkId: "channels.xmpp.open_dm_policy",
        severity: "info",
        title: "XMPP DM policy is open or unset",
        detail:
          "DM policy defaults to 'open' which allows any XMPP user to message the bot. " +
          "Consider setting dmPolicy to 'allowlist' for production use.",
        remediation:
          'Set "dmPolicy": "allowlist" in your XMPP account configuration.',
      });
    }

    return findings;
  },
};
