import path from "path";
import crypto from "crypto";
import { log } from "./lib/logger.js";
import { debugLog } from "./shared/index.js";
import { MessageStore } from "./messageStore.js";
import { parseSvgPathCommands, buildSxePathEdits, sxeEditsToXml } from "./whiteboard.js";
import { xml } from "@xmpp/client";
import type { GatewayContext as GatewayContextType, XmppClient, PluginRuntime } from "./types.js";

export { type GatewayContext } from "./types.js";

interface LifecycleDeps {
  xmppClients: Map<string, XmppClient>;
  contactsStore: Map<string, any>;
  getPluginRuntime: () => PluginRuntime | null;
}

interface LifecycleServices {
  startXmpp: (config: any, contacts: any, logger: any, onMessage: any, onOnline?: any) => Promise<XmppClient>;
  Contacts: new (dataDir: string) => any;
  MessageStore: new (dataDir: string) => any;
}

interface LifecycleDeps {
  xmppClients: Map<string, any>;
  contactsStore: Map<string, any>;
  getPluginRuntime: () => any;
}

interface LifecycleServices {
  startXmpp: (config: any, contacts: any, logger: any, onMessage: any, onOnline?: any) => Promise<any>;
  Contacts: new (dataDir: string) => any;
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

    // Check for existing connection to prevent duplicate connections
    const existingXmpp = this.deps.xmppClients.get(account.accountId);
    if (existingXmpp) {
      debugLog(`Existing XMPP client found for ${account.accountId}, stopping it first`);
      try {
        await existingXmpp.stop();
      } catch (err) {
        debugLog(`Error stopping existing client: ${err}`);
      }
      this.deps.xmppClients.delete(account.accountId);
    }

    // Initialize message store for persistence
    const dataDir = config.dataDir || path.join(process.cwd(), 'data');
    const messageStore = new MessageStore(dataDir);

    let isRunning = true;

    // Use pluginRuntime (from api.runtime) instead of ctx.runtime
    const runtime = this.deps.getPluginRuntime();
    debugLog("Using pluginRuntime in startAccount");

    // Handle incoming file - forward to agent
    const handleIncomingFile = async (filePath: string, filename: string, fromJid: string) => {
      const fromJidStr = typeof fromJid === 'string' ? fromJid : String(fromJid);
      const senderBareJid = fromJidStr.split('/')[0];

      const fileMessage = `[File received] ${filename}\nSaved to: ${filePath}`;
      const sessionKey = `xmpp:${senderBareJid}`;

      const ctxPayload = {
        Body: fileMessage,
        RawBody: fileMessage,
        CommandBody: fileMessage,
        From: `xmpp:${senderBareJid}`,
        To: `xmpp:${config.jid}`,
        SessionKey: sessionKey,
        AccountId: config.accountId,
        ChatType: "direct" as const,
        ConversationLabel: `XMPP: ${senderBareJid}`,
        SenderName: senderBareJid.split('@')[0],
        SenderId: senderBareJid,
        Provider: "xmpp" as const,
        Surface: "xmpp" as const,
        WasMentioned: false,
        MessageSid: `xmpp-file-${Date.now()}`,
        Timestamp: Date.now(),
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "xmpp" as const,
        OriginatingTo: `xmpp:${config.jid}`,
        MediaUrls: [],
        MediaPaths: [filePath],
        MediaUrl: null,
        MediaPath: filePath,
      };

      if (runtime?.channel?.session?.recordInboundSession) {
        try {
          const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, { agentId: "main" });
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey,
            ctx: ctxPayload,
            updateLastRoute: { sessionKey, channel: "xmpp", to: `xmpp:${senderBareJid}`, accountId: config.accountId },
          });
          log.debug("file notification forwarded to agent");
        } catch (err) {
          log.error("[FILE] Error forwarding file to agent:", err);
        }
      }
    };

    const xmpp = await this.services.startXmpp(
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

        // Try to forward message using runtime channel methods
        if (runtime?.channel) {
          log.debug("dispatch inbound", { from: senderBareJid, type: options?.type, hasWhiteboardData: !!options?.whiteboardData, bodyLen: body?.length });

          dispatchSuccess = false;
          dispatchError = null;

          try {
            log.error(`DISPATCH_ENTERED: from=${from} bodyLen=${(body||"").length} type=${options?.type} room=${options?.room} nick=${options?.nick}`);
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
                let jid = roomJid || senderBareJid;
                let cleanText = text;
                const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
                const match = text.match(thinkingRegex);
                if (match) {
                  cleanText = text.slice(match[0].length).trim();
                }
                const bareJid = jid.split('/')[0];

                log.error(`GC_DELIVER: called=true payloadKeys=${Object.keys(payload||{}).join(",")} textLen=${(payload?.text||"").length} isGC=${isGroupChat} optType=${options?.type} roomJid=${roomJid} jid=${jid}`);

                try {
                  const sessionManager = (global as any).whiteboardSessionManager;
                  if (sessionManager && sessionManager.hasSession(bareJid)) {
                    const session = sessionManager.getSession(bareJid);
                    const svgCommands = parseSvgPathCommands(cleanText);
                    if (svgCommands.length > 0) {
                      const pathId = `agent${Date.now()}`;
                      const paths: any[] = svgCommands.map((cmd: any) => ({
                        d: cmd.path,
                        stroke: cmd.color || '#000000',
                        strokeWidth: cmd.width || 1,
                        id: `${pathId}_${cmd.index}`
                      }));
                      const messageType = (isGroupChat && !(options?.type === "chat")) ? 'groupchat' : 'chat';
                      let textOnly = cleanText.replace(/\[WHITEBOARD_DRAW\][\s\S]*?\[\/WHITEBOARD_DRAW\]/gi, '').trim();
                      if (textOnly.length > 2) {
                        if (isGroupChat && !(options?.type === "chat")) {
                          await xmpp.sendGroupchat(jid, textOnly);
                        } else {
                          await xmpp.send(jid, textOnly);
                        }
                      }
                      if (session.protocol === 'sxe' && session.sessionId) {
                        const edits = buildSxePathEdits(paths);
                        const sxeStanzas = sxeEditsToXml(session.sessionId, edits);
                        for (const sxeElement of sxeStanzas) {
                          const wbMessage = xml('message', { type: messageType, to: jid },
                            xml('body', {}, ''),
                            sxeElement
                          );
                          await xmpp.send(wbMessage);
                        }
                        sessionManager.updateSession(bareJid, { paths });
                      } else {
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
                        await xmpp.send(wbMessage);
                      }
                    }
                  }
                  log.error(`GC_SEND: pre isGC=${isGroupChat} optType=${options?.type} jid=${jid} cleanTextLen=${cleanText.length} ready=${true}`);
                  if (isGroupChat && !(options?.type === "chat")) {
                    await xmpp.sendGroupchat(jid, cleanText);
                    log.error(`GC_SEND: post groupchat success=true`);
                  } else {
                    await xmpp.send(jid, cleanText);
                    log.error(`GC_SEND: post direct success=true`);
                  }
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
                } catch (err) {
                  log.error('XMPP SEND ERROR:', err);
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
      }
    );

    // Store client globally by account ID
    this.deps.xmppClients.set(account.accountId, xmpp);

    ctx.setStatus({
      accountId: account.accountId,
      running: true,
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
      lastStopAt: Date.now(),
    });
    ctx.log?.info("XMPP connection stopped");
  }
}
