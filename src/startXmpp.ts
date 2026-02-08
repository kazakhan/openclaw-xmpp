import fs from "fs";
import path from "path";
import { VCard } from "./vcard.js";
import { Contacts } from "./contacts.js";
import { validators } from "./security/validation.js";
import { decryptPasswordFromConfig } from "./security/encryption.js";
import { MessageStore } from "./messageStore.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

let xmppClientModule: any = null;

export interface XmppMessageOptions {
  type?: string;
  room?: string;
  nick?: string;
  botNick?: string;
  mediaUrls?: string[];
  mediaPaths?: string[];
  whiteboardPrompt?: string;
  whiteboardRequest?: boolean;
  whiteboardImage?: boolean;
}

export interface OnMessageCallback {
  (from: string, body: string, options?: XmppMessageOptions): void;
}

export interface XmppClientInterface {
  xmpp: any;
  status?: string;
  stop: () => Promise<void>;
  send: (to: string, body: string) => Promise<void>;
  sendGroupchat: (to: string, body: string) => Promise<void>;
  joinRoom: (roomJid: string, nick?: string) => Promise<void>;
  leaveRoom: (roomJid: string, nick?: string) => Promise<void>;
  getJoinedRooms: () => string[];
  isInRoom: (roomJid: string) => boolean;
  iq: (to: string, type: string, payload?: any) => Promise<void>;
  sendFile: (to: string, filePath: string, text?: string, isGroupChat?: boolean) => Promise<void>;
  roomNicks: Map<string, string>;
  inviteToRoom: (contact: string, room: string, reason?: string, password?: string) => Promise<void>;
}

