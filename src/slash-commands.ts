import { xml } from "@xmpp/client";
import fs from "fs";
import path from "path";
import { validators } from "./security/validation.js";
import { checkRateLimit, MAX_FILE_SIZE, debugLog } from "./shared/index.js";

export interface SlashCommandCtx {
  xmpp: any;
  xmppLog: any;
  safeXmppSend: (xmpp: any, element: any, timeoutMs?: number) => Promise<void>;
  contacts: {
    isAdmin: (jid: string) => Promise<boolean>;
    list: () => Promise<Array<{jid: string, name: string}>>;
    add: (jid: string, name?: string) => Promise<boolean>;
    remove: (jid: string) => Promise<boolean>;
    exists: (jid: string) => Promise<boolean>;
    listAdmins: () => Promise<string[]>;
  };
  cfg: any;
  resolveRoomJid: (room: string) => string;
  getDefaultNick: () => Promise<string>;
  onMessage: (from: string, body: string, options?: any) => void;
  joinedRooms: Set<string>;
  roomNicks: Map<string, string>;
  vcard: any;
  vcardServer: {
    queryVCardFromServer: (jid: string) => Promise<any>;
    updateVCardOnServer: (updates: any) => Promise<boolean>;
    publishAvatar: (filePath: string, imageUrl: string) => Promise<boolean>;
  };
  requestUploadSlot: (filename: string, size: number, contentType?: string) => Promise<{putUrl: string, getUrl: string, headers?: Record<string, string>}>;
  uploadFileViaHTTP: (filePath: string, putUrl: string, headers?: Record<string, string>) => Promise<void>;
}

export interface SlashCommandArgs {
  body: string;
  from: string;
  fromBareJid: string;
  messageType: "chat" | "groupchat";
  mediaUrls: string[];
  mediaPaths: string[];
}

