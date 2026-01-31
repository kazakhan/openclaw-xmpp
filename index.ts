import fs from "fs";
import path from "path";

console.log("XMPP plugin loading at", new Date().toISOString());

// Global store for XMPP clients by account ID
export const xmppClients = new Map<string, any>();

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
const messageQueueMaxSize = 100;

// Set TLS environment variable at module load time
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// We'll import @xmpp/client lazily when needed
let xmppClientModule: any = null;

class Contacts {
  private contactsFile: string;
  private adminsFile: string;
  private contactsCache: Array<{ jid: string; name: string }>;
  private adminsCache: Set<string>;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.contactsFile = path.join(dataDir, "xmpp-contacts.json");
    this.adminsFile = path.join(dataDir, "xmpp-admins.json");
    this.contactsCache = this.loadContacts();
    this.adminsCache = this.loadAdmins();
  }

  private loadContacts(): Array<{ jid: string; name: string }> {
    if (!fs.existsSync(this.contactsFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.contactsFile, "utf8"));
    } catch {
      return [];
    }
  }

  private loadAdmins(): Set<string> {
    if (!fs.existsSync(this.adminsFile)) return new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.adminsFile, "utf8"));
      return new Set(Array.isArray(data) ? data : []);
    } catch {
      return new Set();
    }
  }

  private saveContacts() {
    try {
      fs.writeFileSync(this.contactsFile, JSON.stringify(this.contactsCache, null, 2));
    } catch (err) {
      console.error("Failed to save contacts:", err);
    }
  }

  private saveAdmins() {
    try {
      fs.writeFileSync(this.adminsFile, JSON.stringify(Array.from(this.adminsCache), null, 2));
    } catch (err) {
      console.error("Failed to save admins:", err);
    }
  }

  // Contacts management
  list() {
    return this.contactsCache;
  }

  exists(jid: string) {
    return this.contactsCache.some(c => c.jid === jid);
  }

  add(jid: string, name?: string) {
    // Remove resource part if present
    const bareJid = jid.split('/')[0];
    
    // Check if already exists
    const existingIndex = this.contactsCache.findIndex(c => c.jid === bareJid);
    if (existingIndex >= 0) {
      // Update existing contact
      this.contactsCache[existingIndex].name = name || this.contactsCache[existingIndex].name || bareJid.split('@')[0];
    } else {
      // Add new contact
      this.contactsCache.push({
        jid: bareJid,
        name: name || bareJid.split('@')[0]
      });
    }
    this.saveContacts();
    return true;
  }

  remove(jid: string) {
    const bareJid = jid.split('/')[0];
    const initialLength = this.contactsCache.length;
    this.contactsCache = this.contactsCache.filter(c => c.jid !== bareJid);
    if (this.contactsCache.length < initialLength) {
      this.saveContacts();
      return true;
    }
    return false;
  }

  getName(jid: string): string | undefined {
    const bareJid = jid.split('/')[0];
    const contact = this.contactsCache.find(c => c.jid === bareJid);
    return contact?.name;
  }

  // Admin management
  isAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    return this.adminsCache.has(bareJid);
  }

  addAdmin(jid: string) {
    const bareJid = jid.split('/')[0];
    this.adminsCache.add(bareJid);
    this.saveAdmins();
    return true;
  }

  removeAdmin(jid: string) {
    const bareJid = jid.split('/')[0];
    const result = this.adminsCache.delete(bareJid);
    if (result) {
      this.saveAdmins();
    }
    return result;
  }

  listAdmins(): string[] {
    return Array.from(this.adminsCache);
  }

  // Get all JIDs (contacts + bot's own JID for completeness)
  getAllJids(): string[] {
    return this.contactsCache.map(c => c.jid);
  }
}

class VCard {
  private vcardFile: string;
  private vcardData: {
    fn?: string;
    nickname?: string;
    url?: string;
    desc?: string;
    avatarUrl?: string;
    avatarMimeType?: string;
    avatarData?: string; // base64
  };

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.vcardFile = path.join(dataDir, "xmpp-vcard.json");
    this.vcardData = this.loadVCard();
  }

  private loadVCard() {
    if (!fs.existsSync(this.vcardFile)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.vcardFile, "utf8"));
    } catch {
      return {};
    }
  }

  private saveVCard() {
    try {
      fs.writeFileSync(this.vcardFile, JSON.stringify(this.vcardData, null, 2));
    } catch (err) {
      console.error("Failed to save vCard:", err);
    }
  }

  getFN(): string | undefined {
    return this.vcardData.fn;
  }

  setFN(fn: string) {
    this.vcardData.fn = fn;
    this.saveVCard();
  }

  getNickname(): string | undefined {
    return this.vcardData.nickname;
  }

  setNickname(nickname: string) {
    this.vcardData.nickname = nickname;
    this.saveVCard();
  }

  getURL(): string | undefined {
    return this.vcardData.url;
  }

  setURL(url: string) {
    this.vcardData.url = url;
    this.saveVCard();
  }

  getDesc(): string | undefined {
    return this.vcardData.desc;
  }

  setDesc(desc: string) {
    this.vcardData.desc = desc;
    this.saveVCard();
  }

  getAvatarUrl(): string | undefined {
    return this.vcardData.avatarUrl;
  }

  setAvatarUrl(avatarUrl: string) {
    this.vcardData.avatarUrl = avatarUrl;
    this.saveVCard();
  }

  getAvatarData(): { mimeType?: string; data?: string } | undefined {
    if (!this.vcardData.avatarData) return undefined;
    return {
      mimeType: this.vcardData.avatarMimeType,
      data: this.vcardData.avatarData,
    };
  }

  setAvatarData(mimeType: string, data: string) {
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.saveVCard();
  }

  // Get all vCard data for XML generation
  getData() {
    return { ...this.vcardData };
  }

  // Set multiple fields at once
  update(fields: Partial<typeof this.vcardData>) {
    Object.assign(this.vcardData, fields);
    this.saveVCard();
  }
}

// Message queue management
function addToQueue(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'processed'>) {
  const queuedMessage: QueuedMessage = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...message,
    timestamp: Date.now(),
    processed: false,
  };
  
  messageQueue.unshift(queuedMessage);
  
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
export { addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages, messageQueue, xmppClients };

