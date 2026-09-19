import { sendText, sendMedia } from "./outbound.js";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { registerAskUser } from "./lib/ask-user.js";
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
      autoUpdate: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          intervalHours: { type: "number" },
          mode: { type: "string", enum: ["ask", "auto"] },
          autoRestart: { type: "boolean" },
        },
      },
      sftp: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          host: { type: "string" },
          port: { type: "number" },
          user: { type: "string" },
          password: { type: "string" },
          hostKeyFingerprint: { type: "string" },
        },
      },
      vcard4: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
        },
      },
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
    // SECURITY (2.16.0/2.16.1): register + render ask_user prompts (text-only
    // channel).  Synchronous — no gateway RPC in the delivery path (that was
    // the 2.16.0 lag).
    beforeDeliverPayload: ({ target, payload }: any) => {
      try {
        registerAskUser(payload, {
          accountId: target?.accountId || "default",
          conversation: String(target?.to || "").replace(/^xmpp:/, "").split("/")[0],
        });
      } catch {
        /* best-effort */
      }
    },
    renderPresentation: ({ payload, ctx }: any) => {
      try {
        const ask = registerAskUser(payload, {
          accountId: ctx?.accountId || "default",
          conversation: String(ctx?.to || "").replace(/^xmpp:/, "").split("/")[0],
        });
        if (ask.handled) {
          return { ...payload, text: ask.text ?? payload.text, presentation: undefined, presentationTextMode: undefined };
        }
      } catch {
        /* fall through to core rendering */
      }
      return null;
    },
  },
  // SECURITY (2.18.0): proper channel `message` adapter derived from the
  // outbound send functions.  It carries real `MessageReceipt` identities, so
  // message-tool sends settle instead of throwing "No delivery result".
  message: createChannelMessageAdapterFromOutbound({
    id: "xmpp",
    // `as any`: the legacy send functions also return `{ ok: false, error }`
    // on failure; the bridge type only models the success-shaped receipt.
    outbound: { sendText: sendText as any, sendMedia: sendMedia as any },
  }),
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
