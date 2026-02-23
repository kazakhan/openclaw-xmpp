import fs from "fs";
import path from "path";
import { startXmpp, XmppClientInterface } from "./startXmpp.js";
import { Contacts } from "./contacts.js";
import { VCard } from "./vcard.js";
import { MessageStore } from "./messageStore.js";
import { registerXmppCli } from "./commands.js";

export const xmppClients = new Map<string, XmppClientInterface>();
export const contactsStore = new Map<string, Contacts>();

let pluginRuntime: any = null;
let pluginRegistered = false;

interface QueuedMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  accountId: string;
  processed: boolean;
}

const messageQueue: QueuedMessage[] = [];
const messageQueueMaxSize = 100;

export function addToQueue(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'processed'>): string {
  const queuedMessage: QueuedMessage = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...message,
    timestamp: Date.now(),
    processed: false,
  };

  messageQueue.push(queuedMessage);

  if (messageQueue.length > messageQueueMaxSize) {
    messageQueue.length = messageQueueMaxSize;
  }

  console.log(`Message queued: ${queuedMessage.id} from ${queuedMessage.from}`);
  return queuedMessage.id;
}

export function getUnprocessedMessages(accountId?: string): QueuedMessage[] {
  return messageQueue.filter(msg =>
    !msg.processed && (!accountId || msg.accountId === accountId)
  );
}

export function markAsProcessed(messageId: string): void {
  const msg = messageQueue.find(m => m.id === messageId);
  if (msg) {
    msg.processed = true;
  }
}

export function clearOldMessages(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  const oldCount = messageQueue.length;
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (messageQueue[i].timestamp < cutoff) {
      messageQueue.splice(i, 1);
    }
  }
  console.log(`Cleared ${oldCount - messageQueue.length} old messages`);
}

export { messageQueue };

