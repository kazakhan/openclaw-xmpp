import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { MessageStore } from "./src/messageStore.js";
import { debugLog, setDebugLogDir } from "./src/shared/index.js";
import { xmppSecurityAdapter } from "./src/security/adapter.js";
import { sendText, sendMedia } from "./src/outbound.js";
import { log } from "./src/lib/logger.js";
import type { PluginRuntime } from "./src/types.js";
import { PersistentQueue, QueuedMessage } from "./src/lib/persistent-queue.js";
import { GatewayLifecycle } from "./src/gateway.js";

// Set debug log directory to plugin directory
setDebugLogDir(__dirname);

debugLog(`XMPP plugin loading at ${new Date().toISOString()}`);

let pluginRegistered = false;
let pluginRuntime: PluginRuntime | null = null;

// Global store for XMPP clients by account ID
export const xmppClients = new Map<string, any>();

// Global store for Contacts by account ID
export const contactsStore = new Map<string, any>();

import { Contacts } from "./src/contacts.js";


// Message queue management (persistent)
let messageQueue: PersistentQueue | null = null;

function getQueue(dataDir?: string): PersistentQueue {
  if (!messageQueue) {
    const dir = dataDir || process.cwd();
    messageQueue = new PersistentQueue(dir);
  }
  return messageQueue;
}

function addToQueue(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'processed'>, dataDir?: string): string {
  return getQueue(dataDir).push(message);
}

function getUnprocessedMessages(accountId?: string, dataDir?: string): QueuedMessage[] {
  return getQueue(dataDir).getUnprocessed(accountId);
}

function markAsProcessed(messageId: string, dataDir?: string): void {
  getQueue(dataDir).markProcessed(messageId);
}

function clearOldMessages(maxAgeMs: number = 24 * 60 * 60 * 1000, dataDir?: string): number {
  return getQueue(dataDir).clearOld(maxAgeMs);
}

// Export queue functions for commands module
export { addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages };

import { startXmpp } from "./src/startXMPP.js";

// Import CLI commands module
import { registerXmppCli } from "./src/commands.js";

