import path from "path";
import fs from "fs";
import crypto from "crypto";
import { log } from "./lib/logger.js";
import { debugLog } from "./shared/index.js";
import { MessageStore } from "./messageStore.js";
import { parseSvgPathCommands, buildSxePathEdits, sxeEditsToXml, getAvailableRidPrefix } from "./whiteboard.js";
import { safeSend } from "./lib/xmpp-utils.js";
import { xml } from "@xmpp/client";

import type { GatewayContext as GatewayContextType, XmppClient, PluginRuntime } from "./types.js";

export { type GatewayContext } from "./types.js";

interface LifecycleDeps {
  xmppClients: Map<string, XmppClient>;
  contactsStore: Map<string, any>;
  getPluginRuntime: () => PluginRuntime | null;
}

interface LifecycleServices {
  startXmpp: (config: any, contacts: any, logger: any, onMessage: any, onOnline?: any, onFileReceived?: any) => Promise<XmppClient>;
  Contacts: new (dataDir: string) => any;
  MessageStore: new (dataDir: string) => any;
}

interface QueueFns {
  addToQueue(message: Omit<any, 'id' | 'timestamp' | 'processed'>, dataDir?: string): string;
  markAsProcessed(messageId: string, dataDir?: string): void;
}

export class GatewayLifecycle {
  constructor(
    private deps: LifecycleDeps,
    private services: LifecycleServices,
    private queue: QueueFns
  ) {}

