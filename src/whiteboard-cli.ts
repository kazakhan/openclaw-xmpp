import { xml } from "@xmpp/client";
import { loadXmppConfig } from './lib/config-loader.js';
import { createXmppClient } from './lib/xmpp-connect.js';
import { log } from "./lib/logger.js";

interface SxeConfig {
  sessionId: string;
  target: string;
  isGroupChat: boolean;
}

async function withConnection<T>(fn: (xmpp: any) => Promise<T>): Promise<T> {
  const config = loadXmppConfig();
  const xmpp = createXmppClient(config);
  
  let error: Error | null = null;
  xmpp.on('error', (err: Error) => error = err);
  
  await xmpp.start();
  if (error) { await xmpp.stop(); throw error; }
  
  try {
    return await fn(xmpp);
  } finally {
    await xmpp.stop();
  }
}

function generateSessionId(): string {
  return `sxe${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

function buildSxeElement(sessionId: string, children: any[]): any {
  return xml('sxe', { xmlns: 'http://jabber.org/protocol/sxe', session: sessionId }, children);
}

function buildNegotiationInvitation(): any {
  return xml('negotiation', {}, [
    xml('invitation', {}, [
      xml('feature', {}, 'http://www.w3.org/2000/svg')
    ])
  ]);
}

function buildDocumentBegin(): any {
  return xml('new', { id: 'docbegin' },
    xml('svg', { xmlns: 'http://www.w3.org/2000/svg' },
      xml('title', {}, 'Document Begin')
    )
  );
}

function buildDocumentEnd(usedIds: string[]): any {
  return xml('new', { id: 'docend' },
    xml('svg', { xmlns: 'http://www.w3.org/2000/svg' },
      xml('title', {}, 'Document End')
    )
  );
}

function buildNewElement(id: string, svgContent: string): any {
  return xml('new', { id }, [
    xml('svg', { xmlns: 'http://www.w3.org/2000/svg' }, svgContent)
  ]);
}

function buildSetElement(id: string, svgContent: string): any {
  return xml('set', { id }, [
    xml('svg', { xmlns: 'http://www.w3.org/2000/svg' }, svgContent)
  ]);
}

function buildRemoveElement(id: string): any {
  return xml('remove', { id });
}

function parseSvgPath(pathData: string): string {
  const svgElements: string[] = [];
  const commands = pathData.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi) || [];
  
  let currentX = 0;
  let currentY = 0;
  
  for (const cmd of commands) {
    const type = cmd[0].toUpperCase();
    const args = cmd.slice(1).trim().split(/[\s,]+/).filter(s => s).map(Number);
    
    switch (type) {
      case 'M':
        currentX = args[0];
        currentY = args[1];
        svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'L':
        currentX = args[0];
        currentY = args[1];
        svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'H':
        currentX += args[0];
        svgElements.push(`<path d="H${args[0]}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'V':
        currentY += args[0];
        svgElements.push(`<path d="V${args[0]}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'C':
        currentX = args[4];
        currentY = args[5];
        svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'Q':
        currentX = args[2];
        currentY = args[3];
        svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
        break;
      case 'Z':
        svgElements.push('<path d="Z" fill="none" stroke="#000" stroke-width="1"/>');
        break;
      default:
        svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
    }
  }
  
  return svgElements.join('');
}

export async function sendWhiteboardInvitation(to: string, isGroupChat: boolean = false): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    return await withConnection(async (xmpp) => {
      const sessionId = generateSessionId();
      const messageType = isGroupChat ? 'groupchat' : 'chat';
      
      const sxeElement = buildSxeElement(sessionId, [buildNegotiationInvitation()]);
      
      // Don't include body - only send SXE element to avoid appearing as regular message
      const message = xml('message', { type: messageType, to }, sxeElement);
      
      await xmpp.send(message);
      log.debug("sxe invitation sent", { to, sessionId });
      return { ok: true, sessionId };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sendWhiteboardMessage(to: string, pathData: string, options?: { 
  stroke?: string; 
  strokeWidth?: number; 
  id?: string;
  sessionId?: string;
  isGroupChat?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withConnection(async (xmpp) => {
      const sessionId = options?.sessionId || generateSessionId();
      const pathId = options?.id || `path${Date.now()}`;
      const stroke = options?.stroke || '#000000';
      const strokeWidth = options?.strokeWidth || 1;
      const isGroupChat = options?.isGroupChat || false;
      const messageType = isGroupChat ? 'groupchat' : 'chat';
      
      const svgContent = `<path d="${pathData}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
      const newElement = buildNewElement(pathId, svgContent);
      
      const body = `[Whiteboard] Drawing: ${pathData}`;
      const message = xml('message', { type: messageType, to },
        xml('body', {}, body),
        buildSxeElement(sessionId, [newElement])
      );
      
      await xmpp.send(message);
      log.debug("sxe whiteboard path sent", { to, pathId });
      return { ok: true };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sendWhiteboardMove(to: string, id: string, dx: number, dy: number, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withConnection(async (xmpp) => {
      const sessId = sessionId || generateSessionId();
      
      const setElement = buildSetElement(id, `<g transform="translate(${dx},${dy})"><title>Move ${id}</title></g>`);
      
      const body = `[Whiteboard] Move: ${id} by (${dx}, ${dy})`;
      const message = xml('message', { type: 'chat', to },
        xml('body', {}, body),
        buildSxeElement(sessId, [setElement])
      );
      
      await xmpp.send(message);
      log.debug("sxe move sent", { to, id });
      return { ok: true };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sendWhiteboardDelete(to: string, id: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withConnection(async (xmpp) => {
      const sessId = sessionId || generateSessionId();
      
      const removeElement = buildRemoveElement(id);
      
      const body = `[Whiteboard] Delete: ${id}`;
      const message = xml('message', { type: 'chat', to },
        xml('body', {}, body),
        buildSxeElement(sessId, [removeElement])
      );
      
      await xmpp.send(message);
      log.debug("sxe delete sent", { to, id });
      return { ok: true };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sendWhiteboardClear(to: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await withConnection(async (xmpp) => {
      const sessId = sessionId || generateSessionId();
      
      const beginElement = buildDocumentBegin();
      const endElement = buildDocumentEnd(['docbegin']);
      
      const body = `[Whiteboard] Clear`;
      const message = xml('message', { type: 'chat', to },
        xml('body', {}, body),
        buildSxeElement(sessId, [beginElement, endElement])
      );
      
      await xmpp.send(message);
      log.debug("sxe clear sent", { to });
      return { ok: true };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function getHelp(): string {
  return `Whiteboard commands (SXE protocol - XEP-0114):
  openclaw xmpp whiteboard invite <jid> [groupchat] - Send whiteboard invitation
  openclaw xmpp whiteboard send <jid> <path> [options] - Send drawing path
  openclaw xmpp whiteboard move <jid> <id> <dx> <dy> [session] - Move existing path
  openclaw xmpp whiteboard delete <jid> <id> [session] - Delete path
  openclaw xmpp whiteboard clear <jid> [session] - Clear whiteboard

Path format: M<x>,<y>L<x>,<y>,... (SVG path commands)
Options: stroke#RRGGBB stroke-width<width> id<name> session<id>

Examples:
  openclaw xmpp whiteboard invite user@domain.com
  openclaw xmpp whiteboard send user@domain.com "M100,100L300,100" stroke#ff0000 stroke-width2 idtriangle
  openclaw xmpp whiteboard move user@domain.com triangle 50 50 session123
  openclaw xmpp whiteboard delete user@domain.com triangle session123
  openclaw xmpp whiteboard clear user@domain.com session123

Note: Use 'invite' first to start a whiteboard session with the contact.`;
}
