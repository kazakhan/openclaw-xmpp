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
  collectRuntimeConfigAssignments: (_params: {
    config: { channels?: Record<string, unknown> };
  }): void => {},
};
