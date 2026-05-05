import fs from "fs";
import path from "path";
import { xml } from "@xmpp/client";
import { xmppClients } from "../index.js";
import { log } from "./lib/logger.js";
import { parseSvgPathCommands, buildSxeXml, buildSxePathEdits, sxeEditsToXml } from "./whiteboard.js";

const MAX_CONCURRENT_TRANSFERS = 10;
const activeDownloads = new Map<string, { size: number; startTime: number }>();

export async function sendText({ to, text, accountId }: { to: string; text: string; accountId?: string }) {
  let xmpp = xmppClients.get(accountId || "default");
  if (!xmpp) {
    xmpp = xmppClients.values().next().value;
  }

  if (!xmpp) {
    return { ok: false, error: "XMPP client not available" };
  }

  try {
    const cleanTo = to.replace(/^xmpp:/, '');
    const bareJid = cleanTo.split('/')[0];

    let cleanText = text;
    const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
    const match = text.match(thinkingRegex);
    if (match) {
      cleanText = text.slice(match[0].length).trim();
    }

    const sessionManager = (global as any).whiteboardSessionManager;
    if (sessionManager && sessionManager.hasSession(bareJid)) {
      const session = sessionManager.getSession(bareJid);
      const svgCommands = parseSvgPathCommands(cleanText);
      
      if (svgCommands.length > 0) {
        const pathId = `agent${Date.now()}`;
        
        const paths: any[] = svgCommands.map(cmd => ({
          d: cmd.path,
          stroke: cmd.color || '#000000',
          strokeWidth: cmd.width || 1,
          id: `${pathId}_${cmd.index}`
        }));
        
        const isGroupChat = cleanTo.includes('@conference.');
        const isGroupchatPrivateMessage = isGroupChat && cleanTo.includes('/');
        const messageType = (isGroupChat && !isGroupchatPrivateMessage) ? 'groupchat' : 'chat';
        
        // Strip whiteboard draw tags from text for the normal message
        let textOnly = cleanText.replace(/\[WHITEBOARD_DRAW\][\s\S]*?\[\/WHITEBOARD_DRAW\]/gi, '').trim();
        
        // Send remaining text as normal message (if anything left after stripping)
        if (textOnly.length > 2) {
          if (isGroupChat && !isGroupchatPrivateMessage) {
            await xmpp.sendGroupchat(cleanTo.split('/')[0], textOnly);
          } else {
            await xmpp.send(cleanTo, textOnly);
          }
          log.info("SXE text portion sent", { to: cleanTo, textLength: textOnly.length });
        }
        
        // Send paths as SXE whiteboard message
        if (session.protocol === 'sxe' && session.sessionId) {
          const edits = buildSxePathEdits(paths);
          const sxeStanzas = sxeEditsToXml(session.sessionId, edits);
          
          for (const sxeElement of sxeStanzas) {
            const wbMessage = xml('message', { type: messageType, to: cleanTo },
              xml('body', {}, ''),
              sxeElement
            );
            await xmpp.send(wbMessage);
          }
          
          sessionManager.updateSession(bareJid, { paths });
          
          log.info("SXE whiteboard message sent", { to: cleanTo, paths: paths.length, edits: edits.length, stanzas: sxeStanzas.length });
          return { ok: true, channel: "xmpp", wasWhiteboard: true, protocol: "sxe" };
        } else {
          // Send as SWB message
          const whiteboardChildren = paths.map(p => 
            xml('path', { 
              d: p.d, 
              stroke: p.stroke, 
              'stroke-width': p.strokeWidth.toString(), 
              id: p.id 
            })
          );
          
          const whiteboardElement = xml('x', { xmlns: 'http://jabber.org/protocol/swb' }, whiteboardChildren);
          const wbMessage = xml('message', { type: messageType, to: cleanTo },
            whiteboardElement
          );
          
          await xmpp.send(wbMessage);
          
          sessionManager.updateSession(bareJid, { paths });
          
          log.info("SWB whiteboard message sent", { to: cleanTo, paths: paths.length });
          return { ok: true, channel: "xmpp", wasWhiteboard: true, protocol: "swb" };
        }
      }
    }

    const isGroupChat = cleanTo.includes('@conference.');
    const isGroupchatPrivateMessage = isGroupChat && cleanTo.includes('/');

     if (isGroupChat && !isGroupchatPrivateMessage) {
      await xmpp.sendGroupchat(cleanTo.split('/')[0], cleanText);
    } else if (isGroupchatPrivateMessage) {
      await xmpp.send(cleanTo, cleanText);
    } else {
      await xmpp.send(cleanTo, cleanText);
    }

    return { ok: true, channel: "xmpp" };
  } catch (err) {
    log.error("sendText failed", err);
    return { ok: false, error: String(err) };
  }
}

export async function sendMedia({ to, text, mediaUrl, accountId, deps, replyToId, ...other }: Record<string, unknown>) {
  const xmpp = xmppClients.get(accountId || "default");
  
  if (!xmpp) {
    return { ok: false, error: "XMPP client not available" };
  }
  
  try {
    const isGroupChat = to.includes('@conference.');
    const isGroupchatPrivateMessage = isGroupChat && to.includes('/');
    
    let localFilePath: string | null = null;
    
    if (deps?.loadWebMedia) {
      try {
        const result = await (deps.loadWebMedia as (url: string) => Promise<{ path?: string; url?: string }>)(mediaUrl as string);
        localFilePath = result.path || result.url || mediaUrl as string;
      } catch (err) {
        log.error("loadWebMedia failed", err);
      }
    }
    
    if (!localFilePath) {
      if ((mediaUrl as string)?.startsWith('file://')) {
        localFilePath = (mediaUrl as string).substring(7);
      } else if ((mediaUrl as string)?.startsWith('/') || (mediaUrl as string)?.startsWith('~/') || (mediaUrl as string)?.startsWith('.') || path.isAbsolute(mediaUrl as string)) {
        localFilePath = mediaUrl as string;
      }
    }
    
    if (localFilePath && fs.existsSync(localFilePath)) {
      if (localFilePath.startsWith('~/')) {
        localFilePath = path.join(process.env.HOME || process.env.USERPROFILE || '', localFilePath.substring(2));
      }
      
      const isFileGroupChat = isGroupChat && !isGroupchatPrivateMessage;
      await (xmpp as any).sendFile(to, localFilePath, text, isFileGroupChat);
      
      return { ok: true, channel: "xmpp" };
    } else {
      const message = text ? `${text}\n${mediaUrl}` : mediaUrl;
      
      if (isGroupChat && !isGroupchatPrivateMessage) {
        await xmpp.sendGroupchat(to.split('/')[0], message);
      } else {
        await xmpp.send(to, message);
      }
      
      return { ok: false, error: "File not found locally, sent as URL only" };
    }
  } catch (err) {
    log.error("sendMedia failed", err);
    return { ok: false, error: String(err) };
  }
}