export async function startXmpp(
  cfg: any,
  contacts: Contacts,
  log: any,
  onMessage: OnMessageCallback
): Promise<XmppClientInterface> {
  const getDefaultResource = () => {
    const result = cfg?.resource || cfg?.jid?.split("@")[0] || "openclaw";
    return result;
  };

  const getDefaultNick = () => {
    const result = cfg.jid ? cfg.jid.split("@")[0] : "openclaw";
    return result;
  };

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

  const downloadFile = async (url: string, tempDir: string): Promise<string> => {
    debugLog(`Downloading file from ${url}`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (!validators.isValidUrl(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }

    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let filename = path.basename(pathname) || `file_${Date.now()}.bin`;

    const safeFilename = validators.sanitizeFilename(filename);
    if (safeFilename !== filename) {
      console.log(`[SECURITY] Sanitized filename: "${filename}" -> "${safeFilename}"`);
      filename = safeFilename;
    }

    if (!validators.isSafePath(filename, tempDir)) {
      filename = `file_${Date.now()}_${safeFilename}`;
      console.log(`[SECURITY] Rejected unsafe filename, using: ${filename}`);
    }

    const filePath = path.join(tempDir, filename);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const fileSize = parseInt(contentLength, 10);
        if (fileSize > MAX_FILE_SIZE) {
          throw new Error(`File too large: ${fileSize} bytes > ${MAX_FILE_SIZE} bytes limit`);
        }
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${buffer.byteLength} bytes > ${MAX_FILE_SIZE} bytes limit`);
      }

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

    const tempDir = path.join(cfg.dataDir, 'downloads');
    const localPaths: string[] = [];

    for (const url of urls) {
      try {
        const localPath = await downloadFile(url, tempDir);
        localPaths.push(localPath);
      } catch (err) {
        console.error(`Failed to download ${url}:`, err);
      }
    }

    return localPaths;
  };

  debugLog(`Starting XMPP connection to ${cfg?.service}`);
  debugLog(`XMPP config: jid=${cfg?.jid}, domain=${cfg?.domain}`);

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

  const resolveRoomJid = (room: string): string => {
    if (room.includes('@')) {
      return room;
    }
    return `${room}@conference.${cfg.domain}`;
  };

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
      debugLog(`vCard query received stanza: id=${stanza.attrs.id}, type=${stanza.attrs.type}, from=${stanza.attrs.from}`);
      if (stanza.attrs.id === id && stanza.attrs.type === 'result') {
        response = stanza;
      }
    };

    xmpp.on('stanza', handler);

    try {
      const iqAttrs: any = { type: "get", id };
      if (targetJid) {
        iqAttrs.to = targetJid;
      }
      debugLog(`Querying vCard from ${targetJid || 'self'} with id ${id}`);
      await xmpp.send(xml("iq", iqAttrs, xml("vCard", { xmlns: "vcard-temp" })));
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
      if (vcardEl) {
        const data = parseVCardXml(vcardEl);
        debugLog(`vCard parsed: fn=${data.fn}, nickname=${data.nickname}`);
        return data;
      }
    }
    debugLog(`vCard query no response for ${targetJid || 'self'}`);
    return null;
  };

  const updateVCardOnServer = async (updates: any): Promise<boolean> => {
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
  });

  xmpp.on("offline", () => {
    debugLog("XMPP went offline");
    isRunning = false;
  });

  xmpp.on("online", async (address: any) => {
    log.info("XMPP online as", address.toString());
    debugLog("XMPP connected successfully");

    try {
      const presence = xml("presence");
      await xmpp.send(presence);
      console.log("✅ Presence sent - should appear online now as", address.toString());
      log.info("Presence sent");
    } catch (err) {
      console.error("❌ Failed to send presence:", err);
      log.error("Failed to send presence", err);
    }

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

  const roomsPendingConfig = new Set<string>();
  const ibbSessions = new Map<string, { sid: string, from: string, filename: string, size: number, data: Buffer, received: number }>();

  const joinedRooms = new Set<string>();
  const roomNicks = new Map<string, string>();

  let isRunning = true;

  const vcard = new VCard(cfg.dataDir);

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

    if (stanza.is("presence")) {
      const from = stanza.attrs.from;
      const type = stanza.attrs.type || "available";
      const parts = from.split('/');
      const room = parts[0];
      const nick = parts[1] || '';

      if (type === "subscribe") {
        const bareFrom = from.split('/')[0];
        console.log(`📨 Subscription request from ${bareFrom} - awaiting admin approval`);
        return;
      }

      if (type === "subscribed" || type === "unsubscribe" || type === "unsubscribed") {
        console.log(`📨 Received ${type} from ${from}`);
        if (type === "subscribed") {
          const bareFrom = from.split('/')[0];
          if (!contacts.exists(bareFrom)) {
            contacts.add(bareFrom);
            console.log(`📝 Added ${bareFrom} to contacts after subscription approval`);
          }
        }
        return;
      }

      if (type === "probe") {
        console.log(`🔍 Received presence probe from ${from}`);
        try {
          const presence = xml("presence", { to: from });
          await xmpp.send(presence);
          console.log(`✅ Sent presence response to probe from ${from}`);
        } catch (err) {
          console.error(`❌ Failed to respond to presence probe from ${from}:`, err);
        }
        return;
      }

      const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
      if (xElement) {
        const statusElements = xElement.getChildren('status');
        for (const status of statusElements) {
          const code = status.attrs.code;
          console.log(`MUC status code ${code} for room ${room}, nick ${nick}`);
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
      debugLog(`IQ stanza: type=${type}, from=${from}, id=${id}`);

      if (type === "set") {
        const si = stanza.getChild("si", "http://jabber.org/protocol/si");
        if (si) {
          debugLog(`SI file transfer offer from ${from}`);
          const file = si.getChild("file", "http://jabber.org/protocol/si/profile/file-transfer");
          if (file) {
            const filename = file.attrs.name || "unknown";
            const size = file.attrs.size ? parseInt(file.attrs.size) : 0;
            debugLog(`File offer: ${filename} (${size} bytes)`);

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

              ibbSessions.set(sid, {
                sid,
                from,
                filename,
                size,
                data: Buffer.alloc(0),
                received: 0
              });

              const acceptIq = xml("iq", { to: from, type: "result", id });
              await xmpp.send(acceptIq);
              console.log(`SI session ${sid} accepted, waiting for IBB open`);
            } else {
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
          const resultIq = xml("iq", { to: from, type: "result", id });
          await xmpp.send(resultIq);

          if (session.size > 0 && session.received >= session.size) {
            console.log(`File ${session.filename} received completely (${session.received} bytes)`);
            const tempDir = path.join(cfg.dataDir, 'downloads');
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }

            let safeFilename = validators.sanitizeFilename(session.filename);
            if (!validators.isSafePath(safeFilename, tempDir)) {
              safeFilename = `file_${Date.now()}_${safeFilename}`;
              console.log(`[SECURITY] IBB: Rejected unsafe filename, using: ${safeFilename}`);
            }

            const filePath = path.join(tempDir, safeFilename);
            await fs.promises.writeFile(filePath, session.data);
            console.log(`File saved to ${filePath}`);
            ibbSessions.delete(sid);
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
          if (session.received > 0) {
            const tempDir = path.join(cfg.dataDir, 'downloads');
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }

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

      const vcardElement = stanza.getChild("vCard", "vcard-temp");
      if (vcardElement) {
        const targetJid = to || from;
        console.log(`vCard request from ${from}, target: ${targetJid}, type: ${type}`);

        const botBareJid = cfg.jid?.split('/')[0];
        const targetBareJid = targetJid.split('/')[0];
        const isForBot = targetBareJid === botBareJid;

        if (type === "get") {
          if (isForBot) {
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
            console.log(`Forwarding vCard GET for ${targetJid} to server`);
            const forwardIq = xml("iq", { to: targetJid, type: "get", id }, stanza.children);
            await xmpp.send(forwardIq);
          }
          return;
        } else if (type === "set") {
          console.log(`vCard SET from ${from} - user should update via their XMPP client`);
          const resultIq = xml("iq", { to: from, type: "result", id });
          await xmpp.send(resultIq);
          return;
        }
      }

      return;
    }

    if (stanza.is("message")) {
      console.log(`[RAW STANZA] from=${stanza.attrs.from}, type=${stanza.attrs.type}`);
      console.log(`[RAW STANZA XML] ${stanza.toString()}`);

      const from = stanza.attrs.from;
      const to = stanza.attrs.to;
      const messageType = stanza.attrs.type || "chat";

      const xElement = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
      if (xElement) {
        const inviteElement = xElement.getChild('invite');
        if (inviteElement) {
          const inviter = inviteElement.attrs.from || from.split('/')[0];
          const reason = inviteElement.getChildText('reason') || 'No reason given';
          console.log(`🤝 Received MUC invite to room ${from} from ${inviter}: ${reason}`);

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

      const allXElements = stanza.getChildren('x');
      console.log(`[DEBUG] Message from=${from}, type=${messageType}, xElements count=${allXElements?.length || 0}`);
      for (const xel of allXElements || []) {
        console.log(`[DEBUG] Found x element with xmlns: ${xel.attrs.xmlns}`);
      }

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

      const mucOwnerX = stanza.getChild('x', 'http://jabber.org/protocol/muc#owner');
      if (mucOwnerX) {
        const xDataForm = mucOwnerX.getChild('x', 'jabber:x:data');
        if (xDataForm && xDataForm.attrs.type === 'form') {
          console.log(`📋 Received room configuration form for room ${from}`);

          try {
            const formId = xDataForm.getChildText('title') || 'Room Configuration';
            console.log(`Auto-configuring room: ${formId}`);

            const submittedForm = xml("x", { xmlns: "jabber:x:data", type: "submit" });

            const fields = xDataForm.getChildren('field');
            for (const field of fields) {
              const varName = field.attrs.var;
              if (varName) {
                submittedForm.append(xml("field", { var: varName }));
              }
            }

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

      const oobElement = stanza.getChild('x', 'jabber:x:oob');
      let mediaUrls: string[] = [];
      let mediaPaths: string[] = [];
      if (oobElement) {
        const url = oobElement.getChildText('url');
        if (url) {
          mediaUrls.push(url);
          console.log(`Detected file attachment: ${url}`);

          try {
            const localPaths = await processInboundFiles([url]);
            mediaPaths = localPaths;
            console.log(`Downloaded file to local paths: ${localPaths.join(', ')}`);
          } catch (err) {
            console.error("Failed to download file, will pass URL only:", err);
          }
        }
      }

      const body = stanza.getChildText("body");
      if (!body && mediaUrls.length === 0) return;

      if (body && (body.includes('jabber:x:conference') || body.includes('&lt;x'))) {
        console.log(`🤝 Checking for jabber:x:conference invite in body: ${body.substring(0, 100)}`);

        const jidMatch = body.match(/jid=['"]([^'"]+)['"]/);
        const passwordMatch = body.match(/password=['"]([^'"]+)['"]/);
        const reasonMatch = body.match(/reason=['"]([^'"]+)['"]/);

        const room = jidMatch?.[1];
        const password = passwordMatch?.[1];
        const reason = reasonMatch?.[1] || 'No reason given';

        if (room) {
          console.log(`🤝 Detected jabber:x:conference invite to room ${room}: ${reason}`);

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

      debugLog(`XMPP message: type=${messageType}, from=${from}, body=${body?.substring(0, 50)}`);

      const fromBareJid = from.split("/")[0];

      if (body && body.startsWith('/')) {
        debugLog(`[SLASH] Command: ${body.substring(0, 100)}`);

        const roomJid = messageType === "groupchat" ? from.split("/")[0] : null;
        const nick = messageType === "groupchat" ? from.split("/")[1] || "" : null;
        const botNick = roomJid ? roomNicks.get(roomJid) : null;

        const parts = body?.trim()?.split(/\s+/) || [];
        const command = parts[0].substring(1).toLowerCase();
        const args = parts.slice(1);

        const sendReply = async (replyText: string) => {
          try {
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

        const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
        const rateLimitMaxRequests = 10;
        const rateLimitWindowMs = 60000;

        const checkRateLimit = (jid: string): boolean => {
          const now = Date.now();
          const entry = rateLimitMap.get(jid);

          if (!entry || now - entry.windowStart > rateLimitWindowMs) {
            rateLimitMap.set(jid, { count: 1, windowStart: now });
            return true;
          }

          if (entry.count >= rateLimitMaxRequests) {
            console.log(`[RATE LIMIT] Rejected command from ${jid} (${entry.count} requests in window)`);
            return false;
          }

          entry.count++;
          return true;
        };

        if (!checkRateLimit(fromBareJid)) {
          await sendReply("❌ Too many commands. Please wait before sending more.");
          return;
        }

        const pluginCommands = new Set(['list', 'add', 'remove', 'admins', 'whoami', 'join', 'rooms', 'leave', 'invite', 'whiteboard', 'vcard', 'help']);
        const isPluginCommand = pluginCommands.has(command);

        debugLog(`[SLASH] type=${messageType}, cmd=/${command}, isPlugin=${isPluginCommand}`);

        if (messageType === "groupchat") {
          if (!isPluginCommand) {
            debugLog(`Ignoring non-plugin slash command in groupchat: /${command}`);
            return;
          }
        }

        if (messageType === "chat") {
          if (isPluginCommand) {
          } else {
            if (contacts.exists(fromBareJid)) {
              debugLog(`Forwarding non-plugin command /${command} to agent`);
              onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
            } else {
              debugLog(`Ignoring non-plugin slash command from non-contact: /${command}`);
              await sendReply(`❌ Unknown command: /${command}. You must be a contact to use bot commands.`);
            }
            return;
          }
        }

        try {
          const checkAdminAccess = (): boolean => {
            if (messageType === "chat") {
              return contacts.isAdmin(fromBareJid);
            } else {
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

              if (messageType === "chat" && contacts.exists(fromBareJid)) {
                debugLog(`Forwarding /help to agent`);
                onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
              }
              return;

            case 'list':
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
                const roomJidWhoami = from.split("/")[0];
                const nickWhoami = from.split("/")[1] || "";
                const botNickWhoami = roomNicks.get(roomJidWhoami) || undefined;
                await sendReply(`Room: ${roomJidWhoami}\nNick: ${nickWhoami}\nBot nick: ${botNickWhoami || "Not joined"}`);
              } else {
                const isAdmin = contacts.isAdmin(fromBareJid);
                const isContact = contacts.exists(fromBareJid);
                await sendReply(`JID: ${fromBareJid}\nAdmin: ${isAdmin ? '✅ Yes' : '❌ No'}\nContact: ${isContact ? '✅ Yes' : '❌ No'}`);
              }
              return;

            case 'join':
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
                const nickJoin = args[1] || getDefaultNick();
                const room = resolveRoomJid(roomRaw);

                const presence = xml("presence", { to: `${room}/${nickJoin}` },
                  xml("x", { xmlns: "http://jabber.org/protocol/muc" },
                    xml("history", { maxstanzas: "0" })
                  )
                );
                await xmpp.send(presence);
                joinedRooms.add(room);
                roomNicks.set(room, nickJoin);
                console.log(`✅ Joined room ${room} as ${nickJoin} via slash command (MUC protocol)`);
                await sendReply(`✅ Joined room: ${room} as ${nickJoin}`);
              } catch (err) {
                console.error("Error joining room:", err);
                await sendReply(`❌ Failed to join room. Please check the room address and try again.`);
              }
              return;

            case 'rooms':
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
                const nickLeave = getDefaultNick();
                const presence = xml("presence", { to: `${room}/${nickLeave}`, type: "unavailable" });
                await xmpp.send(presence);
                joinedRooms.delete(room);
                roomNicks.delete(room);
                console.log(`✅ Left room ${room} via slash command`);
                await sendReply(`✅ Left room: ${room}`);
              } catch (err) {
                console.error("Error leaving room:", err);
                const room = resolveRoomJid(args[0]);
                joinedRooms.delete(room);
                roomNicks.delete(room);
                await sendReply(`❌ Failed to leave room. Please try again.`);
              }
              return;

            case 'vcard':
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

                if (!['fn', 'nickname', 'url', 'desc', 'avatarurl'].includes(field)) {
                  await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, avatarUrl`);
                  return;
                }

                const updates: any = {};
                if (field === 'fn') updates.fn = value;
                if (field === 'nickname') updates.nickname = value;
                if (field === 'url') updates.url = value;
                if (field === 'desc') updates.desc = value;
                if (field === 'avatarurl') updates.avatarUrl = value;

                const success = await updateVCardOnServer(updates);

                if (success) {
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
                  nick: nick || undefined,
                  botNick: botNick || undefined,
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
                  nick: nick || undefined,
                  botNick: botNick || undefined,
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

        return;
      }

      debugLog(`[NORMAL] Processing message (type=${messageType})`);
      if (body.startsWith('/')) {
        debugLog(`[ERROR] Slash command reached normal processing! This should not happen.`);
        return;
      }
      if (messageType === "groupchat") {
        const roomJidMsg = from.split("/")[0];
        const nickMsg = from.split("/")[1] || "";
        if (!nickMsg) {
          debugLog(`Ignoring room message without nick (likely room subject)`);
          return;
        }
        const botNickMsg = roomNicks.get(roomJidMsg);
        if (botNickMsg && nickMsg === botNickMsg) {
          debugLog(`Ignoring self-message from bot`);
          return;
        }
        debugLog(`[NORMAL] Forwarding groupchat message from ${nickMsg} to agent`);
        onMessage(roomJidMsg, body, { type: "groupchat", room: roomJidMsg, nick: nickMsg, botNick: botNickMsg, mediaUrls, mediaPaths });
      } else {
        if (contacts.exists(fromBareJid)) {
          debugLog(`[NORMAL] Forwarding chat message from ${fromBareJid} to agent`);
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

  const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}> => {
    debugLog(`Requesting upload slot for ${filename} (${size} bytes)`);

    const iqId = Math.random().toString(36).substring(2);
    const requestStanza = xml("iq", { type: "get", to: cfg.domain, id: iqId },
      xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
    );

    try {
      const response = await xmpp.send(requestStanza);
      debugLog("Upload slot response received");

      const slot = response.getChild("slot", "urn:xmpp:http:upload:0");
      if (!slot) {
        throw new Error("No upload slot in response");
      }

      const putUrl = slot.getChildText("put");
      const getUrl = slot.getChildText("get");

      if (!putUrl || !getUrl) {
        throw new Error("Missing put or get URL in slot");
      }

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

      debugLog(`Upload slot obtained for ${filename}`);
      return { putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined };
    } catch (err) {
      console.error("Failed to request upload slot:", err);
      throw err;
    }
  };

  const uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
    debugLog(`Uploading file ${filePath}`);

    try {
      const fileBuffer = await fs.promises.readFile(filePath);
      const fileSize = fileBuffer.length;

      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
      };

      if (headers) {
        Object.assign(fetchHeaders, headers);
      }

      const response = await fetch(putUrl, {
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
      const stats = await fs.promises.stat(filePath);
      const filename = path.basename(filePath);
      const size = stats.size;

      const slot = await requestUploadSlot(filename, size);

      await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);

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

  const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    debugLog(`Attempting SI file transfer to ${to}`);
    const filename = path.basename(filePath);
    const message = `[File: ${filename}] ${text || ''}`;
    if (isGroupChat) {
      await xmpp.sendGroupchat(to, message);
    } else {
      await xmpp.send(to, message);
    }
    console.log(`SI fallback: Sent file notification for ${filename}`);
  };

  const xmppClient: XmppClientInterface = {
    xmpp: xmpp,
    status: xmpp?.status,
    stop: async () => {
      await xmpp.stop();
    },
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

      const presence = xml("presence", { to: fullJid },
        xml("x", { xmlns: "http://jabber.org/protocol/muc" },
          xml("history", { maxstanzas: "0" })
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
        joinedRooms.delete(resolvedRoomJid);
        roomNicks.delete(resolvedRoomJid);
        throw err;
      }
    },
    getJoinedRooms: () => Array.from(joinedRooms),
    isInRoom: (roomJid: string) => joinedRooms.has(resolveRoomJid(roomJid)),
    iq: async (to: string, type: string, payload?: any) => {
      const id = Math.random().toString(36).substring(2);
      const iqStanza = xml("iq", { to, type, id }, payload);
      return xmpp.send(iqStanza);
    },
    sendFile: async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
      console.log(`XMPP sendFile called: to=${to}, file=${filePath}, text=${text}, group=${isGroupChat}`);
      try {
        await sendFileWithHTTPUpload(to, filePath, text, isGroupChat);
      } catch (httpErr) {
        console.log("HTTP Upload failed, falling back to SI transfer:", httpErr);
        try {
          await sendFileWithSITransfer(to, filePath, text, isGroupChat);
        } catch (siErr) {
          console.error("All file transfer methods failed:", siErr);
          throw new Error(`File transfer failed: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}, ${siErr instanceof Error ? siErr.message : String(siErr)}`);
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
    },
    roomNicks: roomNicks
  };

  return xmppClient;
}