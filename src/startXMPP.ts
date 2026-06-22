import fs from "fs";
import path from "path";
import crypto from "crypto";
import net from "net";
import { validators } from "./security/validation.js";
import { decryptPasswordFromConfig } from "./security/encryption.js";
import { VCard } from "./vcard.js";
import { parseWhiteboardMessage } from "./whiteboard.js";
import { parseSxeMessage, buildSxeXml, convertSxeToWhiteboardData, reconstructPathsFromState, buildSxePathEdits, sxeEditsToXml } from "./whiteboard.js";
import { WhiteboardSessionManager } from "./whiteboard-session.js";
import { debugLog, checkRateLimit, downloadFile, processInboundFiles, MAX_FILE_SIZE } from "./shared/index.js";
import { Config, CapsInfo } from "./config.js";
import { log } from "./lib/logger.js";
import { child } from "./lib/logger.js";
import { parseVCard } from "./lib/vcard-protocol.js";
import { requestUploadSlot as requestUploadSlotShared, uploadFileViaHTTP, sendFileWithHTTPUpload, discoverUploadService } from "./lib/upload-protocol.js";
import { safeSend, findUnderlyingSocket } from "./lib/xmpp-utils.js";
import { createVCardServer } from "./vcard-server.js";
import { handleSlashCommand } from "./slash-commands.js";

// Reconnection constants
const RECONNECT_BASE_MS = Config.RECONNECT_BASE_MS || 1000;
const RECONNECT_MAX_MS = Config.RECONNECT_MAX_MS || 15000;
const RECONNECT_BACKOFF_FACTOR = Config.RECONNECT_BACKOFF_FACTOR || 2;

  // SECURITY (2.0.18, L1): removed module-level `let xmppClientModule`.
// The import is now done at the top of `startXmpp()` (below).  Node's
// module cache makes the second `startXmpp()` invocation's import a
// no-op, so the per-invocation import has no meaningful cost.  The
// old module-level binding was technically safe (modules are
// immutable after load) but the wider scope was unnecessary and
// easy to misread.

const xmppLog = child("xmpp");

// SECURITY (2.1.3, restore-old-design): isRunning flag for the
// offline handler.  The OLD design from D:\Downloads\xmppOLD had
// this as a module-level let (line 27 of that file).  When set
// false, the offline handler clears intervals and destroys the
// whiteboard session manager.  The flag is only cleared on the
// offline event (deliberate xmpp.stop()) and is never read by
// other code in this file (the gateway manages its own
// isRunning via runtime.channel).  Kept here for parity with
// the OLD design.
let isRunning = true;

// Catch-and-log unhandled rejections to diagnose gateway crashes
// Without this handler, Node.js v15+ terminates with exit code 1 on unhandled rejections
process.on('unhandledRejection', (reason: any, promise: any) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '(no stack)';
  log.error(`[UNHANDLED REJECTION] ${msg}`);
  log.error(`[UNHANDLED REJECTION] Stack: ${stack}`);
});

