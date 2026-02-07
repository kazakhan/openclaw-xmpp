import fs from "fs";
import path from "path";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { MessageStore } from "./src/messageStore.js";
import { validators } from "./src/security/validation.js";
import { secureLog } from "./src/security/logging.js";
import { AdvancedRateLimiter, createRateLimiter } from "./src/security/rateLimiter.js";
import { decryptPasswordFromConfig } from "./src/security/encryption.js";
import { SecureFileTransfer, createSecureFileTransfer } from "./src/security/fileTransfer.js";
import { AuditLogger, AuditEventType, logAuditEvent, createAuditLogger } from "./src/security/audit.js";

// Simple file logger for debugging with sanitization
const debugLog = (msg: string) => {
  const logFile = path.join(__dirname, 'cli-debug.log');
  const timestamp = new Date().toISOString();
  const validation = validators.sanitizeForXmpp(msg);
  const sanitizedMsg = validation.valid && validation.sanitized ? validation.sanitized : msg;
  const line = `[${timestamp}] ${sanitizedMsg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (err) {
    // Silently ignore logging errors
  }
};

secureLog.info(`XMPP plugin loading at ${new Date().toISOString()}`);

let pluginRegistered = false;

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

// Rate limiting for commands (per JID)
interface RateLimitEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();
const rateLimitMaxRequests = 10; // Max commands per window
const rateLimitWindowMs = 60000; // 1 minute window

// Pending subscription requests (require admin approval)
interface PendingSubscription {
  jid: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'denied';
}
export const pendingSubscriptions = new Map<string, PendingSubscription>();

// Pending room invites (require admin approval)
interface PendingInvite {
  room: string;
  inviter: string;
  reason?: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'denied';
}
export const pendingInvites = new Map<string, PendingInvite>();

// File transfer size limits
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 3;
const activeDownloads = new Map<string, { size: number; startTime: number }>();

// Advanced rate limiter
export const rateLimiter = createRateLimiter({
  windowMs: 60000,        // 1 minute window
  maxRequests: 10,         // Max commands per window
  blockDurationMs: 300000, // 5 minute block
  maxViolationsBeforeBlock: 3
});

function checkRateLimit(jid: string): { allowed: boolean; reason?: string; remaining?: number } {
  const result = rateLimiter.check(jid);
  if (!result.allowed && result.reason) {
    secureLog.warn(`Rate limit exceeded for ${jid}: ${result.reason}`);
  }
  return {
    allowed: result.allowed,
    reason: result.reason,
    remaining: result.remaining
  };
}

function checkConcurrentDownloadLimit(remoteJid: string): { allowed: boolean; reason?: string } {
  const userDownloads = Array.from(activeDownloads.entries())
    .filter(([_, data]) => {
      const elapsed = Date.now() - data.startTime;
      return elapsed < 5 * 60 * 1000;
    }).length;

  if (userDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return {
      allowed: false,
      reason: `Too many concurrent downloads (${MAX_CONCURRENT_DOWNLOADS} max). Please wait.`
    };
  }
  return { allowed: true };
}



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
export { addToQueue, getUnprocessedMessages, markAsProcessed, clearOldMessages, messageQueue };

async function startXmpp(cfg: any, contacts: any, log: any, onMessage: (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean }) => void) {
   // Helper to get default resource/nick from JID local part
   const getDefaultResource = () => {
     const result = cfg?.resource || cfg?.jid?.split("@")[0] || "openclaw";
     return result;
   };
   const getDefaultNick = () => {
     const result = cfg.jid ? cfg.jid.split("@")[0] : "openclaw";
     return result;
    };
    
    // File download helper for inbound attachments (available in stanza handler)
    const downloadFile = async (url: string, tempDir: string, remoteJid?: string): Promise<string> => {
      secureLog.debug(`Downloading file from ${url}`);

      // Validate URL
      const urlValidation = validators.isValidUrl(url);
      if (!urlValidation.valid) {
        throw new Error(`Invalid URL: ${urlValidation.error}`);
      }

      // Check concurrent download limit
      if (remoteJid) {
        const limitCheck = checkConcurrentDownloadLimit(remoteJid);
        if (!limitCheck.allowed) {
          throw new Error(limitCheck.reason);
        }
      }

      // Create temp directory if needed
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Generate filename and validate
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      let filename = path.basename(pathname) || `file_${Date.now()}.bin`;

      const filenameValidation = validators.sanitizeFilename(filename);
      if (!filenameValidation.valid) {
        throw new Error(`Invalid filename: ${filenameValidation.error}`);
      }
      filename = filenameValidation.sanitized || filename;

      const filePath = path.join(tempDir, filename);

      // Validate path doesn't escape tempDir
      const pathValidation = validators.isSafePath(filePath, tempDir);
      if (!pathValidation.valid) {
        throw new Error(`Invalid path: ${pathValidation.error}`);
      }
     
     try {
       const response = await fetch(url);
       if (!response.ok) {
         throw new Error(`Download failed: ${response.status} ${response.statusText}`);
       }

       // Check content-length header before downloading
       const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          const validation = validators.isValidFileSize(size);
          if (!validation.valid) {
            throw new Error(validation.error || 'Invalid file size');
          }
        }

        const buffer = await response.arrayBuffer();
        const bufferSize = buffer.byteLength;

        // Validate actual downloaded size
        const sizeValidation = validators.isValidFileSize(bufferSize);
        if (!sizeValidation.valid) {
          throw new Error(sizeValidation.error || 'Invalid file size');
        }

       // Track this download
       const downloadId = `${remoteJid || 'unknown'}_${Date.now()}`;
       activeDownloads.set(downloadId, { size: bufferSize, startTime: Date.now() });

       await fs.promises.writeFile(filePath, Buffer.from(buffer));

       console.log(`File downloaded to ${filePath} (${bufferSize} bytes)`);

       // Cleanup download tracking
       activeDownloads.delete(downloadId);

       return filePath;
     } catch (err) {
       console.error("File download failed:", err);
       throw err;
     }
     };
       
     const processInboundFiles = async (urls: string[], remoteJid?: string): Promise<string[]> => {
      if (urls.length === 0) return [];
      
      // Create temp directory for downloads
      const tempDir = path.join(cfg.dataDir, 'downloads');
      const localPaths: string[] = [];
      
      for (const url of urls) {
        try {
          const localPath = await downloadFile(url, tempDir, remoteJid);
          localPaths.push(localPath);
        } catch (err) {
          console.error(`Failed to download ${url}:`, err);
         // Continue with other files
       }
     }
     
      return localPaths;
    };
    
    secureLog.debug(`Starting XMPP connection to ${cfg?.service}`);
    secureLog.debug(`XMPP config: jid=${cfg?.jid}, domain=${cfg?.domain}`);
   
   // Lazy load @xmpp/client module
   if (!xmppClientModule) {
     secureLog.debug("Loading @xmpp/client module...");
     xmppClientModule = await import("@xmpp/client");
     secureLog.debug("XMPP client module loaded");
   }
   
    const { client, xml } = xmppClientModule;

    // Decrypt password if encrypted
    let password: string;
    try {
      password = decryptPasswordFromConfig(cfg || {});
    } catch (err) {
      secureLog.error('Failed to decrypt XMPP password', err);
      throw new Error('Failed to decrypt XMPP password');
    }

    // Initialize secure file transfer
    const secureFileTransfer = createSecureFileTransfer({
      maxFileSizeMB: 10,
      maxUploadSizeMB: 10,
      maxDownloadSizeMB: 10,
      quarantineDir: path.join(cfg?.dataDir || '.', 'quarantine'),
      tempDir: path.join(cfg?.dataDir || '.', 'temp'),
      userQuotaMB: 100,
      enableVirusScan: false
    });

    const xmpp = client({
      service: cfg?.service,
      domain: cfg?.domain,
      username: cfg?.jid?.split("@")[0],
      password: password,
      resource: getDefaultResource()
    });

   // Helper to resolve room JID - add conference domain if missing
    const resolveRoomJid = (room: string): string => {
      if (room.includes('@')) {
        return room;
      }
      // Default to conference.domain for MUC rooms
      return `${room}@conference.${cfg.domain}`;
    };
    
    // vCard server query helpers
    const parseVCardXml = (vcardEl: any): any => {
      const data: any = {};
      if (!vcardEl) return data;
      
      const fn = vcardEl.getChild('FN');
      const nickname = vcardEl.getChild('NICKNAME');
      const url = vcardEl.getChild('URL');
      const desc = vcardEl.getChild('DESC');
      const photo = vcardEl.getChild('PHOTO');
      
      if (fn) data.fn = fn.text();
      if (nickname) data.nickname = nickname.text();
      if (url) data.url = url.text();
      if (desc) data.desc = desc.text();
      if (photo) {
        const uri = photo.getChild('URI');
        if (uri) data.avatarUrl = uri.text();
      }
      
      return data;
    };
    
    const queryVCardFromServer = async (targetJid: string): Promise<any> => {
      const id = `vc-get-${Date.now()}`;
      let response: any = null;
      let error: any = null;
      
      const handler = (stanza: any) => {
        secureLog.debug(`vCard query received stanza: id=${stanza.attrs.id}, type=${stanza.attrs.type}, from=${stanza.attrs.from}`);
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
        secureLog.debug(`Querying vCard from ${targetJid || 'self'} with id ${id}`);
        await xmpp.send(xml("iq", iqAttrs, xml("vCard", { xmlns: "vcard-temp" })));
        // Wait for response
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        error = err;
        secureLog.debug(`vCard query send error: ${err}`);
      } finally {
        xmpp.off('stanza', handler);
      }
      
      if (error) {
        secureLog.debug(`vCard query error: ${error}`);
        return null;
      }
      
      if (response) {
        const vcardEl = response.getChild('vCard');
        if (vcardEl) {
          const data = parseVCardXml(vcardEl);
          secureLog.debug(`vCard parsed: fn=${data.fn}, nickname=${data.nickname}`);
          return data;
        }
      }
      secureLog.debug(`vCard query no response for ${targetJid || 'self'}`);
      return null;
    };
    
    const updateVCardOnServer = async (updates: any): Promise<boolean> => {
      // Get current vCard from server first
      const current = await queryVCardFromServer('');
      const merged = current ? { ...current, ...updates } : updates;
      
      const vcardId = `vc-set-${Date.now()}`;
      const vcardSet = xml("iq", { type: "set", id: vcardId },
        xml("vCard", { xmlns: "vcard-temp" },
          merged.fn ? xml("FN", {}, merged.fn) : null,
          merged.nickname ? xml("NICKNAME", {}, merged.nickname) : null,
          merged.url ? xml("URL", {}, merged.url) : null,
          merged.desc ? xml("DESC", {}, merged.desc) : null,
          merged.avatarUrl ? xml("PHOTO", {}, xml("URI", {}, merged.avatarUrl)) : null
        )
      );
      
      try {
        await xmpp.send(vcardSet);
        return true;
      } catch (err) {
        console.error("Failed to update vCard on server:", err);
        return false;
      }
    };

   xmpp.on("error", (err: any) => {
     log.error("XMPP error", err);
     console.error("XMPP error details:", err);
     logAuditEvent(AuditEventType.SUSPICIOUS_ACTIVITY, cfg?.jid || 'unknown', 'xmpp_error', 'failure', {
       metadata: { error: String(err).substring(0, 500) }
     });
   });

   xmpp.on("offline", () => {
     secureLog.debug("XMPP went offline");
     isRunning = false;
     logAuditEvent(AuditEventType.XMPP_DISCONNECTED, cfg?.jid || 'unknown', 'xmpp_offline', 'success');
   });

    xmpp.on("online", async (address: any) => {
       log.info("XMPP online as", address.toString());
       secureLog.debug("XMPP connected successfully");
       logAuditEvent(AuditEventType.XMPP_CONNECTED, cfg?.jid || 'unknown', 'xmpp_online', 'success', {
         metadata: { address: address.toString() }
       });
 
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
 
      // Register vCard with the XMPP server so clients can query it
      try {
       console.log("📝 Registering vCard with XMPP server...");
       const vcardData = vcard.getData();
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

       await xmpp.send(vcardSet);
       console.log("✅ vCard registered with server (id=" + vcardId + ") - clients can now query it");
       log.info("vCard registered with server");
     } catch (err) {
       console.error("❌ Failed to register vCard with server:", err);
       log.error("Failed to register vCard", err);
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
     // secureLog.debug("XMPP stanza received: " + stanza.toString().substring(0, 200));
     
     if (stanza.is("presence")) {
      const from = stanza.attrs.from;
      const type = stanza.attrs.type || "available";
      const parts = from.split('/');
      const room = parts[0];
      const nick = parts[1] || '';
      
       // Handle subscription requests (require admin approval)
       if (type === "subscribe") {
         const bareFrom = from.split('/')[0];
         console.log(`📨 Received subscription request from ${bareFrom}`);

         // Check if already a contact (pre-approved)
         if (contacts.exists(bareFrom)) {
           try {
             const subscribed = xml("presence", { to: from, type: "subscribed" });
             await xmpp.send(subscribed);
             console.log(`✅ Auto-approved subscription for existing contact ${bareFrom}`);

             const subscribe = xml("presence", { to: from, type: "subscribe" });
             await xmpp.send(subscribe);
             console.log(`📤 Sent mutual subscription request to ${bareFrom}`);
           } catch (err) {
             console.error(`❌ Failed to handle subscription for contact ${bareFrom}:`, err);
           }
           return;
         }

         // Check if already pending
         const existingPending = pendingSubscriptions.get(bareFrom);
         if (existingPending && existingPending.status === 'pending') {
           console.log(`ℹ️ Subscription request from ${bareFrom} already pending`);
           return;
         }

         // Add to pending subscriptions (requires admin approval)
         pendingSubscriptions.set(bareFrom, {
           jid: bareFrom,
           timestamp: Date.now(),
           status: 'pending'
         });
         console.log(`📝 Added ${bareFrom} to pending subscriptions (requires admin approval)`);

         // Notify admins
         const adminJids = contacts.listAdmins();
         if (adminJids.length > 0) {
           const notificationMsg = `🔔 New subscription request from ${bareFrom}\nUse /subscriptions approve ${bareFrom} to approve or /subscriptions deny ${bareFrom} to deny.`;
           for (const adminJid of adminJids) {
             try {
               const notification = xml("message", { to: adminJid, type: "chat" },
                 xml("body", {}, notificationMsg)
               );
               await xmpp.send(notification);
             } catch (err) {
               console.error(`Failed to notify admin ${adminJid}:`, err);
             }
           }
           console.log(`📢 Admins notified of pending subscription request`);
         } else {
           console.log(`⚠️ No admins configured - subscription request pending but no one to approve`);
         }
         return;
       }

       // Helper to approve pending subscription
       async function approveSubscription(targetJid: string): Promise<boolean> {
         const pending = pendingSubscriptions.get(targetJid);
         if (!pending || pending.status !== 'pending') {
           console.log(`No pending subscription found for ${targetJid}`);
           return false;
         }

         try {
           const subscribed = xml("presence", { to: targetJid, type: "subscribed" });
           await xmpp.send(subscribed);
           console.log(`✅ Approved subscription for ${targetJid}`);

           const subscribe = xml("presence", { to: targetJid, type: "subscribe" });
           await xmpp.send(subscribe);
           console.log(`📤 Sent mutual subscription request to ${targetJid}`);

           // Add to contacts
           contacts.add(targetJid);
           console.log(`📝 Added ${targetJid} to contacts`);

           pending.status = 'approved';
           pendingSubscriptions.set(targetJid, pending);

           // Notify requester
           try {
             const notifyMsg = xml("message", { to: targetJid, type: "chat" },
               xml("body", {}, "✅ Your subscription request has been approved!")
             );
             await xmpp.send(notifyMsg);
           } catch (err) {
             console.error(`Failed to notify ${targetJid} of approval:`, err);
           }

           return true;
         } catch (err) {
           console.error(`Failed to approve subscription for ${targetJid}:`, err);
           return false;
         }
       }

       // Helper to deny pending subscription
       async function denySubscription(targetJid: string): Promise<boolean> {
         const pending = pendingSubscriptions.get(targetJid);
         if (!pending || pending.status !== 'pending') {
           console.log(`No pending subscription found for ${targetJid}`);
           return false;
         }

         try {
           const unsubscribed = xml("presence", { to: targetJid, type: "unsubscribed" });
           await xmpp.send(unsubscribed);
           console.log(`❌ Denied subscription for ${targetJid}`);

           pending.status = 'denied';
           pendingSubscriptions.set(targetJid, pending);

           // Notify requester
           try {
             const notifyMsg = xml("message", { to: targetJid, type: "chat" },
               xml("body", {}, "❌ Your subscription request has been denied.")
             );
             await xmpp.send(notifyMsg);
           } catch (err) {
             console.error(`Failed to notify ${targetJid} of denial:`, err);
           }

           return true;
         } catch (err) {
           console.error(`Failed to deny subscription for ${targetJid}:`, err);
           return false;
         }
       }

       // Export helper functions for commands module
       (global as any).approveSubscription = approveSubscription;
       (global as any).denySubscription = denySubscription;
      
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
      secureLog.debug(`IQ stanza: type=${type}, from=${from}, id=${id}`);
      
      // Handle SI File Transfer requests (XEP-0096)
      if (type === "set") {
        const si = stanza.getChild("si", "http://jabber.org/protocol/si");
        if (si) {
          secureLog.debug(`SI file transfer offer from ${from}`);
          // Check for file transfer profile
          const file = si.getChild("file", "http://jabber.org/protocol/si/profile/file-transfer");
           if (file) {
             const filename = file.attrs.name || "unknown";
             const size = file.attrs.size ? parseInt(file.attrs.size) : 0;
             secureLog.debug(`File offer: ${filename} (${size} bytes)`);

              // Validate file size
              if (size > 0) {
                const sizeValidation = validators.isValidFileSize(size);
                if (!sizeValidation.valid) {
                  console.log(`[SECURITY] Rejected file transfer: ${sizeValidation.error}`);
                  const errorIq = xml("iq", { to: from, type: "error", id },
                    xml("error", { type: "cancel" },
                      xml("file-size-too-big", { xmlns: "urn:xmpp:filesize:0" }),
                      xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }, sizeValidation.error || 'File too large')
                    )
                  );
                  await xmpp.send(errorIq);
                  return;
                }
             }

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
              // Save file to downloads directory with path traversal protection
              const tempDir = path.join(cfg.dataDir, 'downloads');
              if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
              }
              
              // Sanitize filename from sender to prevent path traversal
              let safeFilename = session.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const normalizedPath = path.normalize(safeFilename);
              if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
                safeFilename = `file_${Date.now()}_${safeFilename}`;
                console.log(`[SECURITY] IBB: Rejected unsafe filename, using: ${safeFilename}`);
              }
              
              const filePath = path.join(tempDir, safeFilename);
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
            // Save file if we have data with path traversal protection
            if (session.received > 0) {
              const tempDir = path.join(cfg.dataDir, 'downloads');
              if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
              }
              
              // Sanitize filename from sender
              let safeFilename = session.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const normalizedPath = path.normalize(safeFilename);
              if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
                safeFilename = `file_${Date.now()}_${safeFilename}`;
                console.log(`[SECURITY] IBB Close: Rejected unsafe filename, using: ${safeFilename}`);
              }
              
              const filePath = path.join(tempDir, safeFilename);
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
            const targetJid = to || from;
            console.log(`vCard request from ${from}, target: ${targetJid}, type: ${type}`);

            // Check if this is for the bot's JID
            const botBareJid = cfg.jid?.split('/')[0];
            const targetBareJid = targetJid.split('/')[0];
            const isForBot = targetBareJid === botBareJid;

            if (type === "get") {
              if (isForBot) {
                // Respond with bot's vCard
                const localPart = cfg?.jid?.split("@")[0] || "openclaw";
                const fn = vcard.getFN() || `OpenClaw (${localPart})`;
                const nickname = vcard.getNickname() || localPart;
                const url = vcard.getURL() || "https://github.com/anomalyco/openclaw";
                const desc = vcard.getDesc() || "OpenClaw XMPP Plugin - AI Assistant";

                const vcardResponse = xml("iq", { to: from, type: "result", id },
                  xml("vCard", { xmlns: "vcard-temp" },
                    xml("FN", {}, fn),
                    xml("NICKNAME", {}, nickname),
                    xml("URL", {}, url),
                    xml("DESC", {}, desc)
                  )
                );
                await xmpp.send(vcardResponse);
                console.log(`Sent bot vCard response to ${from}`);
              } else {
                // Forward request to server for user vCard
                console.log(`Forwarding vCard GET for ${targetJid} to server`);
                const forwardIq = xml("iq", { to: targetJid, type: "get", id }, stanza.children);
                await xmpp.send(forwardIq);
              }
              return;
            } else if (type === "set") {
              // vCard SET from user - this is for storing on the server
              // The user's XMPP client should handle this directly
              // But if it comes to us, we just acknowledge it (we don't store user vCards)
              console.log(`vCard SET from ${from} - user should update via their XMPP client`);
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
      
       // Check for MUC invites (require admin approval)
       const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
       if (xElement) {
         const inviteElement = xElement.getChild('invite');
         if (inviteElement) {
           const inviter = inviteElement.attrs.from || from.split('/')[0];

           // Validate inviter JID
           const inviterValidation = validators.sanitizeJid(inviter);
           if (!inviterValidation.valid) {
             console.log(`[SECURITY] Invalid inviter JID: ${inviterValidation.error}`);
             return;
           }
           const validInviter = inviterValidation.sanitized || inviter.split('/')[0];

           const reason = inviteElement.getChildText('reason') || 'No reason given';

           // Sanitize room name
           const roomRaw = from.split('/')[0];
           const roomValidation = validators.sanitizeRoomName(roomRaw);
           if (!roomValidation.valid) {
             console.log(`[SECURITY] Invalid room name: ${roomValidation.error}`);
             return;
           }
           const room = roomValidation.sanitized || roomRaw;

           console.log(`🤝 Received MUC invite to room ${room} from ${validInviter}: ${reason}`);

           // Check if inviter is already approved (contact or admin)
           const inviterBare = validInviter.split('/')[0];
           const isApprovedContact = contacts.exists(inviterBare);

           if (isApprovedContact) {
             // Auto-accept invite from approved contacts
             try {
               const presence = xml("presence", { to: `${room}/${getDefaultNick()}` },
                 xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                   xml("history", { maxstanzas: "0" })
                 )
               );
               await xmpp.send(presence);
               joinedRooms.add(room);
               roomNicks.set(room, getDefaultNick());
               console.log(`✅ Auto-accepted invite to room ${room} (from approved contact ${inviterBare})`);
             } catch (err) {
               console.error(`❌ Failed to accept invite to room ${room}:`, err);
             }
             return;
           }

           // Check if already pending
           const existingPending = pendingInvites.get(room);
           if (existingPending && existingPending.status === 'pending') {
             console.log(`ℹ️ Invite to room ${room} already pending`);
             return;
           }

           // Add to pending invites (requires admin approval)
           pendingInvites.set(room, {
             room,
             inviter: inviterBare,
             reason,
             timestamp: Date.now(),
             status: 'pending'
           });
           console.log(`📝 Invite to room ${room} from ${inviterBare} added to pending (requires admin approval)`);

           // Notify admins
           const adminJids = contacts.listAdmins();
           if (adminJids.length > 0) {
             const notificationMsg = `🔔 MUC invite received:\nRoom: ${room}\nFrom: ${inviterBare}\nReason: ${reason}\n\nUse /invites accept ${room} to join or /invites deny ${room} to decline.`;
             for (const adminJid of adminJids) {
               try {
                 const notification = xml("message", { to: adminJid, type: "chat" },
                   xml("body", {}, notificationMsg)
                 );
                 await xmpp.send(notification);
               } catch (err) {
                 console.error(`Failed to notify admin ${adminJid}:`, err);
               }
             }
             console.log(`📢 Admins notified of pending room invite`);
           } else {
             console.log(`⚠️ No admins configured - invite pending but no one to approve`);
           }
           return;
         }
       }

       // Helper to accept pending room invite
       async function acceptRoomInvite(roomName: string): Promise<boolean> {
         const pending = pendingInvites.get(roomName);
         if (!pending || pending.status !== 'pending') {
           console.log(`No pending invite found for room ${roomName}`);
           return false;
         }

         try {
           const presence = xml("presence", { to: `${roomName}/${getDefaultNick()}` },
             xml("x", { xmlns: "http://jabber.org/protocol/muc" },
               xml("history", { maxstanzas: "0" })
             )
           );
           await xmpp.send(presence);
           joinedRooms.add(roomName);
           roomNicks.set(roomName, getDefaultNick());
           console.log(`✅ Joined room ${roomName}`);

           pending.status = 'approved';
           pendingInvites.set(roomName, pending);

           // Notify inviter
           try {
             const notifyMsg = xml("message", { to: pending.inviter, type: "chat" },
               xml("body", {}, `✅ Your invite to room ${roomName} has been accepted!`)
             );
             await xmpp.send(notifyMsg);
           } catch (err) {
             console.error(`Failed to notify ${pending.inviter}:`, err);
           }

           return true;
         } catch (err) {
           console.error(`Failed to join room ${roomName}:`, err);
           return false;
         }
       }

       // Helper to deny pending room invite
       async function denyRoomInvite(roomName: string): Promise<boolean> {
         const pending = pendingInvites.get(roomName);
         if (!pending || pending.status !== 'pending') {
           console.log(`No pending invite found for room ${roomName}`);
           return false;
         }

         pending.status = 'denied';
         pendingInvites.set(roomName, pending);
         console.log(`❌ Denied invite to room ${roomName}`);

         // Notify inviter
         try {
           const notifyMsg = xml("message", { to: pending.inviter, type: "chat" },
             xml("body", {}, `❌ Your invite to room ${roomName} has been declined.`)
           );
           await xmpp.send(notifyMsg);
         } catch (err) {
           console.error(`Failed to notify ${pending.inviter}:`, err);
         }

         return true;
       }

       // Export helper functions for commands module
       (global as any).acceptRoomInvite = acceptRoomInvite;
       (global as any).denyRoomInvite = denyRoomInvite;
      
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
       
       // Strip resource from sender JID early for file downloads
       const fromBareJid = from.split("/")[0];
       
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
              const localPaths = await processInboundFiles([url], fromBareJid);
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
         
         secureLog.debug(`XMPP message: type=${messageType}, from=${from}, body=${body?.substring(0, 50)}`);
          
         // fromBareJid already defined above for file downloads
         
          // Check for slash commands (in both chat and groupchat)
        // Behavior:
        // - Groupchat: Only plugin commands are processed locally, others ignored (not forwarded to agents)
        // - Chat: Plugin commands handled locally, /help also forwarded to agent
        // - Chat non-plugin commands: Forwarded to agent only if sender is contact
        // Plugin commands: list, add, remove, admins, whoami, join, rooms, leave, invite, whiteboard, help
        if (body && body.startsWith('/')) {
           secureLog.debug(`[SLASH] Command: ${body.substring(0, 100)}`);
          
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
          
          // Rate limit check
          if (!checkRateLimit(fromBareJid)) {
            await sendReply("❌ Too many commands. Please wait before sending more.");
            return;
          }
        
          // Define plugin-specific commands
          const pluginCommands = new Set(['list', 'add', 'remove', 'admins', 'whoami', 'join', 'rooms', 'leave', 'invite', 'whiteboard', 'vcard', 'help']);
          const isPluginCommand = pluginCommands.has(command);
          
          secureLog.debug(`[SLASH] type=${messageType}, cmd=/${command}, isPlugin=${isPluginCommand}`);
         
          // Groupchat handling: only process plugin commands, ignore others
          if (messageType === "groupchat") {
            if (!isPluginCommand) {
              secureLog.debug(`Ignoring non-plugin slash command in groupchat: /${command}`);
              return; // DO NOT forward to agents
            }
          }
          
          // Chat handling: plugin commands handled locally, non-plugin forwarded if contact
          if (messageType === "chat") {
            if (isPluginCommand) {
              // Plugin command in chat - handle locally (except /help special case)
            } else {
              // Non-plugin command in chat - only forward if sender is contact
              if (contacts.exists(fromBareJid)) {
                secureLog.debug(`Forwarding non-plugin command /${command} to agent`);
                onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
              } else {
                secureLog.debug(`Ignoring non-plugin slash command from non-contact: /${command}`);
                await sendReply(`❌ Unknown command: /${command}. You must be a contact to use bot commands.`);
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
    /subscriptions - Manage subscription requests (admin only - CLI)
    /invites - Manage room invites (admin only - CLI)
    /help - Show this help`);
              
                // SPECIAL CASE: /help forwards to agent ONLY in direct chat (not groupchat)
                if (messageType === "chat" && contacts.exists(fromBareJid)) {
                   secureLog.debug(`Forwarding /help to agent`);
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
                await sendReply(`❌ Failed to join room. Please check the room address and try again.`);
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
                await sendReply(`❌ Failed to leave room. Please try again.`);
              }
                return;

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
 /vcard get - Show current vCard (from server)
 /vcard get <jid> - Show vCard for any user
 /vcard set fn <value> - Set Full Name
 /vcard set nickname <value> - Set Nickname
 /vcard set url <value> - Set URL
 /vcard set desc <value> - Set Description
 /vcard set avatarUrl <value> - Set Avatar URL`);
                   return;
                 }
                 const subcmd = args[0].toLowerCase();
                 
                 if (subcmd === 'get') {
                   if (args.length >= 2) {
                     // Query another user's vCard
                     const targetJid = args[1];
                     const userVCard = await queryVCardFromServer(targetJid);
                     if (userVCard) {
                       await sendReply(`vCard for ${targetJid}:
 FN: ${userVCard.fn || '(not set)'}
 Nickname: ${userVCard.nickname || '(not set)'}
 URL: ${userVCard.url || '(not set)'}
 Description: ${userVCard.desc || '(not set)'}
 Avatar URL: ${userVCard.avatarUrl || '(not set)'}`);
                     } else {
                       await sendReply(`❌ No vCard found for ${targetJid}`);
                     }
                   } else {
                     // Query bot's vCard from server
                     const botVCard = await queryVCardFromServer('');
                     if (botVCard) {
                       await sendReply(`vCard (from server):
 FN: ${botVCard.fn || '(not set)'}
 Nickname: ${botVCard.nickname || '(not set)'}
 URL: ${botVCard.url || '(not set)'}
 Description: ${botVCard.desc || '(not set)'}
 Avatar URL: ${botVCard.avatarUrl || '(not set)'}`);
                     } else {
                       await sendReply(`❌ Failed to retrieve vCard from server`);
                     }
                   }
                   return;
                 } else if (subcmd === 'set') {
                   if (args.length < 3) {
                     await sendReply('Usage: /vcard set <field> <value>');
                     return;
                   }
                   const field = args[1].toLowerCase();
                   const value = args.slice(2).join(' ');
                   
                   // Validate field
                   if (!['fn', 'nickname', 'url', 'desc', 'avatarurl'].includes(field)) {
                     await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, avatarUrl`);
                     return;
                   }
                   
                   // Update server vCard
                   const updates: any = {};
                   if (field === 'fn') updates.fn = value;
                   if (field === 'nickname') updates.nickname = value;
                   if (field === 'url') updates.url = value;
                   if (field === 'desc') updates.desc = value;
                   if (field === 'avatarurl') updates.avatarUrl = value;
                   
                   const success = await updateVCardOnServer(updates);
                   
                   if (success) {
                     // Also update local cache for responding to others
                     if (field === 'fn') vcard.setFN(value);
                     if (field === 'nickname') vcard.setNickname(value);
                     if (field === 'url') vcard.setURL(value);
                     if (field === 'desc') vcard.setDesc(value);
                     if (field === 'avatarurl') vcard.setAvatarUrl(value);
                     
                     await sendReply(`✅ vCard field '${field}' updated on server: ${value}`);
                    } else {
                      await sendReply(`❌ Failed to update vCard on server`);
                    }
                    return;
                    } else {
                      await sendReply(`Unknown vCard subcommand: ${subcmd}. Use /vcard help for available commands.`);
                    }
                    return;

                case 'whiteboard':
                  // Handle /whiteboard draw <prompt> or /whiteboard send <url>
                  if (args.length === 0) {
                    await sendReply(`Whiteboard commands:
  /whiteboard draw <prompt> - Request AI image generation
  /whiteboard send <url> - Share an image URL`);
                    return;
                  }
                  
                  const wbSubcmd = args[0].toLowerCase();
                  if (wbSubcmd === 'draw' && args.length >= 2) {
                    const prompt = args.slice(1).join(' ');
                    onMessage(fromBareJid, body, { 
                      type: messageType, 
                      room: roomJid || undefined, 
                      nick, 
                      botNick,
                      mediaUrls, 
                      mediaPaths,
                      whiteboardRequest: true,
                      whiteboardPrompt: prompt
                    });
                    await sendReply(`🎨 Requesting image generation for: "${prompt}"`);
                  } else if (wbSubcmd === 'send' && args.length >= 2) {
                    const url = args[1];
                    onMessage(fromBareJid, body, { 
                      type: messageType, 
                      room: roomJid || undefined, 
                      nick, 
                      botNick,
                      mediaUrls: [...(mediaUrls || []), url],
                      mediaPaths,
                      whiteboardImage: true
                    });
                    await sendReply(`🖼️ Sharing image: ${url}`);
                  } else {
                    await sendReply(`Usage: /whiteboard draw <prompt> or /whiteboard send <url>`);
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
       secureLog.debug(`[NORMAL] Processing message (type=${messageType})`);
       // Safety check: slash commands should never reach here
       if (body.startsWith('/')) {
         secureLog.debug(`[ERROR] Slash command reached normal processing! This should not happen.`);
         return;
       }
       if (messageType === "groupchat") {
         // MUC message
         const roomJid = from.split("/")[0];
         const nick = from.split("/")[1] || "";
         if (!nick) {
           secureLog.debug(`Ignoring room message without nick (likely room subject)`);
           return;
         }
         const botNick = roomNicks.get(roomJid);
         // Ignore messages from ourselves
         if (botNick && nick === botNick) {
           secureLog.debug(`Ignoring self-message from bot`);
           return;
         }
         secureLog.debug(`[NORMAL] Forwarding groupchat message from ${nick} to agent`);
         // For groupchat, use room JID for session
         onMessage(roomJid, body, { type: "groupchat", room: roomJid, nick, botNick, mediaUrls, mediaPaths });
       } else {
         // Direct message
         if (contacts.exists(fromBareJid)) {
           secureLog.debug(`[NORMAL] Forwarding chat message from ${fromBareJid} to agent`);

           // Use bare JID for session
           onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
         } else {
           secureLog.debug(`Ignoring message from non-contact: ${fromBareJid}`);
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
     secureLog.debug(`Requesting upload slot for ${filename} (${size} bytes)`);
     
     // Create IQ request for upload slot
     const iqId = Math.random().toString(36).substring(2);
     const requestStanza = xml("iq", { type: "get", to: cfg.domain, id: iqId },
       xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
     );
     
     try {
       const response = await xmpp.send(requestStanza);
       secureLog.debug("Upload slot response received");
       
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
       
       secureLog.debug(`Upload slot obtained for ${filename}`);
       return { putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined };
     } catch (err) {
       console.error("Failed to request upload slot:", err);
       throw err;
     }
   };

   const uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
     secureLog.debug(`Uploading file ${filePath}`);
     
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
       
       secureLog.debug(`File uploaded successfully`);
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
       secureLog.debug(`File sent successfully to ${to}`);
     } catch (err) {
       console.error("Failed to send file via HTTP Upload:", err);
       throw err;
     }
   };

   // SI File Transfer (XEP-0096) helpers (fallback)
   const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
     secureLog.debug(`Attempting SI file transfer to ${to}`);
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

 

    const xmppClient: any = {
      // Access to raw XMPP connection for status and low-level operations
      get xmpp() { return xmpp; },
      get status() { return xmpp?.status; },
      
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

 // Import CLI commands module
  import { registerXmppCli } from "./src/commands.js";

export function register(api: any) {
  secureLog.debug(`register() called, pluginRegistered=${pluginRegistered}`);
  if (pluginRegistered) {
    console.log("XMPP plugin already registered, skipping");
    secureLog.debug("Plugin already registered, skipping");
    return;
  }
  pluginRegistered = true;
  const log = api.logger ?? console;
  log.info("Registering XMPP plugin");
  console.log("XMPP plugin register called - is this CLI or Gateway?");
  secureLog.debug("Registering XMPP plugin");
  
  // Check if this is CLI registration or Gateway registration
  // CLI registration: api.runtime is not available
  // Gateway registration: api.runtime IS available
  const isCliRegistration = !api.runtime;
  console.log(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);
  console.log(`api.runtime available: ${api.runtime ? 'yes' : 'no'}`);
secureLog.debug(`Registration context: ${isCliRegistration ? 'CLI' : 'Gateway'}`);

   // Debug: Inspect the api object
   secureLog.debug("=== API OBJECT INSPECTION ===");
   secureLog.debug("api keys: " + Object.keys(api).join(", "));
   const allApiProps: string[] = [];
   for (const key in api) {
     allApiProps.push(key);
   }
   secureLog.debug("All api properties: " + allApiProps.join(", "));
   const apiMethods = allApiProps.filter(k => typeof api[k] === 'function');
   secureLog.debug("All api methods: " + apiMethods.join(", "));
   
   // Check for runtime access (only for Gateway registration, not CLI)
   if (api.runtime && !isCliRegistration) {
     pluginRuntime = api.runtime;
     secureLog.debug("api.runtime set for Gateway registration, keys: " + Object.keys(api.runtime).join(", "));

     if (api.runtime.channel) {
       secureLog.debug("api.runtime.channel exists, keys: " + Object.keys(api.runtime.channel).join(", "));

       // Check if there's a generic message forwarding method
       const channelMethods = Object.keys(api.runtime.channel);
       secureLog.debug("Channel methods available: " + channelMethods.join(", "));

       // Look for text, message, or routing methods
       const possibleForwardMethods = ['text', 'message', 'routing', 'dispatch', 'receive'];
       for (const method of possibleForwardMethods) {
         if (api.runtime.channel[method]) {
           secureLog.debug("Found channel." + method);

           // If it's an object, log its methods
           if (typeof api.runtime.channel[method] === 'object') {
             const subMethods = Object.keys(api.runtime.channel[method]);
             secureLog.debug("  channel." + method + " methods: " + subMethods.slice(0, 10).join(", "));
           }
         }
       }

       // Also check session and activity which might handle messages
       if (api.runtime.channel.session) {
         const sessionMethods = Object.keys(api.runtime.channel.session);
         secureLog.debug("channel.session methods: " + sessionMethods.slice(0, 10).join(", "));
       }
       if (api.runtime.channel.activity) {
         const activityMethods = Object.keys(api.runtime.channel.activity);
         secureLog.debug("channel.activity methods: " + activityMethods.slice(0, 10).join(", "));
       }
     }
   } else if (isCliRegistration) {
     secureLog.debug("CLI registration - not setting pluginRuntime");
   } else {
     secureLog.debug("api.runtime not available");
   }
   secureLog.debug("=== END API INSPECTION ===");
   
   // Check for emit method
   secureLog.debug("Checking for api.emit method...");
   if (typeof api.emit === 'function') {
     secureLog.debug("api.emit is available");
   } else {
     secureLog.debug("api.emit not found");
     // Check if emit is on a different object
     if (api.runtime?.emit) {
       secureLog.debug("api.runtime.emit is available");
     }
   }
   
   // Try to use api.on for event-based message forwarding
   if (typeof api.on === 'function') {
     secureLog.debug("api.on is available for listening to events");
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
        secureLog.debug("XMPP gateway.startAccount called");
        
        const account = ctx.account;
        const config = account.config;
        
        secureLog.debug(`XMPP startAccount called for account ${account.accountId}`);
        
        if (!config?.jid?.trim() || !config?.password?.trim()) {
          secureLog.debug("Missing jid or password");
          throw new Error("XMPP account missing jid or password");
        }
        
        log?.info(`[${account.accountId}] starting XMPP connection to ${config.service}`);
        secureLog.debug(`Starting XMPP connection to ${config.service}`);
        
        const contacts = new Contacts(config.dataDir);
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
          secureLog.debug(`Existing XMPP client found for ${account.accountId}, stopping it first`);
          try {
            await existingXmpp.stop();
          } catch (err) {
            secureLog.debug(`Error stopping existing client: ${err}`);
          }
          xmppClients.delete(account.accountId);
        }
        
        // Initialize message store for persistence
        const dataDir = config.dataDir || path.join(process.cwd(), 'data');
        const messageStore = new MessageStore(dataDir);
        
         let isRunning = true;
 
         // Use pluginRuntime (from api.runtime) instead of ctx.runtime
         const runtime = pluginRuntime;
         secureLog.debug("Using pluginRuntime in startAccount");
         
          // Counter for unique message IDs
          let messageCounter = 0;
          
          const xmpp = await startXmpp(config, contacts, log, async (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean }) => {
            if (!isRunning) {
              secureLog.debug("XMPP message ignored - plugin not running");
              return;
            }

             secureLog.debug(`XMPP inbound from ${from}`);
             
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
                secureLog.debug(`buildContextPayload: senderId=${senderId}, sessionKey=${sessionKey}`);

                // Generate unique message ID using counter + timestamp
                const uniqueMessageId = `xmpp-${Date.now()}-${++messageCounter}`;

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
                              console.error("❌ XMPP SEND ERROR:", err);
                              return { ok: false, error: String(err) };
                            }
                        };
                        
                          // Create a SIMPLE dispatcher that executes immediately
                          const replyToXmpp = `xmpp:${replyTo}`;
                          console.log(`[DISPATCH] Using replyTo: ${replyToXmpp} for ${options?.type}`);
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
                         
                          // Fire-and-forget: dispatch without await to prevent blocking
                          // The simpleDispatcher will call immediateSendText when agent responds
                          console.log("🔄 Calling dispatchReplyFromConfig...");
                          runtime.channel.reply.dispatchReplyFromConfig({
                            ctx: ctxPayload,
                            cfg: ctx.cfg,
                            dispatcher: simpleDispatcher,
                            replyOptions: {},
                          }).then((result: any) => {
                            console.log("✅ dispatchReplyFromConfig returned:", result);
                          }).catch((err: any) => {
                            console.error("❌ Dispatch error (non-blocking):", err);
                          });
                         
                         console.log(`✅ METHOD 1 dispatched (non-blocking)`);
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
                         
                         // Fire-and-forget dispatch
                         runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                           ctx: ctxPayload,
                           cfg: ctx.cfg,
                           sendText: sendText,
                           dispatcherOptions: {},
                         }).catch((err: any) => {
                           console.error("Method 2 dispatch error (non-blocking):", err);
                         });
                         
                         console.log(`✅ METHOD 2 dispatched (non-blocking)`);
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
                  const senderBareJid = from.split('/')[0];
                  if (methodName === 'receiveText' || methodName === 'receiveMessage') {
                    ctx[methodName]({
                      from: `xmpp:${senderBareJid}`,
                      to: `xmpp:${config.jid}`,
                      body: body,
                      channel: "xmpp",
                      accountId: account.accountId,
                    });
                  } else {
                    ctx[methodName](senderBareJid, body, {
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
                 const senderBareJid = from.split('/')[0];
                 const ctxPayload = buildContextPayload(`xmpp:${senderBareJid}`, senderBareJid);

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
                const senderBareJid = from.split('/')[0];
                runtime.channel.activity.record({
                  channel: "xmpp",
                  accountId: account.accountId,
                  from: `xmpp:${senderBareJid}`,
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
            secureLog.debug("XMPP client stopped");
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
        messageQueue
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