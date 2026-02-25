import fs from "fs";
import path from "path";
import crypto from "crypto";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { MessageStore } from "./src/messageStore.js";
import { validators } from "./src/security/validation.js";
import { secureLog } from "./src/security/logging.js";
import { decryptPasswordFromConfig } from "./src/security/encryption.js";
import { debugLog, sanitize, checkRateLimit, setDebugLogDir, MAX_FILE_SIZE } from "./src/shared/index.js";
import { Config } from "./src/config.js";

const MAX_CONCURRENT_TRANSFERS = Config.MAX_CONCURRENT_TRANSFERS;
const activeDownloads = new Map<string, { size: number; startTime: number }>();

// Set debug log directory to plugin directory
setDebugLogDir(__dirname);

debugLog(`XMPP plugin loading at ${new Date().toISOString()}`);

let pluginRegistered = false;

// Global store for XMPP clients by account ID
export const xmppClients = new Map<string, any>();

// Global store for Contacts by account ID
export const contactsStore = new Map<string, any>();

// Store runtime for message forwarding
let pluginRuntime: any = null;

// Message queue for inbound messages (workaround for missing inbound API)
interface QueuedMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  accountId: string;
  processed: boolean;
}

const messageQueue: QueuedMessage[] = [];
const messageQueueMaxSize = Config.MESSAGE_QUEUE_MAX_SIZE;

// We'll import @xmpp/client lazily when needed
let xmppClientModule: any = null;

import { Contacts } from "./src/contacts.js";

import { VCard } from "./src/vcard.js";


// Message queue management
function addToQueue(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'processed'>) {
  const queuedMessage: QueuedMessage = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...message,
    timestamp: Date.now(),
    processed: false,
  };
  
  messageQueue.push(queuedMessage);
  
  // Keep queue size manageable
  if (messageQueue.length > messageQueueMaxSize) {
    messageQueue.length = messageQueueMaxSize;
  }
  
  console.log(`Message queued: ${queuedMessage.id} from ${queuedMessage.from}`);
  return queuedMessage.id;
}

function getUnprocessedMessages(accountId?: string): QueuedMessage[] {
  return messageQueue.filter(msg => 
    !msg.processed && (!accountId || msg.accountId === accountId)
  );
}

function markAsProcessed(messageId: string) {
  const msg = messageQueue.find(m => m.id === messageId);
  if (msg) {
    msg.processed = true;
  }
}

function clearOldMessages(maxAgeMs: number = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const oldCount = messageQueue.length;
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (messageQueue[i].timestamp < cutoff) {
      messageQueue.splice(i, 1);
    }
  }
  console.log(`Cleared ${oldCount - messageQueue.length} old messages`);
}

// Export queue functions for commands module
export { addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages, messageQueue };

import { startXmpp } from "./src/startXmpp.js";

