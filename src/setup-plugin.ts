export const xmppSetupPlugin = {
  id: "xmpp",
  meta: {
    id: "xmpp",
    label: "XMPP",
    selectionLabel: "XMPP (Jabber)",
    docsPath: "/channels/xmpp",
    blurb: "XMPP/Jabber setup placeholder for bundled-channel-setup-entry.",
    aliases: ["jabber"],
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: true,
  },
  configSchema: {
    type: "object",
    properties: {
      service: { type: "string" },
      domain: { type: "string" },
      jid: { type: "string" },
      password: { type: "string" },
      dataDir: { type: "string" },
    },
    required: ["service", "domain", "jid", "password", "dataDir"],
  },
  config: {
    listAccountIds: (cfg: any) => Object.keys(cfg.channels?.xmpp?.accounts ?? {}),
    resolveAccount: (cfg: any, accountId: string) => {
      const id = accountId || "default";
      const accountConfig = cfg.channels?.xmpp?.accounts?.[id];
      return {
        accountId: id,
        enabled: accountConfig?.enabled ?? true,
        config: accountConfig ?? {},
      };
    },
    defaultAccountId: () => "default",
    isConfigured: (account: any) =>
      Boolean(account?.config?.jid?.trim() && account?.config?.password?.trim()),
    describeAccount: (account: any) => ({
      accountId: account?.accountId,
      name: account?.config?.jid || account?.accountId,
      enabled: account?.enabled,
      configured: Boolean(account?.config?.jid?.trim() && account?.config?.password?.trim()),
      tokenSource: "config",
    }),
  },
};
