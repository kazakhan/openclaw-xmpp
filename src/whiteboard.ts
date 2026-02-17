import { xml } from "@xmpp/client";

export interface WhiteboardPath {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  id?: string;
}

export interface WhiteboardMove {
  id: string;
  dx: number;
  dy: number;
}

export interface WhiteboardDelete {
  id: string;
}

export interface WhiteboardData {
  type: 'path' | 'move' | 'delete';
  paths?: WhiteboardPath[];
  moves?: WhiteboardMove[];
  deletes?: WhiteboardDelete[];
  rawXml?: string;
}

export function parseWhiteboardMessage(stanza: any): WhiteboardData | null {
  const swbElement = stanza.getChild('x', 'http://jabber.org/protocol/swb');
  
  if (!swbElement) {
    return null;
  }
  
  const result: WhiteboardData = {
    type: 'path',
    paths: [],
    moves: [],
    deletes: [],
    rawXml: swbElement.toString()
  };
  
  const pathElements = swbElement.getChildren('path');
  for (const pathEl of pathElements) {
    const path: WhiteboardPath = {
      d: pathEl.attrs.d || '',
      stroke: pathEl.attrs.stroke,
      strokeWidth: pathEl.attrs['stroke-width'] ? parseInt(pathEl.attrs['stroke-width'], 10) : undefined,
      id: pathEl.attrs.id
    };
    if (path.d) {
      result.paths!.push(path);
      result.type = 'path';
    }
  }
  
  const moveElements = swbElement.getChildren('move');
  for (const moveEl of moveElements) {
    const move: WhiteboardMove = {
      id: moveEl.attrs.id,
      dx: parseInt(moveEl.attrs.dx, 10) || 0,
      dy: parseInt(moveEl.attrs.dy, 10) || 0
    };
    if (move.id) {
      result.moves!.push(move);
      result.type = 'move';
    }
  }
  
  const deleteElements = swbElement.getChildren('delete');
  for (const delEl of deleteElements) {
    const del: WhiteboardDelete = {
      id: delEl.attrs.id
    };
    if (del.id) {
      result.deletes!.push(del);
      result.type = 'delete';
    }
  }
  
  if (result.paths!.length === 0 && result.moves!.length === 0 && result.deletes!.length === 0) {
    return null;
  }
  
  return result;
}

function buildPathElement(path: WhiteboardPath): any {
  const attrs: any = { d: path.d };
  if (path.stroke) attrs.stroke = path.stroke;
  if (path.strokeWidth) attrs['stroke-width'] = path.strokeWidth.toString();
  if (path.id) attrs.id = path.id;
  return xml('path', attrs);
}

function buildMoveElement(move: WhiteboardMove): any {
  return xml('move', {
    id: move.id,
    dx: move.dx.toString(),
    dy: move.dy.toString()
  });
}

function buildDeleteElement(del: WhiteboardDelete): any {
  return xml('delete', { id: del.id });
}

export function buildWhiteboardXml(paths?: WhiteboardPath[], moves?: WhiteboardMove[], deletes?: WhiteboardDelete[]): any {
  const children: any[] = [];
  
  if (paths) {
    for (const path of paths) {
      children.push(buildPathElement(path));
    }
  }
  
  if (moves) {
    for (const move of moves) {
      children.push(buildMoveElement(move));
    }
  }
  
  if (deletes) {
    for (const del of deletes) {
      children.push(buildDeleteElement(del));
    }
  }
  
  return xml('x', { xmlns: 'http://jabber.org/protocol/swb' }, children);
}

interface WhiteboardCommandOptions {
  xmpp: any;
  to: string;
  isGroupChat: boolean;
  sendReply: (msg: string) => Promise<void>;
  onMessage: (from: string, body: string, options?: any) => void;
}