  async startAccount(ctx: GatewayContextType): Promise<void> {
    const logger = ctx.log || log;
    logger.info("XMPP gateway.startAccount called");
    debugLog("XMPP gateway.startAccount called");

    const account = ctx.account;
    const config = account.config;

    debugLog(`XMPP startAccount called for account ${account.accountId}`);

    if (!config?.jid?.trim() || !config?.password?.trim()) {
      debugLog("Missing jid or password");
      throw new Error("XMPP account missing jid or password");
    }

    logger.info(`[${account.accountId}] starting XMPP connection to ${config.service}`);
    debugLog(`Starting XMPP connection to ${config.service}`);

    const contacts = new this.services.Contacts(config.dataDir);
    this.deps.contactsStore.set(account.accountId, contacts);
    const contactList = await contacts.list();
    logger.info(`[${account.accountId}] loaded ${contactList.length} contacts`);

    // Initialize super admin from config if specified
    if (config?.adminJid?.trim()) {
      const adminJid = config.adminJid?.trim() || '';
      if (!(await contacts.isAdmin(adminJid))) {
        await contacts.addAdmin(adminJid);
        logger.info(`[${account.accountId}] Added super admin from config`);
      }
    }

    const adminCount = (await contacts.listAdmins()).length;
    logger.info(`[${account.accountId}] Total admins: ${adminCount}`);

    // SECURITY (2.1.4): the v2.0.20 "refuse to start a
    // second concurrent connection" guard was DELETED here
    // because it relied on a `_lastInboundAt` field that
    // the v2.1.3 liveness-manager removal had already
    // stopped maintaining.  The 2.1.3 changelog (file
    // `CHANGELOG.md` v2.1.3 entry) explained that the
    // liveness manager was the root cause of the
    // "stale-disconnect tears down the live connection"
    // bug; with it gone, this guard reads `undefined`
    // and `idleMs = +Infinity`, falling into the
    // "stale, tear down" branch — which is exactly the
    // bug the guard was meant to prevent.
    //
    // Concurrent-start protection is now provided by:
    //
    // 1. `stopAccount()` always removes the client from
    //    `xmppClients` before returning (see below), so
    //    the framework's "stop then start" sequence never
    //    leaves a stale entry.
    // 2. `startXmpp()` uses a unique resource per call
    //    (see `getDefaultResource` in `src/startXMPP.ts`,
    //    v2.1.4), so even if a concurrent start slipped
    //    through, the XMPP server would not raise
    //    `StreamError: conflict` because the two
    //    connections have different full JIDs.
    // 3. `xmppClient.stop()` now does a `socket.destroy()`
    //    fast path (v2.1.4) so the framework's
    //    auto-restart doesn't hang for 30s on a dead
    //    socket, which was the precondition for the
    //    previous conflict cycle.

    // Initialize message store for persistence
    const dataDir = config.dataDir || path.join(process.cwd(), 'data');
    const messageStore = new MessageStore(dataDir);

    let isRunning = true;

    // Use pluginRuntime (from api.runtime) instead of ctx.runtime
    const runtime = this.deps.getPluginRuntime();
    debugLog("Using pluginRuntime in startAccount");

    // Handle agent /sendfile command in response text
    const handleAgentSendFile = async (text: string, to: string, sendXmpp: any, isGroupChat: boolean, messageType: string): Promise<boolean> => {
      if (!text || !text.trim().startsWith('/sendfile')) return false;

      const cmdText = text.trim().substring('/sendfile'.length).trim();
      if (!cmdText) return false;

      // Quote-aware argument parser
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

      const filename = args[0];
      const description = args.slice(1).join(' ');
      if (!filename) return false;

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

      if (!resolvedPath) {
        log.error("sendfile: file not found", { filename, searched: uploadsDir });
        const msgEl = xml("message", { type: "chat", to }, xml("body", {}, `File not found: ${filename}`));
        await sendXmpp.send(msgEl).catch(() => {});
        return true;
      }

      try {
        if (isGroupChat) {
          const msgText = `[File: ${filename}]${description ? ' ' + description : ''}`;
          const msgEl = xml("message", { type: messageType, to }, xml("body", {}, msgText));
          await sendXmpp.send(msgEl);
        } else {
          if (description) {
            const descEl = xml("message", { type: "chat", to }, xml("body", {}, description));
            await sendXmpp.send(descEl);
          }
          await sendXmpp.sendFile(to, resolvedPath);
        }
        debugLog("sendfile success");
      } catch (err) {
        log.error("sendfile failed: " + (err?.message || String(err)));
      }
      return true;
    };

    // Handle incoming file - notify agent via standard dispatch pipeline
    const handleIncomingFile = async (filePath: string, filename: string, fromJid: string, description?: string) => {
      let fileMessage = `[File received] ${filename}`;
      if (description) {
        fileMessage += `\nDescription: ${description}`;
      }
      fileMessage += `\nSaved to: ${filePath}`;

      const fromJidStr = typeof fromJid === 'string' ? fromJid : String(fromJid);
      const senderBareJid = fromJidStr.split('/')[0];
      debugLog("incoming file notification");

      // Queue the notification for polling
      const messageId = this.queue.addToQueue({
        from: fromJidStr,
        body: fileMessage,
        accountId: account.accountId,
      });

      // Dispatch through the runtime pipeline
      if (runtime?.channel) {
        try {
          const channelRuntime = runtime.channel as any;
          const route = await channelRuntime.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: "xmpp",
            accountId: account.accountId,
            peer: { kind: "direct", id: senderBareJid },
          });
          const storePath = channelRuntime.session.resolveStorePath(
            ctx.cfg.session?.store,
            { agentId: route.agentId }
          );
          const ctxPayload = channelRuntime.reply.finalizeInboundContext({
            Body: fileMessage,
            RawBody: fileMessage,
            CommandBody: fileMessage,
            From: `xmpp:${senderBareJid}`,
            To: `xmpp:${senderBareJid}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            ConversationLabel: `XMPP: ${senderBareJid}`,
            SenderName: fromJidStr.split('@')[0],
            SenderId: senderBareJid,
            Provider: "xmpp",
            Surface: "xmpp",
            WasMentioned: false,
            CommandAuthorized: true,
            CommandSource: "text",
            OriginatingChannel: "xmpp",
            OriginatingTo: `xmpp:${senderBareJid}`,
            MessageSid: `xmpp-file-${Date.now()}`,
            Timestamp: Date.now(),
            MediaUrls: [],
            MediaPaths: [filePath],
            MediaUrl: null,
            MediaPath: filePath,
          });
          const mod = await import("openclaw/plugin-sdk/inbound-reply-dispatch");
          await mod.dispatchInboundReplyWithBase({
            cfg: ctx.cfg,
            channel: "xmpp",
            accountId: account.accountId,
            route,
            storePath,
            ctxPayload,
            core: { channel: channelRuntime },
            onRecordError: (err: any) => {
              log.error("Session record error:", err?.message ?? err);
            },
            onDispatchError: (err: any, info: { kind: string }) => {
              log.error(`Dispatch error (kind=${info.kind}):`, err?.message ?? err);
            },
            deliver: async (payload: any) => {
              const text = payload?.text || payload?.message || payload?.body || JSON.stringify(payload);
              if (text && xmpp) {
                if (await handleAgentSendFile(text, fromJidStr, xmpp, false, "chat")) return;
                try {
                  await xmpp.send(fromJidStr, text);
                } catch (err) {
                  log.error("Failed to send file transfer response:", err);
                }
              }
            },
          });
          this.queue.markAsProcessed(messageId);
          log.debug("file notification dispatched to agent");
        } catch (err) {
          log.error("[FILE] Error dispatching file notification:", err);
        }
      } else {
        log.warn(`[${account.accountId}] file notification not dispatched: runtime.channel unavailable`);
      }
    };

    // SECURITY (2.0.17, M9): startXmpp() can hang on a broken
    // server (TCP connect, TLS, SASL, resource binding, SM — each
    // a place a server can hang silently).  Race the call against
    // a 60s timeout so the gateway can surface the failure instead
    // of holding the abort signal forever.  Also hook the caller's
    // `abortSignal` so an early abort tears down the XMPP client.
    const START_XMPP_TIMEOUT_MS = 60_000;
    const startXmppTimer: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };
    const startXmppTimeoutPromise: Promise<never> = new Promise((_, reject) => {
      startXmppTimer.handle = setTimeout(
        () => reject(new Error(`startXmpp timed out after ${START_XMPP_TIMEOUT_MS}ms`)),
        START_XMPP_TIMEOUT_MS
      );
    });
    const startXmppAbortSignal: AbortSignal | undefined = (ctx as any)?.abortSignal;
    let startXmppResult: Awaited<ReturnType<typeof this.services.startXmpp>> | undefined;
    const onStartXmppAbort = () => {
      try { startXmppResult?.stop?.(); } catch { /* swallow */ }
    };
    if (startXmppAbortSignal && typeof startXmppAbortSignal.addEventListener === "function") {
      startXmppAbortSignal.addEventListener("abort", onStartXmppAbort);
    }
    const clearStartXmppGuards = () => {
      if (startXmppTimer.handle !== null) { clearTimeout(startXmppTimer.handle); startXmppTimer.handle = null; }
      if (startXmppAbortSignal && typeof startXmppAbortSignal.removeEventListener === "function") {
        startXmppAbortSignal.removeEventListener("abort", onStartXmppAbort);
      }
    };
    const startXmppPromise: Promise<Awaited<ReturnType<typeof this.services.startXmpp>>> =
      this.services.startXmpp(
        config,
        contacts,
        logger,
        async (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, roomSubject?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean, whiteboardData?: any, isSystemMessage?: boolean }) => {
        if (!isRunning) {
          debugLog("XMPP message ignored - plugin not running");
          return;
        }

        debugLog(`XMPP inbound from ${from}`);

        let dispatchSuccess = false;
        let dispatchError: any = null;

        // Add message to queue for polling
        const messageId = this.queue.addToQueue({
          from: from,
          body: body,
          accountId: account.accountId,
        });

        log.debug("message queued", { id: messageId });

        const senderBareJid = from.split('/')[0];
        const senderNick = from.split('/')[1];

        // Check for groupchat command: @<botNick> /<command>
        if (options?.type === "groupchat" && options?.room && options?.botNick && body) {
          const botNick = options.botNick;
          const commandPrefix = `@${botNick} `;
          if (body.startsWith(commandPrefix)) {
            body = body.substring(commandPrefix.length).trim();
          }
        }

        // Prepend sender's nickname to message body for groupchat messages
        if (options?.room && senderNick) {
          body = `<From: ${senderNick}>\n${body}`;
        }

        // Persist message to JSON storage
        const msgType = options?.type || 'chat';

        try {
          await messageStore.saveMessage({
            direction: 'inbound',
            type: msgType as 'chat' | 'groupchat',
            roomJid: options?.room || undefined,
            fromBareJid: senderBareJid,
            fromFullJid: from,
            fromNick: senderNick,
            to: config.jid,
            body: body,
            timestamp: Date.now(),
            accountId: account.accountId
          });
          log.debug("message persisted", { type: msgType, from: senderBareJid });
        } catch (err) {
          log.error('[MessageStore] Failed to persist message:', err);
        }

        // SECURITY (2.0.16): whiteboard and other system messages
        // (e.g. "[WHITEBOARD] SXE session established…") were
        // triggering an AI turn in 2.0.15.  The intent is for the
        // operator's tooling to see them, not the AI.  Skip the
        // dispatch but keep the persisted record (above).
        if (options?.isSystemMessage === true) {
          log.debug("skipping AI dispatch for system message", { from: senderBareJid });
          this.queue.markAsProcessed(messageId);
          return;
        }

        // Try to forward message using runtime channel methods
        if (runtime?.channel) {
          log.debug("dispatch inbound", { from: senderBareJid, type: options?.type, hasWhiteboardData: !!options?.whiteboardData, bodyLen: body?.length });

          dispatchSuccess = false;
          dispatchError = null;

          try {
            log.debug(`DISPATCH_ENTERED: from=${from} bodyLen=${(body||"").length} type=${options?.type} room=${options?.room} nick=${options?.nick}`);
            const isGroupChat = options?.type === "groupchat";
            const roomJid = options?.room;
            const senderBareJid = from.split('/')[0];

            const channelRuntime = runtime.channel as any;

            log.debug("Resolving agent route...");
            const route = await channelRuntime.routing.resolveAgentRoute({
              cfg: ctx.cfg,
              channel: "xmpp",
              accountId: account.accountId,
              peer: {
                kind: (roomJid || isGroupChat) ? "group" : "direct",
                id: roomJid || senderBareJid,
              },
            });
            log.debug(`Route resolved: agentId=${route.agentId} sessionKey=${route.sessionKey}`);

            const storePath = channelRuntime.session.resolveStorePath(
              ctx.cfg.session?.store,
              { agentId: route.agentId }
            );
            log.debug(`Store path: ${storePath}`);

            const ctxPayload = channelRuntime.reply.finalizeInboundContext({
              Body: body,
              RawBody: body,
              CommandBody: body,
              From: `xmpp:${senderBareJid}`,
              To: `xmpp:${roomJid || senderBareJid}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: (roomJid || isGroupChat) ? "channel" : "direct",
              ConversationLabel: options?.room
                ? `XMPP Groupchat: ${options.room}`
                : `XMPP: ${senderBareJid}`,
              SenderName: from.split('@')[0],
              SenderId: senderBareJid,
              Provider: "xmpp",
              Surface: "xmpp",
              WasMentioned: false,
              CommandAuthorized: true,
              CommandSource: "text",
              OriginatingChannel: "xmpp",
              OriginatingTo: `xmpp:${roomJid || senderBareJid}`,
              MessageSid: `xmpp-${crypto.randomUUID()}`,
              Timestamp: Date.now(),
              MediaUrls: options?.mediaUrls || [],
              MediaPaths: options?.mediaPaths || [],
              MediaUrl: options?.mediaUrls?.[0] || null,
              MediaPath: options?.mediaPaths?.[0] || null,
              // SECURITY (2.0.16): pass the isSystemMessage flag
              // through to downstream consumers.  Note the current
              // dispatch is short-circuited above when this is true,
              // so this only matters for consumers that wire up
              // their own dispatch path.
              IsSystemMessage: options?.isSystemMessage === true,
            });
            log.debug("Context finalized");

            log.debug("Importing inbound-reply-dispatch...");
            const mod = await import("openclaw/plugin-sdk/inbound-reply-dispatch");
            log.debug("inbound-reply-dispatch loaded");

            await mod.dispatchInboundReplyWithBase({
              cfg: ctx.cfg,
              channel: "xmpp",
              accountId: account.accountId,
              route,
              storePath,
              ctxPayload,
              core: { channel: channelRuntime },
              onRecordError: (err: any) => {
                log.error("Session record error:", err?.message ?? err);
              },
              onDispatchError: (err: any, info: { kind: string }) => {
                log.error(`Dispatch error (kind=${info.kind}):`, err?.message ?? err);
              },
              deliver: async (payload: any) => {
                const text = payload?.text || payload?.message || payload?.body || JSON.stringify(payload);
                let jid = roomJid || from;
                if (await handleAgentSendFile(text, jid, xmpp, isGroupChat, options?.type || "chat")) return;
                let cleanText = text;
                const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
                const match = text.match(thinkingRegex);
                if (match) {
                  cleanText = text.slice(match[0].length).trim();
                }
                const bareJid = jid.split('/')[0];

                log.debug(`GC_DELIVER: called=true payloadKeys=${Object.keys(payload||{}).join(",")} textLen=${(payload?.text||"").length} isGC=${isGroupChat} optType=${options?.type} roomJid=${roomJid} jid=${jid}`);

                const sessionManager = (global as any).whiteboardSessionManager;
                const svgCommands = parseSvgPathCommands(cleanText);
                const hasDrawing = svgCommands.length > 0;

                log.debug(`GC_WB: hasDrawing=${hasDrawing} cmdCount=${svgCommands.length} sessionExists=${!!(sessionManager && sessionManager.hasSession(bareJid))} bareJid=${bareJid}`);

                if (sessionManager && sessionManager.hasSession(bareJid)) {
                  const sessCheck = sessionManager.getSession(bareJid);
                  log.debug(`GC_WB: session protocol=${sessCheck?.protocol} sessionId=${sessCheck?.sessionId} sxeNodes=${Object.keys(sessCheck?.sxeNodes||{}).length} svgParentRid=${sessCheck?.svgParentRid}`);
                }

                // STEP 1: Determine and send the human-readable text (strip whiteboard tags if present)
                const displayText = hasDrawing
                  ? cleanText.replace(/\[WHITEBOARD_DRAW\][\s\S]*?\[\/WHITEBOARD_DRAW\]/gi, '').trim()
                  : cleanText;

                if (displayText) {
                  try {
                    if (isGroupChat && !(options?.type === "chat")) {
                      await xmpp.sendGroupchat(jid, displayText);
                    } else {
                      await xmpp.send(jid, displayText);
                    }
                  } catch (err) {
                    log.error('XMPP SEND TEXT ERROR:', err);
                  }
                }

                // STEP 2: Send whiteboard drawing (SXE/SWB) in isolated error handling
                if (hasDrawing && sessionManager && sessionManager.hasSession(bareJid)) {
                  const session = sessionManager.getSession(bareJid);
                  const pathId = `agent${Date.now()}`;
                  const paths: any[] = svgCommands.map((cmd: any) => ({
                    d: cmd.path,
                    stroke: cmd.color || '#000000',
                    strokeWidth: cmd.width || 1,
                    id: `${pathId}_${cmd.index}`
                  }));
                  const messageType = (isGroupChat && !(options?.type === "chat")) ? 'groupchat' : 'chat';

                  log.debug(`GC_WB: attempting protocol=${session?.protocol} sessionId=${session?.sessionId} pathCount=${paths.length} paths=${paths.map(p=>p.d.substring(0,40)).join("|")}`);

                  try {
                    if (session.protocol === 'sxe' && session.sessionId) {
                      const svgParentRid = session.svgParentRid || '0.1';
                      log.debug(`GC_WB: building SXE edits svgParentRid=${svgParentRid} prefix=${getAvailableRidPrefix(session.sxeNodes)}`);
                      const edits = buildSxePathEdits(paths, getAvailableRidPrefix(session.sxeNodes), svgParentRid, session.ridOffset);
                      session.ridOffset += paths.length;
                      const sxeStanzas = sxeEditsToXml(session.sessionId, edits);
                      log.debug(`GC_WB: SXE stanzas count=${sxeStanzas.length} sessionId=${session.sessionId}`);
                      for (const sxeElement of sxeStanzas) {
                        const wbMessage = xml('message', { type: messageType, to: jid },
                          xml('body', {}, ''),
                          sxeElement
                        );
                        log.debug(`GC_WB: sending SXE stanza rid=${sxeElement?.children?.[0]?.attrs?.rid || '?'} jid=${jid}`);
                        log.info(`SXE_DELIVER_XML: ${wbMessage.toString().substring(0, 3000)}`);
                        await safeSend(xmpp.xmpp, wbMessage);
                      }
                      sessionManager.updateSession(bareJid, { paths });
                      log.info(`GC_WB: SXE whiteboard SENT to ${bareJid} paths=${paths.length}`);
                    } else {
                      log.debug(`GC_WB: sending SWB protocol=${session?.protocol} sessionId=${session?.sessionId}`);
                      const whiteboardChildren = paths.map((p: any) =>
                        xml('path', {
                          d: p.d,
                          stroke: p.stroke,
                          'stroke-width': p.strokeWidth.toString(),
                          id: p.id
                        })
                      );
                      const whiteboardElement = xml('x', { xmlns: 'http://jabber.org/protocol/swb' }, whiteboardChildren);
                      const wbMessage = xml('message', { type: messageType, to: jid }, whiteboardElement);
                      await safeSend(xmpp.xmpp, wbMessage);
                      log.info(`GC_WB: SWB whiteboard SENT to ${bareJid} paths=${paths.length}`);
                    }
                  } catch (err) {
                    log.error('XMPP WHITEBOARD SEND ERROR:', err instanceof Error ? err.message : String(err));
                    log.error('XMPP WHITEBOARD SEND STACK:', err instanceof Error ? err.stack || '' : '');
                    // Emergency fallback: if no readable text was sent (displayText was empty),
                    // send the raw response text as a normal message
                    if (!displayText) {
                      log.debug(`GC_WB: emergency fallback — sending raw text to ${jid}`);
                      try {
                        if (isGroupChat && !(options?.type === "chat")) {
                          await xmpp.sendGroupchat(jid, cleanText);
                        } else {
                          await xmpp.send(jid, cleanText);
                        }
                      } catch (fallbackErr) {
                        log.error('XMPP FALLBACK SEND ERROR:', fallbackErr);
                      }
                    }
                  }
                } else if (hasDrawing) {
                  log.debug(`GC_WB: hasDrawing=true but NO session for ${bareJid}`);
                }

                // STEP 3: Debug log for normal (non-whiteboard) sends
                if (!hasDrawing) {
                  log.debug(`GC_SEND: pre isGC=${isGroupChat} optType=${options?.type} jid=${jid} cleanTextLen=${cleanText.length} ready=${true}`);
                }

                ctx.setStatus({ lastTransportActivityAt: Date.now() });
                try {
                  await messageStore.saveMessage({
                    direction: 'outbound',
                    type: (options?.type || 'chat') as 'chat' | 'groupchat',
                    roomJid: options?.room || undefined,
                    fromBareJid: jid,
                    fromFullJid: `${config.jid}/openclaw`,
                    to: config.jid,
                    body: cleanText,
                    timestamp: Date.now(),
                    accountId: account.accountId
                  });
                } catch (err) {
                  log.error('[MessageStore] Failed to save outbound:', err);
                }
              },
            });

            dispatchSuccess = true;
            this.queue.markAsProcessed(messageId);
            log.info(`Dispatch SUCCESS for ${senderBareJid}`);
          } catch (err) {
            log.error("DISPATCH BLOCK FAILED:");
            log.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
            log.error(`  Stack: ${err instanceof Error ? err.stack : '(no stack)'}`);
            log.error(`  Type: ${err?.constructor?.name || typeof err}`);
            log.error(`  Full: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
            dispatchError = err;
          }
        } else {
          log.warn("runtime.channel not available, cannot dispatch", { error: dispatchError || "Unknown error" });
        }
      }, async (xmppClient) => {
        // Auto-join configured rooms when XMPP is online
        if (Array.isArray(config.rooms) && config.rooms.length > 0) {
          logger.info(`[${account.accountId}] Auto-joining ${config.rooms.length} room(s)`);
          for (const room of config.rooms) {
            try {
              await xmppClient.joinRoom(room, config.nick);
              logger.debug("auto-joined room", { room });
            } catch (err) {
              logger.error(`Failed to join room ${room}:`, err);
            }
          }
        }
      },
      handleIncomingFile
    );
    let xmpp: Awaited<ReturnType<typeof this.services.startXmpp>>;
    try {
      xmpp = await Promise.race([startXmppPromise, startXmppTimeoutPromise]);
      startXmppResult = xmpp;
      clearStartXmppGuards();
    } catch (err) {
      clearStartXmppGuards();
      logger?.error?.(`[${account.accountId}] startXmpp failed:`, err);
      throw err;
    }

    // Store client globally by account ID
    this.deps.xmppClients.set(account.accountId, xmpp);

    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      connected: true,
      lastTransportActivityAt: Date.now(),
      lastStartAt: Date.now(),
    });

    ctx.abortSignal?.addEventListener("abort", () => {
      isRunning = false;
      logger?.info(`[${account.accountId}] XMPP connection stopping`);
    });

    return new Promise<void>((resolve) => {
      ctx.abortSignal?.addEventListener("abort", () => {
        isRunning = false;
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
        resolve();
      });
    });
  }

  async stopAccount(ctx: GatewayContextType): Promise<void> {
    const xmpp = this.deps.xmppClients.get(ctx.accountId || "default");
    if (xmpp) {
      try {
        await xmpp.stop();
      } catch (err) {
        ctx.log?.error("Error stopping XMPP client:", err);
      }
      this.deps.xmppClients.delete(ctx.accountId || "default");
    }
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });
    ctx.log?.info("XMPP connection stopped");
  }
}