export async function handleSlashCommand(ctx: SlashCommandCtx, args: SlashCommandArgs): Promise<void> {
  const { body, from, fromBareJid, messageType, mediaUrls, mediaPaths } = args;
  const { xmpp, xmppLog, safeXmppSend, contacts, cfg, resolveRoomJid, getDefaultNick, onMessage, joinedRooms, roomNicks, vcard, vcardServer, requestUploadSlot, uploadFileViaHTTP } = ctx;

  debugLog(`[SLASH] Command: ${body.substring(0, 100)}`);
  
  // Extract room and nick for groupchat
  const roomJid = messageType === "groupchat" ? from.split("/")[0] : null;
  const nick = messageType === "groupchat" ? from.split("/")[1] || "" : null;
  const botNick = roomJid ? roomNicks.get(roomJid) : null;
  
  // Parse command and arguments
  const parts = body?.trim()?.split(/\s+/) || [];
  const command = parts[0].substring(1).toLowerCase();
  const cmdArgs = parts.slice(1);
  
  // Helper to send reply (works for both chat and groupchat)
  const sendReply = async (replyText: string) => {
    try {
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
      await safeXmppSend(xmpp, message);
    } catch (err) {
      xmppLog.error("command reply send failed", err);
    }
  };
  
  // Rate limit check
  if (!checkRateLimit(fromBareJid)) {
    await sendReply("Too many commands. Please wait before sending more.");
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
      return;
    }
  }
  
  // Chat handling: plugin commands handled locally, non-plugin forwarded if contact
  if (messageType === "chat") {
    if (isPluginCommand) {
      // Plugin command in chat - handle locally (except /help special case)
    } else {
      if (await contacts.exists(fromBareJid)) {
        debugLog(`Forwarding non-plugin command /${command} to agent`);
        onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
      } else {
        debugLog(`Ignoring non-plugin slash command from non-contact: /${command}`);
        await sendReply(`Unknown command: /${command}. You must be a contact to use bot commands.`);
      }
      return;
    }
  }
  
  // Process plugin commands (both chat and groupchat)
  try {
    const checkAdminAccess = async (): Promise<boolean> => {
      if (messageType === "chat") {
        return await contacts.isAdmin(fromBareJid);
      } else {
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
        
        if (messageType === "chat" && await contacts.exists(fromBareJid)) {
          debugLog(`Forwarding /help to agent`);
          onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
        }
        return;
        
      case 'list':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        const contactList = await contacts.list();
        if (contactList.length === 0) {
          await sendReply("No contacts configured.");
        } else {
          const listText = contactList.map(c => `  ${c.jid} (${c.name})`).join('\n');
          await sendReply(`Contacts (${contactList.length}):\n${listText}`);
        }
        return;
        
      case 'add':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        if (cmdArgs.length === 0) {
          await sendReply("Usage: /add <jid> [name]");
          return;
        }
        const jidToAdd = cmdArgs[0];
        const nameToAdd = cmdArgs[1] || jidToAdd.split('@')[0];
        const added = await contacts.add(jidToAdd, nameToAdd);
        if (added) {
          await sendReply(`Added contact: ${jidToAdd} (${nameToAdd})`);
          try {
            const subscribe = xml("presence", { to: jidToAdd, type: "subscribe" });
            await safeXmppSend(xmpp, subscribe);
          } catch (err) {
            xmppLog.error("subscription send failed", err);
          }
        } else {
          await sendReply(`Failed to add contact: ${jidToAdd}`);
        }
        return;
        
      case 'remove':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        if (cmdArgs.length === 0) {
          await sendReply("Usage: /remove <jid>");
          return;
        }
        const jidToRemove = cmdArgs[0];
        const removed = await contacts.remove(jidToRemove);
        if (removed) {
          await sendReply(`Removed contact: ${jidToRemove}`);
        } else {
          await sendReply(`Contact not found: ${jidToRemove}`);
        }
        return;
        
      case 'admins':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        const adminList = await contacts.listAdmins();
        if (adminList.length === 0) {
          await sendReply("No admins configured.");
        } else {
          const listText = adminList.map(jid => `  ${jid}`).join('\n');
          await sendReply(`Admins (${adminList.length}):\n${listText}`);
        }
        return;
        
      case 'whoami':
        if (messageType === "groupchat") {
          const rJid = from.split("/")[0];
          const rNick = from.split("/")[1] || "";
          const bNick = roomNicks.get(rJid);
          await sendReply(`Room: ${rJid}\nNick: ${rNick}\nBot nick: ${bNick || "Not joined"}`);
        } else {
          const isAdmin = await contacts.isAdmin(fromBareJid);
          const isContact = await contacts.exists(fromBareJid);
          await sendReply(`JID: ${fromBareJid}\nAdmin: ${isAdmin ? 'Yes' : 'No'}\nContact: ${isContact ? 'Yes' : 'No'}`);
        }
        return;
        
      case 'join':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        if (cmdArgs.length === 0) {
          await sendReply("Usage: /join <room> [nick]");
          return;
        }
        try {
          const roomRaw = cmdArgs[0];
          const joinNick = cmdArgs[1] || await getDefaultNick();
          const room = resolveRoomJid(roomRaw);
          
          const presence = xml("presence", { to: `${room}/${joinNick}` },
            xml("x", { xmlns: "http://jabber.org/protocol/muc" },
              xml("history", { maxstanzas: "0" })
            )
          );
          await safeXmppSend(xmpp, presence);
          joinedRooms.add(room);
          roomNicks.set(room, joinNick);
          debugLog(`room joined: ${room} as ${joinNick}`);
          await sendReply(`Joined room: ${room} as ${joinNick}`);
        } catch (err) {
          xmppLog.error("join room failed", err);
          await sendReply("Failed to join room. Please check the room address and try again.");
        }
        return;
        
      case 'rooms':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        const rooms = Array.from(joinedRooms);
        if (rooms.length === 0) {
          await sendReply("Not currently joined to any rooms. Use /join <room> to join a room.");
        } else {
          const roomList = rooms.map(room => `  ${room}`).join('\n');
          await sendReply(`Currently joined to ${rooms.length} room(s):\n${roomList}`);
        }
        return;
        
      case 'leave':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === "groupchat" 
            ? "Admin commands not available in groupchat. Use direct message."
            : "Permission denied. Admin access required.");
          return;
        }
        if (cmdArgs.length === 0) {
          await sendReply("Usage: /leave <room>");
          return;
        }
        try {
          const roomRaw = cmdArgs[0];
          const room = resolveRoomJid(roomRaw);
          const leaveNick = await getDefaultNick();
          const presence = xml("presence", { to: `${room}/${leaveNick}`, type: "unavailable" });
          await safeXmppSend(xmpp, presence);
          joinedRooms.delete(room);
          roomNicks.delete(room);
          debugLog(`room left: ${room}`);
          await sendReply(`Left room: ${room}`);
        } catch (err) {
          xmppLog.error("leave room failed", err);
          const room = resolveRoomJid(cmdArgs[0]);
          joinedRooms.delete(room);
          roomNicks.delete(room);
          await sendReply("Failed to leave room. Please try again.");
        }
        return;

      case 'vcard':
        if (!(await checkAdminAccess())) {
          await sendReply(messageType === 'groupchat' 
            ? 'Admin commands not available in groupchat. Use direct message.'
            : 'Permission denied. Admin access required.');
          return;
        }
        if (cmdArgs.length === 0 || cmdArgs[0] === 'help') {
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
        const subcmd = cmdArgs[0].toLowerCase();
        
        if (subcmd === 'get') {
          if (cmdArgs.length >= 2) {
            const targetJid = cmdArgs[1];
            const userVCard = await vcardServer.queryVCardFromServer(targetJid);
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
              await sendReply(`No vCard found for ${targetJid}`);
            }
          } else {
            const botVCard = await vcardServer.queryVCardFromServer('');
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
              await sendReply("Failed to retrieve vCard from server");
            }
          }
          return;
        } else if (subcmd === 'set') {
          if (cmdArgs.length < 2) {
            await sendReply('Usage: /vcard set <field> <value>\nFor avatar: /vcard set avatar <url> or attach an image and use /vcard set avatar');
            return;
          }
          const field = cmdArgs[1].toLowerCase();
          
          if (field === 'avatar') {
            let filePath: string;
            
            if (cmdArgs.length >= 3) {
              const url = cmdArgs.slice(2).join(' ');
              xmppLog.debug("avatar", { action: "url-provided" });
              
              try {
                const tempDir = path.join(cfg.dataDir, 'downloads');
                if (!fs.existsSync(tempDir)) {
                  fs.mkdirSync(tempDir, { recursive: true });
                }
                
                if (!validators.isValidUrl(url)) {
                  await sendReply('Invalid URL provided');
                  return;
                }
                
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
                await sendReply(`Failed to download image: ${err instanceof Error ? err.message : 'Unknown error'}`);
                return;
              }
            } else if (mediaPaths.length > 0) {
              filePath = mediaPaths[0];
            } else {
              await sendReply('No image URL or attachment provided.\nUsage: /vcard set avatar <url>\nOr attach an image and use /vcard set avatar');
              return;
            }
            
            try {
              const stats = await fs.promises.stat(filePath);
              const size = stats.size;
              
              let imageUrl: string;
              if (cmdArgs.length >= 3) {
                imageUrl = cmdArgs.slice(2).join(' ');
              } else {
                const filename = path.basename(filePath);
                xmppLog.debug("avatar", { action: "uploading", filename, size });
                const slot = await requestUploadSlot(filename, size);
                await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
                imageUrl = slot.getUrl;
              }
              
              const avatarPublished = await vcardServer.publishAvatar(filePath, imageUrl);
              
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
              const vcardUpdated = await vcardServer.updateVCardOnServer(updates);
              
              if (avatarPublished && vcardUpdated) {
                await vcard.setAvatarUrl(imageUrl);
                await sendReply(`Avatar updated successfully!\n\nXEP-0084 (PEP): Published\nvCard (XEP-0054): Updated\nURL: ${imageUrl}`);
              } else if (avatarPublished) {
                await vcard.setAvatarUrl(imageUrl);
                await sendReply(`XEP-0084 avatar published!\nWarning: vCard update failed (non-critical)\nURL: ${imageUrl}`);
              } else if (vcardUpdated) {
                await vcard.setAvatarUrl(imageUrl);
                await sendReply(`vCard avatar updated!\nWarning: XEP-0084 publish failed (non-critical)\nURL: ${imageUrl}`);
              } else {
                await sendReply("Failed to publish avatar");
              }
            } catch (err) {
              xmppLog.error("avatar upload failed", err);
              await sendReply(`Failed to upload avatar: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            return;
          }
          
          if (cmdArgs.length < 3) {
            await sendReply('Usage: /vcard set <field> <value>\nSimple fields: fn, nickname, url, desc, birthday, title, role, timezone');
            return;
          }
          
          const value = cmdArgs.slice(2).join(' ');
          
          if (!['fn', 'nickname', 'url', 'desc', 'birthday', 'title', 'role', 'timezone'].includes(field)) {
            await sendReply(`Unknown field: ${field}. Available fields: fn, nickname, url, desc, birthday, title, role, timezone, avatar`);
            return;
          }
          
          const updates: any = {};
          if (field === 'fn') updates.fn = value;
          if (field === 'nickname') updates.nickname = value;
          if (field === 'url') updates.url = value;
          if (field === 'desc') updates.desc = value;
          if (field === 'birthday') updates.bday = value;
          if (field === 'title') updates.title = value;
          if (field === 'role') updates.role = value;
          if (field === 'timezone') updates.tz = value;
          
          const success = await vcardServer.updateVCardOnServer(updates);
          
          if (success) {
            if (field === 'fn') await vcard.setFN(value);
            if (field === 'nickname') await vcard.setNickname(value);
            if (field === 'url') await vcard.setUrl(value);
            if (field === 'desc') await vcard.setDesc(value);
            if (field === 'birthday') await vcard.setBday(value);
            if (field === 'title') await vcard.setTitle(value);
            if (field === 'role') await vcard.setRole(value);
            if (field === 'timezone') await vcard.setTz(value);
            
            await sendReply(`vCard field '${field}' updated on server: ${value}`);
          } else {
            await sendReply("Failed to update vCard on server");
          }
          return;
        } else if (subcmd === 'name') {
          if (cmdArgs.length < 3) {
            await sendReply('Usage: /vcard name <family> <given> [middle] [prefix] [suffix]\nExample: /vcard name Smith John David Mr.');
            return;
          }
          const family = cmdArgs[1];
          const given = cmdArgs[2];
          const middle = cmdArgs[3];
          const prefix = cmdArgs[4];
          const suffix = cmdArgs[5];
          
          try {
            const current = await vcardServer.queryVCardFromServer('');
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
            
            await safeXmppSend(xmpp, vcardSet);
            let waited = 0;
            while (!responseReceived && waited < 5000) {
              await new Promise(r => setTimeout(r, 100));
              waited += 100;
            }
            xmpp.off('stanza', handler);
            
            if (updateSuccess) {
              await vcard.setNameComponents(family, given, middle, prefix, suffix);
              const nameStr = [prefix, given, middle, family, suffix].filter(Boolean).join(' ').trim();
              await sendReply(`vCard name updated: ${nameStr}`);
            } else {
              await sendReply("Failed to update vCard name on server");
            }
          } catch (err) {
            await sendReply(`Error updating vCard name: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
          return;
        } else if (subcmd === 'phone') {
          if (cmdArgs.length < 2) {
            await sendReply('Usage:\n  /vcard phone add <number> [type...]\n  /vcard phone remove <index>\nTypes: home work voice fax cell video pager msg');
            return;
          }
          const phoneCmd = cmdArgs[1].toLowerCase();
          
          if (phoneCmd === 'add') {
            if (cmdArgs.length < 3) {
              await sendReply('Usage: /vcard phone add <number> [type...]\nExample: /vcard phone add +1234567890 cell work');
              return;
            }
            const number = cmdArgs[2];
            const types: string[] = [];
            for (let i = 3; i < cmdArgs.length; i++) {
              const t = cmdArgs[i].toUpperCase();
              if (['HOME', 'WORK', 'VOICE', 'FAX', 'CELL', 'VIDEO', 'PAGER', 'MSG'].includes(t)) {
                types.push(t);
              }
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              const merged = current || {};
              if (!merged.tel) merged.tel = [];
              merged.tel.push({ types: types.length > 0 ? types : ['HOME'], number });
              
              const success = await vcardServer.updateVCardOnServer({ tel: merged.tel });
              if (success) {
                await vcard.setTel(merged.tel);
                await sendReply(`Phone added: ${number} (${types.join(', ') || 'default'})`);
              } else {
                await sendReply("Failed to add phone on server");
              }
            } catch (err) {
              await sendReply(`Error adding phone: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else if (phoneCmd === 'remove') {
            const idx = parseInt(cmdArgs[2]) - 1;
            if (isNaN(idx)) {
              await sendReply('Usage: /vcard phone remove <index>\nUse /vcard get to see phone indices');
              return;
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              if (!current || !current.tel || !current.tel[idx]) {
                await sendReply(`No phone at index ${idx + 1}`);
                return;
              }
              const removed = current.tel.splice(idx, 1)[0];
              
              const success = await vcardServer.updateVCardOnServer({ tel: current.tel });
              if (success) {
                await vcard.setTel(current.tel);
                await sendReply(`Phone removed: ${removed.number}`);
              } else {
                await sendReply("Failed to remove phone on server");
              }
            } catch (err) {
              await sendReply(`Error removing phone: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else {
            await sendReply('Usage:\n  /vcard phone add <number> [type...]\n  /vcard phone remove <index>');
          }
          return;
        } else if (subcmd === 'email') {
          if (cmdArgs.length < 2) {
            await sendReply('Usage:\n  /vcard email add <address> [type...]\n  /vcard email remove <index>\nTypes: home work internet pref');
            return;
          }
          const emailCmd = cmdArgs[1].toLowerCase();
          
          if (emailCmd === 'add') {
            if (cmdArgs.length < 3) {
              await sendReply('Usage: /vcard email add <address> [type...]\nExample: /vcard email add john@example.com work');
              return;
            }
            const userid = cmdArgs[2];
            const types: string[] = [];
            for (let i = 3; i < cmdArgs.length; i++) {
              const t = cmdArgs[i].toUpperCase();
              if (['HOME', 'WORK', 'INTERNET', 'PREF'].includes(t)) {
                types.push(t);
              }
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              const merged = current || {};
              if (!merged.email) merged.email = [];
              merged.email.push({ types: types.length > 0 ? types : ['INTERNET'], userid });
              
              const success = await vcardServer.updateVCardOnServer({ email: merged.email });
              if (success) {
                await vcard.setEmail(merged.email);
                await sendReply(`Email added: ${userid} (${types.join(', ') || 'default'})`);
              } else {
                await sendReply("Failed to add email on server");
              }
            } catch (err) {
              await sendReply(`Error adding email: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else if (emailCmd === 'remove') {
            const idx = parseInt(cmdArgs[2]) - 1;
            if (isNaN(idx)) {
              await sendReply('Usage: /vcard email remove <index>\nUse /vcard get to see email indices');
              return;
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              if (!current || !current.email || !current.email[idx]) {
                await sendReply(`No email at index ${idx + 1}`);
                return;
              }
              const removed = current.email.splice(idx, 1)[0];
              
              const success = await vcardServer.updateVCardOnServer({ email: current.email });
              if (success) {
                await vcard.setEmail(current.email);
                await sendReply(`Email removed: ${removed.userid}`);
              } else {
                await sendReply("Failed to remove email on server");
              }
            } catch (err) {
              await sendReply(`Error removing email: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else {
            await sendReply('Usage:\n  /vcard email add <address> [type...]\n  /vcard email remove <index>');
          }
          return;
        } else if (subcmd === 'address') {
          if (cmdArgs.length < 2) {
            await sendReply('Usage:\n  /vcard address add <street> <city> <region> <postal> <country> [type]\n  /vcard address remove <index>\nTypes: home work postal parcel');
            return;
          }
          const addrCmd = cmdArgs[1].toLowerCase();
          
          if (addrCmd === 'add') {
            if (cmdArgs.length < 7) {
              await sendReply('Usage: /vcard address add <street> <city> <region> <postal> <country> [type]\nExample: /vcard address add "123 Main St" Boston MA 02101 USA home');
              return;
            }
            const street = cmdArgs[2];
            const locality = cmdArgs[3];
            const region = cmdArgs[4];
            const pcode = cmdArgs[5];
            const ctry = cmdArgs[6];
            const addrTypes: string[] = [];
            if (cmdArgs[7]) {
              const t = cmdArgs[7].toUpperCase();
              if (['HOME', 'WORK', 'POSTAL', 'PARCEL'].includes(t)) {
                addrTypes.push(t);
              }
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              const merged = current || {};
              if (!merged.adr) merged.adr = [];
              merged.adr.push({ types: addrTypes.length > 0 ? addrTypes : ['HOME'], street, locality, region, pcode, ctry });
              
              const success = await vcardServer.updateVCardOnServer({ adr: merged.adr });
              if (success) {
                await vcard.setAdr(merged.adr);
                await sendReply(`Address added: ${street}, ${locality}, ${region} ${pcode}, ${ctry} (${addrTypes.join(', ') || 'default'})`);
              } else {
                await sendReply("Failed to add address on server");
              }
            } catch (err) {
              await sendReply(`Error adding address: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else if (addrCmd === 'remove') {
            const idx = parseInt(cmdArgs[2]) - 1;
            if (isNaN(idx)) {
              await sendReply('Usage: /vcard address remove <index>\nUse /vcard get to see address indices');
              return;
            }
            
            try {
              const current = await vcardServer.queryVCardFromServer('');
              if (!current || !current.adr || !current.adr[idx]) {
                await sendReply(`No address at index ${idx + 1}`);
                return;
              }
              const removed = current.adr.splice(idx, 1)[0];
              const parts = [removed.street, removed.locality, removed.region, removed.pcode, removed.ctry].filter(Boolean);
              
              const success = await vcardServer.updateVCardOnServer({ adr: current.adr });
              if (success) {
                await vcard.setAdr(current.adr);
                await sendReply(`Address removed: ${parts.join(', ')}`);
              } else {
                await sendReply("Failed to remove address on server");
              }
            } catch (err) {
              await sendReply(`Error removing address: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          } else {
            await sendReply('Usage:\n  /vcard address add <street> <city> <region> <postal> <country> [type]\n  /vcard address remove <index>');
          }
          return;
        } else if (subcmd === 'org') {
          if (cmdArgs.length < 2) {
            await sendReply('Usage: /vcard org <orgname> [orgunit...]\nExample: /vcard org "Acme Inc" Engineering Sales');
            return;
          }
          const orgname = cmdArgs[1];
          const orgunits = cmdArgs.slice(2);
          
          try {
            const current = await vcardServer.queryVCardFromServer('');
            const merged = current || {};
            merged.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };
            
            const success = await vcardServer.updateVCardOnServer({ org: merged.org });
            if (success) {
              vcard.setOrgComponents(orgname, ...orgunits);
              const orgStr = orgname + (orgunits.length > 0 ? ` (${orgunits.join(', ')})` : '');
              await sendReply(`Organization updated: ${orgStr}`);
            } else {
              await sendReply("Failed to update organization on server");
            }
          } catch (err) {
            await sendReply(`Error updating organization: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
          return;
        } else {
          await sendReply(`Unknown vCard subcommand: ${subcmd}. Use /vcard help for available commands.`);
          return;
        }

      case 'test':
        if (cmdArgs.length === 0) {
          await sendReply(`Test commands:
  /test upload <url> - Test XEP-0363 HTTP File Upload`);
          return;
        }
        
        const testCmd = cmdArgs[0].toLowerCase();
        if (testCmd === 'upload' && cmdArgs.length >= 2) {
          const url = cmdArgs.slice(1).join(' ');
          await sendReply(`Testing XEP-0363 upload with: ${url}`);
          
          try {
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
            
            await sendReply(`Downloaded ${filename} (${size} bytes)`);
            
            await sendReply("Requesting upload slot from server...");
            const slot = await requestUploadSlot(filename, size);
            
            await sendReply(`Got slot:\nPUT: ${slot.putUrl.substring(0, 60)}...\nGET: ${slot.getUrl.substring(0, 60)}...`);
            
            await sendReply("Uploading file...");
            await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
            
            await sendReply(`XEP-0363 upload successful!\nFile URL: ${slot.getUrl}`);
          } catch (err) {
            xmppLog.error("test upload failed", err);
            await sendReply(`Upload test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        } else {
          await sendReply(`Usage: /test upload <url>`);
        }
        return;

      default:
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
      await safeXmppSend(xmpp, xml("message", { type: messageType, to: toAddress }, xml("body", {}, "Error processing command.")));
    } catch {}
  }
  
  return;
}
