import { sendText, sendMedia } from "./outbound.js";
import { xmppSecurityAdapter } from "./security/adapter.js";
import { GatewayLifecycle } from "./gateway.js";
import { MessageStore } from "./messageStore.js";
import { Contacts } from "./contacts.js";
import { startXmpp } from "./startXMPP.js";
import { addToQueue, markAsProcessed, flushQueue } from "./queue-bridge.js";
import {
  xmppClients,
  contactsStore,
  getPluginRuntime,
} from "./state.js";

export const xmppChannelPlugin = {
  id: "xmpp",
  meta: {
    id: "xmpp",
    label: "XMPP",
    selectionLabel: "XMPP (Jabber)",
    docsPath: "/channels/xmpp",
    blurb: "XMPP/Jabber messaging via direct chat.",
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
  messaging: {
    targetResolver: {
      looksLikeId: (raw: string): boolean => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
      },
    },
  },
  configSchema: {
    type: "object",
    properties: {
      service: { type: "string" },
      domain: { type: "string" },
      jid: { type: "string" },
      password: { type: "string" },
      dataDir: { type: "string" },
      resource: { type: "string" },
      adminJid: { type: "string" },
      nick: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "allowlist"] },
      allowFrom: { type: "array", items: { type: "string" } },
      autoJoinRooms: { type: "array", items: { type: "string" } },
      rooms: { type: "array", items: { type: "string" } },
      vcard: {
        type: "object",
        properties: {
          fn: { type: "string" },
          nickname: { type: "string" },
          url: { type: "string" },
          desc: { type: "string" },
          avatarUrl: { type: "string" },
        },
      },
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
  status: {
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      accountId: account?.accountId,
      name: account?.config?.jid || account?.accountId,
      enabled: account?.enabled,
      configured: Boolean(account?.config?.jid?.trim() && account?.config?.password?.trim()),
      tokenSource: "config",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  security: xmppSecurityAdapter,
  outbound: {
    deliveryMode: "gateway",
    sendText,
    sendMedia,
  },
  gateway: (() => {
    const lifecycle = new GatewayLifecycle(
      { xmppClients, contactsStore, getPluginRuntime },
      { startXmpp, Contacts, MessageStore },
      { addToQueue, markAsProcessed }
    );
    return {
      startAccount: (ctx: any) => lifecycle.startAccount(ctx),
      stopAccount: async (ctx: any) => {
        await flushQueue();
        await lifecycle.stopAccount(ctx);
      },
    };
  })(),
};