async function startXmpp(cfg: any, contacts: any, log: any, onMessage: (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean }) => void) {
  // Helper to get default resource/nick from JID local part
  const getDefaultResource = () => {
    const result = cfg.resource || cfg.jid.split("@")[0] || "clawdbot";
    console.log(`getDefaultResource: cfg.resource=${cfg.resource}, cfg.jid=${cfg.jid}, result=${result}`);
    return result;
  };
  const getDefaultNick = () => {
    const result = cfg.jid ? cfg.jid.split("@")[0] : "clawdbot";
    console.log(`getDefaultNick: cfg.jid=${cfg.jid}, result=${result}`);
    return result;
   };
   
   // File download helper for inbound attachments (available in stanza handler)
   const downloadFile = async (url: string, tempDir: string): Promise<string> => {
     console.log(`Downloading file from ${url}`);
     
     // Create temp directory if needed
     if (!fs.existsSync(tempDir)) {
       fs.mkdirSync(tempDir, { recursive: true });
     }
     
     // Generate filename from URL
     const urlObj = new URL(url);
     const pathname = urlObj.pathname;
     const filename = path.basename(pathname) || `file_${Date.now()}.bin`;
     const filePath = path.join(tempDir, filename);
     
     try {
       const response = await fetch(url);
       if (!response.ok) {
         throw new Error(`Download failed: ${response.status} ${response.statusText}`);
       }
       
       const buffer = await response.arrayBuffer();
       await fs.promises.writeFile(filePath, Buffer.from(buffer));
       
       console.log(`File downloaded to ${filePath} (${buffer.byteLength} bytes)`);
       return filePath;
     } catch (err) {
       console.error("File download failed:", err);
       throw err;
     }
   };

   const processInboundFiles = async (urls: string[]): Promise<string[]> => {
     if (urls.length === 0) return [];
     
     // Create temp directory for downloads
     const tempDir = path.join(cfg.dataDir, 'downloads');
     const localPaths: string[] = [];
     
     for (const url of urls) {
       try {
         const localPath = await downloadFile(url, tempDir);
         localPaths.push(localPath);
       } catch (err) {
         console.error(`Failed to download ${url}:`, err);
         // Continue with other files
       }
     }
     
     return localPaths;
   };
   
   console.log("Starting XMPP connection with TLS rejection disabled");
  console.log("startXmpp config:", {
    service: cfg.service,
    domain: cfg.domain,
    jid: cfg.jid,
    resource: cfg.resource,
    hasResource: cfg.resource !== undefined,
    jidLocalPart: cfg.jid ? cfg.jid.split("@")[0] : 'undefined'
  });
  
  // Lazy load @xmpp/client module
  if (!xmppClientModule) {
    console.log("Loading @xmpp/client module...");
    xmppClientModule = await import("@xmpp/client");
    console.log("XMPP client module loaded");
  }
  
  const { client, xml } = xmppClientModule;
  
   const xmpp = client({
     service: cfg.service,
     domain: cfg.domain,
     username: cfg.jid.split("@")[0],
     password: cfg.password,
      resource: getDefaultResource(),
     tls: { rejectUnauthorized: false }
   });

   // Helper to resolve room JID - add conference domain if missing
   const resolveRoomJid = (room: string): string => {
     if (room.includes('@')) {
       return room;
     }
     // Default to conference.domain for MUC rooms
     return `${room}@conference.${cfg.domain}`;
   };

  xmpp.on("error", (err: any) => {
    log.error("XMPP error", err);
    console.error("XMPP error details:", err);
  });
  
  xmpp.on("online", async (address: any) => {
    log.info("XMPP online as", address.toString());
    console.log("XMPP connected successfully as", address.toString());
    
    // Send initial presence to appear online
    try {
      const presence = xml("presence");
      await xmpp.send(presence);
      console.log("✅ Presence sent - should appear online now as", address.toString());
      log.info("Presence sent");
    } catch (err) {
      console.error("❌ Failed to send presence:", err);
      log.error("Failed to send presence", err);
    }
  });

   const joinedRooms = new Set<string>();
   const roomNicks = new Map<string, string>(); // room JID -> nick used by bot
   const roomsPendingConfig = new Set<string>(); // rooms waiting for configuration
    const ibbSessions = new Map<string, { sid: string, from: string, filename: string, size: number, data: Buffer, received: number }>(); // IBB session tracking

    // Initialize vCard with config defaults
    const vcard = new VCard(cfg.dataDir);
    // Update vCard with config defaults if fields are not set
    if (cfg.vcard) {
      const vcardData = vcard.getData();
      const updates: any = {};
      if (cfg.vcard.fn && !vcardData.fn) updates.fn = cfg.vcard.fn;
      if (cfg.vcard.nickname && !vcardData.nickname) updates.nickname = cfg.vcard.nickname;
      if (cfg.vcard.url && !vcardData.url) updates.url = cfg.vcard.url;
      if (cfg.vcard.desc && !vcardData.desc) updates.desc = cfg.vcard.desc;
      if (cfg.vcard.avatarUrl && !vcardData.avatarUrl) updates.avatarUrl = cfg.vcard.avatarUrl;
      if (Object.keys(updates).length > 0) {
        vcard.update(updates);
        console.log("vCard updated with config defaults:", updates);
      }
    }

   xmpp.on("stanza", async (stanza: any) => {
    console.log("XMPP stanza received:", stanza.toString());
    
    if (stanza.is("presence")) {
      const from = stanza.attrs.from;
      const type = stanza.attrs.type || "available";
      const parts = from.split('/');
      const room = parts[0];
      const nick = parts[1] || '';
      
       // Handle subscription requests (not MUC)
      if (type === "subscribe") {
        console.log(`📨 Received subscription request from ${from}`);
        // Add to contacts if not already
        const bareFrom = from.split('/')[0];
        if (!contacts.exists(bareFrom)) {
          contacts.add(bareFrom);
          console.log(`📝 Added ${bareFrom} to contacts`);
        }
        // Auto-approve subscription
        try {
          const subscribed = xml("presence", { to: from, type: "subscribed" });
          await xmpp.send(subscribed);
          console.log(`✅ Auto-approved subscription for ${from}`);
          
          // Also request subscription from them (mutual)
          const subscribe = xml("presence", { to: from, type: "subscribe" });
          await xmpp.send(subscribe);
          console.log(`📤 Sent subscription request to ${from}`);
        } catch (err) {
          console.error(`❌ Failed to handle subscription request from ${from}:`, err);
        }
        return;
      }
      
       // Handle other subscription types
      if (type === "subscribed" || type === "unsubscribe" || type === "unsubscribed") {
        console.log(`📨 Received ${type} from ${from}`);
        // Add to contacts if subscribed
        if (type === "subscribed") {
          const bareFrom = from.split('/')[0];
          if (!contacts.exists(bareFrom)) {
            contacts.add(bareFrom);
            console.log(`📝 Added ${bareFrom} to contacts after subscription approval`);
          }
        }
        return;
      }
      
      // Handle presence probes
      if (type === "probe") {
        console.log(`🔍 Received presence probe from ${from}`);
        // Respond with available presence
        try {
          const presence = xml("presence", { to: from });
          await xmpp.send(presence);
          console.log(`✅ Sent presence response to probe from ${from}`);
        } catch (err) {
          console.error(`❌ Failed to respond to presence probe from ${from}:`, err);
        }
        return;
      }
      
      // Check for MUC status codes
      const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
      if (xElement) {
        const statusElements = xElement.getChildren('status');
        for (const status of statusElements) {
          const code = status.attrs.code;
          console.log(`MUC status code ${code} for room ${room}, nick ${nick}`);
          // Common MUC status codes:
          // 201: Room created
          // 210: Room is being configured
          // 100: User's presence in room
          // 110: Self-presence (our own join)
          if (code === "201") {
            console.log(`🏗️ Room ${room} was created`);
            roomsPendingConfig.add(room);
          } else if (code === "210") {
            console.log(`⚙️ Room ${room} needs configuration`);
            roomsPendingConfig.add(room);
          } else if (code === "110") {
            console.log(`✅ Successfully joined room ${room} as ${nick}`);
            roomsPendingConfig.delete(room);
          }
        }
      }
      
      if (type === "unavailable") {
        console.log(`👋 User left room ${room}: ${nick} (${from})`);
      } else {
        console.log(`👋 User joined room ${room}: ${nick} (${from})`);
      }
    }
    
    if (stanza.is("iq")) {
      const from = stanza.attrs.from;
      const to = stanza.attrs.to;
      const type = stanza.attrs.type;
      const id = stanza.attrs.id;
      console.log(`IQ stanza received - Type: ${type}, From: ${from}, To: ${to}, ID: ${id}`);
      
      // Handle SI File Transfer requests (XEP-0096)
      if (type === "set") {
        const si = stanza.getChild("si", "http://jabber.org/protocol/si");
        if (si) {
          console.log(`SI file transfer offer from ${from}`);
          // Check for file transfer profile
          const file = si.getChild("file", "http://jabber.org/protocol/si/profile/file-transfer");
          if (file) {
            const filename = file.attrs.name || "unknown";
            const size = file.attrs.size ? parseInt(file.attrs.size) : 0;
            console.log(`File offer: ${filename} (${size} bytes)`);
            
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
              console.log(`Accepting SI file transfer with IBB: ${filename}`);
              // Capture session ID from SI element
              const sid = si.attrs.sid;
              if (!sid) {
                console.log("No SID in SI, rejecting");
                const errorIq = xml("iq", { to: from, type: "error", id },
                  xml("error", { type: "cancel" },
                    xml("bad-request", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
                    xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }, "Missing SID")
                  )
                );
                await xmpp.send(errorIq);
                return;
              }
              
              // Store IBB session
              ibbSessions.set(sid, {
                sid,
                from,
                filename,
                size,
                data: Buffer.alloc(0),
                received: 0
              });
              
              // Accept the SI request
              const acceptIq = xml("iq", { to: from, type: "result", id });
              await xmpp.send(acceptIq);
              console.log(`SI session ${sid} accepted, waiting for IBB open`);
            } else {
              // No supported method, reject
              console.log(`No supported stream method, rejecting SI transfer`);
              const errorIq = xml("iq", { to: from, type: "error", id },
                xml("error", { type: "cancel" },
                  xml("feature-not-implemented", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
                  xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }, "No supported stream method")
                )
              );
              await xmpp.send(errorIq);
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
           console.log(`Unknown IBB session ${sid}, rejecting`);
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("item-not-found", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await xmpp.send(errorIq);
           return;
         }
         // Accept open
         const resultIq = xml("iq", { to: from, type: "result", id });
         await xmpp.send(resultIq);
         console.log(`IBB session ${sid} opened for file ${session.filename}`);
         return;
       }
       
       const ibbData = stanza.getChild("data", "http://jabber.org/protocol/ibb");
       if (ibbData) {
         const sid = ibbData.attrs.sid;
         const session = ibbSessions.get(sid);
         if (!session) {
           console.log(`Unknown IBB session ${sid} for data, rejecting`);
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("item-not-found", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await xmpp.send(errorIq);
           return;
         }
         const base64Data = ibbData.getText();
         try {
           const chunk = Buffer.from(base64Data, 'base64');
           session.data = Buffer.concat([session.data, chunk]);
           session.received += chunk.length;
           console.log(`IBB session ${sid} received ${chunk.length} bytes, total ${session.received}/${session.size}`);
           // Acknowledge data
           const resultIq = xml("iq", { to: from, type: "result", id });
           await xmpp.send(resultIq);
           
           // If we've received all data, close session and process file
           if (session.size > 0 && session.received >= session.size) {
             console.log(`File ${session.filename} received completely (${session.received} bytes)`);
             // Save file to downloads directory
             const tempDir = path.join(cfg.dataDir, 'downloads');
             if (!fs.existsSync(tempDir)) {
               fs.mkdirSync(tempDir, { recursive: true });
             }
             const filePath = path.join(tempDir, session.filename);
             await fs.promises.writeFile(filePath, session.data);
             console.log(`File saved to ${filePath}`);
             ibbSessions.delete(sid);
             // TODO: Notify about incoming file
           }
         } catch (err) {
           console.error(`Error processing IBB data:`, err);
           const errorIq = xml("iq", { to: from, type: "error", id },
             xml("error", { type: "cancel" },
               xml("bad-request", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })
             )
           );
           await xmpp.send(errorIq);
         }
         return;
       }
       
       const ibbClose = stanza.getChild("close", "http://jabber.org/protocol/ibb");
       if (ibbClose) {
         const sid = ibbClose.attrs.sid;
         const session = ibbSessions.get(sid);
         if (session) {
           console.log(`IBB session ${sid} closed, received ${session.received} bytes`);
           // Save file if we have data
           if (session.received > 0) {
             const tempDir = path.join(cfg.dataDir, 'downloads');
             if (!fs.existsSync(tempDir)) {
               fs.mkdirSync(tempDir, { recursive: true });
             }
             const filePath = path.join(tempDir, session.filename);
             await fs.promises.writeFile(filePath, session.data);
             console.log(`File saved to ${filePath}`);
             // TODO: Notify about incoming file
           }
           ibbSessions.delete(sid);
         }
         const resultIq = xml("iq", { to: from, type: "result", id });
         await xmpp.send(resultIq);
         return;
       }
       
         // Handle vCard requests (XEP-0054)
         const vcardElement = stanza.getChild("vCard", "vcard-temp");
         if (vcardElement) {
           console.log(`vCard request from ${from}, type: ${type}`);
           if (type === "get") {
             // Extract local part from JID for nickname fallback
             const localPart = cfg.jid.split("@")[0];
             const fn = vcard.getFN() || `ClawdBot (${localPart})`;
             const nickname = vcard.getNickname() || localPart;
             const url = vcard.getURL() || "https://github.com/anomalyco/clawdbot";
             const desc = vcard.getDesc() || "ClawdBot XMPP Plugin - AI Assistant";
             
             const vcardResponse = xml("iq", { to: from, type: "result", id },
               xml("vCard", { xmlns: "vcard-temp" },
                 xml("FN", {}, fn),
                 xml("NICKNAME", {}, nickname),
                 xml("URL", {}, url),
                 xml("DESC", {}, desc)
               )
             );
             await xmpp.send(vcardResponse);
             console.log(`Sent vCard response to ${from}`);
             return;
           } else if (type === "set") {
             // Accept vCard updates (log but don't store)
             console.log(`vCard update from ${from}, ignoring`);
             const resultIq = xml("iq", { to: from, type: "result", id });
             await xmpp.send(resultIq);
             return;
           }
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
          console.log(`🤝 Received MUC invite to room ${from} from ${inviter}: ${reason}`);
          
          // Auto-accept invite by joining the room
          try {
            const room = from.split('/')[0];
            const presence = xml("presence", { to: `${room}/${getDefaultNick()}` },
              xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                xml("history", { maxstanzas: "0" })
              )
            );
            await xmpp.send(presence);
            joinedRooms.add(room);
            roomNicks.set(room, getDefaultNick());
            console.log(`✅ Auto-accepted invite to room ${room}`);
          } catch (err) {
            console.error(`❌ Failed to accept invite to room ${from}:`, err);
          }
          return;
        }
      }
      
      // Check for room configuration forms (MUC owner namespace)
      const mucOwnerX = stanza.getChild('x', 'http://jabber.org/protocol/muc#owner');
      if (mucOwnerX) {
        const xDataForm = mucOwnerX.getChild('x', 'jabber:x:data');
        if (xDataForm && xDataForm.attrs.type === 'form') {
          console.log(`📋 Received room configuration form for room ${from}`);
          
          // Try to auto-configure room by submitting the form with default values
          try {
            // Create a submitted form with same fields but empty values (use defaults)
            const formId = xDataForm.getChildText('title') || 'Room Configuration';
            console.log(`Auto-configuring room: ${formId}`);
            
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
            await xmpp.send(configMessage);
            console.log(`✅ Sent room configuration submission for ${from}`);
            roomsPendingConfig.delete(from.split('/')[0]);
          } catch (err) {
            console.error(`❌ Failed to send room configuration:`, err);
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
           console.log(`Detected file attachment: ${url}`);
           
           // Download file locally for agent processing
           try {
             const localPaths = await processInboundFiles([url]);
             mediaPaths = localPaths;
             console.log(`Downloaded file to local paths: ${localPaths.join(', ')}`);
           } catch (err) {
             console.error("Failed to download file, will pass URL only:", err);
           }
         }
       }
       
       // Only process messages with body
       const body = stanza.getChildText("body");
       if (!body && mediaUrls.length === 0) return;
      
      console.log(`Received XMPP message - Type: ${messageType}, From: ${from}, To: ${to}, Body: ${body}`);
      
      // Strip resource from sender JID for contact check
      const fromBareJid = from.split("/")[0];
      
       // Check for slash commands (in both chat and groupchat)
       // Behavior:
       // - Groupchat: Only plugin commands are processed locally, others ignored (not forwarded to agents)
       // - Chat: Plugin commands handled locally, /help also forwarded to agent
       // - Chat non-plugin commands: Forwarded to agent only if sender is contact
       // Plugin commands: list, add, remove, admins, whoami, join, rooms, leave, invite, whiteboard, help
       if (body && body.startsWith('/')) {
          console.log(`[SLASH] Command detected from ${from} (bare=${fromBareJid}, type=${messageType}): ${body}`);
          console.log(`[SLASH] Body starts with '/', length=${body.length}, first char='${body[0]}'`);
         
         // Extract room and nick for groupchat
         const roomJid = messageType === "groupchat" ? from.split("/")[0] : null;
         const nick = messageType === "groupchat" ? from.split("/")[1] || "" : null;
         const botNick = roomJid ? roomNicks.get(roomJid) : null;
         
         // Parse command and arguments
         const parts = body.trim().split(/\s+/);
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
                  console.error(`[SENDREPLY ERROR] roomJid is null for groupchat message! from=${from}`);
                }
              }
              console.log(`[SENDREPLY] messageType=${messageType}, from=${from}, roomJid=${roomJid}, toAddress=${toAddress}`);
              const message = xml("message", { type: messageType, to: toAddress }, xml("body", {}, replyText));
              await xmpp.send(message);
              console.log(`Command reply sent to ${toAddress} (type=${messageType}): ${replyText}`);
            } catch (err) {
              console.error("Error sending command reply:", err);
              console.error("Error details:", err.message || err);
            }
          };
        
        // Define plugin-specific commands
        const pluginCommands = new Set(['list', 'add', 'remove', 'admins', 'whoami', 'join', 'rooms', 'leave', 'invite', 'whiteboard', 'vcard', 'help']);
        const isPluginCommand = pluginCommands.has(command);
        
        // Groupchat handling: only process plugin commands, ignore others
        console.log(`[SLASH] Groupchat check: type=${messageType}, isPluginCommand=${isPluginCommand}`);
        if (messageType === "groupchat") {
          if (!isPluginCommand) {
            console.log(`Ignoring non-plugin slash command in groupchat: /${command}`);
            console.log(`[SLASH] Returning early, not forwarding non-plugin command`);
            return; // DO NOT forward to agents
          }
          // For plugin commands in groupchat, continue to handle locally
          console.log(`Processing plugin command in groupchat: /${command}`);
        }
        
        // Chat handling: plugin commands handled locally, non-plugin forwarded if contact
        console.log(`[SLASH] Chat check: type=${messageType}, isPluginCommand=${isPluginCommand}`);
        if (messageType === "chat") {
          if (isPluginCommand) {
            // Plugin command in chat - handle locally (except /help special case)
            console.log(`Processing plugin command in chat: /${command}`);
          } else {
            // Non-plugin command in chat - only forward if sender is contact
            if (contacts.exists(fromBareJid)) {
              console.log(`Forwarding non-plugin slash command from contact to agent: /${command}`);
               // Forward to agent for clawdbot processing
               console.log(`[SLASH] Forwarding non-plugin command to agent: /${command}`);
               onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
            } else {
              console.log(`Ignoring non-plugin slash command from non-contact: /${command}`);
               await sendReply(`❌ Unknown command: /${command}. You must be a contact to use bot commands.`);
               console.log(`[SLASH] Returning early, not forwarding non-plugin command from non-contact`);
             }
             return; // Stop further processing
          }
        }
        
         // Process plugin commands (both chat and groupchat)
         try {
           // Helper to check admin access (works differently for chat vs groupchat)
           const checkAdminAccess = (): boolean => {
             if (messageType === "chat") {
               return contacts.isAdmin(fromBareJid);
             } else {
               // In groupchat, admin commands not available (can't verify user identity)
               return false;
             }
           };
           
           switch (command) {
            case 'help':
                  await sendReply(`Available commands (groupchat: only whoami, whiteboard, help):
 /list - Show contacts (admin only - direct chat)
 /add <jid> [name] - Add contact (admin only - direct chat)
 /remove <jid> - Remove contact (admin only - direct chat)
 /admins - List admins (admin only - direct chat)
 /whoami - Show your info (room/nick in groupchat)
 /join <room> [nick] - Join MUC room (admin only - direct chat)
 /rooms - List joined rooms (admin only - direct chat)
 /leave <room> - Leave MUC room (admin only - direct chat)
 /invite <contact> <room> - Invite contact to room (admin only - direct chat)
 /whiteboard - Whiteboard drawing and image sharing
 /vcard - Manage vCard profile (admin only - direct chat)
 /help - Show this help`);
              
               // SPECIAL CASE: /help forwards to agent ONLY in direct chat (not groupchat)
               if (messageType === "chat" && contacts.exists(fromBareJid)) {
                  console.log(`Forwarding /help to agent for additional help (direct chat only)`);
                  console.log(`[SLASH] Forwarding /help to agent (chat)`);
                  onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
               }
               // NO FORWARDING in groupchat - only local processing
              return; // Stop further processing
              
             case 'list':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              const contactList = contacts.list();
              if (contactList.length === 0) {
                await sendReply("No contacts configured.");
              } else {
                const listText = contactList.map(c => `• ${c.jid} (${c.name})`).join('\n');
                await sendReply(`Contacts (${contactList.length}):\n${listText}`);
              }
              return;
              
             case 'add':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
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
               const added = contacts.add(jidToAdd, nameToAdd);
               if (added) {
                 await sendReply(`✅ Added contact: ${jidToAdd} (${nameToAdd})`);
                 // Send subscription request to new contact
                 try {
                   const subscribe = xml("presence", { to: jidToAdd, type: "subscribe" });
                   await xmpp.send(subscribe);
                   console.log(`📤 Sent subscription request to ${jidToAdd}`);
                 } catch (err) {
                   console.error(`❌ Failed to send subscription request to ${jidToAdd}:`, err);
                 }
               } else {
                 await sendReply(`❌ Failed to add contact: ${jidToAdd}`);
               }
               return;
              
             case 'remove':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
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
              const removed = contacts.remove(jidToRemove);
              if (removed) {
                await sendReply(`✅ Removed contact: ${jidToRemove}`);
              } else {
                await sendReply(`❌ Contact not found: ${jidToRemove}`);
              }
              return;
              
             case 'admins':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              const adminList = contacts.listAdmins();
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
                 const isAdmin = contacts.isAdmin(fromBareJid);
                 const isContact = contacts.exists(fromBareJid);
                 await sendReply(`JID: ${fromBareJid}\nAdmin: ${isAdmin ? '✅ Yes' : '❌ No'}\nContact: ${isContact ? '✅ Yes' : '❌ No'}`);
               }
               return;
              
             case 'join':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
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
                const nick = args[1] || getDefaultNick();
                const room = resolveRoomJid(roomRaw);
                
                // MUC protocol presence with muc namespace
                const presence = xml("presence", { to: `${room}/${nick}` },
                  xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                    xml("history", { maxstanzas: "0" })
                  )
                );
                await xmpp.send(presence);
                joinedRooms.add(room);
                roomNicks.set(room, nick);
                console.log(`✅ Joined room ${room} as ${nick} via slash command (MUC protocol)`);
                await sendReply(`✅ Joined room: ${room} as ${nick}`);
              } catch (err) {
                console.error("Error joining room:", err);
                await sendReply(`❌ Failed to join room: ${err.message}`);
              }
              return;
              
             case 'rooms':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
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
               if (!checkAdminAccess()) {
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
                const nick = getDefaultNick();
                const presence = xml("presence", { to: `${room}/${nick}`, type: "unavailable" });
                await xmpp.send(presence);
                joinedRooms.delete(room);
                roomNicks.delete(room);
                console.log(`✅ Left room ${room} via slash command`);
                await sendReply(`✅ Left room: ${room}`);
              } catch (err) {
                console.error("Error leaving room:", err);
                const room = resolveRoomJid(args[0]);
                joinedRooms.delete(room); // Still remove from tracking since we attempted to leave
                roomNicks.delete(room);
                await sendReply(`❌ Failed to leave room: ${err.message}`);
              }
              return;
              
             case 'invite':
               // Admin only - not available in groupchat
               if (!checkAdminAccess()) {
                 await sendReply(messageType === "groupchat" 
                   ? "❌ Admin commands not available in groupchat. Use direct message."
                   : "❌ Permission denied. Admin access required.");
                 return;
               }
              if (args.length < 2) {
                await sendReply("Usage: /invite <contact> <room>");
                return;
              }
              try {
                const contact = args[0];
                const roomRaw = args[1];
                const room = resolveRoomJid(roomRaw);
                const invite = xml("message", { to: room },
                  xml("x", { xmlns: "http://jabber.org/protocol/muc#user" },
                    xml("invite", { to: contact })
                  )
                );
                await xmpp.send(invite);
                await sendReply(`✅ Invited ${contact} to ${room}`);
              } catch (err) {
                console.error("Error sending invite:", err);
                await sendReply(`❌ Failed to send invite: ${err.message}`);
              }
               return;
               
              case 'whiteboard':
                // Whiteboard command integration
                if (args.length === 0 || args[0] === 'help') {
                  await sendReply(`Whiteboard commands:
/whiteboard help - Show this help
/whiteboard draw <prompt> - Generate image from text prompt (forwards to agent)
/whiteboard send <image_url> - Send whiteboard image via file transfer
/whiteboard status - Check whiteboard availability`);
                  return;
                }
                
                const subcommand = args[0].toLowerCase();
                switch (subcommand) {
                  case 'draw':
                    if (args.length < 2) {
                      await sendReply("Usage: /whiteboard draw <prompt>");
                      return;
                    }
                    const prompt = args.slice(1).join(' ');
                    console.log(`Whiteboard draw request from ${from}: "${prompt}"`);
                    
                    // Forward to agent with whiteboard flag
                    // Create modified body for agent processing
                    const whiteboardBody = `whiteboard draw: ${prompt}`;
                    
                    // Determine if this is a groupchat or direct message
                    if (messageType === "groupchat") {
                      const roomJid = from.split("/")[0];
                      const nick = from.split("/")[1] || "";
                      const botNick = roomNicks.get(roomJid);
                      
                      // Ignore self-messages
                      if (botNick && nick === botNick) {
                        console.log(`Ignoring whiteboard self-message from bot`);
                        return;
                      }
                      
                       // Forward to agent with whiteboard metadata
                       console.log(`[SLASH] Forwarding whiteboard draw to agent (groupchat): "${prompt}"`);
                       onMessage(roomJid, whiteboardBody, { 
                        type: "groupchat", 
                        room: roomJid, 
                        nick, 
                        botNick, 
                        mediaUrls: [],
                        mediaPaths: [],
                        whiteboardPrompt: prompt,
                        whiteboardRequest: true
                      });
                     } else {
                       // Direct message
                       console.log(`[SLASH] Forwarding whiteboard draw to agent (chat): "${prompt}"`);
                       onMessage(fromBareJid, whiteboardBody, { 
                        type: "chat", 
                        mediaUrls: [],
                        mediaPaths: [],
                        whiteboardPrompt: prompt,
                        whiteboardRequest: true
                      });
                    }
                    
                    // Send acknowledgement
                    await sendReply(`🎨 Whiteboard drawing requested: "${prompt}". Processing...`);
                    return;
                    
                  case 'send':
                    if (args.length < 2) {
                      await sendReply("Usage: /whiteboard send <image_url>");
                      return;
                    }
                    const imageUrl = args[1];
                    
                    // Check if we have a valid URL
                    try {
                      new URL(imageUrl);
                      await sendReply(`🖼️ Whiteboard image URL received: ${imageUrl}. Sending via file transfer...`);
                      
                      // Forward to agent with image URL
                      const imageBody = `whiteboard send image: ${imageUrl}`;
                      if (messageType === "groupchat") {
                        const roomJid = from.split("/")[0];
                        const nick = from.split("/")[1] || "";
                        const botNick = roomNicks.get(roomJid);
                        
                        if (!(botNick && nick === botNick)) {
                           console.log(`[SLASH] Forwarding whiteboard send to agent (groupchat): ${imageUrl}`);
                           onMessage(roomJid, imageBody, { 
                             type: "groupchat", 
                             room: roomJid, 
                             nick, 
                             botNick, 
                             mediaUrls: [imageUrl],
                             mediaPaths: [],
                             whiteboardImage: true
                           });
                         }
                       } else {
                         console.log(`[SLASH] Forwarding whiteboard send to agent (chat): ${imageUrl}`);
                         onMessage(fromBareJid, imageBody, { 
                           type: "chat", 
                           mediaUrls: [imageUrl],
                           mediaPaths: [],
                           whiteboardImage: true
                         });
                       }
                    } catch (err) {
                      await sendReply(`❌ Invalid URL: ${imageUrl}. Please provide a valid http:// or https:// URL.`);
                    }
                    return;
                    
                  case 'status':
                    await sendReply(`✅ Whiteboard support enabled:
• Image generation: Forwarded to agent system
• File transfer: HTTP Upload (XEP-0363) and SI transfer (XEP-0096)
• Max file size: Configurable via server
• Supported formats: PNG, JPEG, GIF, WebP`);
                return;
              }
              
               case 'vcard':
                 // vCard management
                 if (!checkAdminAccess()) {
                   await sendReply(messageType === 'groupchat' 
                     ? '❌ Admin commands not available in groupchat. Use direct message.'
                     : '❌ Permission denied. Admin access required.');
                   return;
                 }
                if (args.length === 0 || args[0] === 'help') {
                  await sendReply(`vCard commands:
/vcard help - Show this help
/vcard get - Show current vCard fields
/vcard set fn <value> - Set Full Name
/vcard set nickname <value> - Set Nickname
/vcard set url <value> - Set URL
/vcard set desc <value> - Set Description
/vcard set avatarUrl <value> - Set Avatar URL`);
                  return;
                }
                const subcmd = args[0].toLowerCase();
                if (subcmd === 'get') {
                  const data = vcard.getData();
                  await sendReply(`Current vCard:
FN: ${data.fn || '(not set)'}
Nickname: ${data.nickname || '(not set)'}
URL: ${data.url || '(not set)'}
Description: ${data.desc || '(not set)'}
Avatar URL: ${data.avatarUrl || '(not set)'}`);
                  return;
                } else if (subcmd === 'set') {
                  if (args.length < 3) {
                    await sendReply('Usage: /vcard set <field> <value>');
                    return;
                  }
                  const field = args[1].toLowerCase();
                  const value = args.slice(2).join(' ');
                  let updated = false;
                  switch (field) {
                    case 'fn':
                      vcard.setFN(value);
                      updated = true;
                      break;
                    case 'nickname':
                      vcard.setNickname(value);
                      updated = true;
                      break;
                    case 'url':
                      vcard.setURL(value);
                      updated = true;
                      break;
                    case 'desc':
                      vcard.setDesc(value);
                      updated = true;
                      break;
                    case 'avatarurl':
                      vcard.setAvatarUrl(value);
                      updated = true;
                      break;
                    default:
                      await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, avatarUrl`);
                      return;
                  }
                  if (updated) {
                    await sendReply(`✅ vCard field '${field}' updated to: ${value}`);
                  }
                  return;
                } else {
                  await sendReply(`Unknown vCard subcommand: ${subcmd}. Use /vcard help for available commands.`);
                }
                return;


               
              default:
                // Should not reach here for non-plugin commands (handled earlier)
                await sendReply(`Unknown command: /${command}. Type /help for available commands.`);
                return;
          }
        } catch (err) {
          console.error("Error processing slash command:", err);
           try {
             let toAddress = from;
             if (messageType === "groupchat" && roomJid) {
               toAddress = roomJid;
             }
             await xmpp.send(xml("message", { type: messageType, to: toAddress }, xml("body", {}, "❌ Error processing command.")));
           } catch {}
        }
        
        // If we processed a plugin command, return (don't forward to normal processing)
        return;
      }
      
      // Normal message processing
      console.log(`[NORMAL] Processing message (type=${messageType}, body=${body?.substring(0, 50)}${body?.length > 50 ? '...' : ''})`);
      // Safety check: slash commands should never reach here
      if (body.startsWith('/')) {
        console.log(`[ERROR] Slash command reached normal processing! This should not happen.`);
        return;
      }
      if (messageType === "groupchat") {
        // MUC message
        const roomJid = from.split("/")[0];
        const nick = from.split("/")[1] || "";
        if (!nick) {
          console.log(`Ignoring room message without nick (likely room subject): ${body}`);
          return;
        }
        console.log(`MUC message from room ${roomJid}, nick ${nick}, forwarding to agent`);
        const botNick = roomNicks.get(roomJid);
        console.log(`Bot nick for room ${roomJid}: ${botNick}`);
        // Ignore messages from ourselves
        if (botNick && nick === botNick) {
          console.log(`Ignoring self-message from bot (nick: ${nick})`);
          return;
        }
        console.log(`[NORMAL] Forwarding groupchat message to agent`);
        onMessage(roomJid, body, { type: "groupchat", room: roomJid, nick, botNick, mediaUrls, mediaPaths });
      } else {
        // Direct message
        if (contacts.exists(fromBareJid)) {
          console.log(`Message from contact ${fromBareJid}, forwarding to agent`);
          console.log(`[NORMAL] Forwarding chat message to agent`);
          onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
        } else {
          console.log(`Ignoring message from non-contact: ${fromBareJid}`);
          log.debug(`Ignoring message from non-contact: ${fromBareJid}`);
        }
      }
    }
  });

  xmpp.start().catch((err: any) => {
    log.error("XMPP start failed", err);
    console.error("XMPP start failed details:", err);
  });

  // HTTP File Upload (XEP-0363) helpers
  const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}> => {
    console.log(`Requesting upload slot for ${filename} (${size} bytes)`);
    
    // Create IQ request for upload slot
    const iqId = Math.random().toString(36).substring(2);
    const requestStanza = xml("iq", { type: "get", to: cfg.domain, id: iqId },
      xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
    );
    
    try {
      const response = await xmpp.send(requestStanza);
      console.log("Upload slot response:", response.toString());
      
      const slot = response.getChild("slot", "urn:xmpp:http:upload:0");
      if (!slot) {
        throw new Error("No upload slot in response");
      }
      
      const putUrl = slot.getChildText("put");
      const getUrl = slot.getChildText("get");
      
      if (!putUrl || !getUrl) {
        throw new Error("Missing put or get URL in slot");
      }
      
      // Parse optional headers
      const putHeaders: Record<string, string> = {};
      const putElement = slot.getChild("put");
      if (putElement) {
        const headerElements = putElement.getChildren("header");
        for (const header of headerElements) {
          const name = header.attrs.name;
          const value = header.getText();
          if (name && value) {
            putHeaders[name] = value;
          }
        }
      }
      
      console.log(`Upload slot obtained: PUT ${putUrl}, GET ${getUrl}`);
      return { putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined };
    } catch (err) {
      console.error("Failed to request upload slot:", err);
      throw err;
    }
  };

  const uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
    console.log(`Uploading file ${filePath} to ${putUrl}`);
    
    try {
      // Read file
      const fileBuffer = await fs.promises.readFile(filePath);
      const fileSize = fileBuffer.length;
      
      // Prepare headers
      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
      };
      
      if (headers) {
        Object.assign(fetchHeaders, headers);
      }
      
      // Upload via PUT
      const response = await fetch(putUrl, {
        method: 'PUT',
        headers: fetchHeaders,
        body: fileBuffer,
      });
      
      if (!response.ok) {
        throw new Error(`HTTP upload failed: ${response.status} ${response.statusText}`);
      }
      
      console.log(`File uploaded successfully: ${filePath}`);
    } catch (err) {
      console.error("File upload failed:", err);
      throw err;
    }
  };

  const sendFileWithHTTPUpload = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    try {
      // Get file stats
      const stats = await fs.promises.stat(filePath);
      const filename = path.basename(filePath);
      const size = stats.size;
      
      // Request upload slot
      const slot = await requestUploadSlot(filename, size);
      
      // Upload file
      await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
      
      // Send message with file URL
      const messageType = isGroupChat ? "groupchat" : "chat";
      const message = xml("message", { type: messageType, to },
        text ? xml("body", {}, text) : null,
        xml("x", { xmlns: "jabber:x:oob" },
          xml("url", {}, slot.getUrl)
        )
      );
      
      await xmpp.send(message);
      console.log(`File sent successfully to ${to}: ${slot.getUrl}`);
    } catch (err) {
      console.error("Failed to send file via HTTP Upload:", err);
      throw err;
    }
  };

  // SI File Transfer (XEP-0096) helpers (fallback)
  const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    console.log(`Attempting SI file transfer to ${to} for ${filePath}`);
    // For now, fallback to out-of-band URL sharing
    // TODO: Implement proper SI file transfer with bytestreams
    const filename = path.basename(filePath);
    const message = `[File: ${filename}] ${text || ''}`;
    if (isGroupChat) {
      await xmpp.sendGroupchat(to, message);
    } else {
      await xmpp.send(to, message);
    }
    console.log(`SI fallback: Sent file notification for ${filename}`);
  };

 

   const xmppClient = {
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
        const actualNick = nick || getDefaultNick();
        const fullJid = `${resolvedRoomJid}/${actualNick}`;
        
        // MUC protocol presence with muc namespace and optional history
        const presence = xml("presence", { to: fullJid },
          xml("x", { xmlns: "http://jabber.org/protocol/muc" },
            xml("history", { maxstanzas: "0" }) // Request no history
          )
        );
        try {
          await xmpp.send(presence);
          joinedRooms.add(resolvedRoomJid);
          roomNicks.set(resolvedRoomJid, actualNick);
          console.log(`✅ Joined room ${resolvedRoomJid} as ${actualNick} (MUC protocol)`);
        } catch (err) {
          console.error(`❌ Failed to join room ${resolvedRoomJid}:`, err);
          throw err;
        }
      },
      leaveRoom: async (roomJid: string, nick?: string) => {
        const resolvedRoomJid = resolveRoomJid(roomJid);
        const fullJid = nick ? `${resolvedRoomJid}/${nick}` : `${resolvedRoomJid}/${getDefaultNick()}`;
        const presence = xml("presence", { to: fullJid, type: "unavailable" });
        try {
          await xmpp.send(presence);
          joinedRooms.delete(resolvedRoomJid);
          roomNicks.delete(resolvedRoomJid);
          console.log(`✅ Left room ${resolvedRoomJid}`);
        } catch (err) {
          console.error(`❌ Failed to leave room ${resolvedRoomJid}:`, err);
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
        console.log(`XMPP sendFile called: to=${to}, file=${filePath}, text=${text}, group=${isGroupChat}`);
        try {
          // First try HTTP Upload
          await sendFileWithHTTPUpload(to, filePath, text, isGroupChat);
          return true;
        } catch (httpErr) {
          console.log("HTTP Upload failed, falling back to SI transfer:", httpErr);
          try {
            await sendFileWithSITransfer(to, filePath, text, isGroupChat);
            return true;
          } catch (siErr) {
            console.error("All file transfer methods failed:", siErr);
            throw new Error(`File transfer failed: ${httpErr.message}, ${siErr.message}`);
          }
        }
      }
    };

  xmppClient.roomNicks = roomNicks;

  return xmppClient;
}

export function register(api: any) {
  const log = api.logger ?? console;
  log.info("Registering XMPP plugin");
  console.log("XMPP plugin register called");
  
  // Debug: Inspect the api object
  console.log("=== API OBJECT INSPECTION ===");
  console.log("api keys:", Object.keys(api));
  const allApiProps = [];
  for (let key in api) {
    allApiProps.push(key);
  }
  console.log("All api properties:", allApiProps);
  const apiMethods = allApiProps.filter(k => typeof api[k] === 'function');
  console.log("All api methods:", apiMethods);
  
  // Check for runtime access
  if (api.runtime) {
    pluginRuntime = api.runtime;
    console.log("api.runtime exists, keys:", Object.keys(api.runtime));
    if (api.runtime.channel) {
      console.log("api.runtime.channel exists, keys:", Object.keys(api.runtime.channel));
      
      // Check if there's a generic message forwarding method
      const channelMethods = Object.keys(api.runtime.channel);
      console.log("Channel methods available:", channelMethods);
      
      // Look for text, message, or routing methods
      const possibleForwardMethods = ['text', 'message', 'routing', 'dispatch', 'receive'];
      for (const method of possibleForwardMethods) {
        if (api.runtime.channel[method]) {
          console.log(`✅ Found channel.${method}:`, typeof api.runtime.channel[method]);
          
          // If it's an object, log its methods
          if (typeof api.runtime.channel[method] === 'object') {
            const subMethods = Object.keys(api.runtime.channel[method]);
            console.log(`  channel.${method} methods:`, subMethods.slice(0, 10)); // First 10 methods
          }
        }
      }
      
      // Also check session and activity which might handle messages
      if (api.runtime.channel.session) {
        const sessionMethods = Object.keys(api.runtime.channel.session);
        console.log("channel.session methods:", sessionMethods.slice(0, 10));
      }
      if (api.runtime.channel.activity) {
        const activityMethods = Object.keys(api.runtime.channel.activity);
        console.log("channel.activity methods:", activityMethods.slice(0, 10));
      }
    }
  }
  console.log("=== END API INSPECTION ===");
  
  // Check for emit method
  console.log("Checking for api.emit method...");
  if (typeof api.emit === 'function') {
    console.log("✅ api.emit is available");
  } else {
    console.log("❌ api.emit not found");
    // Check if emit is on a different object
    if (api.runtime?.emit) {
      console.log("✅ api.runtime.emit is available");
    }
  }
  
  // Try to use api.on for event-based message forwarding
  if (typeof api.on === 'function') {
    console.log("api.on is available for listening to events");
  }

  const xmppPlugin = {
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
      isConfigured: (account: any) => Boolean(account.config.jid?.trim() && account.config.password?.trim()),
      describeAccount: (account: any) => ({
        accountId: account.accountId,
        name: account.config.jid || account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.config.jid?.trim() && account.config.password?.trim()),
        tokenSource: "config",
      }),
    },
    status: {
      buildAccountSnapshot: ({ account, runtime }: any) => ({
        accountId: account.accountId,
        name: account.config.jid || account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.config.jid?.trim() && account.config.password?.trim()),
        tokenSource: "config",
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, accountId }: any) => {
        console.log("XMPP sendText called with:", { to, text, accountId });
        
        // Get the XMPP client from global store
        const xmpp = xmppClients.get(accountId || "default");
        console.log("XMPP client available:", !!xmpp);
        
        if (!xmpp) {
          return { ok: false, error: "XMPP client not available" };
        }
        
        try {
          console.log(`Attempting to send message to ${to}: ${text}`);
          await xmpp.send(to, text);
          console.log("Message sent successfully");
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
        console.log("XMPP gateway.startAccount called");
        
        // Log ALL ctx methods to find the inbound message method
        console.log("=== CTX INSPECTION ===");
        console.log("ctx keys:", Object.keys(ctx));
        const allProps = [];
        for (let key in ctx) {
          allProps.push(key);
        }
        console.log("All ctx properties (including inherited):", allProps);
        const methods = allProps.filter(k => typeof ctx[k] === 'function');
        console.log("All ctx methods:", methods);
        
        // Check specific possible inbound methods
        const possibleInboundMethods = [
          'receive', 'receiveText', 'receiveMessage', 'inbound',
          'dispatch', 'dispatchInbound', 'handleInbound', 'onMessage',
          'message', 'text', 'chat', 'send', 'post'
        ];
        for (const method of possibleInboundMethods) {
          if (typeof ctx[method] === 'function') {
            console.log(`✅ Found potential inbound method: ctx.${method}`);
          }
        }
        console.log("=== END CTX INSPECTION ===");
        
        const account = ctx.account;
        const config = account.config;
        const log = ctx.log;
        
        console.log(`XMPP startAccount called for account ${account.accountId}`);
        
        if (!config.jid?.trim() || !config.password?.trim()) {
          console.log("Missing jid or password");
          throw new Error("XMPP account missing jid or password");
        }
        
        log?.info(`[${account.accountId}] starting XMPP connection to ${config.service}`);
        console.log(`Starting XMPP connection to ${config.service}`);
        
        const contacts = new Contacts(config.dataDir);
        const contactList = contacts.list();
        log?.info(`[${account.accountId}] loaded ${contactList.length} contacts`);
        
        // Initialize super admin from config if specified
        if (config.adminJid?.trim()) {
          const adminJid = config.adminJid.trim();
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
        
        let isRunning = true;
        
        // Use pluginRuntime (from api.runtime) instead of ctx.runtime
        const runtime = pluginRuntime;
        console.log("Using pluginRuntime in startAccount:", runtime ? "exists" : "undefined");
        console.log("pluginRuntime.channel exists?", runtime?.channel ? "yes" : "no");
        if (runtime?.channel) {
          console.log("pluginRuntime.channel methods:", Object.keys(runtime.channel));
        }
        
        const xmpp = await startXmpp(config, contacts, log, async (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, mediaUrls?: string[] }) => {
          if (!isRunning) return;
          
           console.log("XMPP inbound message from:", from, "Body:", body, "Options:", options);
           console.log("runtime in callback:", runtime ? "exists" : "undefined");
           
           // Helper to build context payload based on message type
            const buildContextPayload = (sessionKey: string) => {
              const isGroupChat = options?.type === "groupchat";
              const room = options?.room || from;
              const nick = options?.nick || from.split('@')[0];
              const senderName = isGroupChat ? nick : from.split('@')[0];
              const senderId = isGroupChat ? `${room}/${nick}` : from;
              const chatType = isGroupChat ? "group" as const : "direct" as const;
              const conversationLabel = isGroupChat ? `XMPP room ${room}` : `XMPP chat with ${from}`;
               const botNick = isGroupChat ? options?.botNick || null : null;
               console.log(`buildContextPayload: isGroupChat=${isGroupChat}, botNick=${botNick}, room=${room}`);
               const wasMentioned = isGroupChat && botNick ? 
                 body.includes(botNick) || body.includes(`@${botNick}`) : false;
              
              return {
                Body: body,
                RawBody: body,
                CommandBody: body,
                From: `xmpp:${isGroupChat ? room : from}`,
                To: `xmpp:${config.jid}`,
                SessionKey: sessionKey,
                AccountId: account.accountId,
                ChatType: chatType,
                ConversationLabel: conversationLabel,
                SenderName: senderName,
                SenderId: senderId,
                Provider: "xmpp" as const,
                Surface: "xmpp" as const,
                WasMentioned: wasMentioned,
                MessageSid: `xmpp-${Date.now()}`,
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
           
           // Try to forward message using runtime channel methods
           // Use captured runtime from closure
           if (runtime?.channel) {
             console.log("Attempting to forward via runtime.channel methods");
             
              // Skip routing for now
              let route = null;
             
             // If we have a route, try to process like Matrix
             if (route) {
               try {
                 console.log("Processing message with route");
                 
                 // Get store path
                 const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
                   agentId: route.agentId,
                 });
                 
                  // Build context payload similar to Matrix
                  const ctxPayload = buildContextPayload(route.sessionKey);
                 
                 await runtime.channel.session.recordInboundSession({
                   storePath,
                   sessionKey: ctxPayload.SessionKey,
                   ctx: ctxPayload,
                   updateLastRoute: {
                     sessionKey: route.mainSessionKey || route.sessionKey,
                     channel: "xmpp",
                     to: `xmpp:${from}`,
                     accountId: account.accountId,
                   },
                   onRecordError: (err) => {
                     console.error("Error recording session:", err);
                   },
                 });
                 
                 console.log("✅ Message processed via channel.session.recordInboundSession");
                 markAsProcessed(messageId);
                 return;
               } catch (err) {
                 console.error("❌ Error processing with route:", err);
               }
             }
             
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
                  
                   // Try standard session key format: channel:peerId
                  const sessionKey = options?.type === "groupchat" ? `xmpp:group:${from}` : `xmpp:${from}`;
                  console.log("sessionKey:", sessionKey, "type:", options?.type);
                  
                  const ctxPayload = buildContextPayload(sessionKey);
                  
                   await runtime.channel.session.recordInboundSession({
                    storePath,
                    sessionKey,
                    ctx: ctxPayload,
                    updateLastRoute: {
                      sessionKey: sessionKey,
                      channel: "xmpp",
                      to: `xmpp:${from}`,
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
                   

                    
                    // Try BOTH methods - dispatchReplyFromConfig works but has delays
                    try {
                      console.log("=== STARTING DISPATCH ===");
                      console.log("Time:", new Date().toISOString());
                      
                      // METHOD 1: dispatchReplyFromConfig (works but slow)
                      if (runtime.channel.reply?.dispatchReplyFromConfig) {
                        console.log("🎯 METHOD 1: dispatchReplyFromConfig (fast path)");
                        
                        const immediateSendText = async (to: string, text: string) => {
                          console.log("🚀 IMMEDIATE sendText CALLED! Time:", new Date().toISOString());
                          console.log("  To:", to);
                          console.log("  Text:", text);
                          
                          let jid = to;
                          if (to.startsWith('xmpp:')) {
                            jid = to.substring(5);
                          }
                          
                           try {
                             if (options?.type === "groupchat") {
                               await xmpp.sendGroupchat(jid, text);
                               console.log("✅✅✅ GROUPCHAT REPLY SENT VIA XMPP! Time:", new Date().toISOString());
                             } else {
                               await xmpp.send(jid, text);
                               console.log("✅✅✅ DIRECT REPLY SENT VIA XMPP! Time:", new Date().toISOString());
                             }
                             return { ok: true, channel: "xmpp" };
                           } catch (err) {
                             console.error("❌ XMPP SEND ERROR:", err);
                             return { ok: false, error: String(err) };
                           }
                        };
                        
                        // Create a SIMPLE dispatcher that executes immediately
                        const simpleDispatcher = {
                          sendBlockReply: async (payload: any) => immediateSendText(ctxPayload.From, payload?.text || payload?.message || payload?.body || JSON.stringify(payload)),
                          sendFinalReply: async (payload: any) => immediateSendText(ctxPayload.From, payload?.text || payload?.message || payload?.body || JSON.stringify(payload)),
                          deliver: async (payload: any) => immediateSendText(ctxPayload.From, payload?.text || payload?.message || payload?.body || JSON.stringify(payload)),
                          sendText: immediateSendText,
                          sendMessage: async (msg: any) => immediateSendText(msg?.to || ctxPayload.From, msg?.text || msg?.body || JSON.stringify(msg)),
                          
                          // Stub other methods
                          waitForIdle: async () => ({ ok: true }),
                          getQueuedCounts: async () => ({ ok: true, counts: {} }),
                        };
                        
                        const dispatchStart = Date.now();
                        await runtime.channel.reply.dispatchReplyFromConfig({
                          ctx: ctxPayload,
                          cfg: ctx.cfg,
                          dispatcher: simpleDispatcher,
                          replyOptions: {},
                        });
                        console.log(`✅ METHOD 1 completed in ${Date.now() - dispatchStart}ms`);
                      }
                      
                      // METHOD 2: dispatchReplyWithBufferedBlockDispatcher (if first fails)
                      if (runtime.channel.reply?.dispatchReplyWithBufferedBlockDispatcher) {
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
                        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                          ctx: ctxPayload,
                          cfg: ctx.cfg,
                          sendText: sendText,
                          dispatcherOptions: {},
                        });
                        console.log(`✅ METHOD 2 completed in ${Date.now() - dispatchStart}ms`);
                      }
                      
                      console.log("=== DISPATCH COMPLETE ===");
                    } catch (err) {
                      console.error("❌❌❌ FATAL DISPATCH ERROR:", err);
                      console.error("Error details:", err instanceof Error ? err.stack : err);
                    }
                  
                  markAsProcessed(messageId);
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
             if (typeof ctx[methodName] === 'function') {
               console.log(`✅ Found ctx.${methodName}`);
               try {
                 if (methodName === 'receiveText' || methodName === 'receiveMessage') {
                   ctx[methodName]({
                     from: `xmpp:${from}`,
                     to: `xmpp:${config.jid}`,
                     body: body,
                     channel: "xmpp",
                     accountId: account.accountId,
                   });
                 } else {
                   ctx[methodName](from, body, {
                     channel: "xmpp",
                     accountId: account.accountId,
                   });
                 }
                 console.log(`✅ Message forwarded via ctx.${methodName}`);
                 markAsProcessed(messageId);
                 return;
               } catch (err) {
                 console.error(`❌ Error with ctx.${methodName}:`, err);
               }
             }
           }
           
           console.log("🔴 No inbound method found - message queued for polling");
           console.log("Available runtime.channel methods:", runtime?.channel ? Object.keys(runtime.channel) : "none");
           
           // Try to find dispatchInboundMessage or similar public API
           // Check if runtime has dispatch methods
           if (runtime?.dispatchInboundMessage) {
             try {
               console.log("Trying runtime.dispatchInboundMessage");
               const ctxPayload = buildContextPayload(`xmpp:${account.accountId}:${from}`);
               
               await runtime.dispatchInboundMessage({
                 ctx: ctxPayload,
                 cfg: ctx.cfg, // Pass the config from ctx
               });
               console.log("✅ Message dispatched via runtime.dispatchInboundMessage");
               markAsProcessed(messageId);
               return;
             } catch (err) {
               console.error("❌ Error with dispatchInboundMessage:", err);
             }
           }
           
           // Try channel.activity.record as last resort
           if (runtime?.channel?.activity?.record) {
             try {
               console.log("Trying channel.activity.record");
               runtime.channel.activity.record({
                 channel: "xmpp",
                 accountId: account.accountId,
                 from: `xmpp:${from}`,
                 action: "message:inbound",
                 data: { body: body },
               });
               console.log("✅ Activity recorded");
             } catch (err) {
               console.error("❌ Error recording activity:", err);
             }
           }
           
           // Note: api.emit doesn't exist, only api.on for listening
         });

          // Auto-join configured rooms
          if (Array.isArray(config.rooms) && config.rooms.length > 0) {
            console.log(`[${account.accountId}] Auto-join config debug:`, {
              resource: config.resource,
              jid: config.jid,
              jidLocalPart: config.jid ? config.jid.split("@")[0] : 'undefined',
              rooms: config.rooms
            });
            const nick = config.jid ? config.jid.split("@")[0] : "clawdbot";
            console.log(`[${account.accountId}] Auto-joining ${config.rooms.length} rooms as ${nick} (computed nick)`);
           log?.info(`[${account.accountId}] Auto-joining ${config.rooms.length} rooms`);
           for (const room of config.rooms) {
             try {
               await xmpp.joinRoom(room, nick);
               console.log(`[${account.accountId}] Joined room: ${room}`);
               log?.info(`[${account.accountId}] Joined room: ${room}`);
             } catch (err) {
               console.error(`[${account.accountId}] Failed to join room ${room}:`, err);
               log?.error(`[${account.accountId}] Failed to join room ${room}:`, err);
             }
           }
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
            ctx.setStatus({
              accountId: account.accountId,
              running: false,
              lastStopAt: Date.now(),
            });
            resolve();
          });
        });
      },
    },
  };

  console.log("About to register XMPP channel plugin");
  api.registerChannel({ plugin: xmppPlugin });
  log.info("XMPP channel plugin registered");
  console.log("XMPP channel plugin registered");
  
  // Register CLI commands
  try {
    import("./data/commands.js").then(({ registerCommands }) => {
      registerCommands(api, api.config?.dataDir || "./data");
      console.log("XMPP CLI commands registered");
    }).catch(err => {
      console.error("Failed to register CLI commands:", err);
    });
  } catch (err) {
    console.error("Failed to register CLI commands:", err);
  }
}