export async function handleWhiteboardCommand(
  args: string[],
  options: WhiteboardCommandOptions
): Promise<void> {
  const { xmpp, to, isGroupChat, sendReply, onMessage } = options;
  
  if (args.length === 0 || args[0] === 'help') {
    await sendReply(`Whiteboard commands (XEP-0113):
  /whiteboard help - Show this help
  /whiteboard draw <path> [options] - Send drawing path
  /whiteboard move <id> <dx> <dy> - Move existing path
  /whiteboard delete <id> - Delete path
  /whiteboard clear - Clear all paths

Path format: M<x>,<y>L<x>,<y>,...
Options: stroke#RRGGBB stroke-width<width> id<name>

Example:
  /whiteboard draw M100,100L300,100,200,300,100,100 stroke#ff0000 stroke-width2 idtriangle`);
    return;
  }
  
  const subcmd = args[0].toLowerCase();
  
  if (subcmd === 'draw') {
    if (args.length < 2) {
      await sendReply('Usage: /whiteboard draw <path> [options]\nExample: /whiteboard draw M100,100L300,100 stroke#ff0000');
      return;
    }
    
    const pathArg = args[1];
    let stroke = '#000000';
    let strokeWidth = 1;
    let id = `draw${Date.now()}`;
    
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('stroke#') && arg.length > 7) {
        stroke = '#' + arg.substring(7);
      } else if (arg.startsWith('stroke-width') && arg.length > 12) {
        strokeWidth = parseInt(arg.substring(12), 10) || 1;
      } else if (arg.startsWith('id') && arg.length > 2) {
        id = arg.substring(2);
      }
    }
    
    const path: WhiteboardPath = {
      d: pathArg,
      stroke,
      strokeWidth,
      id
    };
    
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Drawing: ${path.d}`;
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml([path])
    );
    
    await xmpp.send(message);
    
    await sendReply(`✅ Sent whiteboard path: ${id}\n${path.d}\nStroke: ${stroke}, Width: ${strokeWidth}`);
    return;
  }
  
  if (subcmd === 'move') {
    if (args.length < 4) {
      await sendReply('Usage: /whiteboard move <id> <dx> <dy>\nExample: /whiteboard move triangle 50 50');
      return;
    }
    
    const id = args[1];
    const dx = parseInt(args[2], 10);
    const dy = parseInt(args[3], 10);
    
    if (isNaN(dx) || isNaN(dy)) {
      await sendReply('dx and dy must be numbers');
      return;
    }
    
    const move: WhiteboardMove = { id, dx, dy };
    
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Move: ${id} by (${dx}, ${dy})`;
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml(undefined, [move])
    );
    
    await xmpp.send(message);
    
    await sendReply(`✅ Sent move command: ${id} → (${dx}, ${dy})`);
    return;
  }
  
  if (subcmd === 'delete') {
    if (args.length < 2) {
      await sendReply('Usage: /whiteboard delete <id>\nExample: /whiteboard delete triangle');
      return;
    }
    
    const id = args[1];
    const del: WhiteboardDelete = { id };
    
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Delete: ${id}`;
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml(undefined, undefined, [del])
    );
    
    await xmpp.send(message);
    
    await sendReply(`✅ Sent delete command: ${id}`);
    return;
  }
  
  if (subcmd === 'clear') {
    const body = `[Whiteboard] Clear all`;
    
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml([], [], [])
    );
    
    await xmpp.send(message);
    
    await sendReply('✅ Sent clear command');
    return;
  }
  
  await sendReply(`Unknown whiteboard command: ${subcmd}\nUse /whiteboard help for available commands`);
}

export async function sendWhiteboardMessage(
  xmpp: any,
  to: string,
  path: WhiteboardPath,
  isGroupChat: boolean = false
): Promise<boolean> {
  try {
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Drawing: ${path.d}`;
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml([path])
    );
    
    await xmpp.send(message);
    return true;
  } catch (err) {
    console.error('[Whiteboard] Failed to send:', err);
    return false;
  }
}

export async function sendWhiteboardMove(
  xmpp: any,
  to: string,
  id: string,
  dx: number,
  dy: number,
  isGroupChat: boolean = false
): Promise<boolean> {
  try {
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Move: ${id} by (${dx}, ${dy})`;
    const move: WhiteboardMove = { id, dx, dy };
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml(undefined, [move])
    );
    
    await xmpp.send(message);
    return true;
  } catch (err) {
    console.error('[Whiteboard] Failed to send move:', err);
    return false;
  }
}

export async function sendWhiteboardDelete(
  xmpp: any,
  to: string,
  id: string,
  isGroupChat: boolean = false
): Promise<boolean> {
  try {
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    const body = `[Whiteboard] Delete: ${id}`;
    const del: WhiteboardDelete = { id };
    
    const message = xml('message', { type: messageType, to },
      xml('body', {}, body),
      buildWhiteboardXml(undefined, undefined, [del])
    );
    
    await xmpp.send(message);
    return true;
  } catch (err) {
    console.error('[Whiteboard] Failed to send delete:', err);
    return false;
  }
}
