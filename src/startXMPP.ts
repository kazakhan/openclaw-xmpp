import fs from "fs";
import path from "path";
import crypto from "crypto";
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

export async function startXmpp(cfg: any, contacts: any, log: any, onMessage: (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, roomSubject?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean, whiteboardData?: any, isSystemMessage?: boolean }) => void, onOnline?: (xmppClient: any) => void, onFileReceived?: (filePath: string, filename: string, from: string) => void) {
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
    
    // vCard server query helpers (parseVCard imported from vcard-protocol)

    const queryVCardFromServer = async (targetJid: string): Promise<any> => {
      const id = `vc-get-${Date.now()}`;
      let response: any = null;
      let error: any = null;
      
      const handler = (stanza: any) => {
        debugLog(`vCard query received stanza: id=${stanza.attrs.id}, type=${stanza.attrs.type}, from=${stanza.attrs.from}`);
        if (stanza.attrs.id === id && stanza.attrs.type === 'result') {
          response = stanza;
        }
      };
      
      xmpp.on('stanza', handler);
      
      try {
        // If targetJid is provided, query that user; otherwise query our own vCard (no 'to' address)
        const iqAttrs: any = { type: "get", id };
        if (targetJid) {
          iqAttrs.to = targetJid;
        }
        debugLog(`Querying vCard from ${targetJid || 'self'} with id ${id}`);
        await safeXmppSend(xmpp,xml("iq", iqAttrs, xml("vCard", { xmlns: "vcard-temp" })));
        // Wait for response
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        error = err;
        debugLog(`vCard query send error: ${err}`);
      } finally {
        xmpp.off('stanza', handler);
      }
      
      if (error) {
        debugLog(`vCard query error: ${error}`);
        return null;
      }
      
      if (response) {
        const vcardEl = response.getChild('vCard');
        xmppLog.debug("vCard query response received");
        if (vcardEl) {
          const data = parseVCard(vcardEl);
          debugLog(`vCard parsed: fn=${data.fn}, nickname=${data.nickname}, avatarUrl=${data.avatarUrl}`);
          return data;
        }
      }
      debugLog(`vCard query no response for ${targetJid || 'self'}`);
      return null;
    };
    
    const updateVCardOnServer = async (updates: any): Promise<boolean> => {
      // Get current vCard from server first
      const current = await queryVCardFromServer('');
      const merged = current ? { ...current, ...updates } : updates;
      
      const vcardId = `vc-set-${Date.now()}`;
      let responseReceived = false;
      let updateSuccess = false;
      
      // Wait for IQ response
      const handler = (stanza: any) => {
        xmppLog.debug("vCard update stanza", { id: stanza.attrs.id, type: stanza.attrs.type });
        if (stanza.attrs.id === vcardId) {
          if (stanza.attrs.type === 'result') {
            updateSuccess = true;
          } else if (stanza.attrs.type === 'error') {
            xmppLog.error("vCard update error");
          }
          responseReceived = true;
        }
      };
      
      xmpp.on('stanza', handler);
      
      const vcardSet = xml("iq", { type: "set", id: vcardId },
        xml("vCard", { xmlns: "vcard-temp" },
          merged.fn ? xml("FN", {}, merged.fn) : null,
          merged.nickname ? xml("NICKNAME", {}, merged.nickname) : null,
          merged.url ? xml("URL", {}, merged.url) : null,
          merged.desc ? xml("DESC", {}, merged.desc) : null,
          (merged.avatarBinval || merged.avatarUrl) ? xml("PHOTO", {}, 
            merged.avatarType ? xml("TYPE", {}, merged.avatarType) : null,
            merged.avatarBinval ? xml("BINVAL", {}, merged.avatarBinval) : null,
            merged.avatarUrl ? xml("EXTVAL", {}, merged.avatarUrl) : null
          ) : null
        )
      );
      
      try {
        xmppLog.debug("vCard update sending", { id: vcardId });
        await safeXmppSend(xmpp,vcardSet);
        
        // Wait for response with timeout
        let waited = 0;
        while (!responseReceived && waited < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waited += 100;
        }
        
        if (!responseReceived) {
          xmppLog.warn("vCard update timeout");
        }
        
        return updateSuccess;
      } catch (err) {
        xmppLog.error("vCard update send failed", err);
        return false;
      } finally {
        xmpp.off('stanza', handler);
      }
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
     const ibbSessions = new Map<string, { sid: string, from: string, filename: string, size: number, data: Buffer, received: number, createdAt: number }>(); // IBB session tracking

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
            
            // Check for supported stream methods
            const feature = si.getChild("feature", "http://jabber.org/protocol/feature-neg");
            let supportedMethod = null;
            if (feature) {
              const streamMethods = feature.getChildren("field");
              for (const field of streamMethods) {
                const method = field.getChildText("value");
                if (method === "http://jabber.org/protocol/ibb") {
                  supportedMethod = method;
                  break;
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
              const sid = si.attrs.sid;
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
              
               // Store IBB session - ensure from is a valid string
                const fromJid = typeof from === 'string' ? from : String(from);
                ibbSessions.set(sid, {
                  sid,
                  from: fromJid,
                  filename,
                  size,
                  data: Buffer.alloc(0),
                  received: 0,
                  createdAt: Date.now()
                });
              
              // Accept the SI request
              const acceptIq = xml("iq", { to: from, type: "result", id });
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
                 onFileReceived(filePath, session.filename, session.from);
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
                  onFileReceived(filePath, session.filename, session.from);
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
            xml("feature", { var: "http://jabber.org/protocol/bytestreams" }),
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
          
         // Check for slash commands (in both chat and groupchat)
        // Behavior:
        // - Groupchat: Only plugin commands are processed locally, others ignored (not forwarded to agents)
        // - Chat: Plugin commands handled locally, /help also forwarded to agent
        // - Chat non-plugin commands: Forwarded to agent only if sender is contact
        // Plugin commands: list, add, remove, admins, whoami, join, rooms, leave, invite, vcard, help
        if (body && body.startsWith('/')) {
           debugLog(`[SLASH] Command: ${body.substring(0, 100)}`);
          
          // Extract room and nick for groupchat
         const roomJid = messageType === "groupchat" ? from.split("/")[0] : null;
         const nick = messageType === "groupchat" ? from.split("/")[1] || "" : null;
         const botNick = roomJid ? roomNicks.get(roomJid) : null;
         
         // Parse command and arguments
          const parts = body?.trim()?.split(/\s+/) || [];
          const command = parts[0].substring(1).toLowerCase(); // Remove leading '/'
          const args = parts.slice(1);
          
          // Helper to send reply (works for both chat and groupchat)
          const sendReply = async (replyText: string) => {
            try {
              // For groupchat, send to room JID only (without nick)
              let toAddress = from;
              if (messageType === "groupchat") {
                if (roomJid) {
                  toAddress = roomJid;
                } else {
                  xmppLog.error("sendReply roomJid null", { from });
                }
              }
              xmppLog.debug("command reply", { to: toAddress, type: messageType, replyLength: replyText?.length });
              const message = xml("message", { type: messageType, to: toAddress }, xml("body", {}, replyText));
              await safeXmppSend(xmpp,message);
            } catch (err) {
              xmppLog.error("command reply send failed", err);
            }
          };
          
          // Rate limit check
          if (!checkRateLimit(fromBareJid)) {
            await sendReply("❌ Too many commands. Please wait before sending more.");
            return;
          }
        
          // Define plugin-specific commands
          const pluginCommands = new Set(['list', 'add', 'remove', 'admins', 'whoami', 'join', 'rooms', 'leave', 'invite', 'vcard', 'help', 'test']);
          const isPluginCommand = pluginCommands.has(command);
          
          debugLog(`[SLASH] type=${messageType}, cmd=/${command}, isPlugin=${isPluginCommand}`);
         
          // Groupchat handling: only process plugin commands, ignore others
          if (messageType === "groupchat") {
            if (!isPluginCommand) {
              debugLog(`Ignoring non-plugin slash command in groupchat: /${command}`);
              return; // DO NOT forward to agents
            }
          }
          
          // Chat handling: plugin commands handled locally, non-plugin forwarded if contact
          if (messageType === "chat") {
            if (isPluginCommand) {
              // Plugin command in chat - handle locally (except /help special case)
            } else {
              // Non-plugin command in chat - only forward if sender is contact
              if (await contacts.exists(fromBareJid)) {
                debugLog(`Forwarding non-plugin command /${command} to agent`);
                onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
              } else {
                debugLog(`Ignoring non-plugin slash command from non-contact: /${command}`);
                await sendReply(`❌ Unknown command: /${command}. You must be a contact to use bot commands.`);
              }
              return; // Stop further processing
            }
          }
        
         // Process plugin commands (both chat and groupchat)
         try {
           // Helper to check admin access (works differently for chat vs groupchat)
            const checkAdminAccess = async (): Promise<boolean> => {
              if (messageType === "chat") {
                return await contacts.isAdmin(fromBareJid);
             } else {
               // In groupchat, admin commands not available (can't verify user identity)
               return false;
             }
           };
           
           switch (command) {
             case 'help':
await sendReply(`Available commands (groupchat: only whoami, help):
  /list - Show contacts (admin only - direct chat)
  /add <jid> [name] - Add contact (admin only - direct chat)
  /remove <jid> - Remove contact (admin only - direct chat)
  /admins - List admins (admin only - direct chat)
  /whoami - Show your info (room/nick in groupchat)
  /join <room> [nick] - Join MUC room (admin only - direct chat)
  /rooms - List joined rooms (admin only - direct chat)
  /leave <room> - Leave MUC room (admin only - direct chat)
  /invite <contact> <room> - Invite contact to room (admin only - direct chat)
  /vcard - Manage vCard profile (admin only - direct chat)
  /help - Show this help`);
              
                // SPECIAL CASE: /help forwards to agent ONLY in direct chat (not groupchat)
                if (messageType === "chat" && await contacts.exists(fromBareJid)) {
                   debugLog(`Forwarding /help to agent`);
                   onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
                }
                // NO FORWARDING in groupchat - only local processing
               return; // Stop further processing
              
             case 'list':
               // Admin only - not available in groupchat
                if (!(await checkAdminAccess())) {
                  await sendReply(messageType === "groupchat" 
                    ? "❌ Admin commands not available in groupchat. Use direct message."
                    : "❌ Permission denied. Admin access required.");
                  return;
                }
               const contactList = await contacts.list();
              if (contactList.length === 0) {
                await sendReply("No contacts configured.");
              } else {
                const listText = contactList.map(c => `• ${c.jid} (${c.name})`).join('\n');
                await sendReply(`Contacts (${contactList.length}):\n${listText}`);
              }
              return;
              
             case 'add':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              if (args.length === 0) {
                await sendReply("Usage: /add <jid> [name]");
                return;
              }
               const jidToAdd = args[0];
               const nameToAdd = args[1] || jidToAdd.split('@')[0];
                const added = await contacts.add(jidToAdd, nameToAdd);
               if (added) {
                 await sendReply(`✅ Added contact: ${jidToAdd} (${nameToAdd})`);
                 // Send subscription request to new contact
                 try {
                    const subscribe = xml("presence", { to: jidToAdd, type: "subscribe" });
                    await safeXmppSend(xmpp,subscribe);
                  } catch (err) {
                    xmppLog.error("subscription send failed", err);
                 }
               } else {
                 await sendReply(`❌ Failed to add contact: ${jidToAdd}`);
               }
               return;
              
             case 'remove':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              if (args.length === 0) {
                await sendReply("Usage: /remove <jid>");
                return;
              }
              const jidToRemove = args[0];
               const removed = await contacts.remove(jidToRemove);
              if (removed) {
                await sendReply(`✅ Removed contact: ${jidToRemove}`);
              } else {
                await sendReply(`❌ Contact not found: ${jidToRemove}`);
              }
              return;
              
             case 'admins':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
               const adminList = await contacts.listAdmins();
              if (adminList.length === 0) {
                await sendReply("No admins configured.");
              } else {
                const listText = adminList.map(jid => `• ${jid}`).join('\n');
                await sendReply(`Admins (${adminList.length}):\n${listText}`);
              }
              return;
              
             case 'whoami':
               if (messageType === "groupchat") {
                 // In groupchat, show room and nick info
                 const roomJid = from.split("/")[0];
                 const nick = from.split("/")[1] || "";
                 const botNick = roomNicks.get(roomJid);
                 await sendReply(`Room: ${roomJid}\nNick: ${nick}\nBot nick: ${botNick || "Not joined"}`);
               } else {
                 // In direct chat, show JID-based info
                  const isAdmin = await contacts.isAdmin(fromBareJid);
                  const isContact = await contacts.exists(fromBareJid);
                 await sendReply(`JID: ${fromBareJid}\nAdmin: ${isAdmin ? '✅ Yes' : '❌ No'}\nContact: ${isContact ? '✅ Yes' : '❌ No'}`);
               }
               return;
              
             case 'join':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              if (args.length === 0) {
                await sendReply("Usage: /join <room> [nick]");
                return;
              }
              try {
                const roomRaw = args[0];
                const nick = args[1] || await getDefaultNick();
                const room = resolveRoomJid(roomRaw);
                
                // MUC protocol presence with muc namespace
                const presence = xml("presence", { to: `${room}/${nick}` },
                  xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                    xml("history", { maxstanzas: "0" })
                  )
                );
                await safeXmppSend(xmpp,presence);
                joinedRooms.add(room);
                roomNicks.set(room, nick);
                log.info("room joined", { room, nick });
                await sendReply(`✅ Joined room: ${room} as ${nick}`);
              } catch (err) {
                xmppLog.error("join room failed", err);
                await sendReply(`❌ Failed to join room. Please check the room address and try again.`);
              }
              return;
              
             case 'rooms':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              const rooms = Array.from(joinedRooms);
              if (rooms.length === 0) {
                await sendReply("Not currently joined to any rooms. Use /join <room> to join a room.");
              } else {
                const roomList = rooms.map(room => `• ${room}`).join('\n');
                await sendReply(`Currently joined to ${rooms.length} room(s):\n${roomList}`);
              }
              return;
              
             case 'leave':
               // Admin only - not available in groupchat
               if (!(await checkAdminAccess())) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              if (args.length === 0) {
                await sendReply("Usage: /leave <room>");
                return;
              }
              try {
                const roomRaw = args[0];
                const room = resolveRoomJid(roomRaw);
                const nick = await getDefaultNick();
                const presence = xml("presence", { to: `${room}/${nick}`, type: "unavailable" });
                await safeXmppSend(xmpp,presence);
                joinedRooms.delete(room);
                roomNicks.delete(room);
                log.info("room left", { room });
                await sendReply(`✅ Left room: ${room}`);
              } catch (err) {
                xmppLog.error("leave room failed", err);
                const room = resolveRoomJid(args[0]);
                joinedRooms.delete(room); // Still remove from tracking since we attempted to leave
                roomNicks.delete(room);
                await sendReply(`❌ Failed to leave room. Please try again.`);
              }
                return;

              case 'vcard':
                 // vCard management
                 if (!(await checkAdminAccess())) {
                   await sendReply(messageType === 'groupchat' 
                     ? '❌ Admin commands not available in groupchat. Use direct message.'
                     : '❌ Permission denied. Admin access required.');
                   return;
                  }
                  if (args.length === 0 || args[0] === 'help') {
                      await sendReply(`vCard commands:
    /vcard help - Show this help
    /vcard get - Show current vCard (from server)
    /vcard get <jid> - Show vCard for any user
    /vcard set fn <value> - Set Full Name
    /vcard set nickname <value> - Set Nickname
    /vcard set url <value> - Set URL
    /vcard set desc <value> - Set Description
    /vcard set birthday <YYYY-MM-DD> - Set Birthday
    /vcard set title <value> - Set Job Title
    /vcard set role <value> - Set Job Role
    /vcard set timezone <value> - Set Timezone
    /vcard set avatar <url> - Upload image from URL as avatar
    /vcard set avatar - Upload attached image as avatar
    /vcard name <family> <given> [middle] [prefix] [suffix] - Set structured name
    /vcard phone add <number> [type...] - Add phone (home work voice fax cell)
    /vcard phone remove <index> - Remove phone by index
    /vcard email add <address> [type...] - Add email (home work internet pref)
    /vcard email remove <index> - Remove email by index
    /vcard address add <street> <city> <region> <postal> <country> [type] - Add address
    /vcard address remove <index> - Remove address by index
    /vcard org <orgname> [orgunit...] - Set organization`);
                      return;
                    }
                 const subcmd = args[0].toLowerCase();
                 
                  if (subcmd === 'get') {
                    if (args.length >= 2) {
                      const targetJid = args[1];
                      const userVCard = await queryVCardFromServer(targetJid);
                      if (userVCard) {
                        let info = `vCard for ${targetJid}:
  FN: ${userVCard.fn || '(not set)'}`;
                        if (userVCard.n) {
                          info += `\n  Name: ${[userVCard.n.prefix, userVCard.n.given, userVCard.n.middle, userVCard.n.family, userVCard.n.suffix].filter(Boolean).join(' ') || '(not set)'}`;
                        }
                        info += `\n  Nickname: ${userVCard.nickname || '(not set)'}`;
                        info += `\n  Birthday: ${userVCard.bday || '(not set)'}`;
                        info += `\n  Title: ${userVCard.title || '(not set)'}`;
                        info += `\n  Role: ${userVCard.role || '(not set)'}`;
                        info += `\n  Timezone: ${userVCard.tz || '(not set)'}`;
                        info += `\n  URL: ${userVCard.url || '(not set)'}`;
                        info += `\n  Desc: ${userVCard.desc || '(not set)'}`;
                        info += `\n  Avatar URL: ${userVCard.avatarUrl || '(not set)'}`;
                        if (userVCard.tel && userVCard.tel.length > 0) {
                          info += `\n  Phone Numbers:`;
                          userVCard.tel.forEach((p, i) => info += `\n    ${i + 1}. ${p.number} (${p.types.join(', ') || 'default'})`);
                        }
                        if (userVCard.email && userVCard.email.length > 0) {
                          info += `\n  Emails:`;
                          userVCard.email.forEach((e, i) => info += `\n    ${i + 1}. ${e.userid} (${e.types.join(', ') || 'default'})`);
                        }
                        if (userVCard.adr && userVCard.adr.length > 0) {
                          info += `\n  Addresses:`;
                          userVCard.adr.forEach((a, i) => {
                            const parts = [a.street, a.locality, a.region, a.pcode, a.ctry].filter(Boolean);
                            info += `\n    ${i + 1}. ${parts.join(', ')} (${a.types.join(', ') || 'default'})`;
                          });
                        }
                        if (userVCard.org) {
                          info += `\n  Organization: ${userVCard.org.orgname || '(not set)'}${userVCard.org.orgunit ? ' (' + userVCard.org.orgunit.join(', ') + ')' : ''}`;
                        }
                        await sendReply(info);
                      } else {
                        await sendReply(`❌ No vCard found for ${targetJid}`);
                      }
                    } else {
                      const botVCard = await queryVCardFromServer('');
                      if (botVCard) {
                        let info = `vCard (from server):
  FN: ${botVCard.fn || '(not set)'}`;
                        if (botVCard.n) {
                          info += `\n  Name: ${[botVCard.n.prefix, botVCard.n.given, botVCard.n.middle, botVCard.n.family, botVCard.n.suffix].filter(Boolean).join(' ') || '(not set)'}`;
                        }
                        info += `\n  Nickname: ${botVCard.nickname || '(not set)'}`;
                        info += `\n  Birthday: ${botVCard.bday || '(not set)'}`;
                        info += `\n  Title: ${botVCard.title || '(not set)'}`;
                        info += `\n  Role: ${botVCard.role || '(not set)'}`;
                        info += `\n  Timezone: ${botVCard.tz || '(not set)'}`;
                        info += `\n  URL: ${botVCard.url || '(not set)'}`;
                        info += `\n  Desc: ${botVCard.desc || '(not set)'}`;
                        info += `\n  Avatar URL: ${botVCard.avatarUrl || '(not set)'}`;
                        if (botVCard.tel && botVCard.tel.length > 0) {
                          info += `\n  Phone Numbers:`;
                          botVCard.tel.forEach((p, i) => info += `\n    ${i + 1}. ${p.number} (${p.types.join(', ') || 'default'})`);
                        }
                        if (botVCard.email && botVCard.email.length > 0) {
                          info += `\n  Emails:`;
                          botVCard.email.forEach((e, i) => info += `\n    ${i + 1}. ${e.userid} (${e.types.join(', ') || 'default'})`);
                        }
                        if (botVCard.adr && botVCard.adr.length > 0) {
                          info += `\n  Addresses:`;
                          botVCard.adr.forEach((a, i) => {
                            const parts = [a.street, a.locality, a.region, a.pcode, a.ctry].filter(Boolean);
                            info += `\n    ${i + 1}. ${parts.join(', ')} (${a.types.join(', ') || 'default'})`;
                          });
                        }
                        if (botVCard.org) {
                          info += `\n  Organization: ${botVCard.org.orgname || '(not set)'}${botVCard.org.orgunit ? ' (' + botVCard.org.orgunit.join(', ') + ')' : ''}`;
                        }
                        await sendReply(info);
                      } else {
                        await sendReply(`❌ Failed to retrieve vCard from server`);
                      }
                    }
                    return;
                   } else if (subcmd === 'set') {
                     if (args.length < 2) {
                       await sendReply('Usage: /vcard set <field> <value>\nFor avatar: /vcard set avatar <url> or attach an image and use /vcard set avatar');
                       return;
                     }
                     const field = args[1].toLowerCase();
                     
                     // Handle avatar upload
                     if (field === 'avatar') {
                       let filePath: string;
                       
                       // Check if URL was provided as argument
                       if (args.length >= 3) {
                        const url = args.slice(2).join(' ');
                        xmppLog.debug("avatar", { action: "url-provided" });
                         
                         // Download the file from URL
                         try {
                           const tempDir = path.join(cfg.dataDir, 'downloads');
                           if (!fs.existsSync(tempDir)) {
                             fs.mkdirSync(tempDir, { recursive: true });
                           }
                           
                           // Validate URL
                           if (!validators.isValidUrl(url)) {
                             await sendReply('❌ Invalid URL provided');
                             return;
                           }
                           
                           // Download file
                           const response = await fetch(url);
                           if (!response.ok) {
                             throw new Error(`Download failed: ${response.status} ${response.statusText}`);
                           }
                           
                           const contentLength = response.headers.get('content-length');
                           if (contentLength) {
                             const fileSize = parseInt(contentLength, 10);
                             if (fileSize > MAX_FILE_SIZE) {
                               throw new Error(`File too large: ${fileSize} bytes`);
                             }
                           }
                           
                           const buffer = await response.arrayBuffer();
                           if (buffer.byteLength > MAX_FILE_SIZE) {
                             throw new Error(`File too large: ${buffer.byteLength} bytes`);
                           }
                           
                           // Generate safe filename
                           const urlObj = new URL(url);
                           let filename = path.basename(urlObj.pathname) || `avatar_${Date.now()}.jpg`;
                           filename = validators.sanitizeFilename(filename);
                           if (!validators.isSafePath(filename, tempDir)) {
                             filename = `avatar_${Date.now()}.jpg`;
                           }
                           
                            filePath = path.join(tempDir, filename);
                            await fs.promises.writeFile(filePath, Buffer.from(buffer));
                          } catch (err) {
                            xmppLog.error("avatar download failed", err);
                           await sendReply(`❌ Failed to download image: ${err instanceof Error ? err.message : 'Unknown error'}`);
                           return;
                         }
                        } else if (mediaPaths.length > 0) {
                          // Use attached file
                          filePath = mediaPaths[0];
                       } else {
                         await sendReply('❌ No image URL or attachment provided.\nUsage: /vcard set avatar <url>\nOr attach an image and use /vcard set avatar');
                         return;
                       }
                       
                         try {
                           // Get file info for XEP-0084 metadata
                           const stats = await fs.promises.stat(filePath);
                           const size = stats.size;
                           
                           // Determine URL to use
                           let imageUrl: string;
                           if (args.length >= 3) {
                             // User provided URL
                             imageUrl = args.slice(2).join(' ');
                           } else {
                             // For attached files, we need to upload via XEP-0363
                              const filename = path.basename(filePath);
                              xmppLog.debug("avatar", { action: "uploading", filename, size });
                              const slot = await requestUploadSlot(filename, size);
                              await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
                              imageUrl = slot.getUrl;
                           }
                           
                            // Step 1: Publish via XEP-0084 User Avatar
                             const avatarPublished = await publishAvatar(filePath, imageUrl);
                             
                             // Step 2: Update vCard with embedded base64 avatar (BINVAL) - this is what clients expect
                             const fileBuffer = await fs.promises.readFile(filePath);
                            const base64Data = fileBuffer.toString('base64');
                            const ext = path.extname(filePath).toLowerCase();
                            let mimeType = 'image/jpeg';
                            if (ext === '.png') mimeType = 'image/png';
                            else if (ext === '.gif') mimeType = 'image/gif';
                            else if (ext === '.webp') mimeType = 'image/webp';
                            
                            const updates = { 
                               avatarUrl: imageUrl,
                               avatarBinval: base64Data,
                               avatarType: mimeType
                             };
                             const vcardUpdated = await updateVCardOnServer(updates);
                           
                           // Report results
                            if (avatarPublished && vcardUpdated) {
                              await vcard.setAvatarUrl(imageUrl);
                              await sendReply(`✅ Avatar updated successfully!\n\nXEP-0084 (PEP): Published\nvCard (XEP-0054): Updated\nURL: ${imageUrl}`);
                            } else if (avatarPublished) {
                              await vcard.setAvatarUrl(imageUrl);
                              await sendReply(`✅ XEP-0084 avatar published!\n⚠️ vCard update failed (non-critical)\nURL: ${imageUrl}`);
                            } else if (vcardUpdated) {
                              await vcard.setAvatarUrl(imageUrl);
                              await sendReply(`✅ vCard avatar updated!\n⚠️ XEP-0084 publish failed (non-critical)\nURL: ${imageUrl}`);
                           } else {
                             await sendReply(`❌ Failed to publish avatar`);
                           }
                          } catch (err) {
                            xmppLog.error("avatar upload failed", err);
                           await sendReply(`❌ Failed to upload avatar: ${err instanceof Error ? err.message : 'Unknown error'}`);
                         }
                        return;
                     }
                    
                    // For other fields, require a value
                    if (args.length < 3) {
                      await sendReply('Usage: /vcard set <field> <value>\nSimple fields: fn, nickname, url, desc, birthday, title, role, timezone');
                      return;
                    }
                    
                    const value = args.slice(2).join(' ');
                    
                    // Validate field
                    if (!['fn', 'nickname', 'url', 'desc', 'birthday', 'title', 'role', 'timezone'].includes(field)) {
                      await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, birthday, title, role, timezone, avatar`);
                      return;
                    }
                    
                    // Update server vCard
                    const updates: any = {};
                    if (field === 'fn') updates.fn = value;
                    if (field === 'nickname') updates.nickname = value;
                    if (field === 'url') updates.url = value;
                    if (field === 'desc') updates.desc = value;
                    if (field === 'birthday') updates.bday = value;
                    if (field === 'title') updates.title = value;
                    if (field === 'role') updates.role = value;
                    if (field === 'timezone') updates.tz = value;
                    
                    const success = await updateVCardOnServer(updates);
                    
                      if (success) {
                       if (field === 'fn') await vcard.setFN(value);
                       if (field === 'nickname') await vcard.setNickname(value);
                       if (field === 'url') await vcard.setUrl(value);
                       if (field === 'desc') await vcard.setDesc(value);
                       if (field === 'birthday') await vcard.setBday(value);
                       if (field === 'title') await vcard.setTitle(value);
                       if (field === 'role') await vcard.setRole(value);
                       if (field === 'timezone') await vcard.setTz(value);
                      
                      await sendReply(`✅ vCard field '${field}' updated on server: ${value}`);
                    } else {
                       await sendReply(`❌ Failed to update vCard on server`);
                    }
                    return;
                  } else if (subcmd === 'name') {
                    // /vcard name <family> <given> [middle] [prefix] [suffix]
                    if (args.length < 3) {
                      await sendReply('Usage: /vcard name <family> <given> [middle] [prefix] [suffix]\nExample: /vcard name Smith John David Mr.');
                      return;
                    }
                    const family = args[1];
                    const given = args[2];
                    const middle = args[3];
                    const prefix = args[4];
                    const suffix = args[5];
                    
                    try {
                      const current = await queryVCardFromServer('');
                      const merged = current || {};
                      merged.n = { family, given, middle, prefix, suffix };
                      
                      const vcardId = `vc-name-${Date.now()}`;
                      let responseReceived = false;
                      let updateSuccess = false;
                      
                      const handler = (stanza: any) => {
                        if (stanza.attrs.id === vcardId && stanza.attrs.type === 'result') {
                          updateSuccess = true;
                        }
                        if (stanza.attrs.id === vcardId) {
                          responseReceived = true;
                        }
                      };
                      xmpp.on('stanza', handler);
                      
                      const vcardSet = xml("iq", { type: "set", id: vcardId },
                        xml("vCard", { xmlns: "vcard-temp" },
                          merged.fn ? xml("FN", {}, merged.fn) : null,
                          xml("N", {},
                            merged.n.family ? xml("FAMILY", {}, merged.n.family) : null,
                            merged.n.given ? xml("GIVEN", {}, merged.n.given) : null,
                            merged.n.middle ? xml("MIDDLE", {}, merged.n.middle) : null,
                            merged.n.prefix ? xml("PREFIX", {}, merged.n.prefix) : null,
                            merged.n.suffix ? xml("SUFFIX", {}, merged.n.suffix) : null
                          ),
                          merged.nickname ? xml("NICKNAME", {}, merged.nickname) : null
                        )
                      );
                      
                      await safeXmppSend(xmpp,vcardSet);
                      let waited = 0;
                      while (!responseReceived && waited < 5000) {
                        await new Promise(r => setTimeout(r, 100));
                        waited += 100;
                      }
                      xmpp.off('stanza', handler);
                      
                      if (updateSuccess) {
                        await vcard.setNameComponents(family, given, middle, prefix, suffix);
                        const nameStr = [prefix, given, middle, family, suffix].filter(Boolean).join(' ').trim();
                        await sendReply(`✅ vCard name updated: ${nameStr}`);
                      } else {
                        await sendReply(`❌ Failed to update vCard name on server`);
                      }
                    } catch (err) {
                      await sendReply(`❌ Error updating vCard name: ${err instanceof Error ? err.message : 'Unknown error'}`);
                    }
                    return;
                  } else if (subcmd === 'phone') {
                    // /vcard phone add <number> [type...]
                    // /vcard phone remove <index>
                    if (args.length < 2) {
                      await sendReply('Usage:\n  /vcard phone add <number> [type...]\n  /vcard phone remove <index>\nTypes: home work voice fax cell video pager msg');
                      return;
                    }
                    const phoneCmd = args[1].toLowerCase();
                    
                    if (phoneCmd === 'add') {
                      if (args.length < 3) {
                        await sendReply('Usage: /vcard phone add <number> [type...]\nExample: /vcard phone add +1234567890 cell work');
                        return;
                      }
                      const number = args[2];
                      const types: string[] = [];
                      for (let i = 3; i < args.length; i++) {
                        const t = args[i].toUpperCase();
                        if (['HOME', 'WORK', 'VOICE', 'FAX', 'CELL', 'VIDEO', 'PAGER', 'MSG'].includes(t)) {
                          types.push(t);
                        }
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        const merged = current || {};
                        if (!merged.tel) merged.tel = [];
                        merged.tel.push({ types: types.length > 0 ? types : ['HOME'], number });
                        
                        const success = await updateVCardOnServer({ tel: merged.tel });
                        if (success) {
                          await vcard.setTel(merged.tel);
                          await sendReply(`✅ Phone added: ${number} (${types.join(', ') || 'default'})`);
                        } else {
                          await sendReply(`❌ Failed to add phone on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error adding phone: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else if (phoneCmd === 'remove') {
                      const idx = parseInt(args[2]) - 1;
                      if (isNaN(idx)) {
                        await sendReply('Usage: /vcard phone remove <index>\nUse /vcard get to see phone indices');
                        return;
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        if (!current || !current.tel || !current.tel[idx]) {
                          await sendReply(`❌ No phone at index ${idx + 1}`);
                          return;
                        }
                        const removed = current.tel.splice(idx, 1)[0];
                        
                        const success = await updateVCardOnServer({ tel: current.tel });
                        if (success) {
                          await vcard.setTel(current.tel);
                          await sendReply(`✅ Phone removed: ${removed.number}`);
                        } else {
                          await sendReply(`❌ Failed to remove phone on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error removing phone: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else {
                      await sendReply('Usage:\n  /vcard phone add <number> [type...]\n  /vcard phone remove <index>');
                    }
                    return;
                  } else if (subcmd === 'email') {
                    // /vcard email add <address> [type...]
                    // /vcard email remove <index]
                    if (args.length < 2) {
                      await sendReply('Usage:\n  /vcard email add <address> [type...]\n  /vcard email remove <index>\nTypes: home work internet pref');
                      return;
                    }
                    const emailCmd = args[1].toLowerCase();
                    
                    if (emailCmd === 'add') {
                      if (args.length < 3) {
                        await sendReply('Usage: /vcard email add <address> [type...]\nExample: /vcard email add john@example.com work');
                        return;
                      }
                      const userid = args[2];
                      const types: string[] = [];
                      for (let i = 3; i < args.length; i++) {
                        const t = args[i].toUpperCase();
                        if (['HOME', 'WORK', 'INTERNET', 'PREF'].includes(t)) {
                          types.push(t);
                        }
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        const merged = current || {};
                        if (!merged.email) merged.email = [];
                        merged.email.push({ types: types.length > 0 ? types : ['INTERNET'], userid });
                        
                        const success = await updateVCardOnServer({ email: merged.email });
                        if (success) {
                          await vcard.setEmail(merged.email);
                          await sendReply(`✅ Email added: ${userid} (${types.join(', ') || 'default'})`);
                        } else {
                          await sendReply(`❌ Failed to add email on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error adding email: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else if (emailCmd === 'remove') {
                      const idx = parseInt(args[2]) - 1;
                      if (isNaN(idx)) {
                        await sendReply('Usage: /vcard email remove <index>\nUse /vcard get to see email indices');
                        return;
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        if (!current || !current.email || !current.email[idx]) {
                          await sendReply(`❌ No email at index ${idx + 1}`);
                          return;
                        }
                        const removed = current.email.splice(idx, 1)[0];
                        
                        const success = await updateVCardOnServer({ email: current.email });
                        if (success) {
                          await vcard.setEmail(current.email);
                          await sendReply(`✅ Email removed: ${removed.userid}`);
                        } else {
                          await sendReply(`❌ Failed to remove email on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error removing email: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else {
                      await sendReply('Usage:\n  /vcard email add <address> [type...]\n  /vcard email remove <index>');
                    }
                    return;
                  } else if (subcmd === 'address') {
                    // /vcard address add <street> <city> <region> <postal> <country> [type]
                    // /vcard address remove <index>
                    if (args.length < 2) {
                      await sendReply('Usage:\n  /vcard address add <street> <city> <region> <postal> <country> [type]\n  /vcard address remove <index>\nTypes: home work postal parcel');
                      return;
                    }
                    const addrCmd = args[1].toLowerCase();
                    
                    if (addrCmd === 'add') {
                      if (args.length < 7) {
                        await sendReply('Usage: /vcard address add <street> <city> <region> <postal> <country> [type]\nExample: /vcard address add "123 Main St" Boston MA 02101 USA home');
                        return;
                      }
                      const street = args[2];
                      const locality = args[3];
                      const region = args[4];
                      const pcode = args[5];
                      const ctry = args[6];
                      const types: string[] = [];
                      if (args[7]) {
                        const t = args[7].toUpperCase();
                        if (['HOME', 'WORK', 'POSTAL', 'PARCEL'].includes(t)) {
                          types.push(t);
                        }
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        const merged = current || {};
                        if (!merged.adr) merged.adr = [];
                        merged.adr.push({ types: types.length > 0 ? types : ['HOME'], street, locality, region, pcode, ctry });
                        
                        const success = await updateVCardOnServer({ adr: merged.adr });
                        if (success) {
                          await vcard.setAdr(merged.adr);
                          await sendReply(`✅ Address added: ${street}, ${locality}, ${region} ${pcode}, ${ctry} (${types.join(', ') || 'default'})`);
                        } else {
                          await sendReply(`❌ Failed to add address on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error adding address: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else if (addrCmd === 'remove') {
                      const idx = parseInt(args[2]) - 1;
                      if (isNaN(idx)) {
                        await sendReply('Usage: /vcard address remove <index>\nUse /vcard get to see address indices');
                        return;
                      }
                      
                      try {
                        const current = await queryVCardFromServer('');
                        if (!current || !current.adr || !current.adr[idx]) {
                          await sendReply(`❌ No address at index ${idx + 1}`);
                          return;
                        }
                        const removed = current.adr.splice(idx, 1)[0];
                        const parts = [removed.street, removed.locality, removed.region, removed.pcode, removed.ctry].filter(Boolean);
                        
                        const success = await updateVCardOnServer({ adr: current.adr });
                        if (success) {
                          await vcard.setAdr(current.adr);
                          await sendReply(`✅ Address removed: ${parts.join(', ')}`);
                        } else {
                          await sendReply(`❌ Failed to remove address on server`);
                        }
                      } catch (err) {
                        await sendReply(`❌ Error removing address: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      }
                    } else {
                      await sendReply('Usage:\n  /vcard address add <street> <city> <region> <postal> <country> [type]\n  /vcard address remove <index>');
                    }
                    return;
                  } else if (subcmd === 'org') {
                    // /vcard org <orgname> [orgunit...]
                    if (args.length < 2) {
                      await sendReply('Usage: /vcard org <orgname> [orgunit...]\nExample: /vcard org "Acme Inc" Engineering Sales');
                      return;
                    }
                    const orgname = args[1];
                    const orgunits = args.slice(2);
                    
                    try {
                      const current = await queryVCardFromServer('');
                      const merged = current || {};
                      merged.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };
                      
                      const success = await updateVCardOnServer({ org: merged.org });
                      if (success) {
                        vcard.setOrgComponents(orgname, ...orgunits);
                        const orgStr = orgname + (orgunits.length > 0 ? ` (${orgunits.join(', ')})` : '');
                        await sendReply(`✅ Organization updated: ${orgStr}`);
                      } else {
                        await sendReply(`❌ Failed to update organization on server`);
                      }
                    } catch (err) {
                      await sendReply(`❌ Error updating organization: ${err instanceof Error ? err.message : 'Unknown error'}`);
                    }
                    return;
                  } else {
                    await sendReply(`Unknown vCard subcommand: ${subcmd}. Use /vcard help for available commands.`);
                    return;
                  }

                case 'test':
                   // Test commands for debugging
                   if (args.length === 0) {
                     await sendReply(`Test commands:
  /test upload <url> - Test XEP-0363 HTTP File Upload`);
                     return;
                   }
                   
                   const testCmd = args[0].toLowerCase();
                   if (testCmd === 'upload' && args.length >= 2) {
                     const url = args.slice(1).join(' ');
                     await sendReply(`🧪 Testing XEP-0363 upload with: ${url}`);
                     
                     try {
                       // Download file
                       const tempDir = path.join(cfg.dataDir, 'downloads');
                       if (!fs.existsSync(tempDir)) {
                         fs.mkdirSync(tempDir, { recursive: true });
                       }
                       
                       const response = await fetch(url);
                       if (!response.ok) {
                         throw new Error(`Download failed: ${response.status}`);
                       }
                       
                       const buffer = await response.arrayBuffer();
                       const urlObj = new URL(url);
                       let filename = path.basename(urlObj.pathname) || 'test_file.jpg';
                       filename = validators.sanitizeFilename(filename);
                       const filePath = path.join(tempDir, filename);
                       
                       await fs.promises.writeFile(filePath, Buffer.from(buffer));
                       const size = buffer.byteLength;
                       
                       await sendReply(`📥 Downloaded ${filename} (${size} bytes)`);
                       
                       // Request upload slot
                       await sendReply(`📤 Requesting upload slot from server...`);
                       const slot = await requestUploadSlot(filename, size);
                       
                       await sendReply(`✅ Got slot:\nPUT: ${slot.putUrl.substring(0, 60)}...\nGET: ${slot.getUrl.substring(0, 60)}...`);
                       
                       // Upload file
                       await sendReply(`⬆️ Uploading file...`);
                       await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
                       
                       await sendReply(`✅ XEP-0363 upload successful!\nFile URL: ${slot.getUrl}`);
                      } catch (err) {
                        xmppLog.error("test upload failed", err);
                       await sendReply(`❌ Upload test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
                     }
                   } else {
                     await sendReply(`Usage: /test upload <url>`);
                   }
                   return;

                 default:
                // Should not reach here for non-plugin commands (handled earlier)
                await sendReply(`Unknown command: /${command}. Type /help for available commands.`);
                return;
          }
        } catch (err) {
          xmppLog.error("slash command error", err);
           try {
             let toAddress = from;
             if (messageType === "groupchat" && roomJid) {
               toAddress = roomJid;
             }
             await safeXmppSend(xmpp,xml("message", { type: messageType, to: toAddress }, xml("body", {}, "❌ Error processing command.")));
           } catch {}
        }
        
        // If we processed a plugin command, return (don't forward to normal processing)
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

   // HTTP File Upload (XEP-0363) helpers -- delegated to upload-protocol.ts

   let uploadServiceJid: string | null = null;

   const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}> => {
     return requestUploadSlotShared(xmpp, cfg.domain, filename, size, contentType, uploadServiceJid);
   };

   const _uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
     return uploadFileViaHTTP(filePath, putUrl, headers);
   };

   const _sendFileWithHTTPUpload = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
     return sendFileWithHTTPUpload(xmpp, to, filePath, cfg.domain, text, isGroupChat, cfg.dataDir || path.join(process.cwd(), 'data'), uploadServiceJid);
   };

     // SI File Transfer (XEP-0096) helpers (fallback)
    const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
        debugLog(`Attempting SI file transfer to ${to}`);
        const filename = path.basename(filePath);

        const downloadsDir = path.join(cfg.dataDir || path.join(process.cwd(), 'data'), 'downloads');
        if (!fs.existsSync(downloadsDir)) {
          fs.mkdirSync(downloadsDir, { recursive: true });
        }
        const localPath = path.join(downloadsDir, filename);
        try {
          await fs.promises.copyFile(filePath, localPath);
          debugLog(`File saved locally to: ${localPath}`);
        } catch (copyErr) {
          xmppLog.error("SI fallback save failed", copyErr);
        }

         const message = `[File: ${filename}] ${text || ''}`;
         const msgEl = xml("message", { type: isGroupChat ? "groupchat" : "chat", to }, xml("body", {}, message));
         await safeXmppSend(xmpp,msgEl);
      };

    // XEP-0084: User Avatar helpers
    const publishAvatar = async (filePath: string, imageUrl: string): Promise<boolean> => {
      try {
        // Read file and calculate hash
        const fileBuffer = await fs.promises.readFile(filePath);
        const hash = crypto.createHash('sha1').update(fileBuffer).digest('hex');
        const size = fileBuffer.length;
        
        // Detect MIME type from extension
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = 'image/jpeg';
        if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.webp') mimeType = 'image/webp';
         
         xmppLog.debug("avatar", { action: "publishing", size, type: mimeType });
        
        // Publish metadata to pubsub (XEP-0084) - MUST include 'to' with bare JID for PEP
        const bareJid = cfg.jid.split('/')[0];
        
        // First, retract any existing avatar (optional but good practice)
        const retractId = `avatar-retract-${Date.now()}`;
        const retractStanza = xml("iq", { type: "set", to: bareJid, id: retractId },
          xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
            xml("retract", { node: "urn:xmpp:avatar:metadata" },
              xml("item", { id: hash })
            )
          )
        );
        
        // Publish metadata
        const metadataId = `avatar-meta-${Date.now()}`;
        const metadataStanza = xml("iq", { type: "set", to: bareJid, id: metadataId },
          xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
            xml("publish", { node: "urn:xmpp:avatar:metadata" },
              xml("item", { id: hash },
                xml("metadata", { xmlns: "urn:xmpp:avatar:metadata" },
                  xml("info", { 
                    bytes: size.toString(), 
                    id: hash, 
                    type: mimeType
                  })
                )
              )
            )
          )
        );
        
        await safeXmppSend(xmpp,metadataStanza);
         
         // Also publish the actual avatar data for clients that support XEP-0084 natively
        const dataId = `avatar-data-${Date.now()}`;
        const base64Data = fileBuffer.toString('base64');
        const dataStanza = xml("iq", { type: "set", to: bareJid, id: dataId },
          xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
            xml("publish", { node: "urn:xmpp:avatar:data" },
              xml("item", { id: hash },
                xml("data", { xmlns: "urn:xmpp:avatar:data" }, base64Data)
              )
            )
          )
        );
        
        await safeXmppSend(xmpp,dataStanza);
         
         return true;
      } catch (err) {
        xmppLog.error("PEP avatar publish failed", err);
        return false;
      }
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
         xmppLog.debug("fileTransfer", { action: "send", to, file: filePath });
         try {
           // First try HTTP Upload
            await sendFileWithHTTPUpload(xmpp, to, filePath, cfg.domain, text, isGroupChat);
           return true;
          } catch (httpErr) {
            xmppLog.debug("fileTransfer", { action: "fallback-to-si" });
            try {
              await sendFileWithSITransfer(to, filePath, text, isGroupChat);
              return true;
            } catch (siErr) {
              xmppLog.error("all transfer methods failed", siErr);
             throw new Error(`File transfer failed: ${httpErr.message}, ${siErr.message}`);
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