export function register(api: any) {
  debugLog(`register() called, pluginRegistered=${pluginRegistered}`);
  if (pluginRegistered) {
    debugLog("Plugin already registered, skipping");
    return;
  }
  pluginRegistered = true;
  const log = api.logger ?? console;
  log.info("Registering XMPP plugin");
  debugLog("Registering XMPP plugin");
  
  // Check if this is CLI registration or Gateway registration
  // CLI registration: api.runtime is not available
  // Gateway registration: api.runtime IS available
  const isCliRegistration = !api.runtime;
  debugLog(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);

   // Debug: Inspect the api object
   debugLog("=== API OBJECT INSPECTION ===");
   debugLog("api keys: " + Object.keys(api).join(", "));
   const allApiProps: string[] = [];
   for (const key in api) {
     allApiProps.push(key);
   }
   debugLog("All api properties: " + allApiProps.join(", "));
   const apiMethods = allApiProps.filter(k => typeof api[k] === 'function');
   debugLog("All api methods: " + apiMethods.join(", "));
   
   // Check for runtime access (only for Gateway registration, not CLI)
   if (api.runtime && !isCliRegistration) {
     pluginRuntime = api.runtime;
     debugLog("api.runtime set for Gateway registration, keys: " + Object.keys(api.runtime).join(", "));

     if (api.runtime.channel) {
       debugLog("api.runtime.channel exists, keys: " + Object.keys(api.runtime.channel).join(", "));

       // Check if there's a generic message forwarding method
       const channelMethods = Object.keys(api.runtime.channel);
       debugLog("Channel methods available: " + channelMethods.join(", "));

       // Look for text, message, or routing methods
       const possibleForwardMethods = ['text', 'message', 'routing', 'dispatch', 'receive'];
       for (const method of possibleForwardMethods) {
         if (api.runtime.channel[method]) {
           debugLog("Found channel." + method);

           // If it's an object, log its methods
           if (typeof api.runtime.channel[method] === 'object') {
             const subMethods = Object.keys(api.runtime.channel[method]);
             debugLog("  channel." + method + " methods: " + subMethods.slice(0, 10).join(", "));
           }
         }
       }

       // Also check session and activity which might handle messages
       if (api.runtime.channel.session) {
         const sessionMethods = Object.keys(api.runtime.channel.session);
         debugLog("channel.session methods: " + sessionMethods.slice(0, 10).join(", "));
       }
       if (api.runtime.channel.activity) {
         const activityMethods = Object.keys(api.runtime.channel.activity);
         debugLog("channel.activity methods: " + activityMethods.slice(0, 10).join(", "));
       }
     }
   } else if (isCliRegistration) {
     debugLog("CLI registration - not setting pluginRuntime");
   } else {
     debugLog("api.runtime not available");
   }
   debugLog("=== END API INSPECTION ===");
   
   // Check for emit method
   debugLog("Checking for api.emit method...");
   if (typeof api.emit === 'function') {
     debugLog("api.emit is available");
   } else {
     debugLog("api.emit not found");
     // Check if emit is on a different object
     if (api.runtime?.emit) {
       debugLog("api.runtime.emit is available");
     }
   }
   
   // Try to use api.on for event-based message forwarding
   if (typeof api.on === 'function') {
     debugLog("api.on is available for listening to events");
   }

  const xmppChannelPlugin = {
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
             avatarUrl: { type: "string" }
           }
         }
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
      isConfigured: (account: any) => Boolean(account?.config?.jid?.trim() && account?.config?.password?.trim()),
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
        { xmppClients, contactsStore, getPluginRuntime: () => pluginRuntime },
        { startXmpp, Contacts, MessageStore },
        { addToQueue, markAsProcessed }
      );
      return {
        startAccount: (ctx: any) => lifecycle.startAccount(ctx),
        stopAccount: (ctx: any) => lifecycle.stopAccount(ctx),
      };
    })(),
  };

  api.registerChannel({ plugin: xmppChannelPlugin });
  log.info("XMPP channel plugin registered");

  // Register gateway RPC methods for CLI-to-gateway communication
  api.registerGatewayMethod("xmpp.joinRoom", ({ params, respond }) => {
    const { room, nick } = params || {};
    if (!room) {
      respond(false, { error: "Missing required parameter: room" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { error: "XMPP client not connected. Make sure the XMPP channel is enabled and the gateway is running." });
      return;
    }
    try {
      client.joinRoom(room, nick);
      respond(true, { ok: true, room, nick });
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.leaveRoom", ({ params, respond }) => {
    const { room, nick } = params || {};
    if (!room) {
      respond(false, { error: "Missing required parameter: room" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { error: "XMPP client not connected" });
      return;
    }
    try {
      client.leaveRoom(room, nick);
      respond(true, { ok: true, room });
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.getJoinedRooms", ({ respond }) => {
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { error: "XMPP client not connected" });
      return;
    }
    const rooms = client.getJoinedRooms() || [];
    const roomNicks = client.roomNicks || new Map();
    const roomsWithNicks = rooms.map(room => ({
      room,
      nick: roomNicks instanceof Map ? roomNicks.get(room) : undefined
    }));
    respond(true, { rooms: roomsWithNicks });
  });

  api.registerGatewayMethod("xmpp.inviteToRoom", ({ params, respond }) => {
    const { contact, room, reason, password } = params || {};
    if (!contact || !room) {
      respond(false, { error: "Missing required parameters: contact and room" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { error: "XMPP client not connected" });
      return;
    }
    try {
      client.inviteToRoom(contact, room, reason, password);
      respond(true, { ok: true, contact, room });
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.removeContact", async ({ params, respond }) => {
    const { jid } = params || {};
    if (!jid) {
      respond(false, { error: "Missing required parameter: jid" });
      return;
    }
    const contacts = contactsStore.get("default") || contactsStore.values().next().value;
    if (!contacts) {
      respond(false, { error: "Contacts not available" });
      return;
    }
    try {
      const removed = await contacts.remove(jid);
      if (removed) {
        respond(true, { ok: true, jid });
      } else {
        respond(false, { error: "Contact not found" });
      }
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.sendMessage", ({ params, respond }) => {
    const { jid, message } = params || {};
    if (!jid || !message) {
      respond(false, { error: "Missing required parameters: jid and message" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { error: "XMPP client not connected. Make sure the gateway is running and XMPP is enabled." });
      return;
    }
    try {
      // Detect groupchat (MUC) vs direct message
      const isGroupChat = jid.includes('@conference.');
      const isGroupchatPrivateMessage = isGroupChat && jid.includes('/');
      
      if (isGroupChat && !isGroupchatPrivateMessage) {
        // Public groupchat message - use sendGroupchat
        client.sendGroupchat(jid.split('/')[0], message);
      } else if (isGroupchatPrivateMessage) {
        // Private message in groupchat - use send to room/nick
        client.send(jid, message);
      } else {
        // Direct message - use regular send
        client.send(jid, message);
      }
      respond(true, { ok: true, jid });
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  // Register CLI commands using registerCli
  api.registerCli(
    ({ program }) => {
      const getXmppClient = () => {
        return xmppClients.get("default") || xmppClients.values().next().value;
      };

      registerXmppCli({
        program,
        getXmppClient,
        logger: api.logger,
        getUnprocessedMessages,
        clearOldMessages,
        messageQueue,
        getContacts: () => contactsStore.get("default") || contactsStore.values().next().value || null
      });
    },
    { commands: ["xmpp"] }
  );
}

// Export the register function as default
export default register;

// Also export plugin metadata for compatibility
export const plugin = {
   id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register,
};