export async function startXmpp(cfg: any, contacts: any, log: any, onMessage: (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, roomSubject?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean, whiteboardData?: any, isSystemMessage?: boolean }) => void, onOnline?: (xmppClient: any) => void, onFileReceived?: (filePath: string, filename: string, from: string, description?: string) => void) {
    // SECURITY (2.0.18, L1): per-invocation import of @xmpp/client.
    // Node caches the module so the second call is a no-op.  See
    // the comment on the (now-removed) module-level binding.
    const xmppClientModule = await import("@xmpp/client");
    const { client, xml } = xmppClientModule;
    // Helper to get default resource/nick from JID local part
    // SECURITY (2.1.4): the previous default (`cfg?.jid?.split("@")[0]`)
    // was a STABLE resource, which combined with the
    // `startXmpp()` reconnect path caused the
    // `StreamError { condition: 'conflict', text: 'Replaced by
    // new connection' }` cycle on networks where the XMPP
    // server hadn't noticed the old TCP socket was dead yet
    // (e.g. NAT idle-timeout).  We now generate a
    // stable-prefix + 6-hex-char random suffix per
    // `startXmpp()` call.  16M possible values; collision
    // requires two connections from the same JID in the same
    // millisecond, which is effectively zero.  Operators who
    // supply `cfg.resource` explicitly are honoured verbatim
    // (e.g. for operators who filter their active-sessions
    // list by resource).
    const getDefaultResource = () => {
      if (cfg?.resource) return cfg.resource;
      return `openclaw-${crypto.randomBytes(3).toString("hex")}`;
    };
    
     const getDefaultNick = async () => {
       // Use local vCard value directly (set by CLI command)
       const localNick = await vcard?.getNickname?.();
       const result = localNick || cfg.jid.split("@")[0] || "openclaw";
        xmppLog.debug("getDefaultNick", { localNick, result });
        return result;
     };

     // Track the bot's bound full JID (with resource) after XMPP connection
     // Used for SOCKS5 bytestream SHA1 hash computation (XEP-0065)
     let botFullJid = cfg.jid;
     // Track user full JIDs from inbound messages for SI file transfers
     const fullJidMap = new Map<string, string>();

     async function shouldAcceptInvite(inviterJid: string, roomJid: string): Promise<boolean> {
      const bareInviter = inviterJid.split('/')[0];
      const bareRoom = roomJid.split('/')[0];
      if (await contacts.isAdmin(bareInviter)) return true;
      const autoJoinRooms: string[] = cfg?.autoJoinRooms || cfg?.rooms || [];
      if (autoJoinRooms.includes(bareRoom)) return true;
      return false;
    }
     
     debugLog(`Starting XMPP connection to ${cfg?.service}`);
    debugLog(`XMPP config: jid=${cfg?.jid}, domain=${cfg?.domain}`);

     let password: string;
    try {
      password = decryptPasswordFromConfig(cfg || {});
    } catch (err) {
      debugLog('Failed to decrypt XMPP password: ' + err);
      throw new Error('Failed to decrypt XMPP password');
    }
    
      const xmpp = client({
        service: cfg?.service,
        domain: cfg?.domain,
        username: cfg?.jid?.split("@")[0],
        password: password,
         resource: getDefaultResource()
       });

    // Increase connection timeout from 2s default to 30s to handle slower startups
    xmpp.timeout = 30000;

    // SECURITY (2.1.3, restore-old-design): re-enable the built-in
    // @xmpp/reconnect with a 5-second delay.  The OLD design from
    // D:\Downloads\xmppOLD used this exact setting.  The 2.0.16-era
    // code disabled @xmpp/reconnect and added a custom disconnect
    // handler that triggered reconnection; that handler tore down
    // the LIVE connection when a stale socket's disconnect event
    // fired after the new connection was online.  Restoring
    // @xmpp/reconnect gives us library-tested reconnection logic
    // with a sensible default delay.
    if ((xmpp as any).reconnect) {
      (xmpp as any).reconnect.delay = 5000;
      xmppLog.debug("reconnect delay set to 5000ms (using @xmpp/reconnect built-in)");
    }

    // Register handler for Prosody server XEP-0199 ping requests so the server
    // knows the client is alive (server pings every 5 min per ping_interval config)
    if ((xmpp as any).iqCallee) {
      (xmpp as any).iqCallee.get("urn:xmpp:ping", "ping", async (ctx: any) => {
        const from = ctx?.stanza?.attrs?.from || "unknown";
        debugLog(`PING: received ping request from ${from}, responding`);
        xmppLog.debug(`responding to ping from ${from}`);
        return xml("ping", { xmlns: "urn:xmpp:ping" });
      });
    }

    // Helper to resolve room JID - add conference domain if missing
    const resolveRoomJid = (room: string): string => {
      if (room.includes('@')) {
        return room;
      }
      // Default to conference.domain for MUC rooms
      return `${room}@conference.${cfg.domain}`;
    };
    
    // vCard server helpers (extracted to vcard-server.ts)
    const vcardServer = createVCardServer({ xmpp, bareJid: cfg.jid.split('/')[0] });

    // HTTP File Upload delegates (used by slash commands)
    let uploadServiceJid: string | null = null;
    const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}> => {
      return requestUploadSlotShared(xmpp, cfg.domain, filename, size, contentType, uploadServiceJid);
    };

    // SECURITY (2.1.4): MUC room tracking hoisted here so
    // the error / offline handlers below can clean up
    // `pendingJoins` (and the join-timeout timers) before
    // the rest of the function body runs.
    //
    // `joinedRooms`     — set of MUC room JIDs the server
    //                     has confirmed the bot is in
    //                     (via XEP-0045 self-presence,
    //                     status code 110).  Outbound
    //                     groupchat messages for these
    //                     rooms are accepted by the server.
    // `roomNicks`       — the bot's nick per room JID.
    // `pendingJoins`    — `joinRoom()` Promise registry
    //                     keyed by room JID.  Resolves on
    //                     status 110, rejects on
    //                     `<presence type="error">` or
    //                     5s timeout.  This is what
    //                     closes the "Dispatch SUCCESS
    //                     for stockee@conference but no
    //                     reply" race: the wrapper's
    //                     `joinRoom()` now awaits
    //                     confirmation, and outbound
    //                     groupchat messages are not
    //                     sent until the server says
    //                     we're a participant.
    const joinedRooms = new Set<string>();
    const roomNicks = new Map<string, string>();
    const pendingJoins = new Map<string, {
      resolve: () => void;
      reject: (err: Error) => void;
      nick: string;
      timer: ReturnType<typeof setTimeout>;
    }>();

  xmpp.on("error", (err: any) => {
    log.error("XMPP error", err);
    xmppLog.error("connection error", err);
    // SECURITY (2.1.3, restore-old-design): no liveness manager,
    // no setLastError.  The OLD design from D:\Downloads\xmppOLD
    // just logged errors and let @xmpp/reconnect handle the
    // recovery.  No need to capture the error for R3 fast-fail
    // because there is no R3 fast-fail.
  });

  // SECURITY (2.1.3, restore-old-design): no liveness manager, no
  // custom disconnect handler, no custom reconnection.  Primary
  // reconnection is handled by @xmpp/reconnect (delay 5000ms, set
  // above).  This restores the proven OLD design from
  // D:\Downloads\xmppOLD that the operator confirmed works on
  // Windows 11 and Linux for days/weeks.

  // SECURITY (2.1.3, restore-old-design): no custom reconnect
  // timer / attempts counter.  The OLD design from
  // D:\Downloads\xmppOLD relied on @xmpp/reconnect (set to
  // 5000ms delay above) for primary reconnection.  We do not
  // track reconnectAttempts here.

  // SECURITY (2.0.16): mutable holder for the public client object.
  // Declared up here so the 'online' event handler (registered
  // further down) closes over a defined binding; the real object
  // is assigned at the bottom of startXmpp once the timers,
  // schedulers, and shutdown hooks are all in place.  This
  // replaces the 2.0.15 `typeof (xmppClient as any) === "undefined"`
  // guard, which masked a temporal-dead-zone pattern.
  let xmppClient: any = null;

  // SECURITY (2.1.3, restore-old-design): `safeSend` is now
  // imported from `./lib/xmpp-utils.js` (extracted from the
  // deleted liveness.ts).  `safeXmppSend` is the canonical way
  // to send stanzas; the 42+ call sites use it.
  const safeXmppSend = safeSend;

  // SECURITY (2.1.3, restore-old-design): no `stopLivenessTimers`
  // helper (the liveness manager is gone).  Code that previously
  // called `stopLivenessTimers(reason)` was for the old liveness
  // manager's interval cleanup; with @xmpp/reconnect, there's
  // nothing to clean up here.
  const stopLivenessTimers = (_reason: string): void => {
    /* no-op — liveness manager removed in 2.1.3 */
  };

  // SECURITY (2.1.3, restore-old-design): NO `xmpp.on("disconnect", ...)`
  // handler that triggers reconnection.  The OLD design from
  // D:\Downloads\xmppOLD deliberately did NOT have one — the
  // 2.0.16-era disconnect handler was the source of the
  // "stale-disconnect tears down the live connection" bug the
  // operator was hitting on every reconnect.  @xmpp/reconnect
  // (delay 5000ms, set above) listens for disconnect internally
  // and handles reconnection.  We do NOT double-handle it.

  // SECURITY (2.1.3, restore-old-design): keep the `xmpp.on("offline", ...)`
  // handler from the OLD design.  The @xmpp/client 0.13.x library
  // only emits `offline` after an explicit `xmpp.stop()`.  This
  // handler is a defensive cleanup (clear intervals, destroy
  // whiteboard sessions) for the deliberate-stop path.  It does
  // NOT trigger reconnection.
  xmpp.on("offline", () => {
    log.warn("XMPP went offline");
    isRunning = false;
    if (ibbCleanupInterval) { clearInterval(ibbCleanupInterval); }
    whiteboardSessionManager.stopCleanup();
    whiteboardSessionManager.destroy();
    // SECURITY (2.1.4): reject any in-flight MUC join
    // promises so callers awaiting `joinRoom()` see the
    // stop instead of waiting for a 5-second timeout.
    // This avoids a race where a caller is awaiting a
    // join that will never resolve (because we're
    // stopping).
    for (const [room, pending] of pendingJoins.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`xmpp went offline; pending join for ${room} cancelled`));
    }
    pendingJoins.clear();
    joinedRooms.clear();
    roomNicks.clear();
  });

  // SECURITY (2.1.3, restore-old-design): no SM (XEP-0198) keepalive.
  // The OLD design from D:\Downloads\xmppOLD did not have SM
  // keepalive (no <r/> every 25s).  The 2.0.16-era code added it
  // and the liveness manager tracked smNegotiated.  Restoring the
  // OLD design means we just observe SM features (for visibility)
  // but don't act on them — @xmpp/stream-management's middleware
  // (already attached by the library) handles the actual <r/>/<a/>
  // exchange if SM is negotiated.
  xmpp.on("nonza", (el: any) => {
    try {
      // SECURITY (2.0.16, H3): only treat <sm>/<enabled>/<failed> as
      // SM negotiation signals if they are direct children of the
      // stream-features stanza (i.e. el.parent === xmpp.root).  The
      // previous version matched ANY element in the SM namespace,
      // which would silently flip smNegotiated=true if a server
      // happened to send an <sm> reply (e.g. inside an unrelated
      // IQ).  With the parent check, embedded <sm> elements are
      // ignored.
      if (el?.parent !== xmpp.root) return;
      // SECURITY (2.1.3): the liveness manager is gone, so we no
      // longer call setSmNegotiated().  We just log the SM feature
      // observations for diagnostic purposes.  The actual <r/>/<a/>
      // exchange is handled by @xmpp/stream-management.
      if (el?.is?.("sm", "urn:xmpp:sm:3")) {
        xmppLog.debug("sm: <sm/> feature observed in stream features");
        debugLog("sm: <sm/> feature observed in stream features");
      } else if (el?.is?.("enabled", "urn:xmpp:sm:3")) {
        xmppLog.debug("sm: <enabled/> observed, SM active");
        debugLog("sm: <enabled/> observed, SM active");
      } else if (el?.is?.("failed", "urn:xmpp:sm:3")) {
        xmppLog.warn("sm: <failed/> observed, SM NOT active");
        debugLog("sm: <failed/> observed, SM NOT active");
      }
    } catch (e) {
      // SECURITY (2.0.16, H3): surface the error instead of silently
      // swallowing it.  A parse error here is a real bug worth
      // seeing, not something to hide.
      xmppLog.error("nonza listener parse error", e);
    }
  });

  xmpp.on("online", async (address: any) => {
    log.info("XMPP online as", address.toString());
    botFullJid = address.toString();
    // SECURITY (2.1.3, restore-old-design): no liveness manager,
    // no keepalive setup, no reconnect-timer reset.  The OLD
    // design from D:\Downloads\xmppOLD just logs "online" and
    // proceeds to send presence + vCard.  @xmpp/reconnect
    // (delay 5000ms, set above) handles reconnects via its own
    // internal disconnect listener.
    xmppLog.debug("XMPP online (reconnect handled by @xmpp/reconnect)");
    debugLog("XMPP connected successfully");

      // Send initial presence with Entity Capabilities (XEP-0115)
      try {
        const presence = xml("presence", {},
          xml("c", {
            xmlns: CapsInfo.xmlns,
            hash: CapsInfo.hash,
            node: CapsInfo.node,
            ver: CapsInfo.ver
          })
        );
        await safeXmppSend(xmpp, presence);
        log.info("Presence with XEP-0115 caps sent, ver=" + CapsInfo.ver);
      } catch (err) {
        xmppLog.error("presence failed", err);
        log.error("Failed to send presence", err);
      }

      // Register vCard with the XMPP server so clients can query it
      try {
       const vcardData = await vcard.getData();
       const fn = vcardData.fn || `OpenClaw (${cfg.jid?.split('@')[0]})`;
       const nickname = vcardData.nickname || cfg.jid?.split('@')[0] || "openclaw";
       const url = vcardData.url || "https://github.com/anomalyco/openclaw";
       const desc = vcardData.desc || "OpenClaw XMPP Plugin - AI Assistant";

       const vcardId = `vcard-${Date.now()}`;
       const vcardSet = xml("iq", { type: "set", id: vcardId },
         xml("vCard", { xmlns: "vcard-temp" },
           xml("FN", {}, fn),
           xml("NICKNAME", {}, nickname),
           xml("URL", {}, url),
           xml("DESC", {}, desc)
         )
       );

        await safeXmppSend(xmpp,vcardSet);
         log.info("vCard registered with server");
      } catch (err) {
        xmppLog.error("vCard register failed", err);
       log.error("Failed to register vCard", err);
      }

      if (onOnline) {
        try {
          // SECURITY (2.0.16): xmppClient is now a `let` declarado
          // near the top of startXmpp and assigned at the bottom.
          // The `typeof` guard is replaced with a `==null` check
          // (the binding is initialised to `null` so a `==null`
          // comparison works at every point in the lifecycle).  The
          // guard is now dead code in practice (the binding is set
          // to the real object by the time the online event fires)
          // but is retained for belt-and-braces defence-in-depth.
          if (xmppClient == null) {
            xmppLog.error("online callback: xmppClient not yet initialized; skipping onOnline");
          } else {
            onOnline(xmppClient);
          }
        } catch (err) {
          xmppLog.error("online callback error", err);
          log.error("Error in onOnline callback", err);
        }
      }

   });

     const roomsPendingConfig = new Set<string>(); // rooms waiting for configuration
     const ibbSessions = new Map<string, { sid: string, from: string, filename: string, size: number, description?: string, data: Buffer, received: number, createdAt: number }>(); // IBB session tracking

     // Cleanup function for stale IBB sessions
     const cleanupIbbSessions = () => {
       const now = Date.now();
       for (const [sid, session] of ibbSessions.entries()) {
          if (now - session.createdAt > Config.IBB_SESSION_TIMEOUT_MS) {
            ibbSessions.delete(sid);
         }
       }
     };

      // Run cleanup every minute
      const ibbCleanupInterval = setInterval(cleanupIbbSessions, Config.IBB_CLEANUP_INTERVAL_MS);

      // Whiteboard session tracking
      const whiteboardSessionManager = new WhiteboardSessionManager(Config.WHITEBOARD_SESSION_TIMEOUT_MS);
      whiteboardSessionManager.startCleanup(Config.WHITEBOARD_CLEANUP_INTERVAL_MS);
      
      // Export for outbound message interception
      (global as any).whiteboardSessionManager = whiteboardSessionManager;

      // Local joined rooms tracking for MUC
      // SECURITY (2.1.4): these are hoisted to before the
      // `xmpp.on("error" | "offline" | ...)` registrations
      // so the offline handler can clean up
      // `pendingJoins` (and so the join-timeout timers
      // don't leak across a deliberate stop).  Declared
      // here, used by the stanza handler and the
      // wrapper's `joinRoom`/`leaveRoom` below.
      // (The actual declarations are hoisted to before
      // `xmpp.on("error", ...)` so the offline handler
      // can clean them up.  See lines around 290.)

    // Initialize vCard with config defaults
    const vcard = new VCard(cfg.dataDir);
    // Update vCard with config defaults if fields are not set
    if (cfg.vcard) {
      const vcardData = await vcard.getData();
      const updates: any = {};
      if (cfg.vcard.fn && !vcardData.fn) updates.fn = cfg.vcard.fn;
      if (cfg.vcard.nickname && !vcardData.nickname) updates.nickname = cfg.vcard.nickname;
      if (cfg.vcard.url && !vcardData.url) updates.url = cfg.vcard.url;
      if (cfg.vcard.desc && !vcardData.desc) updates.desc = cfg.vcard.desc;
      if (cfg.vcard.avatarUrl && !vcardData.avatarUrl) updates.avatarUrl = cfg.vcard.avatarUrl;
      if (Object.keys(updates).length > 0) {
        await vcard.update(updates);
      }
    }

    xmpp.on("stanza", async (stanza: any) => {
     // debugLog("XMPP stanza received: " + stanza.toString().substring(0, 200));
     
     if (stanza.is("presence")) {
       const from = stanza.attrs.from;
       if (from && from.includes('/')) fullJidMap.set(from.split('/')[0], from);
       const type = stanza.attrs.type || "available";
      const parts = from.split('/');
      const room = parts[0];
      const nick = parts[1] || '';
      
        // Handle subscription requests (not MUC)
        if (type === "subscribe") {
          const bareFrom = from.split('/')[0];
          if (await contacts.isAdmin(bareFrom)) {
            const subscribed = xml("presence", { to: from, type: "subscribed" });
            await safeXmppSend(xmpp,subscribed);
            xmppLog.debug("presence", { type: "subscribed-auto-admin", from: bareFrom });
          } else {
            const unsubscribed = xml("presence", { to: from, type: "unsubscribed" });
            await safeXmppSend(xmpp,unsubscribed);
            xmppLog.warn("subscription rejected (non-admin)", { from: bareFrom });
          }
          return;
        }
      
       // Handle other subscription types
       if (type === "subscribed" || type === "unsubscribe" || type === "unsubscribed") {
         xmppLog.debug("presence", { type, from });
         // Add to contacts if subscribed
        if (type === "subscribed") {
          const bareFrom = from.split('/')[0];
          if (!(await contacts.exists(bareFrom))) {
            await contacts.add(bareFrom);
            xmppLog.debug("contact added", { jid: bareFrom });
          }
        }
        return;
      }
      
       // Handle presence probes
       if (type === "probe") {
         xmppLog.debug("presence", { type: "probe", from });
         // Respond with available presence including Entity Capabilities
         try {
           const presence = xml("presence", { to: from },
             xml("c", {
               xmlns: CapsInfo.xmlns,
               hash: CapsInfo.hash,
               node: CapsInfo.node,
               ver: CapsInfo.ver
             })
           );
           await safeXmppSend(xmpp,presence);
         } catch (err) {
           xmppLog.error("presence probe response failed", err);
         }
         return;
       }
      
      // Check for MUC status codes
      const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
      if (xElement) {
        const statusElements = xElement.getChildren('status');
        for (const status of statusElements) {
          const code = status.attrs.code;
          xmppLog.debug("muc", { room, nick, code });
          // Common MUC status codes:
          // 201: Room created
          // 210: Room is being configured
          // 100: User's presence in room
          // 110: Self-presence (our own join)
          if (code === "201") {
            roomsPendingConfig.add(room);
          } else if (code === "210") {
            roomsPendingConfig.add(room);
          } else if (code === "110") {
            roomsPendingConfig.delete(room);
            // SECURITY (2.1.4): server has confirmed our
            // MUC presence (XEP-0045 self-presence).  This
            // is the canonical signal that the bot is now
            // a participant in the room and outbound
            // groupchat messages will be accepted.  Resolve
            // any pending join promise for this room.
            if (pendingJoins.has(room)) {
              const pending = pendingJoins.get(room)!;
              clearTimeout(pending.timer);
              pendingJoins.delete(room);
              joinedRooms.add(room);
              roomNicks.set(room, pending.nick);
              xmppLog.info("muc self-presence (110): room joined", { room, nick: pending.nick });
              pending.resolve();
            }
          }
        }
      }
      
      // SECURITY (2.1.4): MUC join error.  When the server
      // rejects a MUC presence (nick conflict, room not
      // found, banned, etc.) it sends back
      // `<presence type="error">` to the full JID we
      // joined with.  Reject the pending join promise so
      // the wrapper's `joinRoom()` caller knows the join
      // failed and `joinedRooms` stays empty for this
      // room.
      if (type === "error") {
        const pending = pendingJoins.get(room);
        if (pending) {
          const errorEl = stanza.getChild('error');
          const errorCondition = errorEl ? errorEl.children?.[0]?.name || 'unknown' : 'unknown';
          xmppLog.warn("muc join rejected by server", { room, nick, errorCondition });
          clearTimeout(pending.timer);
          pendingJoins.delete(room);
          pending.reject(new Error(`MUC join rejected for ${room} (nick=${nick}): ${errorCondition}`));
        }
      }
      
      if (type === "unavailable") {
        xmppLog.debug("muc", { room, nick, action: "leave" });
        // Check if bot was removed from room (kicked or left)
        const botNick = roomNicks.get(room);
        if (nick && nick === botNick) {
          xmppLog.debug("muc", { room, action: "bot-removed" });
          joinedRooms.delete(room);
          roomNicks.delete(room);
        }
      } else {
        xmppLog.debug("muc", { room, nick, action: "join" });
    }
    }
    
    if (stanza.is("iq")) {
      const from = stanza.attrs.from;
      const to = stanza.attrs.to;
      const type = stanza.attrs.type;
      const id = stanza.attrs.id;
      debugLog(`IQ stanza: type=${type}, from=${from}, id=${id}`);
      
      // Handle SI File Transfer requests (XEP-0096)
      if (type === "set") {
        const si = stanza.getChild("si", "http://jabber.org/protocol/si");
        if (si) {
          debugLog(`SI file transfer offer from ${from}`);
          // Check for file transfer profile
          const file = si.getChild("file", "http://jabber.org/protocol/si/profile/file-transfer");
          if (file) {
            const filename = file.attrs.name || "unknown";
            const size = file.attrs.size ? parseInt(file.attrs.size) : 0;
            debugLog(`File offer: ${filename} (${size} bytes)`);

            // Check for supported stream methods — navigate through jabber:x:data form
            const feature = si.getChild("feature", "http://jabber.org/protocol/feature-neg");
            let supportedMethod = null;
            if (feature) {
              const xForm = feature.getChild("x", "jabber:x:data");
              if (xForm) {
                const fields = xForm.getChildren("field");
                for (const field of fields) {
                  if (field.attrs.var === "stream-method") {
                    // Some clients (e.g. Psi+) wrap <value> in <option> elements
                    const options = field.getChildren("option");
                    for (const option of options) {
                      const valueEl = option.getChild("value");
                      if (valueEl && valueEl.getText() === "http://jabber.org/protocol/ibb") {
                        supportedMethod = "http://jabber.org/protocol/ibb";
                        break;
                      }
                    }
                    // Other clients put <value> directly under <field>
                    if (!supportedMethod) {
                      const values = field.getChildren("value");
                      for (const value of values) {
                        if (value.getText() === "http://jabber.org/protocol/ibb") {
                          supportedMethod = "http://jabber.org/protocol/ibb";
                          break;
                        }
                      }
                    }
                    if (supportedMethod) break;
                  }
                }
              }
            }

            if (supportedMethod === "http://jabber.org/protocol/ibb") {
              xmppLog.debug("fileTransfer", { action: "accept-si", filename });
              if (size > MAX_FILE_SIZE) {
                log.warn("Rejected oversized file transfer", { filename, size, max: MAX_FILE_SIZE });
                const errorIq = xml("iq", { to: from, type: "error", id },
                  xml("error", { type: "modify" },
                    xml("file-too-large", { xmlns: "urn:xmpp:file:too-large" }),
                    xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp:stanzas" }, `File exceeds maximum size of ${MAX_FILE_SIZE} bytes`)
                  )
                );
                await safeXmppSend(xmpp,errorIq);
                return;
              }
              // Capture session ID from SI element
              const sid = si.attrs.id || si.attrs.sid;
              if (!sid) {
                xmppLog.debug("fileTransfer", { action: "reject-no-sid" });
                const errorIq = xml("iq", { to: from, type: "error", id },
                  xml("error", { type: "cancel" },
                    xml("bad-request", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
                    xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }, "Missing SID")
                  )
                );
                await safeXmppSend(xmpp,errorIq);
                return;
              }

               // Extract optional description from SI file element
               const descElement = file.getChild("desc", "http://jabber.org/protocol/si/profile/file-transfer");
               const description = descElement ? descElement.getText() : undefined;

                // Store IBB session - ensure from is a valid string
                const fromJid = typeof from === 'string' ? from : String(from);
                ibbSessions.set(sid, {
                  sid,
                  from: fromJid,
                  filename,
                  size,
                  description,
                  data: Buffer.alloc(0),
                  received: 0,
                  createdAt: Date.now()
                });

              // Accept the SI request with proper negotiation response (XEP-0096)
              const acceptIq = xml("iq", { to: from, type: "result", id },
                xml("si", { xmlns: "http://jabber.org/protocol/si" },
                  xml("feature", { xmlns: "http://jabber.org/protocol/feature-neg" },
                    xml("x", { xmlns: "jabber:x:data", type: "submit" },
                      xml("field", { var: "stream-method" },
                        xml("value", {}, "http://jabber.org/protocol/ibb")
                      )
                    )
                  )
                )
              );
              await safeXmppSend(xmpp,acceptIq);
              xmppLog.debug("fileTransfer", { action: "si-accepted", sid, filename });
            } else {
              // No supported method, reject
              xmppLog.debug("fileTransfer", { action: "reject-no-method" });
              const errorIq = xml("iq", { to: from, type: "error", id },
                xml("error", { type: "cancel" },
                  xml("feature-not-implemented", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
                  xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }, "No supported stream method")
                )
              );
              await safeXmppSend(xmpp,errorIq);
            }
            return;
          }
        }
      }
       // Handle IBB (In-Band Bytestreams) requests
       const ibbOpen = stanza.getChild("open", "http://jabber.org/protocol/ibb");
       if (ibbOpen) {
         const sid = ibbOpen.attrs.sid;
         const session = ibbSessions.get(sid);
          if (!session) {
            xmppLog.debug("ibb", { action: "reject-unknown-session", sid });
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("item-not-found", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await safeXmppSend(xmpp,errorIq);
           return;
         }
         // Accept open
         const resultIq = xml("iq", { to: from, type: "result", id });
          await safeXmppSend(xmpp,resultIq);
          xmppLog.debug("ibb", { action: "opened", sid, filename: session.filename });
         return;
       }
       
       const ibbData = stanza.getChild("data", "http://jabber.org/protocol/ibb");
       if (ibbData) {
         const sid = ibbData.attrs.sid;
         const session = ibbSessions.get(sid);
          if (!session) {
            xmppLog.debug("ibb", { action: "reject-unknown-data", sid });
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("item-not-found", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await safeXmppSend(xmpp,errorIq);
           return;
         }
         const base64Data = ibbData.getText();
         try {
           const chunk = Buffer.from(base64Data, 'base64');
            session.data = Buffer.concat([session.data, chunk]);
            session.received += chunk.length;
            xmppLog.debug("ibb", { sid, received: session.received, total: session.size });
           // Acknowledge data
           const resultIq = xml("iq", { to: from, type: "result", id });
           await safeXmppSend(xmpp,resultIq);
           
             // If we've received all data, close session and process file
              if (session.size > 0 && session.received >= session.size) {
                xmppLog.debug("ibb", { action: "complete", sid, filename: session.filename, bytes: session.received });
               // Save file to downloads directory with path traversal protection
               const tempDir = path.join(cfg.dataDir, 'downloads');
               if (!fs.existsSync(tempDir)) {
                 fs.mkdirSync(tempDir, { recursive: true });
               }
               
               // Sanitize filename from sender using validator
               let safeFilename = validators.sanitizeFilename(session.filename);
                if (!validators.isSafePath(safeFilename, tempDir)) {
                  safeFilename = `file_${Date.now()}_${safeFilename}`;
                }
                
                 const filePath = path.join(tempDir, safeFilename);
                await fs.promises.writeFile(filePath, session.data);
                ibbSessions.delete(sid);
               // Notify about incoming file
                if (onFileReceived) {
                  onFileReceived(filePath, session.filename, session.from, session.description);
                }
              }
           } catch (err) {
            xmppLog.error("IBB data error", err);
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("bad-request", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await safeXmppSend(xmpp,errorIq);
         }
         return;
       }
       
        const ibbClose = stanza.getChild("close", "http://jabber.org/protocol/ibb");
        if (ibbClose) {
          const sid = ibbClose.attrs.sid;
          const session = ibbSessions.get(sid);
          if (session) {
              xmppLog.debug("ibb", { action: "closed", sid, received: session.received });
             // Save file if we have data with path traversal protection
             if (session.received > 0) {
               const tempDir = path.join(cfg.dataDir, 'downloads');
               if (!fs.existsSync(tempDir)) {
                 fs.mkdirSync(tempDir, { recursive: true });
               }
               
               // Sanitize filename from sender using validator
               let safeFilename = validators.sanitizeFilename(session.filename);
                if (!validators.isSafePath(safeFilename, tempDir)) {
                  safeFilename = `file_${Date.now()}_${safeFilename}`;
                }
                
                 const filePath = path.join(tempDir, safeFilename);
                await fs.promises.writeFile(filePath, session.data);
                // Notify about incoming file
                if (onFileReceived) {
                  onFileReceived(filePath, session.filename, session.from, session.description);
                }
              }
              ibbSessions.delete(sid);
           }
           const resultIq = xml("iq", { to: from, type: "result", id });
           await safeXmppSend(xmpp,resultIq);
           return;
         }
         
         // Handle vCard requests (XEP-0054)
          const vcardElement = stanza.getChild("vCard", "vcard-temp");
          if (vcardElement) {
            const targetJid = to || from;
            xmppLog.debug("vCard request", { from, target: targetJid, type });

            // Check if this is for the bot's JID
            const botBareJid = cfg.jid?.split('/')[0];
            const targetBareJid = targetJid.split('/')[0];
            const isForBot = targetBareJid === botBareJid;

            if (type === "get") {
              if (isForBot) {
                // Respond with bot's vCard
                const localPart = cfg?.jid?.split("@")[0] || "openclaw";
                const fn = await vcard.getFN() || `OpenClaw (${localPart})`;
                const nickname = await vcard.getNickname() || localPart;
                const url = await vcard.getUrl() || "https://github.com/anomalyco/openclaw";
                const desc = await vcard.getDesc() || "OpenClaw XMPP Plugin - AI Assistant";

                const vcardResponse = xml("iq", { to: from, type: "result", id },
                  xml("vCard", { xmlns: "vcard-temp" },
                    xml("FN", {}, fn),
                    xml("NICKNAME", {}, nickname),
                    xml("URL", {}, url),
                    xml("DESC", {}, desc)
                  )
                );
                await safeXmppSend(xmpp,vcardResponse);
                xmppLog.debug("vCard response sent", { to: from });
              } else {
                // Forward request to server for user vCard
                 xmppLog.debug("vCard forward", { target: targetJid });
                const forwardIq = xml("iq", { to: targetJid, type: "get", id }, stanza.children);
                await safeXmppSend(xmpp,forwardIq);
              }
              return;
            } else if (type === "set") {
              // vCard SET from user - this is for storing on the server
              // The user's XMPP client should handle this directly
              // But if it comes to us, we just acknowledge it (we don't store user vCards)
               xmppLog.debug("vCard set ignored", { from });
              const resultIq = xml("iq", { to: from, type: "result", id });
              await safeXmppSend(xmpp,resultIq);
              return;
            }
          }

        // Handle Service Discovery (XEP-0030) - disco#info
        const queryElement = stanza.getChild("query", "http://jabber.org/protocol/disco#info");
        if (queryElement && type === "get") {
          const node = queryElement.attrs.node || "";
        // Respond with our features
        const discoResponse = xml("iq", { to: from, type: "result", id },
          xml("query", { xmlns: "http://jabber.org/protocol/disco#info", node },
            xml("identity", { category: "client", type: "bot", name: "OpenClaw AI Assistant" }),
            xml("feature", { var: "http://jabber.org/protocol/caps" }),
            xml("feature", { var: "http://jabber.org/protocol/disco#info" }),
            xml("feature", { var: "vcard-temp" }),
            xml("feature", { var: "http://jabber.org/protocol/muc" }),
            xml("feature", { var: "http://jabber.org/protocol/si/profile/file-transfer" }),
            xml("feature", { var: "http://jabber.org/protocol/ibb" }),
            xml("feature", { var: "http://jabber.org/protocol/sxe" }),
            xml("feature", { var: "http://jabber.org/protocol/swb" }),
            xml("feature", { var: "http://www.w3.org/2000/svg" })
          )
        );
          await safeXmppSend(xmpp,discoResponse);
          xmppLog.debug("disco#info sent", { to: from });
          return;
        }

        // Handle HTTP Upload slot requests (responses to our requests)
        // These are handled by the requestUploadSlot function via await xmpp.send()
        // So we don't need to process them here
        
        return;
    }
    
    if (stanza.is("message")) {
        const from = stanza.attrs.from;
       // Track full JID for SI file transfers
       if (from && from.includes('/')) fullJidMap.set(from.split('/')[0], from);
       const to = stanza.attrs.to;
       const messageType = stanza.attrs.type || "chat";
      
      // Check for MUC invites
      const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
      if (xElement) {
        const inviteElement = xElement.getChild('invite');
        if (inviteElement) {
          const inviter = inviteElement.attrs.from || from.split('/')[0];
          const reason = inviteElement.getChildText('reason') || 'No reason given';
          
           // Auto-accept invite by joining the room
          try {
            const room = from.split('/')[0];
            const presence = xml("presence", { to: `${room}/${await getDefaultNick()}` },
              xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                xml("history", { maxstanzas: "0" })
              )
            );
            await safeXmppSend(xmpp,presence);
            joinedRooms.add(room);
            roomNicks.set(room, await getDefaultNick());
            log.info("autoJoin", { room });
          } catch (err) {
            xmppLog.error("invite accept failed", err);
          }
          return;
        }
      }
      
      // Check for jabber:x:conference invites
      const conferenceElement = stanza.getChild('x', 'jabber:x:conference');
      
      if (conferenceElement) {
        const room = conferenceElement.attrs.jid as string;
        const password = conferenceElement.attrs.password as string;
        const reason = conferenceElement.attrs.reason as string || 'No reason given';
        
        if (room) {
          if (!(await shouldAcceptInvite(from, room))) {
            log.warn("Rejected conference invite from non-admin", { from });
            return;
          }
          
           // Auto-accept invite by joining the room
          try {
            const presence = xml("presence", { to: `${room}/${await getDefaultNick()}` },
              xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                password ? xml("password", {}, password) : undefined,
                xml("history", { maxstanzas: "0" })
              )
            );
            await safeXmppSend(xmpp,presence);
            joinedRooms.add(room);
            roomNicks.set(room, await getDefaultNick());
            log.info("autoJoin", { room });
          } catch (err) {
            xmppLog.error("conference invite accept failed", err);
          }
          return;
        }
      }
      
      // Check for room configuration forms (MUC owner namespace)
      const mucOwnerX = stanza.getChild('x', 'http://jabber.org/protocol/muc#owner');
      if (mucOwnerX) {
        const xDataForm = mucOwnerX.getChild('x', 'jabber:x:data');
        if (xDataForm && xDataForm.attrs.type === 'form') {
          
           // Try to auto-configure room by submitting the form with default values
          try {
            // Create a submitted form with same fields but empty values (use defaults)
            const formId = xDataForm.getChildText('title') || 'Room Configuration';
            
            // Build a submitted form
            const submittedForm = xml("x", { xmlns: "jabber:x:data", type: "submit" });
            
            // Copy field definitions but with empty values
            const fields = xDataForm.getChildren('field');
            for (const field of fields) {
              const varName = field.attrs.var;
              if (varName) {
                submittedForm.append(xml("field", { var: varName }));
              }
            }
            
            // Send the configuration submission
            const configMessage = xml("message", { to: from },
              xml("x", { xmlns: "http://jabber.org/protocol/muc#owner" },
                submittedForm
              )
            );
            await safeXmppSend(xmpp,configMessage);
            roomsPendingConfig.delete(from.split('/')[0]);
          } catch (err) {
            xmppLog.error("room config failed", err);
          }
          return;
        }
      }
       // Check for file attachments (XEP-0066: Out of Band Data)
       const oobElement = stanza.getChild('x', 'jabber:x:oob');
       
       let mediaUrls: string[] = [];
       let mediaPaths: string[] = [];
       
        if (oobElement) {
          const url = oobElement.getChildText('url');
          if (url) {
            mediaUrls.push(url);
            
             // Download file locally for agent processing
             try {
               const localPaths = await processInboundFiles([url], cfg.dataDir);
             mediaPaths = localPaths;
           } catch (err) {
             xmppLog.error("file download failed", err);
           }
         }
       }
       
       // Check for other common file sharing namespaces
       const sfsElement = stanza.getChild('file-sharing', 'urn:xmpp:sfs:0');
       const simsElement = stanza.getChild('media-sharing', 'urn:xmpp:sims:1');
       const jingleFile = stanza.getChild('file', 'http://jabber.org/protocol/si/profile/file-transfer');
       const bobElement = stanza.getChild('data', 'urn:xmpp:bob');
         
         // Extract body and subject from message
          const body = stanza.getChildText("body");
          const subject = stanza.getChildText("subject");

          if (body && body.length > Config.MAX_MESSAGE_BODY_SIZE) {
            log.warn("Dropping oversized message", { size: body.length, max: Config.MAX_MESSAGE_BODY_SIZE });
            return;
          }
         
         // Check for room subject change (MUC subject message)
         const isGroupChat = messageType === "groupchat";
          if (isGroupChat && subject && !body) {
            xmppLog.debug("room subject", { subject });
           // Forward subject as a special message to the agent
           const botNick = roomNicks.get(from.split('/')[0]);
            onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [], isSystemMessage: true });
           return;
         }
         
           // Strip resource from sender JID for contact check (needed for SXE too)
         const fromBareJid = from.split("/")[0];

          // Check for SXE Whiteboard messages BEFORE body guard — PSI+ sends pure <message><sxe> with no <body>
          const sxeElement = stanza.getChild('sxe', 'http://jabber.org/protocol/sxe');
          if (sxeElement) {
            try {
              debugLog(`SXE raw stanza: ${stanza.toString().substring(0, 2000)}`);
              const sxeData = parseSxeMessage(stanza);
              debugLog(`SXE parsed: type=${sxeData.type}, session=${sxeData.sessionId}, elements=${sxeData.elements?.length || 0}`);
              if (sxeData.elements && sxeData.elements.length > 0) {
                debugLog(`SXE elements: ${JSON.stringify(sxeData.elements).substring(0, 2000)}`);
              }
              xmppLog.debug("SXE message received", { session: sxeData.sessionId, type: sxeData.type });
              
              let session = whiteboardSessionManager.getSession(fromBareJid);
              if (!session) {
                session = whiteboardSessionManager.createSession(fromBareJid, 'sxe', sxeData.sessionId);
                xmppLog.info("SXE whiteboard session created", { jid: fromBareJid, session: sxeData.sessionId });
              }
              
              if (sxeData.type === 'invitation') {
                xmppLog.info("SXE invitation received, auto-accepting", { from: fromBareJid });
                
                const acceptResponse = buildSxeXml({
                  sessionId: sxeData.sessionId,
                  type: 'accept-invitation'
                });
                
                const acceptMessage = xml('message', { type: messageType, to: from }, acceptResponse);
                await safeXmppSend(xmpp,acceptMessage);
                xmppLog.debug("SXE accept-invitation sent");
                
                return;
              }
              
              if (sxeData.type === 'document-begin' || sxeData.type === 'accept-invitation') {
                xmppLog.debug("SXE negotiation complete", { type: sxeData.type });
                session.instructionsSent = true;
                
                const instructions = `[WHITEBOARD] SXE whiteboard session established with ${fromBareJid} (session: ${sxeData.sessionId}).\n\nHow to draw on the whiteboard:\nWrap SVG path commands in [WHITEBOARD_DRAW] tags. Each line inside is one complete SVG path.\n\nExample:\nI'll draw a house for you!\n\n[WHITEBOARD_DRAW]\nM100,200L200,100L300,200Z\nM120,200L120,150L180,150L180,200\nM145,150L145,120L175,120L175,150 with blue\n[/WHITEBOARD_DRAW]\n\nRules:\n- Each line inside tags = one SVG path (starts with M, uses L/H/V/C/S/Q/T/A/Z commands)\n- Add "with red/blue/green/black/#rrggbb" after a path for color\n- Add "width N" after a path for stroke width\n- Text outside the tags is sent as a normal chat message\n- You can mix drawing and text in one response\n\nCurrent whiteboard state:\n- ${session.paths.length} paths\n- ${session.moves.length} moves\n- ${session.deletes.length} deletes`;
                onMessage(fromBareJid, instructions, { 
                  type: messageType, 
                  room: undefined, 
                  nick: undefined, 
                  botNick: undefined,
                  isSystemMessage: true
                });

                if (sxeData.elements && sxeData.elements.length > 0) {
                  const convertedData = convertSxeToWhiteboardData(sxeData);
                  whiteboardSessionManager.updateSession(fromBareJid, {
                    paths: convertedData.paths,
                    moves: convertedData.moves,
                    deletes: convertedData.deletes
                  });
                  xmppLog.debug("SXE document-begin contained embedded elements", { count: sxeData.elements.length });
                }

                return;
              }
              
              if (sxeData.type === 'left-session') {
                xmppLog.info("SXE session ended", { from: fromBareJid });
                whiteboardSessionManager.deleteSession(fromBareJid);
                return;
              }
              
              if (sxeData.type === 'new' || sxeData.type === 'set' || sxeData.type === 'remove') {
                // Accumulate elements into session state across stanzas
                // PSI+ sends path data as multiple separate stanzas:
                //   1) <path> element + attrs (d="" stub)
                //   2) <set> chdata chunk 1
                //   3) <set> chdata chunk 2, etc.
                // Path reconstruction happens in the timer callback after all chunks arrive
                if (sxeData.elements) {
                  for (const el of sxeData.elements) {
                    if (el.type === 'element' || el.type === 'new') {
                      if (el.name && el.parent !== undefined && el.rid) {
                        session.sxeNodes[el.rid] = { name: el.name, parent: el.parent };
                      }
                    } else if (el.type === 'attr') {
                      if (el.rid) {
                        session.sxeAttrs[el.rid] = { parent: el.parent || '', name: el.name || '', chdata: el.chdata || '' };
                      }
                    } else if (el.type === 'set') {
                      const targetRid = el.rid;
                      if (targetRid && session.sxeAttrs[targetRid]) {
                        const existing = session.sxeAttrs[targetRid];
                        if (el.replacen !== undefined && el.replacefrom !== undefined && el.chdata !== undefined) {
                          const from = parseInt(el.replacefrom, 10);
                          const len = parseInt(el.replacen, 10);
                          existing.chdata = existing.chdata.substring(0, from) + el.chdata + existing.chdata.substring(from + len);
                        } else if (el.chdata !== undefined) {
                          existing.chdata = el.chdata;
                        }
                      } else if (targetRid && el.chdata !== undefined) {
                        session.sxeAttrs[targetRid] = { parent: el.parent || targetRid, name: el.name || '', chdata: el.chdata };
                      }
                    } else if (el.type === 'remove') {
                      const rid = el.rid || el.id;
                      if (rid) {
                        delete session.sxeNodes[rid];
                        delete session.sxeAttrs[rid];
                        session.deletes.push({ id: rid });
                      }
                    }
                  }
                }
                
                debugLog(`SXE accumulated: nodes=${Object.keys(session.sxeNodes).length}, attrs=${Object.keys(session.sxeAttrs).length}`);
                
                whiteboardSessionManager.clearIncomingTimer(fromBareJid);
                
                whiteboardSessionManager.setIncomingTimer(fromBareJid, async () => {
                  try {
                  const currentSession = whiteboardSessionManager.getSession(fromBareJid);
                  if (!currentSession) return;
                  
                  const reconstructedPaths = reconstructPathsFromState(currentSession);
                  debugLog(`SXE reconstructed paths: ${reconstructedPaths.length}`);
                  if (reconstructedPaths.length > 0) {
                    debugLog(`SXE reconstructed: ${JSON.stringify(reconstructedPaths).substring(0, 1000)}`);
                    debugLog(`SXE reconstructed d[0] length: ${reconstructedPaths[0]?.d?.length || 0}`);
                  }
                  
                  currentSession.paths = reconstructedPaths;
                  currentSession.lastActivity = Date.now();
                  
                  const pathDescriptions = reconstructedPaths.map((p: any, i: number) => 
                    `Path ${i + 1}: d="${p.d?.substring(0, 80)}${p.d?.length > 80 ? '...' : ''}" stroke="${p.stroke || '#000'}"${p.fill ? ` fill="${p.fill}"` : ''}${p.strokeWidth && p.strokeWidth !== 1 ? ` stroke-width="${p.strokeWidth}"` : ''}`
                  ).join('\n');
                  
                  const bodyText = `[WHITEBOARD UPDATE] User drew on whiteboard:\n${pathDescriptions || '(no parseable paths)'}\n\nTotal session state: ${currentSession.paths.length} paths, ${currentSession.moves.length} moves, ${currentSession.deletes.length} deletes.\n\nTo draw back, use [WHITEBOARD_DRAW] tags:\n[WHITEBOARD_DRAW]\nM100,200L300,200\n[/WHITEBOARD_DRAW]`;
                  
                  debugLog(`SXE timer: calling onMessage for ${fromBareJid}, type=${messageType}, bodyLen=${bodyText.length}`);
                  await onMessage(fromBareJid, bodyText, { 
                    type: messageType, 
                    room: undefined, 
                    nick: undefined, 
                    botNick: undefined,
                    whiteboardData: {
                      type: 'path',
                      paths: currentSession.paths,
                      moves: currentSession.moves,
                      deletes: currentSession.deletes
                    }
                  });
                  debugLog(`SXE timer: onMessage completed for ${fromBareJid}`);
                  
                  // Auto-draw a small test circle on first whiteboard update to verify outbound SXE
                  if (reconstructedPaths.length > 0 && !currentSession.autoDrawSent) {
                    try {
                      const autoPaths = [{ d: 'M200,200m-20,0a20,20 0 1,0 40,0a20,20 0 1,0 -40,0', stroke: '#ff0000', strokeWidth: 2, id: `auto${Date.now()}` }];
                      const autoEdits = buildSxePathEdits(autoPaths);
                      const autoStanzas = sxeEditsToXml(currentSession.sessionId!, autoEdits);
                      for (const sxeEl of autoStanzas) {
                        const autoMsg = xml('message', { type: messageType, to: from },
                          xml('body', {}, ''),
                          sxeEl
                        );
                        await safeXmppSend(xmpp,autoMsg);
                      }
                      currentSession.autoDrawSent = true;
                      debugLog(`SXE auto-draw sent: ${autoStanzas.length} stanzas for circle`);
                      xmppLog.info("SXE auto-draw test circle sent", { to: fromBareJid });
                    } catch (autoErr: any) {
                      debugLog(`SXE auto-draw failed: ${autoErr?.message || autoErr}`);
                    }
                  }
                  
                  xmppLog.debug("SXE whiteboard forwarded to agent", { 
                    jid: fromBareJid, 
                    paths: currentSession.paths.length,
                    moves: currentSession.moves.length,
                    deletes: currentSession.deletes.length
                  });
                  } catch (timerErr: any) {
                    debugLog(`SXE timer callback FATAL: ${timerErr?.message || timerErr}`);
                    debugLog(`SXE timer stack: ${timerErr?.stack?.substring(0, 500) || 'no stack'}`);
                    xmppLog.error("SXE timer callback error", { message: timerErr?.message, stack: timerErr?.stack?.substring(0, 500) });
                  }
                }, Config.WHITEBOARD_FORWARD_DELAY_MS);
                
                return;
              }
              
              xmppLog.debug("SXE unhandled message type", { type: sxeData.type, sessionId: sxeData.sessionId, rawXml: (sxeData.rawXml || '').substring(0, 500) });
            } catch (sxeErr: any) {
              xmppLog.error("SXE message handling error", { message: sxeErr?.message || String(sxeErr), stack: sxeErr?.stack?.substring(0, 500) || '', rawXml: stanza.toString().substring(0, 500) });
            }
           }

            // Only process messages with body (invites are in body)
           if (!body && mediaUrls.length === 0) return;
         
           // Check for jabber:x:conference invites in body (may be escaped)
           if (body && (body.includes('jabber:x:conference') || body.includes('&lt;x'))) {
             
              // Extract invite attributes (handle both escaped and unescaped)
             const jidMatch = body.match(/jid=['"]([^'"]+)['"]/);
             const passwordMatch = body.match(/password=['"]([^'"]+)['"]/);
             const reasonMatch = body.match(/reason=['"]([^'"]+)['"]/);
             
             const room = jidMatch?.[1];
             const password = passwordMatch?.[1];
             const reason = reasonMatch?.[1] || 'No reason given';
             
            if (room) {
                const inviter = from;
                if (!(await shouldAcceptInvite(inviter, room))) {
                  log.warn("Rejected body-parsed conference invite from non-admin", { from: inviter });
                 return;
               }
                // Auto-accept invite by joining the room
               try {
                 const presence = xml("presence", { to: `${room}/${await getDefaultNick()}` },
                   xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                     password ? xml("password", {}, password) : undefined,
                     xml("history", { maxstanzas: "0" })
                   )
                 );
                 await safeXmppSend(xmpp,presence);
                 joinedRooms.add(room);
                 roomNicks.set(room, await getDefaultNick());
                 log.info("autoJoin", { room });
               } catch (err) {
                 xmppLog.error("body-parsed invite accept failed", err);
               }
               return; // Don't dispatch invite to AI
             }
           }
           
           debugLog(`XMPP message: type=${messageType}, from=${from}, body=${body?.substring(0, 50)}`);
        
        // Check for XEP-0113 Whiteboard messages (delayed forwarding to AI)
        const whiteboardData = parseWhiteboardMessage(stanza);
        if (whiteboardData) {
          xmppLog.debug("whiteboard received", { type: whiteboardData.type, paths: whiteboardData.paths?.length || 0 });
          
          // Get or create session
          let session = whiteboardSessionManager.getSession(fromBareJid);
          if (!session) {
            session = whiteboardSessionManager.createSession(fromBareJid);
            xmppLog.info("whiteboard session created", { jid: fromBareJid });
          }
          
          // Update session with incoming data
          whiteboardSessionManager.updateSession(fromBareJid, {
            paths: whiteboardData.paths,
            moves: whiteboardData.moves,
            deletes: whiteboardData.deletes
          });
          
          // Clear any existing timer (reset delay)
          whiteboardSessionManager.clearIncomingTimer(fromBareJid);
          
          // Set timer to forward after delay (collects rapid drawing operations)
          whiteboardSessionManager.setIncomingTimer(fromBareJid, async () => {
            try {
            const currentSession = whiteboardSessionManager.getSession(fromBareJid);
            if (!currentSession) return;
            
            // Send AI instructions on first message
            if (!currentSession.instructionsSent) {
              const instructions = `[WHITEBOARD] Whiteboard session established with ${fromBareJid}.\n\nHow to draw on the whiteboard:\nWrap SVG path commands in [WHITEBOARD_DRAW] tags. Each line inside is one complete SVG path.\n\nExample:\nI'll draw a house for you!\n\n[WHITEBOARD_DRAW]\nM100,200L200,100L300,200Z\nM120,200L120,150L180,150L180,200\nM145,150L145,120L175,120L175,150 with blue\n[/WHITEBOARD_DRAW]\n\nRules:\n- Each line inside tags = one SVG path (starts with M, uses L/H/V/C/S/Q/T/A/Z commands)\n- Add "with red/blue/green/black/#rrggbb" after a path for color\n- Add "width N" after a path for stroke width\n- Text outside the tags is sent as a normal chat message\n- You can mix drawing and text in one response\n\nCurrent whiteboard state:\n- ${currentSession.paths.length} paths\n- ${currentSession.moves.length} moves\n- ${currentSession.deletes.length} deletes`;
              await onMessage(fromBareJid, instructions, { 
                type: messageType, 
                room: undefined, 
                nick: undefined, 
                botNick: undefined,
                isSystemMessage: true
              });
              
              currentSession.instructionsSent = true;
            }
            
            // Forward consolidated whiteboard data to agent
            const consolidatedData = {
              type: whiteboardData.type,
              paths: currentSession.paths,
              moves: currentSession.moves,
              deletes: currentSession.deletes,
              rawXml: whiteboardData.rawXml
            };
            
            await onMessage(fromBareJid, `[WHITEBOARD UPDATE] Whiteboard update received.\nTo draw, use [WHITEBOARD_DRAW] tags:\n[WHITEBOARD_DRAW]\nM100,200L300,200\n[/WHITEBOARD_DRAW]`, { 
              type: messageType, 
              room: undefined, 
              nick: undefined, 
              botNick: undefined,
              whiteboardData: consolidatedData
            });
            
            // Auto-draw a small test circle on first whiteboard update
            if (currentSession.paths.length > 0 && !currentSession.autoDrawSent) {
              try {
                const autoPaths = [{ d: 'M200,200m-20,0a20,20 0 1,0 40,0a20,20 0 1,0 -40,0', stroke: '#ff0000', strokeWidth: 2, id: `auto${Date.now()}` }];
                if (currentSession.protocol === 'sxe' && currentSession.sessionId) {
                  const autoEdits = buildSxePathEdits(autoPaths);
                  const autoStanzas = sxeEditsToXml(currentSession.sessionId, autoEdits);
                  for (const sxeEl of autoStanzas) {
                    const autoMsg = xml('message', { type: messageType, to: from },
                      xml('body', {}, ''),
                      sxeEl
                    );
                    await safeXmppSend(xmpp,autoMsg);
                  }
                } else {
                  const wbChildren = autoPaths.map(p =>
                    xml('path', { d: p.d, stroke: p.stroke, 'stroke-width': String(p.strokeWidth), id: p.id })
                  );
                  const wbElement = xml('x', { xmlns: 'http://jabber.org/protocol/swb' }, wbChildren);
                  const wbMsg = xml('message', { type: messageType, to: from }, wbElement);
                  await safeXmppSend(xmpp,wbMsg);
                }
                currentSession.autoDrawSent = true;
                debugLog(`Auto-draw test circle sent to ${fromBareJid}`);
              } catch (autoErr: any) {
                debugLog(`Auto-draw failed: ${autoErr?.message || autoErr}`);
              }
            }
            
            xmppLog.debug("whiteboard forwarded to agent", { 
              jid: fromBareJid, 
              paths: currentSession.paths.length,
              moves: currentSession.moves.length,
              deletes: currentSession.deletes.length
            });
            } catch (timerErr: any) {
              debugLog(`SWB timer callback FATAL: ${timerErr?.message || timerErr}`);
              xmppLog.error("SWB timer callback error", { message: timerErr?.message, stack: timerErr?.stack?.substring(0, 500) });
            }
          }, Config.WHITEBOARD_FORWARD_DELAY_MS);
          
          return; // Don't process further
        }
          
         // Check for slash commands (extracted to slash-commands.ts)
         if (body && body.startsWith('/')) {
           await handleSlashCommand({
             xmpp, xmppLog, safeXmppSend, contacts, cfg,
             resolveRoomJid, getDefaultNick, onMessage,
             joinedRooms, roomNicks, vcard, vcardServer,
             requestUploadSlot, uploadFileViaHTTP
           }, {
             body, from, fromBareJid, messageType, mediaUrls, mediaPaths
           });
           return;
         }
      
       // Normal message processing
        debugLog(`[NORMAL] Processing message (type=${messageType})`);
        // Safety check: slash commands should never reach here
        if (body.startsWith('/')) {
          debugLog(`[ERROR] Slash command reached normal processing! This should not happen.`);
          return;
        }
        
        // Check if message is from a groupchat (MUC) - either type="groupchat" OR from contains @conference.
        const isFromGroupChat = messageType === "groupchat" || from.includes('@conference.');
        
        if (isFromGroupChat) {
          // MUC message (including private messages within groupchat)
          const roomJid = from.split("/")[0];
          const nick = from.split("/")[1] || "";
          if (!nick) {
            debugLog(`Ignoring room message without nick (likely room subject)`);
            return;
          }
          const botNick = roomNicks.get(roomJid);
          // Ignore messages from ourselves
          if (botNick && nick === botNick) {
            debugLog(`Ignoring self-message from bot`);
            return;
          }
          debugLog(`[NORMAL] Forwarding groupchat message from ${nick} to agent`);
          // Use actual messageType from stanza - "groupchat" for public, "chat" for private
          onMessage(roomJid, body || '', { type: messageType, room: roomJid, nick, botNick, mediaUrls, mediaPaths });
        } else {
          // Direct message
          if (await contacts.exists(fromBareJid)) {
            debugLog(`[NORMAL] Forwarding chat message from ${fromBareJid} to agent`);

            // Use bare JID for session
            onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
          } else {
            debugLog(`Ignoring message from non-contact: ${fromBareJid}`);
            log.debug(`Ignoring message from non-contact: ${fromBareJid}`);
          }
        }
       }
    });

  xmpp.start().catch((err: any) => {
    log.error("XMPP start failed", err);
    xmppLog.error("start failed", err);
    // SECURITY (2.1.3, restore-old-design): no liveness manager,
    // no forceReconnect.  The OLD design from D:\Downloads\xmppOLD
    // just logged the initial-start failure.  @xmpp/reconnect
    // (delay 5000ms, set above) handles reconnects via its own
    // internal disconnect listener; if the initial start fails
    // outright (e.g. bad credentials), @xmpp/reconnect will also
    // see the error and attempt to reconnect.
  });

     const MIME_TYPES: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".bmp": "image/bmp", ".ico": "image/x-icon",
        ".pdf": "application/pdf", ".zip": "application/zip",
        ".gz": "application/gzip", ".tar": "application/x-tar",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
        ".mp4": "video/mp4", ".webm": "video/webm",
        ".json": "application/json", ".xml": "application/xml",
        ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
        ".ts": "text/typescript", ".txt": "text/plain", ".md": "text/markdown",
        ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      };
      const getMimeType = (fname: string): string =>
        MIME_TYPES[path.extname(fname).toLowerCase()] || "application/octet-stream";

      // SI File Transfer (XEP-0096) + IBB (XEP-0047) outbound helper
    const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
      if (isGroupChat) {
        // SI/IBB only works for 1:1 chats; send text notification to room
        const filename = path.basename(filePath);
        const msgEl = xml("message", { type: "groupchat", to }, xml("body", {}, `[File: ${filename}] ${text || ''}`));
        await safeXmppSend(xmpp, msgEl);
        return;
      }

      debugLog(`Attempting SI file transfer to ${to}`);
      const filename = path.basename(filePath);
      const fileData = await fs.promises.readFile(filePath);
      const size = fileData.length;

      if (size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_SIZE} bytes)`);
      }

      if (size === 0) {
        throw new Error("Cannot transfer empty file");
      }

      const sid = `si-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

      // Helper: send an IQ-set with payload and wait for result
      const sendIqAndWait = (payload: any, timeout = 120000, context = "IBB transfer", toOverride?: string): Promise<any> => {
        return new Promise((resolve, reject) => {
          const id = `iq-${Date.now()}-${Math.random().toString(36).substring(2, 12)}`;
          const iq = xml("iq", { to: toOverride || to, type: "set", id }, payload);
          let resolved = false;
          let timer: ReturnType<typeof setTimeout> | null = null;

          const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
          const handler = (stanza: any) => {
            if (stanza.is("iq") && stanza.attrs.id === id) {
              resolved = true;
              xmpp.off('stanza', handler);
              cleanup();
              if (stanza.attrs.type === 'result') resolve(stanza);
              else {
                const errChild = stanza.getChild("error");
                const errText = errChild ? errChild.toString() : stanza.attrs.type;
                xmppLog.error(`${context} rejected: ${errText}`);
                reject(new Error(`Remote rejected ${context}`));
              }
            }
          };

          xmpp.on('stanza', handler);
          xmpp.send(iq).catch((err: any) => {
            if (!resolved) { resolved = true; xmpp.off('stanza', handler); cleanup(); reject(err); }
          });

          timer = setTimeout(() => {
            if (!resolved) { resolved = true; xmpp.off('stanza', handler); reject(new Error(`${context} timeout`)); }
          }, timeout);
        });
      };

      // 1. Send SI request
      debugLog(`Sending SI request to ${to}`);
      const fileEl = xml("file", { xmlns: "http://jabber.org/protocol/si/profile/file-transfer", name: filename, size: size.toString() });
      if (text) { fileEl.children.push(xml("desc", {}, text)); }
      const siPayload = xml("si", {
        xmlns: "http://jabber.org/protocol/si",
        profile: "http://jabber.org/protocol/si/profile/file-transfer",
        id: sid,
        "mime-type": getMimeType(filename)
      },
        fileEl,
        xml("feature", { xmlns: "http://jabber.org/protocol/feature-neg" },
          xml("x", { xmlns: "jabber:x:data", type: "form" },
            xml("field", { var: "stream-method", type: "list-single" },
              xml("option", {},
                xml("value", {}, "http://jabber.org/protocol/ibb")
              ),
              xml("option", {},
                xml("value", {}, "http://jabber.org/protocol/bytestreams")
              )
            )
          )
        )
      );
      xmppLog.error("SI request to=" + to + " stanza: " + siPayload.toString().substring(0, 800));
      const siResp = await sendIqAndWait(siPayload, 120000, "SI request");
      // Verify which stream method PSI+ selected (IBB or SOCKS5 bytestreams)
      const siRespChild = siResp?.getChild?.("si", "http://jabber.org/protocol/si");
      const featureNeg = siRespChild?.getChild?.("feature", "http://jabber.org/protocol/feature-neg");
      const xData = featureNeg?.getChild?.("x", "jabber:x:data");
      const getMethodFromField = (field: any): string => {
        const values = field.getChildren?.("value") || [];
        for (const v of values) {
          const t = v.text();
          if (t === "http://jabber.org/protocol/ibb" || t === "http://jabber.org/protocol/bytestreams") return t;
        }
        const options = field.getChildren?.("option") || [];
        for (const o of options) {
          const ov = o.getChild?.("value");
          if (ov) {
            const t = ov.text();
            if (t === "http://jabber.org/protocol/ibb" || t === "http://jabber.org/protocol/bytestreams") return t;
          }
        }
        return "";
      };
      let selectedMethod = "";
      if (xData) {
        for (const child of xData.children || []) {
          if (child.name === "field" && child.attrs?.var === "stream-method") {
            selectedMethod = getMethodFromField(child);
            if (selectedMethod) break;
          }
        }
      }
      if (!selectedMethod) { throw new Error("Remote did not select a supported stream-method"); }
      xmppLog.debug("fileTransfer", { action: "si-request-accepted", sid, filename, method: selectedMethod });

      if (selectedMethod === "http://jabber.org/protocol/ibb") {
        // 2. Open IBB stream
        debugLog(`Opening IBB stream to ${to} (sid=${sid})`);
        const blockSize = 4096;
        const openPayload = xml("open", {
          xmlns: "http://jabber.org/protocol/ibb",
          sid,
          "block-size": blockSize.toString(),
          stanza: "iq"
        });
        await sendIqAndWait(openPayload, 120000, "IBB open");
        xmppLog.debug("fileTransfer", { action: "ibb-opened", sid });

        // 3. Send file data in chunks
        const totalChunks = Math.ceil(fileData.length / blockSize);
        xmppLog.debug("fileTransfer", { action: "ibb-transfer-start", sid, chunks: totalChunks, bytes: size });
        for (let offset = 0, seq = 0; offset < fileData.length; offset += blockSize, seq++) {
          const end = Math.min(offset + blockSize, fileData.length);
          const chunk = fileData.slice(offset, end);
          const dataPayload = xml("data", {
            xmlns: "http://jabber.org/protocol/ibb",
            sid,
            seq: seq.toString()
          }, chunk.toString('base64'));
          await sendIqAndWait(dataPayload, 60000, "IBB data");
          if (seq % 20 === 0 && seq > 0) {
            xmppLog.debug("fileTransfer", { action: "ibb-progress", sid, seq, total: totalChunks });
          }
        }

        // 4. Close IBB stream
        debugLog(`Closing IBB stream sid=${sid}`);
        const closePayload = xml("close", { xmlns: "http://jabber.org/protocol/ibb", sid });
        await sendIqAndWait(closePayload, 120000, "IBB close");
        xmppLog.debug("fileTransfer", { action: "ibb-closed", sid, filename, bytes: size });

      } else if (selectedMethod === "http://jabber.org/protocol/bytestreams") {
        // 2. SOCKS5 bytestream via proxy65
        const proxyDomain = `proxy.${cfg.domain}`;
        const proxyHost = proxyDomain;
        const proxyPort = 5000;
        const proxyJid = proxyDomain;

        debugLog(`Starting SOCKS5 bytestream to ${proxyHost}:${proxyPort} (sid=${sid})`);

        // 2a. Send streamhost list to target
        const streamhostPayload = xml("query", { xmlns: "http://jabber.org/protocol/bytestreams", sid },
          xml("streamhost", {
            jid: proxyJid,
            host: proxyHost,
            port: String(proxyPort)
          })
        );
        await sendIqAndWait(streamhostPayload, 120000, "Streamhost");

        // 2b. Compute SOCKS5 hash: SHA1(SID + initiator_jid + target_jid)
        const initiatorJid = botFullJid;
        const targetJid = to;
        const hashInput = `${sid}${initiatorJid}${targetJid}`;
        const hash = crypto.createHash("sha1").update(hashInput, "utf8").digest("hex");

        // 2c. Connect to SOCKS5 proxy
        const socket = new net.Socket();
        await new Promise<void>((resolve, reject) => {
          socket.connect(proxyPort, proxyHost, () => {
            // SOCKS5 greeting: VER=5, NAUTH=1, AUTH=no-auth
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
            socket.once("data", (greetingResp: Buffer) => {
              if (greetingResp[0] !== 0x05 || greetingResp[1] !== 0x00) {
                reject(new Error(`SOCKS5 greeting failed: ${greetingResp[1]}`));
                return;
              }
              // SOCKS5 connect: VER=5, CMD=1(connect), RSV=0, ATYP=3(domain), len=40, hash(40 hex chars), port=0
              const hashBytes = Buffer.from(hash, "utf8");
              const connectReq = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, 40]),
                hashBytes,
                Buffer.from([0x00, 0x00])
              ]);
              socket.write(connectReq);
              socket.once("data", (connectResp: Buffer) => {
                if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
                  reject(new Error(`SOCKS5 connect failed: ${connectResp[1]}`));
                  return;
                }
                resolve();
              });
            });
          });
          socket.on("error", reject);
        });

        // 2d. Short delay for target to connect to proxy too
        await new Promise(r => setTimeout(r, 1000));

        // 2e. Send activate IQ to proxy
        debugLog(`Activating bytestream sid=${sid} on ${proxyJid}`);
        const activatePayload = xml("query", { xmlns: "http://jabber.org/protocol/bytestreams", sid },
          xml("activate", {}, targetJid)
        );
        await sendIqAndWait(activatePayload, 120000, "Activate", proxyJid);

        // 2f. Write file data to socket
        debugLog(`Writing ${size} bytes to SOCKS5 socket (sid=${sid})`);
        await new Promise<void>((resolve, reject) => {
          socket.write(fileData, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // 2g. Close socket
        await new Promise(r => setTimeout(r, 500));
        socket.destroy();
        xmppLog.debug("fileTransfer", { action: "bytestream-done", sid, filename, bytes: size });
      }
    };

    const parseSendfileArgs = (cmdText: string): string[] => {
      const args: string[] = [];
      let current = '';
      let quoteChar = '';
      for (const char of cmdText) {
        if (quoteChar) {
          if (char === quoteChar) quoteChar = '';
          else current += char;
        } else if (char === '"' || char === "'") {
          quoteChar = char;
        } else if (char === ' ') {
          if (current) { args.push(current); current = ''; }
        } else {
          current += char;
        }
      }
      if (current) args.push(current);
      return args;
    };

    xmppClient = {
      // Access to raw XMPP connection for status and low-level operations
      get xmpp() { return xmpp; },
      get status() { return xmpp?.status; },
      // SECURITY (2.1.3, restore-old-design): no `_lastInboundAt`
      // on the wrapper.  The OLD design from D:\Downloads\xmppOLD
      // didn't have a gateway de-dup (the gateway simply called
      // startXmpp once per account, and @xmpp/reconnect handled
      // reconnects internally on the same xmpp instance).  With
      // @xmpp/reconnect as the primary reconnection mechanism,
      // there's no need to track last-inbound time on the
      // wrapper.

      send: (to: string, body: string) => {
        if (body && body.trim().startsWith('/sendfile')) {
          const cmdText = body.trim().substring('/sendfile'.length).trim();
          if (cmdText) {
            const args = parseSendfileArgs(cmdText);
            const filename = args[0];
            const description = args.slice(1).join(' ');
            if (filename) {
              const dataDir = cfg.dataDir || path.join(process.cwd(), 'data');
              const uploadsDir = path.join(dataDir, 'uploads');
              let resolvedPath = '';
              if (path.isAbsolute(filename) && fs.existsSync(filename)) {
                resolvedPath = filename;
              } else {
                const uploadsCandidate = path.join(uploadsDir, filename);
                if (fs.existsSync(uploadsCandidate)) {
                  resolvedPath = uploadsCandidate;
                }
              }
              if (resolvedPath) {
                (async () => {
                  try {
                    await xmppClient.sendFile(to, resolvedPath, description);
                  } catch (err: any) {
                    xmppLog.error("sendfile in send() failed: " + (err?.message || String(err)));
                  }
                })();
                return Promise.resolve();
              } else {
                xmppLog.error("sendfile: file not found", { to, filename, searched: uploadsDir });
                return Promise.resolve();
              }
            }
          }
        }
        const message = xml("message", { type: "chat", to }, xml("body", {}, body));
        return xmpp.send(message);
      },
      sendGroupchat: (to: string, body: string) => {
        const message = xml("message", { type: "groupchat", to }, xml("body", {}, body));
        return xmpp.send(message);
      },
      joinRoom: async (roomJid: string, nick?: string) => {
        const resolvedRoomJid = resolveRoomJid(roomJid);
        const actualNick = nick || await getDefaultNick();
        const fullJid = `${resolvedRoomJid}/${actualNick}`;

        // SECURITY (2.1.4): race protection.  If a previous
        // `joinRoom()` for the same room is still in flight
        // (waiting for self-presence), reject it before
        // starting a new one.  The previous Promise is
        // rejected with a benign reason; the caller of the
        // new `joinRoom()` then proceeds.
        if (pendingJoins.has(resolvedRoomJid)) {
          const stale = pendingJoins.get(resolvedRoomJid)!;
          clearTimeout(stale.timer);
          pendingJoins.delete(resolvedRoomJid);
          stale.reject(new Error(`joinRoom superseded for ${resolvedRoomJid}`));
        }

        // SECURITY (2.1.4): register the pending-join
        // Promise BEFORE sending the presence so the
        // presence-stanza handler (which fires async, on
        // the same tick after `safeXmppSend` resolves) can
        // find the Promise.  The Promise resolves when the
        // server sends self-presence (status code 110)
        // back, and rejects on `<presence type="error">`.
        // A 5-second timeout covers slow MUC servers; if
        // the server hasn't responded in 5s, we treat the
        // join as still-pending and warn the operator.  We
        // do NOT mark the room as joined in that case
        // (the bot might not be a participant).
        const joinPromise = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pendingJoins.has(resolvedRoomJid)) {
              pendingJoins.delete(resolvedRoomJid);
              xmppLog.warn("muc join timed out (no status 110 within 5s)", { room: resolvedRoomJid, nick: actualNick });
              reject(new Error(`MUC join timed out for ${resolvedRoomJid}`));
            }
          }, 5000);
          pendingJoins.set(resolvedRoomJid, { resolve, reject, nick: actualNick, timer });
        });

        // MUC protocol presence with muc namespace and optional history
        const presence = xml("presence", { to: fullJid },
          xml("x", { xmlns: "http://jabber.org/protocol/muc" },
            xml("history", { maxstanzas: "0" }) // Request no history
          )
        );
        try {
          await safeXmppSend(xmpp, presence);
        } catch (err) {
          // Presence send failed.  Clean up the pending
          // entry and propagate the error so the caller
          // knows the join did not happen.
          const pending = pendingJoins.get(resolvedRoomJid);
          if (pending) {
            clearTimeout(pending.timer);
            pendingJoins.delete(resolvedRoomJid);
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
          xmppLog.error("join room failed", err);
          throw err;
        }
        // SECURITY (2.1.4): wait for the server's self-
        // presence (status 110) or error response.  The
        // presence-stanza handler resolves/rejects the
        // pending Promise; we just await it.  When the
        // Promise resolves, `joinedRooms`/`roomNicks` are
        // already populated by the status-110 handler.
        try {
          await joinPromise;
        } catch (joinErr) {
          xmppLog.error("join room: server did not confirm presence", joinErr);
          throw joinErr;
        }
        log.info("room joined", { room: resolvedRoomJid, nick: actualNick });
      },
      leaveRoom: async (roomJid: string, nick?: string) => {
        const resolvedRoomJid = resolveRoomJid(roomJid);
        const fullJid = nick ? `${resolvedRoomJid}/${nick}` : `${resolvedRoomJid}/${await getDefaultNick()}`;
        // SECURITY (2.1.4): if there is a pending join for
        // this room, cancel it before we send the
        // unavailable presence.  This avoids a race where
        // the server's self-presence arrives after we've
        // already left and incorrectly marks the room as
        // joined.
        const pending = pendingJoins.get(resolvedRoomJid);
        if (pending) {
          clearTimeout(pending.timer);
          pendingJoins.delete(resolvedRoomJid);
          pending.reject(new Error(`leaveRoom superseded pending join for ${resolvedRoomJid}`));
        }
        const presence = xml("presence", { to: fullJid, type: "unavailable" });
        try {
          await safeXmppSend(xmpp,presence);
          joinedRooms.delete(resolvedRoomJid);
          roomNicks.delete(resolvedRoomJid);
          log.info("room left", { room: resolvedRoomJid });
        } catch (err) {
          xmppLog.error("leave room failed", err);
          // Still remove from tracking since we attempted to leave
          joinedRooms.delete(resolvedRoomJid);
          roomNicks.delete(resolvedRoomJid);
          throw err;
        }
      },
      getJoinedRooms: () => Array.from(joinedRooms),
      isInRoom: (roomJid: string) => joinedRooms.has(resolveRoomJid(roomJid)),
      iq: async (to: string, type: string, payload?: any) => {
        // Simple IQ sender
        const id = Math.random().toString(36).substring(2);
        const iqStanza = xml("iq", { to, type, id }, payload);
        return xmpp.send(iqStanza);
      },
        sendFile: async (to: string, filePath: string, text?: string, isGroupChat?: boolean) => {
          // Resolve bare JID to last-known full JID (with resource) for SI
          const bareTo = to.split('/')[0];
          const fullTo = (bareTo !== to) ? to : (fullJidMap.get(bareTo) || to);
          xmppLog.debug("fileTransfer", { action: "send", to, fullTo, file: filePath });
          try {
            // First try SI (native PSI+ file transfer dialog via SOCKS5/IBB)
             await sendFileWithSITransfer(fullTo, filePath, text, isGroupChat);
            return true;
           } catch (siErr) {
             xmppLog.debug("fileTransfer", { action: "fallback-to-http" });
             try {
               await sendFileWithHTTPUpload(xmpp, to, filePath, cfg.domain, text, isGroupChat);
               return true;
             } catch (httpErr) {
                xmppLog.error("all transfer methods failed: " + (siErr?.message || String(siErr)));
              throw new Error(`File transfer failed: ${siErr.message}, ${httpErr.message}`);
            }
         }
       },
       inviteToRoom: async (contact: string, room: string, reason?: string, password?: string) => {
         const resolvedRoom = resolveRoomJid(room);
         const inviteAttrs: any = { jid: resolvedRoom };
         if (reason) inviteAttrs.reason = reason;
         if (password) inviteAttrs.password = password;
         
         const message = xml("message", { to: contact },
           xml("x", { xmlns: "jabber:x:conference", ...inviteAttrs })
         );
         
           await safeXmppSend(xmpp,message);
        }
      };

  xmppClient.roomNicks = roomNicks;

  xmppClient.stop = async () => {
    log.info("XMPP shutting down gracefully");
    if (ibbCleanupInterval) clearInterval(ibbCleanupInterval);
    whiteboardSessionManager.stopCleanup();
    whiteboardSessionManager.destroy();
    try { await safeXmppSend(xmpp, xml("presence", { type: "unavailable" })); } catch {}
    // SECURITY (2.1.4): on a dead or half-dead TCP socket,
    // `xmpp.stop()` -> `disconnect(timeout=30000)` hangs for
    // up to 30 seconds waiting for `socket.end()`'s FIN to be
    // ACKed.  When the framework's health-monitor is the
    // caller (auto-restart after a stale-socket detection),
    // this 30s hang delays the new `startAccount` call long
    // enough that the XMPP server's old session is still
    // alive, and the new connection comes up with the same
    // full JID -> `StreamError: conflict, 'Replaced by new
    // connection'` cycle.  We break the hang with a
    // `socket.destroy()` fast path.  This is safe: the
    // stream-close stanza is best-effort and the framework
    // has already decided to stop the plugin.
    try {
      const sock = findUnderlyingSocket(xmpp);
      if (sock && typeof sock.destroy === "function" && !sock.destroyed) {
        xmppLog.debug("stop: socket.destroy() fast path");
        sock.destroy();
      }
    } catch (destroyErr) {
      xmppLog.debug("stop: socket.destroy() fast path failed (ignored)", destroyErr);
    }
    // SECURITY (2.1.3, restore-old-design): no liveness manager
    // to clean up, no setUserInitiatedStop flag to set.  The
    // OLD design from D:\Downloads\xmppOLD just called
    // xmpp.stop() and let @xmpp/reconnect / the offline handler
    // do their thing.  The xmpp.stop() call is what triggers the
    // @xmpp/client 0.13.x library to emit the `offline` event
    // (which our offline handler above uses for cleanup).
    // @xmpp/reconnect's internal listener also fires on the
    // socket close, but since we're deliberately stopping it
    // doesn't try to reconnect (its `entity.status` check sees
    // we're closing).
    try { await xmpp.stop(); } catch (err) { log.error("xmpp.stop error", err); }
  };

  const shutdownSignals = ['SIGTERM', 'SIGINT', 'SIGUSR2'] as const;
  for (const signal of shutdownSignals) {
    process.on(signal, async () => {
      log.info(`Received ${signal}, shutting down`);
      await xmppClient.stop();
    });
  }

  return xmppClient;
}