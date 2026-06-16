import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { registerXmppCliMetadata } from "./src/cli-metadata.js";

import {
  xmppClients,
  contactsStore,
  getPluginRuntime,
  setXmppRuntime,
  isPluginRegistered,
} from "./src/state.js";
export {
  xmppClients,
  contactsStore,
  getPluginRuntime,
  setXmppRuntime,
  isPluginRegistered,
};
export {
  addToQueue,
  getUnprocessedMessages,
  markAsProcessed,
  clearOldMessages,
} from "./src/queue-bridge.js";

export function registerXmppGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("xmpp.joinRoom", async ({ params, respond }) => {
    const { room, nick } = params || {};
    if (!room) {
      respond(false, { error: "Missing required parameter: room" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, {
        error: "XMPP client not connected. Make sure the XMPP channel is enabled and the gateway is running.",
      });
      return;
    }
    try {
      // SECURITY (2.0.15): client.joinRoom is async; previously the
      // result was discarded and the RPC returned ok=true before the
      // underlying presence stanza was sent.  This is now awaited
      // so any rejection is propagated back to the caller.
      await client.joinRoom(room, nick);
      respond(true, { ok: true, room, nick });
    } catch (err: any) {
      respond(false, { error: err?.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.leaveRoom", async ({ params, respond }) => {
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
      // SECURITY (2.0.15): see comment in xmpp.joinRoom above.
      await client.leaveRoom(room, nick);
      respond(true, { ok: true, room });
    } catch (err: any) {
      respond(false, { error: err?.message || String(err) });
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
    const roomsWithNicks = rooms.map((room: string) => ({
      room,
      nick: roomNicks instanceof Map ? roomNicks.get(room) : undefined,
    }));
    respond(true, { rooms: roomsWithNicks });
  });

  api.registerGatewayMethod("xmpp.inviteToRoom", async ({ params, respond }) => {
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
      // SECURITY (2.0.15): client.inviteToRoom is async; the previous
      // implementation discarded its promise.  Now awaited so any
      // rejection is propagated.
      await client.inviteToRoom(contact, room, reason, password);
      respond(true, { ok: true, contact, room });
    } catch (err: any) {
      respond(false, { error: err?.message || String(err) });
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

  api.registerGatewayMethod("xmpp.sendMessage", async ({ params, respond }) => {
    const p = (params || {}) as Record<string, unknown>;
    const jid = (p.jid as string) || '';
    const message = (p.message as string) || '';
    if (!jid || !message) {
      respond(false, { error: "Missing required parameters: jid and message" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, {
        error: "XMPP client not connected. Make sure the gateway is running and XMPP is enabled.",
      });
      return;
    }
    try {
      const isGroupChat = jid.includes("@conference.");
      const isGroupchatPrivateMessage = isGroupChat && jid.includes("/");

      // SECURITY (2.0.15): client.send and client.sendGroupchat are
      // async; previously the promises were discarded and the RPC
      // returned ok=true before the underlying message stanza was
      // actually written to the socket.  Now awaited so that any
      // rejection (including the case where the underlying socket
      // has died and write() rejects) is propagated to the caller.
      if (isGroupChat && !isGroupchatPrivateMessage) {
        await client.sendGroupchat(jid.split("/")[0], message);
      } else {
        await client.send(jid, message);
      }
      respond(true, { ok: true, jid });
    } catch (err: any) {
      respond(false, { error: err?.message || String(err) });
    }
  });
}

export default defineBundledChannelEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP/Jabber messaging channel plugin with file transfer and whiteboard support",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "xmppChannelPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setXmppRuntime",
  },
  registerCliMetadata: registerXmppCliMetadata,
  registerFull: registerXmppGatewayMethods,
});
