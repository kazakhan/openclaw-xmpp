import fs from "fs";
import path from "path";
import { xml } from "@xmpp/client";
import { xmppClients } from "../index.js";
import { log } from "./lib/logger.js";
import { parseSvgPathCommands, buildSxeXml, buildSxePathEdits, sxeEditsToXml, getAvailableRidPrefix } from "./whiteboard.js";
import { safeSend } from "./lib/xmpp-utils.js";

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
    const svgCommands = parseSvgPathCommands(cleanText);
    const hasDrawing = svgCommands.length > 0;

    log.debug(`ST_WB: hasDrawing=${hasDrawing} cmdCount=${svgCommands.length} sessionExists=${!!(sessionManager && sessionManager.hasSession(bareJid))} bareJid=${bareJid}`);

    if (sessionManager && sessionManager.hasSession(bareJid)) {
      const s = sessionManager.getSession(bareJid);
      log.debug(`ST_WB: session protocol=${s?.protocol} sessionId=${s?.sessionId} sxeNodes=${Object.keys(s?.sxeNodes||{}).length} svgParentRid=${s?.svgParentRid}`);
    }

    const isGroupChat = cleanTo.includes('@conference.');
    const isGroupchatPrivateMessage = isGroupChat && cleanTo.includes('/');
    const messageType = (isGroupChat && !isGroupchatPrivateMessage) ? 'groupchat' : 'chat';

    // STEP 1: Always send the human-readable text (strip whiteboard tags if present)
    const displayText = hasDrawing
      ? cleanText.replace(/\[WHITEBOARD_DRAW\][\s\S]*?\[\/WHITEBOARD_DRAW\]/gi, '').trim()
      : cleanText;

    if (displayText) {
      if (isGroupChat && !isGroupchatPrivateMessage) {
        await xmpp.sendGroupchat(cleanTo.split('/')[0], displayText);
      } else {
        await xmpp.send(cleanTo, displayText);
      }
    }

    // STEP 2: Send whiteboard drawing (SXE/SWB) in isolated try/catch
    if (hasDrawing && sessionManager && sessionManager.hasSession(bareJid)) {
      const session = sessionManager.getSession(bareJid);
      const pathId = `agent${Date.now()}`;

      const paths: any[] = svgCommands.map(cmd => ({
        d: cmd.path,
        stroke: cmd.color || '#000000',
        strokeWidth: cmd.width || 1,
        id: `${pathId}_${cmd.index}`
      }));

      log.debug(`ST_WB: attempting protocol=${session?.protocol} sessionId=${session?.sessionId} pathCount=${paths.length} paths=${paths.map(p=>p.d.substring(0,40)).join("|")}`);

      try {
        if (session.protocol === 'sxe' && session.sessionId) {
          const svgParentRid = session.svgParentRid || '0.1';
          log.debug(`ST_WB: building SXE edits svgParentRid=${svgParentRid} prefix=${getAvailableRidPrefix(session.sxeNodes)}`);
          const edits = buildSxePathEdits(paths, getAvailableRidPrefix(session.sxeNodes), svgParentRid, session.ridOffset);
          session.ridOffset += paths.length;
          const sxeStanzas = sxeEditsToXml(session.sessionId, edits);
          log.debug(`ST_WB: SXE stanzas count=${sxeStanzas.length} sessionId=${session.sessionId}`);

          for (const sxeElement of sxeStanzas) {
            const wbMessage = xml('message', { type: messageType, to: cleanTo },
              xml('body', {}, ''),
              sxeElement
            );
            log.debug(`ST_WB: sending SXE stanza rid=${sxeElement?.children?.[0]?.attrs?.rid || '?'} to=${cleanTo}`);
            log.info(`SXE_SENDTEXT_XML: ${wbMessage.toString().substring(0, 3000)}`);
            await safeSend(xmpp.xmpp, wbMessage);
          }

          sessionManager.updateSession(bareJid, { paths });

          log.info("SXE whiteboard message sent", { to: cleanTo, paths: paths.length, edits: edits.length, stanzas: sxeStanzas.length });
        } else {
          log.debug(`ST_WB: sending SWB protocol=${session?.protocol} sessionId=${session?.sessionId}`);
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
          await safeSend(xmpp.xmpp, wbMessage);

          sessionManager.updateSession(bareJid, { paths });

          log.info("SWB whiteboard message sent", { to: cleanTo, paths: paths.length });
        }
      } catch (wbErr) {
        log.error("sendText whiteboard send failed", wbErr instanceof Error ? wbErr.message : String(wbErr));
        log.error("sendText whiteboard send stack", wbErr instanceof Error ? wbErr.stack || '' : '');
        // Emergency fallback: if no readable text was sent (displayText was empty),
        // send the raw response text as a normal message
        if (!displayText) {
          log.debug(`ST_WB: emergency fallback — sending raw text to ${cleanTo}`);
          if (isGroupChat && !isGroupchatPrivateMessage) {
            await xmpp.sendGroupchat(cleanTo.split('/')[0], cleanText);
          } else {
            await xmpp.send(cleanTo, cleanText);
          }
        }
      }
    }

    return { ok: true, channel: "xmpp" };
  } catch (err) {
    log.error("sendText failed", err);
    return { ok: false, error: String(err) };
  }
}

export async function sendMedia(params: Record<string, unknown>): Promise<{ ok: boolean; channel?: string; error?: string }> {
  const to = params.to as string || '';
  const text = params.text as string | undefined;
  const mediaUrl = params.mediaUrl as string | undefined;
  const accountId = params.accountId as string || "default";
  const deps = params.deps as { loadWebMedia?: (url: string) => Promise<{ path?: string; url?: string }> } | undefined;

  const xmpp = xmppClients.get(accountId);
  
  if (!xmpp) {
    return { ok: false, error: "XMPP client not available" };
  }
  
  try {
    const isGroupChat = to.includes('@conference.');
    const isGroupchatPrivateMessage = isGroupChat && to.includes('/');
    
    let localFilePath: string | null = null;
    
    if (deps?.loadWebMedia && mediaUrl) {
      try {
        const result = await deps.loadWebMedia(mediaUrl);
        localFilePath = result.path || result.url || mediaUrl;
      } catch (err) {
        log.error("loadWebMedia failed", err);
      }
    }
    
    if (!localFilePath && mediaUrl) {
      if (mediaUrl.startsWith('file://')) {
        localFilePath = mediaUrl.substring(7);
      } else if (mediaUrl.startsWith('/') || mediaUrl.startsWith('~/') || mediaUrl.startsWith('.') || path.isAbsolute(mediaUrl)) {
        localFilePath = mediaUrl;
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
      const message = text ? `${text}\n${mediaUrl}` : (mediaUrl || '');
      
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