const debugLog = (msg: string) => {
  const sanitizedMsg = sanitize(msg);
  const logFile = path.join(__dirname, 'cli-debug.log');
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${sanitizedMsg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (err) {
  }
};

function sanitize(message: string): string {
  if (!message || typeof message !== 'string') return '';
  let sanitized = message;
  const SENSITIVE_PATTERNS = [
    /password["']?\s*[:=]\s*["']?[^"']+["']?/gi,
    /password[:\s][^\s,"']+/gi,
    /credential[s]?[:\s][^\s,"']+/gi,
    /api[_-]?key[s]?[:\s][^\s,"']+/gi,
  ];
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export function register(api: any) {
  debugLog(`register() called, pluginRegistered=${pluginRegistered}`);
  if (pluginRegistered) {
    console.log("XMPP plugin already registered, skipping");
    debugLog("Plugin already registered, skipping");
    return;
  }
  pluginRegistered = true;
  const log = api.logger ?? console;
  log.info("Registering XMPP plugin");
  console.log("XMPP plugin register called - is this CLI or Gateway?");
  debugLog("Registering XMPP plugin");

  const isCliRegistration = !api.runtime;
  console.log(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);
  console.log(`api.runtime available: ${api.runtime ? 'yes' : 'no'}`);
  debugLog(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);

  debugLog("=== API OBJECT INSPECTION ===");
  debugLog("api keys: " + Object.keys(api).join(", "));
  const allApiProps: string[] = [];
  for (const key in api) {
    allApiProps.push(key);
  }
  debugLog("All api properties: " + allApiProps.join(", "));
  const apiMethods = allApiProps.filter(k => typeof api[k] === 'function');
  debugLog("All api methods: " + apiMethods.join(", "));

  if (api.runtime && !isCliRegistration) {
    pluginRuntime = api.runtime;
    debugLog("api.runtime set for Gateway registration, keys: " + Object.keys(api.runtime).join(", "));

    if (api.runtime.channel) {
      debugLog("api.runtime.channel exists, keys: " + Object.keys(api.runtime.channel).join(", "));

      const channelMethods = Object.keys(api.runtime.channel);
      debugLog("Channel methods available: " + channelMethods.join(", "));

      const possibleForwardMethods = ['text', 'message', 'routing', 'dispatch', 'receive'];
      for (const method of possibleForwardMethods) {
        if (api.runtime.channel[method]) {
          debugLog("Found channel." + method);

          if (typeof api.runtime.channel[method] === 'object') {
            const subMethods = Object.keys(api.runtime.channel[method]);
            debugLog("  channel." + method + " methods: " + subMethods.slice(0, 10).join(", "));
          }
        }
      }

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

  debugLog("Checking for api.emit method...");
  if (typeof api.emit === 'function') {
    debugLog("api.emit is available");
  } else {
    debugLog("api.emit not found");
    if (api.runtime?.emit) {
      debugLog("api.runtime.emit is available");
    }
  }

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
      chatTypes: ["direct"],
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
    outbound: {
      deliveryMode: "gateway",
      sendText: async ({ to, text, accountId }: any) => {
        console.log("XMPP sendText called with:", { to, text, accountId });

        const xmpp = xmppClients.get(accountId || "default");
        console.log("XMPP client available:", !!xmpp);

        if (!xmpp) {
          return { ok: false, error: "XMPP client not available" };
        }

        try {
          const cleanTo = to.replace(/^xmpp:/, '');

          let cleanText = text;
          const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
          const match = text.match(thinkingRegex);
          if (match) {
            console.log(`Filtering "Thinking..." prefix from message`);
            cleanText = text.slice(match[0].length).trim();
          }

          console.log(`Attempting to send message to ${cleanTo}: ${cleanText.substring(0, 100)}...`);

          const isGroupChat = cleanTo.includes('@conference.');

          if (isGroupChat) {
            await xmpp.sendGroupchat(cleanTo.split('/')[0], cleanText);
            console.log("Groupchat message sent successfully");
          } else {
            await xmpp.send(cleanTo, cleanText);
            console.log("Direct message sent successfully");
          }

          return { ok: true, channel: "xmpp" };
        } catch (err) {
          console.error("Error sending message:", err);
          return { ok: false, error: String(err) };
        }
      },
      sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, ...other }: any) => {
        console.log("XMPP sendMedia called with:", { to, text, mediaUrl, accountId, deps: deps ? 'present' : 'missing' });

        const xmpp = xmppClients.get(accountId || "default");
        console.log("XMPP client available:", !!xmpp);

        if (!xmpp) {
          return { ok: false, error: "XMPP client not available" };
        }

        try {
          const isGroupChat = to.includes('@conference.') || to.includes('/');

          let localFilePath: string | null = null;

          if (deps?.loadWebMedia) {
            console.log("Using loadWebMedia from deps");
            try {
              const result = await deps.loadWebMedia(mediaUrl);
              localFilePath = result.path || result.url || mediaUrl;
              console.log(`loadWebMedia returned path: ${localFilePath}`);
            } catch (err) {
              console.error("loadWebMedia failed:", err);
            }
          }

          if (!localFilePath) {
            if (mediaUrl.startsWith('file://')) {
              localFilePath = mediaUrl.substring(7);
            } else if (mediaUrl.startsWith('/') || mediaUrl.startsWith('~/') || mediaUrl.startsWith('.') || path.isAbsolute(mediaUrl)) {
              localFilePath = mediaUrl;
            }
          }

          if (localFilePath && fs.existsSync(localFilePath)) {
            if (localFilePath.startsWith('~')) {
              localFilePath = path.join(process.env.HOME || process.env.USERPROFILE || '', localFilePath.substring(2));
            }

            console.log(`Sending local file: ${localFilePath}`);

            await xmpp.sendFile(to, localFilePath, text, isGroupChat);

            console.log("File sent successfully via XMPP file transfer");
            return { ok: true, channel: "xmpp" };
          } else {
            console.log(`No local file, sending as URL: ${mediaUrl}`);
            const message = text ? `${text}\n${mediaUrl}` : mediaUrl;

            if (isGroupChat) {
              await xmpp.sendGroupchat(to, message);
            } else {
              await xmpp.send(to, message);
            }

            console.log("Media URL sent (out-of-band fallback)");
            return { ok: false, error: "File not found locally, sent as URL only" };
          }
        } catch (err) {
          console.error("Error sending media:", err);
          return { ok: false, error: String(err) };
        }
      },
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const log = ctx.log;
        log?.info("XMPP gateway.startAccount called");
        debugLog("XMPP gateway.startAccount called");

        const account = ctx.account;
        const config = account.config;

        debugLog(`XMPP startAccount called for account ${account.accountId}`);

        if (!config?.jid?.trim() || !config?.password?.trim()) {
          debugLog("Missing jid or password");
          throw new Error("XMPP account missing jid or password");
        }

        log?.info(`[${account.accountId}] starting XMPP connection to ${config.service}`);
        debugLog(`Starting XMPP connection to ${config.service}`);

        const contacts = new Contacts(config.dataDir);
        contactsStore.set(account.accountId, contacts);
        const contactList = contacts.list();
        log?.info(`[${account.accountId}] loaded ${contactList.length} contacts`);

        if (config?.adminJid?.trim()) {
          const adminJid = config.adminJid?.trim() || '';
          if (!contacts.isAdmin(adminJid)) {
            contacts.addAdmin(adminJid);
            console.log(`[${account.accountId}] Added super admin from config: ${adminJid}`);
            log?.info(`[${account.accountId}] Added super admin from config: ${adminJid}`);
          }
        }

        const adminCount = contacts.listAdmins().length;
        console.log(`[${account.accountId}] Total admins: ${adminCount}`);
        log?.info(`[${account.accountId}] Total admins: ${adminCount}`);

        const existingXmpp = xmppClients.get(account.accountId);
        if (existingXmpp) {
          debugLog(`Existing XMPP client found for ${account.accountId}, stopping it first`);
          try {
            await existingXmpp.stop();
          } catch (err) {
            debugLog(`Error stopping existing client: ${err}`);
          }
          xmppClients.delete(account.accountId);
        }

        const dataDir = config.dataDir || path.join(process.cwd(), 'data');
        const messageStore = new MessageStore(dataDir);

        let isRunning = true;

        const runtime = pluginRuntime;
        debugLog("Using pluginRuntime in startAccount");

        let messageCounter = 0;

        const xmpp = await startXmpp(config, contacts, log, async (from: string, body: string, options?: any) => {
          if (!isRunning) {
            debugLog("XMPP message ignored - plugin not running");
            return;
          }

          debugLog(`XMPP inbound from ${from}`);

          let dispatchSuccess = false;
          let dispatchError: any = null;

          const buildContextPayload = (sessionKey: string, senderBareJid: string) => {
            const room = options?.room || from;
            const nick = options?.nick || from.split('@')[0];

            const senderId = senderBareJid;
            const senderName = from.split('@')[0];

            const chatType = "direct" as const;
            const conversationLabel = `XMPP: ${senderBareJid}`;
            const botNick = options?.botNick || null;
            debugLog(`buildContextPayload: senderId=${senderId}, sessionKey=${sessionKey}`);

            const uniqueMessageId = `xmpp-${Date.now()}-${++messageCounter}`;

            return {
              Body: body,
              RawBody: body,
              CommandBody: body,
              From: `xmpp:${senderBareJid}`,
              To: `xmpp:${config.jid}`,
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
              OriginatingTo: `xmpp:${config.jid}`,
              MediaUrls: options?.mediaUrls || [],
              MediaPaths: options?.mediaPaths || [],
              MediaUrl: options?.mediaUrls?.[0] || null,
              MediaPath: options?.mediaPaths?.[0] || null,
              WhiteboardPrompt: options?.whiteboardPrompt || null,
              WhiteboardRequest: options?.whiteboardRequest || false,
              WhiteboardImage: options?.whiteboardImage || false,
            };
          };

          const messageId = addToQueue({
            from: from,
            body: body,
            accountId: account.accountId,
          });

          console.log(`Message ${messageId} added to queue`);

          const senderBareJid = from.split('/')[0];
          const senderNick = from.split('/')[1];
          const msgType = options?.type || 'chat';

          console.log(`[DEBUG] Persist: type=${msgType}, room=${options?.room}, fromBareJid=${senderBareJid}`);

          try {
            messageStore.saveMessage({
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
            console.log(`[MessageStore] Persisted ${msgType} message from ${senderBareJid}`);
          } catch (err) {
            console.error('[MessageStore] Failed to persist message:', err);
          }

          if (runtime?.channel) {
            console.log("Attempting to forward via runtime.channel methods");

            let dispatchSuccess = false;
            let dispatchError: any = null;

            if (runtime.channel.session?.recordInboundSession) {
              console.log(`Fallback for ${options?.type} message from ${from}`);
              try {
                console.log("Trying simple recordInboundSession as fallback");

                const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
                  agentId: "main",
                });
                console.log("storePath resolved to:", storePath);
                console.log("ctx.cfg.session?.store:", ctx.cfg.session?.store);

                const senderBareJidSession = from.split('/')[0];
                const isRoomJid = !!options?.room;

                let sessionKey: string;
                let replyTo: string;

                if (isRoomJid) {
                  sessionKey = `xmpp:${senderBareJidSession}`;
                  replyTo = options!.room || senderBareJidSession;
                  console.log("sessionKey (groupchat):", sessionKey, "replyTo:", replyTo);
                } else {
                  sessionKey = `xmpp:${senderBareJidSession}`;
                  replyTo = senderBareJidSession;
                  console.log("sessionKey (direct chat):", sessionKey);
                }

                console.log(`replyTo set to: ${replyTo}`);

                const nick = options?.nick || from.split('/')[1] || 'unknown';
                const payloadJid = senderBareJidSession;
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
                    console.error("❌ Error recording session:", err);
                    console.error("Error details:", err instanceof Error ? err.stack : err);
                  },
                });

                console.log("✅ Message recorded via fallback");
                console.log("✅ Message recorded to session store");

                console.log("Checking available dispatch methods...");
                console.log("runtime.channel.reply methods:", runtime.channel.reply ? Object.keys(runtime.channel.reply) : "none");
                console.log("runtime.dispatchInboundMessage?", typeof runtime.dispatchInboundMessage === 'function' ? "yes" : "no");

                try {
                  const sendReply = async (replyText: string, _replyTo?: string): Promise<void> => {
                    console.log(`[REPLY] Reply called with: ${replyText?.substring(0, 100)}...`);
                    try {
                      let replyTarget = _replyTo || replyTo || from;
                      console.log(`[REPLY] Original from: ${from}, resolved replyTo: ${replyTo}, using replyTarget: ${replyTarget}`);

                      const isGroupChatReply = (options?.type === "groupchat");
                      console.log(`[REPLY] isGroupChatReply: ${isGroupChatReply}`);

                      if (isGroupChatReply) {
                        const roomForReply = options?.room || from.split('/')[0];
                        replyTarget = roomForReply;
                        console.log(`[REPLY] Groupchat reply - sending to room: ${roomForReply}`);
                      }

                      if (!replyTarget) {
                        console.error(`[REPLY] ERROR: replyTarget is null/undefined! from=${from}, options=`, options);
                        return;
                      }

                      await xmpp.send(replyTarget, replyText);
                      console.log(`✅ Reply sent via XMPP: ${replyText?.substring(0, 50)}...`);
                    } catch (err) {
                      console.error(`❌ Error sending reply:`, err);
                    }
                  };

                  const textReply = async (response: any): Promise<void> => {
                    console.log(`[REPLY] textReply called with: ${JSON.stringify(response).substring(0, 200)}`);
                    await sendReply(response.text);
                  };

                  const channelReply = {
                    text: textReply,
                    debugText: async (response: any) => {
                      console.log(`[DEBUG REPLY] Response: ${JSON.stringify(response).substring(0, 200)}`);
                      if (response.text) {
                        await sendReply(response.text);
                      }
                    },
                    debugJson: async (response: any) => {
                      console.log(`[DEBUG JSON] Response:`, response);
                      if (response.text) {
                        await sendReply(response.text);
                      }
                    },
                    send: async (response: any) => {
                      console.log(`[SEND] Response: ${JSON.stringify(response).substring(0, 200)}`);
                      if (response.text) {
                        await sendReply(response.text);
                      }
                    }
                  };

                  const inboundPayload = {
                    ctx: {
                      ...ctxPayload,
                      reply: channelReply,
                      sendReply: sendReply,
                    },
                    sessionKey,
                    runtime: {
                      channel: runtime.channel,
                    },
                    blocking: false
                  };

                  console.log("=== DISPATCHING TO CHANNEL ===");
                  console.log("Time:", new Date().toISOString());
                  console.log("sessionKey:", sessionKey);
                  console.log("body preview:", body?.substring(0, 100));
                  console.log("options:", JSON.stringify(options).substring(0, 200));
                  console.log("runtime keys:", Object.keys(runtime || {}).join(", "));
                  console.log("channel keys:", runtime?.channel ? Object.keys(runtime.channel).join(", ") : "none");

                  try {
                    if (typeof runtime.channel.text === 'function') {
                      console.log("✅ Calling runtime.channel.text()");

                      const textResult = await runtime.channel.text(sessionKey, {
                        Body: body,
                        SenderId: ctxPayload.SenderId,
                        SenderName: ctxPayload.SenderName,
                        AccountId: account.accountId,
                        Channel: "xmpp",
                        OriginatingChannel: "xmpp",
                        Provider: "xmpp",
                        Surface: "xmpp",
                        sendReply: sendReply,
                        reply: channelReply,
                      });

                      console.log("✅ runtime.channel.text() succeeded, result:", textResult);
                      dispatchSuccess = true;
                    } else if (typeof runtime.channel.message === 'function') {
                      console.log("Using runtime.channel.message()");

                      const messageResult = await runtime.channel.message(sessionKey, {
                        Body: body,
                        SenderId: ctxPayload.SenderId,
                        SenderName: ctxPayload.SenderName,
                        AccountId: account.accountId,
                        Channel: "xmpp",
                        OriginatingChannel: "xmpp",
                        Provider: "xmpp",
                        Surface: "xmpp",
                        sendReply: sendReply,
                        reply: channelReply,
                      });

                      console.log("runtime.channel.message() result:", messageResult);
                      dispatchSuccess = true;
                    } else {
                      console.log("No standard dispatch method found");
                    }
                  } catch (dispatchErr) {
                    console.error("❌ Dispatch error:", dispatchErr);
                    dispatchError = dispatchErr;
                  }

                  console.log("=== DISPATCH COMPLETE ===");
                  console.log("Success:", dispatchSuccess);
                  console.log("Error:", dispatchError);

                } catch (err) {
                  console.error("❌ Error in dispatch flow:", err);
                  dispatchError = err;
                }

                console.log("=== FALLBACK COMPLETE ===");
                console.log("Success:", dispatchSuccess);
                console.log("Error:", dispatchError);

                if (!dispatchSuccess) {
                  console.log("Fallback also failed");
                }

              } catch (err) {
                console.error("Fallback error:", err);
                dispatchError = err;
              }
            } else {
              console.log("No recordInboundSession available");
            }
          } else {
            console.log("No runtime.channel available, using queue only");
          }

          console.log(`[FINAL] Message from ${from} dispatch: success=${dispatchSuccess}, error=${dispatchError ? 'yes' : 'no'}`);
        });

        xmppClients.set(account.accountId, xmpp);

        console.log(`[${account.accountId}] XMPP client started and registered`);

        return {
          running: true,
          stop: async () => {
            console.log(`[${account.accountId}] Stopping XMPP...`);
            isRunning = false;
            try {
              const xmppToStop = xmppClients.get(account.accountId);
              if (xmppToStop) {
                console.log(`[${account.accountId}] Calling xmpp.stop()`);
                await xmppToStop.stop();
              }
              xmppClients.delete(account.accountId);
              console.log(`[${account.accountId}] XMPP stopped`);
            } catch (err) {
              console.error(`[${account.accountId}] Error stopping XMPP:`, err);
            }
          }
        };
      }
    }
  };

  if (isCliRegistration) {
    console.log("CLI registration detected - skipping gateway plugin registration");
    debugLog("CLI mode - registering CLI commands only");

    if (api.program) {
      console.log("Registering CLI commands via program");
      registerXmppCli({
        program: api.program,
        getXmppClient: (accountId?: string) => xmppClients.get(accountId || "default"),
        logger: log,
        getUnprocessedMessages,
        clearOldMessages,
        messageQueue,
        getContacts: (accountId?: string) => {
          const id = accountId || "default";
          let contacts = contactsStore.get(id);
          if (!contacts) {
            const dataDir = path.join(process.cwd(), 'data');
            contacts = new Contacts(dataDir);
            contactsStore.set(id, contacts);
          }
          return contacts;
        }
      });
      console.log("CLI commands registered successfully");
    } else {
      console.log("No program object found in API");
      debugLog("No program object for CLI registration");
    }
  }

  console.log("About to register XMPP channel plugin");
  api.registerChannel({ plugin: xmppChannelPlugin });
  log.info("XMPP channel plugin registered");

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
    const roomNicksMap = client.roomNicks || new Map();
    const roomsWithNicks = rooms.map(room => ({
      room,
      nick: roomNicksMap instanceof Map ? roomNicksMap.get(room) : undefined
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

  api.registerGatewayMethod("xmpp.removeContact", ({ params, respond }) => {
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
      const removed = contacts.remove(jid);
      if (removed) {
        respond(true, { ok: true, jid });
      } else {
        respond(false, { error: "Contact not found" });
      }
    } catch (err: any) {
      respond(false, { error: err.message || String(err) });
    }
  });

  api.registerCli(
    ({ program }) => {
      const getXmppClient = () => {
        return xmppClients.get("default") || xmppClients.values().next().value;
      };

      registerXmppCli({
        program,
        getXmppClient,
        logger: log,
        getUnprocessedMessages,
        clearOldMessages,
        messageQueue,
        getContacts: (accountId?: string) => {
          const id = accountId || "default";
          let contacts = contactsStore.get(id);
          if (!contacts) {
            const dataDir = path.join(process.cwd(), 'data');
            contacts = new Contacts(dataDir);
            contactsStore.set(id, contacts);
          }
          return contacts;
        }
      });
    }
  );
}
