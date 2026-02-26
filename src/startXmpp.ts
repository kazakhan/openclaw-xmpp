import fs from "fs";
import path from "path";
import crypto from "crypto";
import { validators } from "./security/validation.js";
import { decryptPasswordFromConfig } from "./security/encryption.js";
import { VCard } from "./vcard.js";
import { parseWhiteboardMessage } from "./whiteboard.js";
import { debugLog, checkRateLimit, downloadFile, processInboundFiles, MAX_FILE_SIZE } from "./shared/index.js";
import { Config } from "./config.js";

// We'll import @xmpp/client lazily when needed
let xmppClientModule: any = null;
let isRunning = false;

export async function startXmpp(cfg: any, contacts: any, log: any, onMessage: (from: string, body: string, options?: { type?: string, room?: string, nick?: string, botNick?: string, roomSubject?: string, mediaUrls?: string[], mediaPaths?: string[], whiteboardPrompt?: string, whiteboardRequest?: boolean, whiteboardImage?: boolean, whiteboardData?: any }) => void) {
   // Helper to get default resource/nick from JID local part
   const getDefaultResource = () => {
     const result = cfg?.resource || cfg?.jid?.split("@")[0] || "openclaw";
     return result;
   };
   const getDefaultNick = () => {
      // Priority: 
      // 1. cfg.nick (from config)
      // 2. vCard.nickname (from vCard)
      // 3. JID local part (fallback)
      // 4. "openclaw" (final fallback)
      const vcardNickname = vcard?.getNickname?.();
      const result = cfg.nick || vcardNickname || (cfg.jid ? cfg.jid.split("@")[0] : "openclaw");
      console.log(`[DEBUG] getDefaultNick: cfg.nick=${cfg.nick}, vcard.nickname=${vcardNickname}, result=${result}`);
      return result;
   };
    
    debugLog(`Starting XMPP connection to ${cfg?.service}`);
    debugLog(`XMPP config: jid=${cfg?.jid}, domain=${cfg?.domain}`);
   
   // Lazy load @xmpp/client module
   if (!xmppClientModule) {
     debugLog("Loading @xmpp/client module...");
     xmppClientModule = await import("@xmpp/client");
     debugLog("XMPP client module loaded");
   }
   
    const { client, xml } = xmppClientModule;
    
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
        const extval = photo.getChild('EXTVAL');
        if (extval) data.avatarUrl = extval.text();
      }
      
      return data;
    };
    
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
        await xmpp.send(xml("iq", iqAttrs, xml("vCard", { xmlns: "vcard-temp" })));
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
        console.log(`[VCARD QUERY] Full vCard XML: ${vcardEl?.toString()}`);
        if (vcardEl) {
          const data = parseVCardXml(vcardEl);
          debugLog(`vCard parsed: fn=${data.fn}, nickname=${data.nickname}, avatarUrl=${data.avatarUrl}`);
          console.log(`[VCARD QUERY] Parsed data: fn=${data.fn}, avatarUrl=${data.avatarUrl}`);
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
        console.log(`[VCARD UPDATE] Received stanza: id=${stanza.attrs.id}, type=${stanza.attrs.type}, from=${stanza.attrs.from}`);
        if (stanza.attrs.id === vcardId) {
          if (stanza.attrs.type === 'result') {
            console.log(`[VCARD UPDATE] Success!`);
            updateSuccess = true;
          } else if (stanza.attrs.type === 'error') {
            console.log(`[VCARD UPDATE] Error: ${stanza.toString()}`);
            updateSuccess = false;
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
        console.log(`[VCARD UPDATE] Sending vCard update with id ${vcardId}`);
        await xmpp.send(vcardSet);
        
        // Wait for response with timeout
        let waited = 0;
        while (!responseReceived && waited < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waited += 100;
        }
        
        if (!responseReceived) {
          console.log(`[VCARD UPDATE] Timeout waiting for response`);
        }
        
        console.log(`[VCARD UPDATE] Final result: ${updateSuccess}`);
        return updateSuccess;
      } catch (err) {
        console.error("[VCARD UPDATE] Failed to send vCard update:", err);
        return false;
      } finally {
        xmpp.off('stanza', handler);
      }
    };

  xmpp.on("error", (err: any) => {
    log.error("XMPP error", err);
    console.error("XMPP error details:", err);
  });

  xmpp.on("offline", () => {
    debugLog("XMPP went offline");
    isRunning = false;
    // Cleanup intervals
    if (ibbCleanupInterval) {
      clearInterval(ibbCleanupInterval);
    }
  });

   xmpp.on("online", async (address: any) => {
      log.info("XMPP online as", address.toString());
      debugLog("XMPP connected successfully");
 
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

     const roomsPendingConfig = new Set<string>(); // rooms waiting for configuration
     const ibbSessions = new Map<string, { sid: string, from: string, filename: string, size: number, data: Buffer, received: number, createdAt: number }>(); // IBB session tracking

     // Cleanup function for stale IBB sessions
     const cleanupIbbSessions = () => {
       const now = Date.now();
       for (const [sid, session] of ibbSessions.entries()) {
         if (now - session.createdAt > Config.IBB_SESSION_TIMEOUT_MS) {
           console.log(`[IBB] Cleaning up stale session: ${sid}`);
           ibbSessions.delete(sid);
         }
       }
     };

     // Run cleanup every minute
     const ibbCleanupInterval = setInterval(cleanupIbbSessions, Config.IBB_CLEANUP_INTERVAL_MS);

     // Local joined rooms tracking for MUC
     const joinedRooms = new Set<string>();
     const roomNicks = new Map<string, string>(); // room JID -> nick used by bot

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
          if (contacts.exists(bareFrom)) {
            // Auto-approve whitelisted contacts
            const subscribed = xml("presence", { to: from, type: "subscribed" });
            await xmpp.send(subscribed);
            console.log(`✅ Auto-approved subscription for whitelisted contact: ${bareFrom}`);
          } else {
            console.log(`📨 Subscription request from ${bareFrom} - not whitelisted, awaiting admin approval`);
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
        // Check if bot was removed from room (kicked or left)
        const botNick = roomNicks.get(room);
        if (nick && nick === botNick) {
          console.log(`🤖 Bot was removed from room ${room}, cleaning up...`);
          joinedRooms.delete(room);
          roomNicks.delete(room);
        }
      } else {
        console.log(`👋 User joined room ${room}: ${nick} (${from})`);
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
              console.log(`Accepting SI file transfer with IBB: ${filename}`);
              if (size > MAX_FILE_SIZE) {
                console.log(`[SECURITY] Rejected file transfer: ${filename} (${size} bytes) exceeds ${MAX_FILE_SIZE} bytes limit`);
                const errorIq = xml("iq", { to: from, type: "error", id },
                  xml("error", { type: "modify" },
                    xml("file-too-large", { xmlns: "urn:xmpp:file:too-large" }),
                    xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp:stanzas" }, `File exceeds maximum size of ${MAX_FILE_SIZE} bytes`)
                  )
                );
                await xmpp.send(errorIq);
                return;
              }
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
                 received: 0,
                 createdAt: Date.now()
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
               
               // Sanitize filename from sender using validator
               let safeFilename = validators.sanitizeFilename(session.filename);
               if (!validators.isSafePath(safeFilename, tempDir)) {
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
               
               // Sanitize filename from sender using validator
               let safeFilename = validators.sanitizeFilename(session.filename);
               if (!validators.isSafePath(safeFilename, tempDir)) {
                 safeFilename = `file_${Date.now()}_${safeFilename}`;
                 console.log(`[SECURITY] IBB Close: Rejected unsafe filename, using: ${safeFilename}`);
               }
               
               const filePath = path.join(tempDir, safeFilename);
               await fs.promises.writeFile(filePath, session.data);
               console.log(`File saved to ${filePath}`);
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
                const url = vcard.getUrl() || "https://github.com/anomalyco/openclaw";
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

        // Handle Service Discovery (XEP-0030) - disco#info
        const queryElement = stanza.getChild("query", "http://jabber.org/protocol/disco#info");
        if (queryElement && type === "get") {
          const node = queryElement.attrs.node || "";
          // Respond with our features
          const discoResponse = xml("iq", { to: from, type: "result", id },
            xml("query", { xmlns: "http://jabber.org/protocol/disco#info", node },
              xml("identity", { category: "client", type: "bot", name: "OpenClaw AI Assistant" }),
              xml("feature", { var: "http://jabber.org/protocol/disco#info" }),
              xml("feature", { var: "vcard-temp" }),
              xml("feature", { var: "http://jabber.org/protocol/muc" })
            )
          );
          await xmpp.send(discoResponse);
          console.log(`[DISCO] Sent disco#info to ${from}`);
          return;
        }

        // Handle HTTP Upload slot requests (responses to our requests)
        // These are handled by the requestUploadSlot function via await xmpp.send()
        // So we don't need to process them here
        
        return;
    }
    
    if (stanza.is("message")) {
      // DEBUG stanza for invite: Log raw debugging
      console.log(`[RAW STANZA] from=${stanza.attrs.from}, type=${stanza.attrs.type}`);
      console.log(`[RAW STANZA XML] ${stanza.toString()}`);
      
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
      
      // DEBUG: Check all x elements in stanza
      const allXElements = stanza.getChildren('x');
      console.log(`[DEBUG] Message from=${from}, type=${messageType}, xElements count=${allXElements?.length || 0}`);
      for (const xel of allXElements || []) {
        console.log(`[DEBUG] Found x element with xmlns: ${xel.attrs.xmlns}`);
      }
      
      // Check for jabber:x:conference invites
      const conferenceElement = stanza.getChild('x', 'jabber:x:conference');
      console.log(`[DEBUG] jabber:x:conference element found: ${!!conferenceElement}`);
      if (conferenceElement) {
        console.log(`[DEBUG] conferenceElement attrs:`, conferenceElement.attrs);
        console.log(`[DEBUG] conferenceElement children:`, conferenceElement.children);
      }
      
      if (conferenceElement) {
        const room = conferenceElement.attrs.jid as string;
        const password = conferenceElement.attrs.password as string;
        const reason = conferenceElement.attrs.reason as string || 'No reason given';
        console.log(`[DEBUG] Parsed invite - room=${room}, password=${password}, reason=${reason}`);
        
        if (room) {
          console.log(`🤝 Received jabber:x:conference invite to room ${room}: ${reason}`);
          
          // Auto-accept invite by joining the room
          try {
            const presence = xml("presence", { to: `${room}/${getDefaultNick()}` },
              xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                password ? xml("password", {}, password) : undefined,
                xml("history", { maxstanzas: "0" })
              )
            );
            await xmpp.send(presence);
            joinedRooms.add(room);
            roomNicks.set(room, getDefaultNick());
            console.log(`✅ Auto-accepted jabber:x:conference invite to room ${room}`);
          } catch (err) {
            console.error(`❌ Failed to accept jabber:x:conference invite to room ${room}:`, err);
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
       // DEBUG: Log raw stanza for file messages
       console.log(`[DEBUG FILE] ==== MESSAGE STANZA DEBUG ====`);
       console.log(`[DEBUG FILE] from=${from}, type=${messageType}`);
       console.log(`[DEBUG FILE] body=${stanza.getChildText("body")?.substring(0, 200)}`);
       console.log(`[DEBUG FILE] raw stanza: ${stanza.toString()}`);
       
       // DEBUG: Log all children
       const allChildren = stanza.children || [];
       console.log(`[DEBUG FILE] Total children: ${allChildren.length}`);
       for (const child of allChildren) {
         if (typeof child === 'object' && child.name) {
           console.log(`[DEBUG FILE] Child: name=${child.name}, xmlns=${child.attrs?.xmlns || 'none'}`);
         }
       }
       
       // Check for file attachments (XEP-0066: Out of Band Data)
       const oobElement = stanza.getChild('x', 'jabber:x:oob');
       console.log(`[DEBUG FILE] OOB element found: ${oobElement ? 'YES' : 'NO'}`);
       
       let mediaUrls: string[] = [];
       let mediaPaths: string[] = [];
       
       if (oobElement) {
         const url = oobElement.getChildText('url');
         console.log(`[DEBUG FILE] OOB URL: ${url || 'none'}`);
         if (url) {
           mediaUrls.push(url);
           console.log(`[DEBUG FILE] Detected file attachment: ${url}`);
           
            // Download file locally for agent processing
            try {
              const localPaths = await processInboundFiles([url], cfg.dataDir);
             mediaPaths = localPaths;
             console.log(`[DEBUG FILE] Downloaded file to local paths: ${localPaths.join(', ')}`);
           } catch (err) {
             console.error("[DEBUG FILE] Failed to download file:", err);
           }
         }
       }
       
       // DEBUG: Check for other common file sharing namespaces
       const sfsElement = stanza.getChild('file-sharing', 'urn:xmpp:sfs:0');
       console.log(`[DEBUG FILE] XEP-0447 (SFS) found: ${sfsElement ? 'YES' : 'NO'}`);
       
       const simsElement = stanza.getChild('media-sharing', 'urn:xmpp:sims:1');
       console.log(`[DEBUG FILE] XEP-0385 (SIMS) found: ${simsElement ? 'YES' : 'NO'}`);
       
       const jingleFile = stanza.getChild('file', 'http://jabber.org/protocol/si/profile/file-transfer');
       console.log(`[DEBUG FILE] XEP-0234 (File Transfer) found: ${jingleFile ? 'YES' : 'NO'}`);
       
       const bobElement = stanza.getChild('data', 'urn:xmpp:bob');
       console.log(`[DEBUG FILE] XEP-0231 (BoB) found: ${bobElement ? 'YES' : 'NO'}`);
       
       console.log(`[DEBUG FILE] ==== END DEBUG ====`);
         
         // Extract body and subject from message
         const body = stanza.getChildText("body");
         const subject = stanza.getChildText("subject");
         
         // Check for room subject change (MUC subject message)
         const isGroupChat = messageType === "groupchat";
         if (isGroupChat && subject && !body) {
           console.log(`📝 Room subject changed to: ${subject}`);
           // Forward subject as a special message to the agent
           const botNick = roomNicks.get(from.split('/')[0]);
           onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [] });
           return;
         }
         
          // Only process messages with body (invites are in body)
          if (!body && mediaUrls.length === 0) return;
        
          // Check for jabber:x:conference invites in body (may be escaped)
          if (body && (body.includes('jabber:x:conference') || body.includes('&lt;x'))) {
            console.log(`🤝 Checking for jabber:x:conference invite in body: ${body.substring(0, 100)}`);
            
            // Extract invite attributes (handle both escaped and unescaped)
            const jidMatch = body.match(/jid=['"]([^'"]+)['"]/);
            const passwordMatch = body.match(/password=['"]([^'"]+)['"]/);
            const reasonMatch = body.match(/reason=['"]([^'"]+)['"]/);
            
            const room = jidMatch?.[1];
            const password = passwordMatch?.[1];
            const reason = reasonMatch?.[1] || 'No reason given';
            
            if (room) {
              console.log(`🤝 Detected jabber:x:conference invite to room ${room}: ${reason}`);
              
              // Auto-accept invite by joining the room
              try {
                const presence = xml("presence", { to: `${room}/${getDefaultNick()}` },
                  xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                    password ? xml("password", {}, password) : undefined,
                    xml("history", { maxstanzas: "0" })
                  )
                );
                await xmpp.send(presence);
                joinedRooms.add(room);
                roomNicks.set(room, getDefaultNick());
                console.log(`✅ Auto-accepted jabber:x:conference invite to room ${room}`);
              } catch (err) {
                console.error(`❌ Failed to accept jabber:x:conference invite to room ${room}:`, err);
              }
              return; // Don't dispatch invite to AI
            }
          }
          
          debugLog(`XMPP message: type=${messageType}, from=${from}, body=${body?.substring(0, 50)}`);
        
        // Strip resource from sender JID for contact check
        const fromBareJid = from.split("/")[0];
        
        // Check for XEP-0113 Whiteboard messages (forward to AI)
        const whiteboardData = parseWhiteboardMessage(stanza);
        if (whiteboardData) {
          console.log(`🎨 Detected whiteboard message: type=${whiteboardData.type}, paths=${whiteboardData.paths?.length || 0}`);
          onMessage(fromBareJid, body || '[Whiteboard]', { 
            type: messageType, 
            room: undefined, 
            nick: undefined, 
            botNick: undefined,
            whiteboardData
          });
          return;
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
              if (contacts.exists(fromBareJid)) {
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
                if (messageType === "chat" && contacts.exists(fromBareJid)) {
                   debugLog(`Forwarding /help to agent`);
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
    /vcard set avatar <url> - Upload image from URL as avatar
   /vcard set avatar - Upload attached image as avatar`);
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
                         console.log(`[AVATAR] URL provided: ${url}`);
                         
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
                           console.log(`[AVATAR] Downloaded to: ${filePath}`);
                         } catch (err) {
                           console.error('[AVATAR] Download failed:', err);
                           await sendReply(`❌ Failed to download image: ${err instanceof Error ? err.message : 'Unknown error'}`);
                           return;
                         }
                       } else if (mediaPaths.length > 0) {
                         // Use attached file
                         filePath = mediaPaths[0];
                         console.log(`[AVATAR] Using attached file: ${filePath}`);
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
                             console.log(`[AVATAR] Uploading ${filename} (${size} bytes) via XEP-0363...`);
                             const slot = await requestUploadSlot(filename, size);
                             await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
                             imageUrl = slot.getUrl;
                             console.log(`[AVATAR] File uploaded to: ${imageUrl}`);
                           }
                           
                           // Step 1: Publish via XEP-0084 User Avatar
                           console.log(`[AVATAR] Publishing XEP-0084 avatar with URL: ${imageUrl}`);
                            const avatarPublished = await publishAvatar(filePath, imageUrl);
                            
                            // Step 2: Update vCard with embedded base64 avatar (BINVAL) - this is what clients expect
                            console.log(`[AVATAR] Reading file for vCard embedding...`);
                            const fileBuffer = await fs.promises.readFile(filePath);
                            const base64Data = fileBuffer.toString('base64');
                            const ext = path.extname(filePath).toLowerCase();
                            let mimeType = 'image/jpeg';
                            if (ext === '.png') mimeType = 'image/png';
                            else if (ext === '.gif') mimeType = 'image/gif';
                            else if (ext === '.webp') mimeType = 'image/webp';
                            
                            console.log(`[AVATAR] Updating vCard with embedded avatar (${mimeType}, ${fileBuffer.length} bytes)...`);
                            const updates = { 
                              avatarUrl: imageUrl,
                              avatarBinval: base64Data,
                              avatarType: mimeType
                            };
                            const vcardUpdated = await updateVCardOnServer(updates);
                           
                           // Report results
                           if (avatarPublished && vcardUpdated) {
                             vcard.setAvatarUrl(imageUrl);
                             await sendReply(`✅ Avatar updated successfully!\n\nXEP-0084 (PEP): Published\nvCard (XEP-0054): Updated\nURL: ${imageUrl}`);
                           } else if (avatarPublished) {
                             vcard.setAvatarUrl(imageUrl);
                             await sendReply(`✅ XEP-0084 avatar published!\n⚠️ vCard update failed (non-critical)\nURL: ${imageUrl}`);
                           } else if (vcardUpdated) {
                             vcard.setAvatarUrl(imageUrl);
                             await sendReply(`✅ vCard avatar updated!\n⚠️ XEP-0084 publish failed (non-critical)\nURL: ${imageUrl}`);
                           } else {
                             await sendReply(`❌ Failed to publish avatar`);
                           }
                         } catch (err) {
                           console.error('Avatar upload failed:', err);
                           await sendReply(`❌ Failed to upload avatar: ${err instanceof Error ? err.message : 'Unknown error'}`);
                         }
                        return;
                     }
                    
                    // For other fields, require a value
                    if (args.length < 3) {
                      await sendReply('Usage: /vcard set <field> <value>');
                      return;
                    }
                    
                    const value = args.slice(2).join(' ');
                    
                    // Validate field
                    if (!['fn', 'nickname', 'url', 'desc'].includes(field)) {
                      await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, avatar (with attached image)`);
                      return;
                    }
                    
                    // Update server vCard
                    const updates: any = {};
                    if (field === 'fn') updates.fn = value;
                    if (field === 'nickname') updates.nickname = value;
                    if (field === 'url') updates.url = value;
                    if (field === 'desc') updates.desc = value;
                    
                    const success = await updateVCardOnServer(updates);
                    
                    if (success) {
                      // Also update local cache for responding to others
                      if (field === 'fn') vcard.setFN(value);
                      if (field === 'nickname') vcard.setNickname(value);
                      if (field === 'url') vcard.setUrl(value);
                      if (field === 'desc') vcard.setDesc(value);
                      
                      await sendReply(`✅ vCard field '${field}' updated on server: ${value}`);
                     } else {
                       await sendReply(`❌ Failed to update vCard on server`);
                     }
                     return;
                    } else {
                      await sendReply(`Unknown vCard subcommand: ${subcmd}. Use /vcard help for available commands.`);
                    }
                    return;

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
                       console.error('[TEST UPLOAD] Failed:', err);
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
          if (contacts.exists(fromBareJid)) {
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
    console.error("XMPP start failed details:", err);
  });

   // HTTP File Upload (XEP-0363) helpers
    
    // Cache for upload service JID
    let uploadServiceJid: string | null = null;
    
    // Service Discovery to find HTTP File Upload service
    const discoverUploadService = async (): Promise<string | null> => {
      if (uploadServiceJid) return uploadServiceJid;
      
      console.log(`[DISCOVERY] Looking for HTTP File Upload service...`);
      const iqId = `disco-${Date.now()}`;
      
      return new Promise((resolve) => {
        let resolved = false;
        
        const handler = (stanza: any) => {
          if (stanza.attrs.id === iqId && stanza.attrs.type === 'result') {
            resolved = true;
            xmpp.off('stanza', handler);
            
            const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
            if (query) {
              const items = query.getChildren('item');
              for (const item of items) {
                const jid = item.attrs.jid;
                console.log(`[DISCOVERY] Found service: ${jid}`);
                // Check if this is an upload service
                if (jid.includes('upload') || jid.includes('httpfile')) {
                  uploadServiceJid = jid;
                  console.log(`[DISCOVERY] Found upload service: ${jid}`);
                  resolve(jid);
                  return;
                }
              }
            }
            resolve(null);
          } else if (stanza.attrs.id === iqId && stanza.attrs.type === 'error') {
            resolved = true;
            xmpp.off('stanza', handler);
            console.log(`[DISCOVERY] Service discovery failed`);
            resolve(null);
          }
        };
        
        xmpp.on('stanza', handler);
        
        // Query server for services
        const discoStanza = xml("iq", { type: "get", to: cfg.domain, id: iqId },
          xml("query", { xmlns: "http://jabber.org/protocol/disco#items" })
        );
        
        xmpp.send(discoStanza).catch(() => {
          if (!resolved) {
            xmpp.off('stanza', handler);
            resolve(null);
          }
        });
        
        setTimeout(() => {
          if (!resolved) {
            xmpp.off('stanza', handler);
            resolve(null);
          }
        }, 10000);
      });
    };
    
    const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}> => {
      debugLog(`Requesting upload slot for ${filename} (${size} bytes)`);
      
      // Discover upload service if needed
      let uploadJid = uploadServiceJid;
      if (!uploadJid) {
        uploadJid = await discoverUploadService();
      }
      
      // Fallback to domain if no upload service found
      const targetJid = uploadJid || cfg.domain;
      console.log(`[UPLOAD] Requesting slot from: ${targetJid}`);
      
      // Create IQ request for upload slot
      const iqId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const requestStanza = xml("iq", { type: "get", to: targetJid, id: iqId },
        xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
      );
      
      return new Promise((resolve, reject) => {
        let responseReceived = false;
        
        const handler = (stanza: any) => {
          if (stanza.attrs.id === iqId && stanza.attrs.type === 'result') {
            responseReceived = true;
            xmpp.off('stanza', handler);
            
            try {
              console.log(`[XEP-0363] Full response: ${stanza.toString()}`);
              
              const slot = stanza.getChild("slot", "urn:xmpp:http:upload:0");
              if (!slot) {
                console.log(`[XEP-0363] No slot element found`);
                reject(new Error("No upload slot in response"));
                return;
              }
              
              console.log(`[XEP-0363] Slot element: ${slot.toString()}`);
              console.log(`[XEP-0363] Slot children: ${slot.children.map((c: any) => c.name).join(', ')}`);
              
              // Prosody returns URLs as attributes, not text content
              const putElement = slot.getChild("put");
              const getElement = slot.getChild("get");
              const putUrl = putElement?.attrs?.url;
              const getUrl = getElement?.attrs?.url;
              
              console.log(`[XEP-0363] putUrl=${putUrl}, getUrl=${getUrl}`);
              
              if (!putUrl || !getUrl) {
                reject(new Error("Missing put or get URL in slot"));
                return;
              }
              
              // Parse optional headers (putElement already defined above)
              const putHeaders: Record<string, string> = {};
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
              
              debugLog(`Upload slot obtained for ${filename}`);
              resolve({ putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined });
            } catch (err) {
              reject(err);
            }
          } else if (stanza.attrs.id === iqId && stanza.attrs.type === 'error') {
            responseReceived = true;
            xmpp.off('stanza', handler);
            console.log(`[UPLOAD] Error stanza: ${stanza.toString()}`);
            const errorEl = stanza.getChild('error');
            let errorDetails = 'Unknown error';
            if (errorEl) {
              const errorText = errorEl.getChildText('text', 'urn:ietf:params:xml:ns:xmpp-stanzas');
              const errorCondition = errorEl.children.find((c: any) => c.name && c.name !== 'text')?.name;
              errorDetails = errorText || errorCondition || `Error type: ${errorEl.attrs.type}`;
            }
            reject(new Error(`Upload slot request failed: ${errorDetails}`));
          }
        };
        
        // Set up listener
        xmpp.on('stanza', handler);
        
        // Send request
        xmpp.send(requestStanza).catch((err: any) => {
          if (!responseReceived) {
            xmpp.off('stanza', handler);
            reject(err);
          }
        });
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (!responseReceived) {
            xmpp.off('stanza', handler);
            reject(new Error("Upload slot request timeout"));
          }
        }, 30000);
      });
    };

    const uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
      debugLog(`Uploading file ${filePath}`);
      
      try {
        // Convert HTTPS to HTTP for upload (many XMPP servers use HTTP on port 5281)
        const httpPutUrl = putUrl.replace(/^https:\/\//, 'http://');
        console.log(`[UPLOAD] Using HTTP URL: ${httpPutUrl}`);
        
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
       const response = await fetch(httpPutUrl, {
         method: 'PUT',
         headers: fetchHeaders,
         body: fileBuffer,
       });
      
       if (!response.ok) {
         throw new Error(`HTTP upload failed: ${response.status} ${response.statusText}`);
       }
       
       debugLog(`File uploaded successfully`);
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
       debugLog(`File sent successfully to ${to}`);
     } catch (err) {
       console.error("Failed to send file via HTTP Upload:", err);
       throw err;
     }
   };

   // SI File Transfer (XEP-0096) helpers (fallback)
    const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
      debugLog(`Attempting SI file transfer to ${to}`);
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
        
        console.log(`[XEP-0084] Publishing avatar: hash=${hash}, size=${size}, type=${mimeType}`);
        
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
        
        await xmpp.send(metadataStanza);
        console.log(`[XEP-0084] Avatar metadata published to ${bareJid}`);
        
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
        
        await xmpp.send(dataStanza);
        console.log(`[XEP-0084] Avatar data published`);
        
        return true;
      } catch (err) {
        console.error('[XEP-0084] Failed to publish avatar:', err);
        return false;
      }
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
       },
       inviteToRoom: async (contact: string, room: string, reason?: string, password?: string) => {
         const resolvedRoom = resolveRoomJid(room);
         const inviteAttrs: any = { jid: resolvedRoom };
         if (reason) inviteAttrs.reason = reason;
         if (password) inviteAttrs.password = password;
         
         const message = xml("message", { to: contact },
           xml("x", { xmlns: "jabber:x:conference", ...inviteAttrs })
         );
         
         debugLog(`Sending invite XML: ${message.toString()}`);
         console.log(`[INVITE DEBUG] Contact: ${contact}, Room: ${resolvedRoom}`);
         console.log(`[INVITE DEBUG] XML: ${message.toString()}`);
         
         await xmpp.send(message);
         console.log(`Invited ${contact} to room ${resolvedRoom}`);
       }
     };

  xmppClient.roomNicks = roomNicks;

  return xmppClient;
}