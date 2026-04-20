import path from "path";
import crypto from "crypto";
import { log } from "./lib/logger.js";
import { debugLog } from "./shared/index.js";
import { MessageStore } from "./messageStore.js";
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
      async (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, roomSubject?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean }) => {
        if (!isRunning) {
          debugLog("XMPP message ignored - plugin not running");
          return;
        }

        debugLog(`XMPP inbound from ${from}`);

        let dispatchSuccess = false;
        let dispatchError: any = null;

        const buildContextPayload = (sessionKey: string, senderBareJid: string) => {
          const room = options?.room || from;
          const nick = options?.nick || from.split('/')[1] || from.split('@')[0];
          const senderId = senderBareJid;
          const senderName = from.split('@')[0];
          const isGroupChatMessage = options?.type === "groupchat" || options?.type === "chat";
          const chatType = (isGroupChatMessage ? "channel" : "direct") as "direct" | "channel";
          const conversationLabel = options?.room
            ? `XMPP Groupchat: ${options.room}`
            : `XMPP: ${senderBareJid}`;

          let replyDestination: string;
          if (options?.type === "chat" && room) {
            replyDestination = `${room}/${nick}`;
          } else if (room) {
            replyDestination = room;
          } else {
            replyDestination = senderBareJid;
          }

          const uniqueMessageId = `xmpp-${crypto.randomUUID()}`;

          return {
            Body: body,
            RawBody: body,
            CommandBody: body,
            From: `xmpp:${senderBareJid}`,
            To: `xmpp:${replyDestination}`,
            SessionKey: sessionKey,
            AccountId: account.accountId,
            ChatType: chatType,
            ConversationLabel: conversationLabel,
            SenderName: senderName,
            SenderId: senderId,
            Provider: "xmpp" as const,
            Surface: "xmpp" as const,
            WasMentioned: false,
            MessageSid: uniqueMessageId,
            Timestamp: Date.now(),
            CommandAuthorized: true,
            CommandSource: "text" as const,
            OriginatingChannel: "xmpp" as const,
            OriginatingTo: `xmpp:${replyDestination}`,
            MediaUrls: options?.mediaUrls || [],
            MediaPaths: options?.mediaPaths || [],
            MediaUrl: options?.mediaUrls?.[0] || null,
            MediaPath: options?.mediaPaths?.[0] || null,
            WhiteboardPrompt: options?.whiteboardPrompt || null,
            WhiteboardRequest: options?.whiteboardRequest || false,
            WhiteboardImage: options?.whiteboardImage || false,
          };
        };

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
          log.debug("dispatch inbound", { from: senderBareJid, type: options?.type });

          dispatchSuccess = false;
          dispatchError = null;

          if (runtime.channel.session?.recordInboundSession) {
            try {
              const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
                agentId: "main",
              });

              const isRoomJid = !!options?.room;

              let sessionKey: string;
              let replyTo: string;

              const nick = options?.nick;
              const room = options?.room;

              if (room) {
                sessionKey = `xmpp:${senderBareJid}`;
                if (options?.type === "chat") {
                  replyTo = `${room}/${nick}`;
                } else {
                  replyTo = room;
                }
              } else {
                sessionKey = `xmpp:${senderBareJid}`;
                replyTo = senderBareJid;
              }

              const payloadNick = nick || from.split('/')[1] || 'unknown';
              const payloadJid = senderBareJid;
              const ctxPayload = buildContextPayload(sessionKey, payloadJid);

              await runtime.channel.session.recordInboundSession({
                storePath,
                sessionKey,
                ctx: ctxPayload,
                updateLastRoute: {
                  sessionKey: sessionKey,
                  channel: "xmpp",
                  to: `xmpp:${payloadJid}`,
                  accountId: account.accountId,
                },
                onRecordError: (err: any) => {
                  log.error("Error recording session:", err);
                  log.error("Error details:", err instanceof Error ? err.stack : err);
                },
              });

              dispatchSuccess = false;
              dispatchError = null;

              try {
                // METHOD 1: dispatchReplyFromConfig (fast path)
                if (runtime.channel.reply?.dispatchReplyFromConfig && !dispatchSuccess) {

                  const immediateSendText = async (to: string, text: string) => {
                    let jid = to;
                    if (to.startsWith('xmpp:')) {
                      jid = to.substring(5);
                    }

                    let cleanText = text;
                    const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
                    const match = text.match(thinkingRegex);
                    if (match) {
                      cleanText = text.slice(match[0].length).trim();
                    }

                    const isGroupChatMessage = options?.type === "groupchat" || options?.type === "chat";
                    const isPrivateMessage = options?.type === "chat";

                    try {
                      if (isGroupChatMessage && !isPrivateMessage) {
                        await xmpp.sendGroupchat(jid.split('/')[0], cleanText);
                      } else {
                        await xmpp.send(jid, cleanText);
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
                        log.debug("outbound message saved", { type: options?.type || 'chat', to: jid });
                      } catch (err) {
                        log.error('[MessageStore] Failed to save outbound:', err);
                      }

                      return { ok: true, channel: "xmpp" };
                    } catch (err) {
                      log.error('XMPP SEND ERROR:', err);
                      return { ok: false, error: String(err), channel: "xmpp" };
                    }
                  };

                  const replyToXmpp = `xmpp:${replyTo}`;

                  const simpleDispatcher = {
                    sendBlockReply: async (payload: any) => {
                      return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                    },
                    sendFinalReply: async (payload: any) => {
                      return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                    },
                    deliver: async (payload: any) => {
                      return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                    },
                    sendText: async (to: string, text: string) => {
                      return immediateSendText(to, text);
                    },
                    sendMessage: async (msg: any) => {
                      return immediateSendText(msg?.to || replyToXmpp, msg?.text || msg?.body || JSON.stringify(msg));
                    },

                    waitForIdle: async () => ({ ok: true }),
                    getQueuedCounts: async () => ({ ok: true, counts: {} }),
                  };

                  const dispatchStart = Date.now();

                  try {
                    const result = await runtime.channel.reply.dispatchReplyFromConfig({
                      ctx: ctxPayload,
                      cfg: ctx.cfg,
                      dispatcher: simpleDispatcher,
                      replyOptions: {},
                    });
                    if (result?.ok !== false) {
                      dispatchSuccess = true;
                    }
                  } catch (err) {
                    log.error("Dispatch error (Method 1):", err);
                    dispatchError = err;
                  }
                }

                // METHOD 2: dispatchReplyWithBufferedBlockDispatcher (if first failed)
                if (runtime.channel.reply?.dispatchReplyWithBufferedBlockDispatcher && !dispatchSuccess) {

                  const sendText = async (to: string, text: string) => {
                    let jid = to;
                    if (to.startsWith('xmpp:')) {
                      jid = to.substring(5);
                    }

                    const isGroupChatMessage = options?.type === "groupchat" || options?.type === "chat";
                    const isPrivateMessage = options?.type === "chat";

                    try {
                      if (isGroupChatMessage && !isPrivateMessage) {
                        await xmpp.sendGroupchat(jid.split('/')[0], text);
                      } else {
                        await xmpp.send(jid, text);
                      }
                      return { ok: true, channel: "xmpp" };
                    } catch (err) {
                      log.error("XMPP SEND ERROR (Method 2):", err);
                      return { ok: false, error: String(err) };
                    }
                  };

                  const dispatchStart = Date.now();

                  try {
                    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                      ctx: ctxPayload,
                      cfg: ctx.cfg,
                      sendText: sendText,
                      dispatcherOptions: {},
                    });
                    dispatchSuccess = true;
                  } catch (err) {
                    log.error("Method 2 dispatch error:", err);
                    dispatchError = err;
                  }
                }

              } catch (err) {
                log.error("FATAL DISPATCH ERROR:", err);
                log.error("Error details:", err instanceof Error ? err.stack : err);
                dispatchError = err;
              }

              if (dispatchSuccess) {
                this.queue.markAsProcessed(messageId);
              } else {
                log.warn("dispatch failed, message remains in queue", { error: dispatchError || "Unknown error" });
              }
              return;
            } catch (err) {
              log.error("Error with fallback:", err);
            }
          }
        }

        // Fallback: Try to find the correct inbound method on ctx
        const inboundMethods = ['receiveText', 'receiveMessage', 'inbound', 'dispatch'];

        for (const methodName of inboundMethods) {
          if (typeof ctx[methodName] === 'function' && !dispatchSuccess) {
            try {
              const fbSenderBareJid = from.split('/')[0];
              if (methodName === 'receiveText' || methodName === 'receiveMessage') {
                await ctx[methodName]({
                  from: `xmpp:${fbSenderBareJid}`,
                  to: `xmpp:${config.jid}`,
                  body: body,
                  channel: "xmpp",
                  accountId: account.accountId,
                });
              } else {
                await ctx[methodName](fbSenderBareJid, body, {
                  channel: "xmpp",
                  accountId: account.accountId,
                });
              }
              dispatchSuccess = true;
              break;
            } catch (err) {
              log.error(`Error with ctx.${methodName}:`, err);
              dispatchError = err;
            }
          }
        }

        // Try dispatchInboundMessage if ctx methods failed
        if (runtime?.dispatchInboundMessage && !dispatchSuccess) {
          try {
            const diSenderBareJid = from.split('/')[0];
            const diCtxPayload = buildContextPayload(`xmpp:${diSenderBareJid}`, diSenderBareJid);

            await runtime.dispatchInboundMessage({
              ctx: diCtxPayload,
              cfg: ctx.cfg,
            });
            dispatchSuccess = true;
          } catch (err) {
            log.error("Error with dispatchInboundMessage:", err);
            dispatchError = err;
          }
        }

        // Try channel.activity.record as last resort (only logs, doesn't count as success)
        if (runtime?.channel?.activity?.record && !dispatchSuccess) {
          try {
            const actSenderBareJid = from.split('/')[0];
            runtime.channel.activity.record({
              channel: "xmpp",
              accountId: account.accountId,
              from: `xmpp:${actSenderBareJid}`,
              action: "message:inbound",
              data: { body: body },
            });
          } catch (err) {
            log.error("Error recording activity:", err);
          }
        }

        // Final success check - mark as processed only if dispatch succeeded
        if (dispatchSuccess) {
          this.queue.markAsProcessed(messageId);
        } else {
          log.warn("all dispatch methods failed, message remains in queue", { error: dispatchError || "Unknown error" });
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