// Import CLI commands module
import { registerXmppCli } from "./src/commands.js";

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
  
  // Check if this is CLI registration or Gateway registration
  // CLI registration: api.runtime is not available
  // Gateway registration: api.runtime IS available
  const isCliRegistration = !api.runtime;
  console.log(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);
  console.log(`api.runtime available: ${api.runtime ? 'yes' : 'no'}`);
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

        // Get the XMPP client from global store
        const xmpp = xmppClients.get(accountId || "default");
        console.log("XMPP client available:", !!xmpp);

        if (!xmpp) {
          return { ok: false, error: "XMPP client not available" };
        }

        try {
          // Strip xmpp: prefix if present
          const cleanTo = to.replace(/^xmpp:/, '');

          // Filter out "Thinking..." prefixes from agent responses
          let cleanText = text;
          const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
          const match = text.match(thinkingRegex);
          if (match) {
            console.log(`Filtering "Thinking..." prefix from message`);
            cleanText = text.slice(match[0].length).trim();
          }

          console.log(`Attempting to send message to ${cleanTo}: ${cleanText.substring(0, 100)}...`);

          // Check if this is a groupchat (has conference in domain)
          const isGroupChat = cleanTo.includes('@conference.');

           if (isGroupChat) {
            // For groupchat, use sendGroupchat
            await xmpp.sendGroupchat(cleanTo.split('/')[0], cleanText);
            console.log("Groupchat message sent successfully");
          } else {
            // For direct messages, use regular send
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
        
        // Get the XMPP client from global store
        const xmpp = xmppClients.get(accountId || "default");
        console.log("XMPP client available:", !!xmpp);
        
        if (!xmpp) {
          return { ok: false, error: "XMPP client not available" };
        }
        
        try {
          // Check if this is a groupchat (room) or direct message
          const isGroupChat = to.includes('@conference.') || to.includes('/');
          
          // Try to use loadWebMedia if available in deps
          let localFilePath: string | null = null;
          
          if (deps?.loadWebMedia) {
            console.log("Using loadWebMedia from deps");
            try {
              // loadWebMedia handles URLs, file paths, optimization, and size limits
              const result = await deps.loadWebMedia(mediaUrl);
              localFilePath = result.path || result.url || mediaUrl;
              console.log(`loadWebMedia returned path: ${localFilePath}`);
            } catch (err) {
              console.error("loadWebMedia failed:", err);
              // Fallback to direct handling
            }
          }
          
          // If we have a local file path (from loadWebMedia or already a file path)
          if (!localFilePath) {
            // Check if mediaUrl is already a local file path
            if (mediaUrl.startsWith('file://')) {
              localFilePath = mediaUrl.substring(7); // Remove file://
            } else if (mediaUrl.startsWith('/') || mediaUrl.startsWith('~/') || mediaUrl.startsWith('.') || path.isAbsolute(mediaUrl)) {
              localFilePath = mediaUrl;
            }
          }
          
          if (localFilePath && fs.existsSync(localFilePath)) {
            // Resolve ~ to home directory
            if (localFilePath.startsWith('~/')) {
              localFilePath = path.join(process.env.HOME || process.env.USERPROFILE || '', localFilePath.substring(2));
            }
            
            console.log(`Sending local file: ${localFilePath}`);
            
            // Use XMPP file transfer
            await xmpp.sendFile(to, localFilePath, text, isGroupChat);
            
            console.log("File sent successfully via XMPP file transfer");
            return { ok: true, channel: "xmpp" };
          } else {
            // Fallback to URL sharing (out-of-band data)
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
        
        // Initialize super admin from config if specified
        if (config?.adminJid?.trim()) {
          const adminJid = config.adminJid?.trim() || '';
          if (!contacts.isAdmin(adminJid)) {
            contacts.addAdmin(adminJid);
            console.log(`[${account.accountId}] Added super admin from config: ${adminJid}`);
            log?.info(`[${account.accountId}] Added super admin from config: ${adminJid}`);
          }
        }
        
        // Log admin count
        const adminCount = contacts.listAdmins().length;
        console.log(`[${account.accountId}] Total admins: ${adminCount}`);
        log?.info(`[${account.accountId}] Total admins: ${adminCount}`);
        
        // Check for existing connection to prevent duplicate connections
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
        
        // Initialize message store for persistence
        const dataDir = config.dataDir || path.join(process.cwd(), 'data');
        const messageStore = new MessageStore(dataDir);
        
         let isRunning = true;
 
          // Use pluginRuntime (from api.runtime) instead of ctx.runtime
          const runtime = pluginRuntime;
          debugLog("Using pluginRuntime in startAccount");
           
            const xmpp = await startXmpp(config, contacts, log, async (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean }) => {
             if (!isRunning) {
               debugLog("XMPP message ignored - plugin not running");
               return;
             }

              debugLog(`XMPP inbound from ${from}`);
              
              // Track dispatch success for message processing
              let dispatchSuccess = false;
              let dispatchError: any = null;
              
               // Helper to build context payload based on message type
             // Uses shared session key (bare JID) for both direct and groupchat
              const buildContextPayload = (sessionKey: string, senderBareJid: string) => {
                const room = options?.room || from;
                const nick = options?.nick || from.split('@')[0];

                // Use consistent senderId based on session (not room/nick)
                // This enables shared memory between direct chat and groupchat
                const senderId = senderBareJid;
                const senderName = from.split('@')[0];

                // IMPORTANT: Use "direct" chatType for BOTH direct and groupchat
                // This prevents openclaw from creating separate "group" sessions
                // The SessionKey determines conversation identity, not ChatType
                const chatType = "direct" as const;
                const conversationLabel = `XMPP: ${senderBareJid}`;
                const botNick = options?.botNick || null;
                debugLog(`buildContextPayload: senderId=${senderId}, sessionKey=${sessionKey}`);

                // Generate unique message ID using crypto.randomUUID()
                const uniqueMessageId = `xmpp-${crypto.randomUUID()}`;

               return {
                 Body: body,
                 RawBody: body,
                 CommandBody: body,
                 From: `xmpp:${senderBareJid}`,  // Use bare JID for shared session
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
            
            // Add message to queue for polling
            const messageId = addToQueue({
              from: from,
              body: body,
              accountId: account.accountId,
            });
           
            console.log(`Message ${messageId} added to queue`);
            
            // Persist message to JSON storage
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
            
              // Try to forward message using runtime channel methods
             // Use captured runtime from closure
             if (runtime?.channel) {
               console.log("Attempting to forward via runtime.channel methods");
               
               // Track dispatch success across all methods
               let dispatchSuccess = false;
               let dispatchError: any = null;
               
               // Route-based routing is disabled (future feature)
               // const route: { agentId: string; sessionKey: string; mainSessionKey?: string } | null = null;
               // if (route) { ... }
              
               // Fallback: Try the simple approach if routing failed
               if (runtime.channel.session?.recordInboundSession) {
                 console.log(`Fallback for ${options?.type} message from ${from}`);
                 try {
                   console.log("Trying simple recordInboundSession as fallback");
                  
                  // Get store path using main agent (matches session store path)
                  const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
                    agentId: "main",
                  });
                  console.log("storePath resolved to:", storePath);
                  console.log("ctx.cfg.session?.store:", ctx.cfg.session?.store);
                  
                   // Use bare JID for session key
                   const senderBareJid = from.split('/')[0];
                   const isRoomJid = !!options?.room;
                   
                   let sessionKey: string;
                   let replyTo: string;
                   
                    if (isRoomJid) {
                      // Groupchat: session uses sender bare JID, reply to room
                      sessionKey = `xmpp:${senderBareJid}`;
                      replyTo = options!.room || senderBareJid;
                      console.log("sessionKey (groupchat):", sessionKey, "replyTo:", replyTo);
                   } else {
                     // Direct message
                     sessionKey = `xmpp:${senderBareJid}`;
                     replyTo = senderBareJid;
                     console.log("sessionKey (direct chat):", sessionKey);
                   }
                   
                   console.log(`replyTo set to: ${replyTo}`);

                      // Determine the JID to use in context payload
                      const nick = options?.nick || from.split('/')[1] || 'unknown';
                      // Use bare JID directly (no nickToJidMap)
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
                    onRecordError: (err) => {
                      console.error("❌ Error recording session:", err);
                      console.error("Error details:", err instanceof Error ? err.stack : err);
                    },
                  });
                  
                    console.log("✅ Message recorded via fallback");
                    console.log("✅ Message recorded to session store");
                    
                    // Check what dispatch methods are available
                    console.log("Checking available dispatch methods...");
                    console.log("runtime.channel.reply methods:", runtime.channel.reply ? Object.keys(runtime.channel.reply) : "none");
                    console.log("runtime.dispatchInboundMessage?", typeof runtime.dispatchInboundMessage === 'function' ? "yes" : "no");
                    
 
                     
                    // Track dispatch success across all methods
                    let dispatchSuccess = false;
                    let dispatchError: any = null;
                    
                    console.log("=== STARTING DISPATCH ===");
                    console.log("Time:", new Date().toISOString());
                    
                    try {
                      // METHOD 1: dispatchReplyFromConfig (fast path)
                      if (runtime.channel.reply?.dispatchReplyFromConfig && !dispatchSuccess) {
                         console.log("🎯 METHOD 1: dispatchReplyFromConfig (fast path)");
                         
                         const immediateSendText = async (to: string, text: string) => {
                           console.log("🚀 IMMEDIATE sendText CALLED! Time:", new Date().toISOString());
                           console.log("  To:", to);
                           console.log("  Text:", text);
                           
                           let jid = to;
                            if (to.startsWith('xmpp:')) {
                              jid = to.substring(5);
                            }

                            // Filter out "Thinking..." prefixes from agent responses
                            let cleanText = text;
                            const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
                            const match = text.match(thinkingRegex);
                            if (match) {
                              console.log(`[FILTER] Removing "Thinking..." prefix`);
                              cleanText = text.slice(match[0].length).trim();
                            }

                             try {
                               if (options?.type === "groupchat") {
                                 await xmpp.sendGroupchat(jid, cleanText);
                                 console.log("✅✅✅ GROUPCHAT REPLY SENT VIA XMPP! Time:", new Date().toISOString());
                               } else {
                                 await xmpp.send(jid, cleanText);
                                 console.log("✅✅✅ DIRECT REPLY SENT VIA XMPP! Time:", new Date().toISOString());
                               }
                               
                                // Save outbound message to persistence
                                // For direct messages, save to the RECIPIENT's file (jid), not sender's (config.jid)
                                try {
                                  const saveStart = Date.now();
                                  messageStore.saveMessage({
                                    direction: 'outbound',
                                    type: (options?.type || 'chat') as 'chat' | 'groupchat',
                                    roomJid: options?.room || undefined,
                                    fromBareJid: jid,  // Save to recipient's file
                                    fromFullJid: `${config.jid}/openclaw`,
                                    to: config.jid,
                                    body: cleanText,
                                    timestamp: Date.now(),
                                    accountId: account.accountId
                                  });
                                  console.log(`[MessageStore] Persisted outbound ${options?.type || 'chat'} message to ${jid} (${Date.now() - saveStart}ms)`);
                                } catch (err) {
                                  console.error('[MessageStore] Failed to save outbound message:', err);
                                }
                               
                               return { ok: true, channel: "xmpp" };
                             } catch (err) {
                               console.error('❌❌❌ XMPP SEND ERROR:', err);
                               return { ok: false, error: String(err), channel: "xmpp" };
                             }
                           };
                           const replyToXmpp = `xmpp:${replyTo}`;
                           
                           const simpleDispatcher = {
                             sendBlockReply: async (payload: any) => {
                               console.log("🎯 DISPATCHER sendBlockReply called!", payload);
                               return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                             },
                             sendFinalReply: async (payload: any) => {
                               console.log("🎯 DISPATCHER sendFinalReply called!", payload);
                               return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                             },
                             deliver: async (payload: any) => {
                               console.log("🎯 DISPATCHER deliver called!", payload);
                               return immediateSendText(replyToXmpp, payload?.text || payload?.message || payload?.body || JSON.stringify(payload));
                             },
                             sendText: async (to: string, text: string) => {
                               console.log("🎯 DISPATCHER sendText called!", { to, text });
                               return immediateSendText(to, text);
                             },
                             sendMessage: async (msg: any) => {
                               console.log("🎯 DISPATCHER sendMessage called!", msg);
                               return immediateSendText(msg?.to || replyToXmpp, msg?.text || msg?.body || JSON.stringify(msg));
                             },
                            
                            // Stub other methods
                            waitForIdle: async () => ({ ok: true }),
                            getQueuedCounts: async () => ({ ok: true, counts: {} }),
                          };
                         
                          const dispatchStart = Date.now();
                          
                          // Properly await dispatch result
                          console.log("🔄 Calling dispatchReplyFromConfig...");
                          try {
                            const result = await runtime.channel.reply.dispatchReplyFromConfig({
                              ctx: ctxPayload,
                              cfg: ctx.cfg,
                              dispatcher: simpleDispatcher,
                              replyOptions: {},
                            });
                            console.log("✅ dispatchReplyFromConfig returned:", result);
                            if (result?.ok !== false) {
                              dispatchSuccess = true;
                            }
                          } catch (err) {
                            console.error("❌ Dispatch error (Method 1):", err);
                            dispatchError = err;
                          }
                          
                          if (dispatchSuccess) {
                            console.log(`✅ METHOD 1 succeeded`);
                          }
                       }
                       
                       // METHOD 2: dispatchReplyWithBufferedBlockDispatcher (if first failed)
                       if (runtime.channel.reply?.dispatchReplyWithBufferedBlockDispatcher && !dispatchSuccess) {
                         console.log("🎯 METHOD 2: dispatchReplyWithBufferedBlockDispatcher (backup)");
                         
                         const sendText = async (to: string, text: string) => {
                           console.log("📤 METHOD 2 sendText CALLED!");
                           console.log("  To:", to);
                           console.log("  Text:", text);
                           
                           let jid = to;
                           if (to.startsWith('xmpp:')) {
                             jid = to.substring(5);
                           }
                           
                            try {
                              if (options?.type === "groupchat") {
                                await xmpp.sendGroupchat(jid, text);
                                console.log("✅✅✅ GROUPCHAT REPLY SENT VIA XMPP (Method 2)!");
                              } else {
                                await xmpp.send(jid, text);
                                console.log("✅✅✅ DIRECT REPLY SENT VIA XMPP (Method 2)!");
                              }
                              return { ok: true, channel: "xmpp" };
                            } catch (err) {
                              console.error("❌ XMPP SEND ERROR (Method 2):", err);
                              return { ok: false, error: String(err) };
                            }
                         };
                         
                          const dispatchStart = Date.now();
                          
                          // Properly await dispatch
                          try {
                            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                              ctx: ctxPayload,
                              cfg: ctx.cfg,
                              sendText: sendText,
                              dispatcherOptions: {},
                            });
                            dispatchSuccess = true;
                            console.log(`✅ METHOD 2 succeeded`);
                          } catch (err) {
                            console.error("Method 2 dispatch error:", err);
                            dispatchError = err;
                          }
                       }
                       
                       console.log("=== DISPATCH ATTEMPTS COMPLETE ===");
                     } catch (err) {
                       console.error("❌❌❌ FATAL DISPATCH ERROR:", err);
                       console.error("Error details:", err instanceof Error ? err.stack : err);
                       dispatchError = err;
                     }
                   
                   // Only mark as processed if dispatch succeeded
                   if (dispatchSuccess) {
                     console.log("✅ Dispatch succeeded - marking message as processed");
                     markAsProcessed(messageId);
                   } else {
                     console.log("⚠️ Dispatch failed - message remains in queue for polling");
                     console.log("⚠️ Dispatch error:", dispatchError || "Unknown error");
                   }
                   return;
                } catch (err) {
                  console.error("❌ Error with fallback:", err);
                }
              }
             
               // Note: Other channel methods don't exist or aren't for inbound messages
           }
           
            // Fallback: Try to find the correct inbound method on ctx
            const inboundMethods = ['receiveText', 'receiveMessage', 'inbound', 'dispatch'];
            
             for (const methodName of inboundMethods) {
               if (typeof ctx[methodName] === 'function' && !dispatchSuccess) {
                 console.log(`✅ Found ctx.${methodName}`);
                 try {
                   const senderBareJid = from.split('/')[0];
                   if (methodName === 'receiveText' || methodName === 'receiveMessage') {
                     await ctx[methodName]({
                       from: `xmpp:${senderBareJid}`,
                       to: `xmpp:${config.jid}`,
                       body: body,
                       channel: "xmpp",
                       accountId: account.accountId,
                     });
                   } else {
                     await ctx[methodName](senderBareJid, body, {
                       channel: "xmpp",
                       accountId: account.accountId,
                     });
                   }
                   console.log(`✅ Message forwarded via ctx.${methodName}`);
                   dispatchSuccess = true;
                   break;
                 } catch (err) {
                   console.error(`❌ Error with ctx.${methodName}:`, err);
                   dispatchError = err;
                 }
               }
             }
            
            // Try dispatchInboundMessage if ctx methods failed
            if (runtime?.dispatchInboundMessage && !dispatchSuccess) {
              try {
                console.log("Trying runtime.dispatchInboundMessage");
                 const senderBareJid = from.split('/')[0];
                 const ctxPayload = buildContextPayload(`xmpp:${senderBareJid}`, senderBareJid);

                await runtime.dispatchInboundMessage({
                  ctx: ctxPayload,
                  cfg: ctx.cfg,
                });
                console.log("✅ Message dispatched via runtime.dispatchInboundMessage");
                dispatchSuccess = true;
              } catch (err) {
                console.error("❌ Error with dispatchInboundMessage:", err);
                dispatchError = err;
              }
            }

            // Try channel.activity.record as last resort (only logs, doesn't count as success)
            if (runtime?.channel?.activity?.record && !dispatchSuccess) {
              try {
                console.log("Trying channel.activity.record");
                const senderBareJid = from.split('/')[0];
                runtime.channel.activity.record({
                  channel: "xmpp",
                  accountId: account.accountId,
                  from: `xmpp:${senderBareJid}`,
                  action: "message:inbound",
                  data: { body: body },
                });
                console.log("✅ Activity recorded (but dispatch still failed)");
              } catch (err) {
                console.error("❌ Error recording activity:", err);
              }
            }
            
            // Final success check - mark as processed only if dispatch succeeded
            if (dispatchSuccess) {
              console.log("✅ Dispatch succeeded - marking message as processed");
              markAsProcessed(messageId);
            } else {
              console.log("⚠️ All dispatch methods failed - message remains in queue for polling");
              console.log("⚠️ Last error:", dispatchError || "Unknown error");
            }
           
           // Note: api.emit doesn't exist, only api.on for listening
         });

          // Auto-join configured rooms - DISABLED by default
          // Rooms require invites, do not auto-join
          if (Array.isArray(config.rooms) && config.rooms.length > 0 && config.rooms.length > 0) {
            console.log(`[${account.accountId}] Auto-join config found but disabled (rooms require invites)`);
            console.log(`[${account.accountId}] Rooms in config:`, config.rooms);
            console.log(`[${account.accountId}] To enable auto-join, set autoJoinRooms: true in config`);
          }

          // Store client globally by account ID
         xmppClients.set(account.accountId, xmpp);

          ctx.setStatus({
           accountId: account.accountId,
           running: true,
           lastStartAt: Date.now(),
         });
        
        ctx.abortSignal.addEventListener("abort", () => {
          isRunning = false;
          log?.info(`[${account.accountId}] XMPP connection stopping`);
        });
        
        return new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => {
            isRunning = false;
            ctx.setStatus({
              accountId: account.accountId,
              running: false,
              lastStopAt: Date.now(),
            });
            resolve();
          });
        });
      },
      stopAccount: async (ctx: any): Promise<void> => {
        isRunning = false;
        const xmpp = xmppClients.get(ctx.accountId || "default");
        if (xmpp) {
          try {
            await xmpp.stop();
            debugLog("XMPP client stopped");
          } catch (err) {
            ctx.log?.error("Error stopping XMPP client:", err);
          }
          xmppClients.delete(ctx.accountId || "default");
        }
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
        ctx.log?.info("XMPP connection stopped");
      },
    },
  };

  console.log("About to register XMPP channel plugin");
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