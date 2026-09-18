import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { registerXmppCliMetadata } from "./src/cli-metadata.js";
import { registerPresenceHooks } from "./src/presence-hooks.js";
import { registerAskUserHooks } from "./src/lib/ask-user-hooks.js";

import { Type } from "typebox";
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

// SECURITY (2.17.1): explicit tool param types.  The SDK types `execute`'s
// params as `unknown` (erased), so annotating them keeps `npx tsc` clean.
interface PresenceToolParams {
  show?: string;
  status?: string;
  priority?: number;
  ttlSeconds?: number;
  clear?: boolean;
}

interface SftpToolParams {
  action: "upload" | "download" | "list" | "delete";
  localPath?: string;
  remoteName?: string;
  remoteDir?: string;
}

export function registerXmppGatewayMethods(api: OpenClawPluginApi): void {
  // SECURITY (2.15.0): auto-activity presence (busy while thinking/tooling),
  // driven by the OpenClaw agent-lifecycle hooks.
  registerPresenceHooks(api);

  // SECURITY (2.16.1): raise the ask_user timeout floor so an XMPP round-trip
  // has time to render the prompt and receive the answer.
  registerAskUserHooks(api);

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

  // SECURITY (2.14.7): vCard operations over the gateway RPC.  This lets
  // `openclaw xmpp vcard` / `vcard4` run on the EXISTING connection instead
  // of opening a second one with the same JID+resource (which caused the
  // server to kick the bot with a `conflict` StreamError).
  api.registerGatewayMethod("xmpp.vcard", async ({ params, respond }) => {
    const p = (params || {}) as Record<string, unknown>;
    const action = (p.action as string) || "";
    const args = Array.isArray(p.args) ? (p.args as any[]) : [];
    if (!action) {
      respond(false, { ok: false, error: "Missing required parameter: action" });
      return;
    }
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, {
        ok: false,
        error: "XMPP client not connected. Make sure the gateway is running and XMPP is enabled.",
      });
      return;
    }
    if (typeof client.vcard !== "function") {
      respond(false, { ok: false, error: "vCard operations are not available on this client." });
      return;
    }
    try {
      const result = await client.vcard(action, args);
      respond(!!result?.ok, result);
    } catch (err: any) {
      respond(false, { ok: false, error: err?.message || String(err) });
    }
  });

  // SECURITY (2.15.0): presence/status over the gateway RPC, so the CLI and
  // other surfaces set status on the EXISTING connection (no second session).
  api.registerGatewayMethod("xmpp.setPresence", async ({ params, respond }) => {
    const p = (params || {}) as Record<string, unknown>;
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { ok: false, error: "XMPP client not connected. Make sure the gateway is running and XMPP is enabled." });
      return;
    }
    try {
      if (p.clear) {
        await client.clearPresence?.();
        respond(true, { ok: true, presence: client.getPresence?.() });
        return;
      }
      await client.setPresence?.(
        (p.show as string) || "available",
        (p.status as string) || undefined,
        (p.priority as number) ?? undefined,
        (p.ttlSeconds as number) ?? undefined,
      );
      respond(true, { ok: true, presence: client.getPresence?.() });
    } catch (err: any) {
      respond(false, { ok: false, error: err?.message || String(err) });
    }
  });

  api.registerGatewayMethod("xmpp.getPresence", ({ respond }) => {
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { ok: false, error: "XMPP client not connected" });
      return;
    }
    respond(true, { ok: true, presence: client.getPresence?.() || null });
  });

  api.registerGatewayMethod("xmpp.clearPresence", async ({ respond }) => {
    const client = xmppClients.get("default") || xmppClients.values().next().value;
    if (!client) {
      respond(false, { ok: false, error: "XMPP client not connected" });
      return;
    }
    try {
      await client.clearPresence?.();
      respond(true, { ok: true, presence: client.getPresence?.() });
    } catch (err: any) {
      respond(false, { ok: false, error: err?.message || String(err) });
    }
  });

  api.registerTool({
    name: "xmpp_setPresence",
    label: "Set XMPP Presence",
    description: "Update the bot's XMPP presence/status. Set a built-in show (available/chat/away/xa/dnd, aliases free/busy) with an optional custom status message, or clear the manual status. A manual status overrides the automatic busy-while-thinking/tooling presence until cleared or its ttlSeconds expires.",
    promptSnippet: "You can set your XMPP availability/status (e.g. busy with a custom message) and clear it again.",
    promptGuidelines: [
      'Thinking and tool use automatically show a busy presence; you do NOT need to set that yourself.',
      'Use xmpp_setPresence with show="dnd" (or "busy") and a status message to pin a custom status (e.g. "Deploying — back in 10m"); it overrides the automatic presence.',
      'Use xmpp_setPresence with show="away" when you are idle.',
      'Use xmpp_setPresence with clear=true to drop your manual status and let the automatic presence track you again.',
      "Use the status field for a short human-readable note; keep secrets out of it (contacts can see it).",
    ],
    parameters: Type.Object({
      show: Type.Optional(Type.Union([
        Type.Literal("away"),
        Type.Literal("chat"),
        Type.Literal("dnd"),
        Type.Literal("xa"),
        Type.Literal("available"),
        Type.Literal("busy"),
        Type.Literal("free"),
      ])),
      status: Type.Optional(Type.String({ description: "Custom status message" })),
      priority: Type.Optional(Type.Integer({ description: "Presence priority (-128 to 127)", minimum: -128, maximum: 127 })),
      ttlSeconds: Type.Optional(Type.Integer({ description: "Auto-revert this status after N seconds (0 = until cleared)", minimum: 0 })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the manual status and return to the default/auto presence" })),
    }),
    execute: async (toolCallId, params: PresenceToolParams, _signal) => {
      const client = xmppClients.get("default") || xmppClients.values().next().value;
      if (!client) {
        throw new Error("XMPP client not connected");
      }
      if (params.clear) {
        await client.clearPresence?.();
        return {
          content: [{ type: "text" as const, text: "Presence cleared (reverted to default/auto)." }],
          details: undefined,
        };
      }
      await client.setPresence(params.show, params.status, params.priority, params.ttlSeconds);
      const parts: string[] = [];
      if (params.show) parts.push(`show=${params.show}`);
      if (params.status) parts.push(`status="${params.status}"`);
      if (params.priority !== undefined) parts.push(`priority=${params.priority}`);
      if (params.ttlSeconds) parts.push(`ttl=${params.ttlSeconds}s`);
      if (parts.length === 0) parts.push("available");
      return {
        content: [{ type: "text" as const, text: `Presence updated: ${parts.join(", ")}` }],
        details: undefined,
      };
    },
    // `as any`: the SDK's AnyAgentTool type omits `promptSnippet` (it lives on
    // AgentToolWithMeta and IS honored at runtime).
  } as any);

  // SECURITY (2.14.0): agent SFTP tool (pinned host key; config-driven).
  api.registerTool({
    name: "xmpp_sftp",
    label: "XMPP SFTP",
    description:
      "Transfer files over SFTP to the configured server (pinned host key). Actions: upload, download, list, delete.",
    promptSnippet: "You can upload/download/list/delete files on the configured SFTP server via xmpp_sftp.",
    promptGuidelines: [
      'Use xmpp_sftp with action="upload" and localPath (and optional remoteName) to send a file to the SFTP server.',
      'Use xmpp_sftp with action="download" and remoteName (and optional localPath) to fetch a file.',
      'Use xmpp_sftp with action="list" (optional remoteDir) to list remote files.',
      'Use xmpp_sftp with action="delete" and remoteName to remove a remote file.',
      "SFTP must be configured with a pinned hostKeyFingerprint; it fails closed otherwise.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upload"),
        Type.Literal("download"),
        Type.Literal("list"),
        Type.Literal("delete"),
      ]),
      localPath: Type.Optional(Type.String({ description: "Local path (upload: source; download: destination)" })),
      remoteName: Type.Optional(Type.String({ description: "Remote path/name (upload/download/delete)" })),
      remoteDir: Type.Optional(Type.String({ description: "Remote directory (list); default '.'" })),
    }),
    execute: async (_toolCallId, params: SftpToolParams, _signal) => {
      const { loadSftpConfigFromDisk, sftpUpload, sftpDownload, sftpList, sftpRemove } = await import(
        "./src/sftp.js"
      );
      let cfg;
      try {
        cfg = loadSftpConfigFromDisk();
      } catch (err: any) {
        throw new Error(`SFTP config error: ${err?.message || String(err)}`);
      }
      let text = "";
      if (params.action === "upload") {
        if (!params.localPath) throw new Error("upload requires localPath");
        const r = await sftpUpload(cfg, params.localPath, params.remoteName);
        if (!r.ok) throw new Error(r.error || "upload failed");
        text = `Uploaded ${params.localPath} -> ${r.data}`;
      } else if (params.action === "download") {
        if (!params.remoteName) throw new Error("download requires remoteName");
        const r = await sftpDownload(cfg, params.remoteName, params.localPath);
        if (!r.ok) throw new Error(r.error || "download failed");
        text = `Downloaded ${params.remoteName} -> ${r.data}`;
      } else if (params.action === "list") {
        const r = await sftpList(cfg, params.remoteDir || params.remoteName || ".");
        if (!r.ok) throw new Error(r.error || "list failed");
        text = `Remote files:\n${(r.data || []).join("\n")}`;
      } else if (params.action === "delete") {
        if (!params.remoteName) throw new Error("delete requires remoteName");
        const r = await sftpRemove(cfg, params.remoteName);
        if (!r.ok) throw new Error(r.error || "delete failed");
        text = `Removed ${r.data}`;
      }
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  } as any);
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
