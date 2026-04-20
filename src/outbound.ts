import fs from "fs";
import path from "path";
import { xmppClients } from "../index.js";
import { log } from "./lib/logger.js";

const MAX_CONCURRENT_TRANSFERS = 10;
const activeDownloads = new Map<string, { size: number; startTime: number }>();

export async function sendText({ to, text, accountId }: { to: string; text: string; accountId?: string }) {
  const xmpp = xmppClients.get(accountId || "default");

  if (!xmpp) {
    return { ok: false, error: "XMPP client not available" };
  }

  try {
    const cleanTo = to.replace(/^xmpp:/, '');

    let cleanText = text;
    const thinkingRegex = /^(Thinking[. ]+.*?[\n\r]+)+/i;
    const match = text.match(thinkingRegex);
    if (match) {
      cleanText = text.slice(match[0].length).trim();
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
