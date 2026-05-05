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

export interface SvgPathCommand {
  path: string;
  color?: string;
  width?: number;
  index: number;
}

export interface SxeData {
  sessionId: string;
  type: 'invitation' | 'accept-invitation' | 'document-begin' | 'new' | 'set' | 'remove' | 'left-session' | 'unknown';
  elements?: any[];
  rawXml?: string;
}

export function parseSxeMessage(stanza: any): SxeData {
  const sxeElement = stanza.getChild('sxe', 'http://jabber.org/protocol/sxe');
  if (!sxeElement) {
    return { sessionId: '', type: 'unknown' };
  }
  
  const sessionId = sxeElement.attrs.session || '';
  const negotiationElement = sxeElement.getChild('negotiation', 'http://jabber.org/protocol/sxe');
  
  // Check for negotiation elements
  if (negotiationElement) {
    if (negotiationElement.getChild('invitation')) {
      return { sessionId, type: 'invitation', rawXml: sxeElement.toString() };
    }
    if (negotiationElement.getChild('accept-invitation')) {
      return { sessionId, type: 'accept-invitation', rawXml: sxeElement.toString() };
    }
    if (negotiationElement.getChild('document-begin')) {
      const embeddedElements: any[] = [];
      
      for (const newEl of negotiationElement.getChildren('new')) {
        embeddedElements.push({
          rid: newEl.attrs.rid || newEl.attrs.id,
          type: 'new',
          parent: newEl.attrs.parent,
          name: newEl.attrs.name,
          chdata: newEl.attrs.chdata,
          primaryWeight: newEl.attrs['primary-weight']
        });
      }
      for (const setEl of negotiationElement.getChildren('set')) {
        embeddedElements.push({
          rid: setEl.attrs.rid || setEl.attrs.id,
          type: 'set',
          parent: setEl.attrs.parent,
          name: setEl.attrs.name,
          chdata: setEl.attrs.chdata
        });
      }
      for (const removeEl of negotiationElement.getChildren('remove')) {
        embeddedElements.push({
          id: removeEl.attrs.id,
          type: 'remove'
        });
      }
      
      return { sessionId, type: 'document-begin', rawXml: sxeElement.toString(), elements: embeddedElements.length > 0 ? embeddedElements : undefined };
    }
    if (negotiationElement.getChild('left-session')) {
      return { sessionId, type: 'left-session', rawXml: sxeElement.toString() };
    }
  }
  
  // Check for SXE editing elements (both direct and inside negotiation)
  const newElements = sxeElement.getChildren('new');
  const setElements = sxeElement.getChildren('set');
  const removeElements = sxeElement.getChildren('remove');
  
  const elements: any[] = [];
  
  for (const newEl of newElements) {
    elements.push({
      rid: newEl.attrs.rid || newEl.attrs.id,
      type: newEl.attrs.type,
      parent: newEl.attrs.parent,
      name: newEl.attrs.name,
      chdata: newEl.attrs.chdata,
      primaryWeight: newEl.attrs['primary-weight']
    });
  }
  
  for (const setEl of setElements) {
    elements.push({
      rid: setEl.attrs.rid || setEl.attrs.id,
      type: 'set',
      parent: setEl.attrs.parent,
      name: setEl.attrs.name,
      chdata: setEl.attrs.chdata,
      replacefrom: setEl.attrs.replacefrom,
      replacen: setEl.attrs.replacen,
      version: setEl.attrs.version
    });
  }
  
  for (const removeEl of removeElements) {
    elements.push({
      id: removeEl.attrs.id,
      type: 'remove'
    });
  }
  
  if (elements.length > 0) {
    const rawType = elements[0].type;
    const type = (rawType === 'element' || rawType === 'attr') ? 'new' : (rawType as 'new' | 'set' | 'remove');
    return { 
      sessionId, 
      type, 
      elements, 
      rawXml: sxeElement.toString() 
    };
  }
  
  return { sessionId, type: 'unknown', rawXml: sxeElement.toString() };
}

export function buildSxeXml(options: {
  sessionId: string;
  type: 'invitation' | 'accept-invitation' | 'document-begin' | 'new' | 'set' | 'remove' | 'left-session';
  id?: string;
  content?: string;
  features?: string[];
}): any {
  const { sessionId, type, id, content, features } = options;
  
  let children: any[] = [];
  
  if (type === 'invitation' && features) {
    const featureElements = features.map(f => 
      xml('feature', {}, f)
    );
    children = [
      xml('negotiation', {},
        xml('invitation', {}, featureElements)
      )
    ];
  } else if (type === 'accept-invitation') {
    children = [
      xml('negotiation', {},
        xml('accept-invitation', {})
      )
    ];
  } else if (type === 'document-begin') {
    children = [
      xml('negotiation', {},
        xml('document-begin', {})
      )
    ];
  } else if (type === 'left-session') {
    children = [
      xml('negotiation', {},
        xml('left-session', {})
      )
    ];
  } else if (type === 'new' && id && content) {
    children = [
      xml('new', { 
        id: id
      }, content)
    ];
  } else if (type === 'set' && id && content) {
    children = [
      xml('set', { 
        id: id
      }, content)
    ];
  } else if (type === 'remove' && id) {
    children = [
      xml('remove', { 
        id: id
      })
    ];
  }
  
  return xml('sxe', { 
    xmlns: 'http://jabber.org/protocol/sxe',
    session: sessionId
  }, children);
}

export interface SxePathEdit {
  rid: string;
  type: 'element' | 'attr' | 'set';
  parent?: string;
  name?: string;
  chdata?: string;
  primaryWeight?: number;
  replacefrom?: number;
  replacen?: number;
  version?: number;
}

const SXE_CHUNK_SIZE = 1024;

export function buildSxePathEdits(paths: Array<{ d: string; stroke?: string; strokeWidth?: number; id?: string }>, prefix: string = 'a'): SxePathEdit[] {
  const edits: SxePathEdit[] = [];
  
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const baseRid = `${prefix}.${(i + 1) * 10}`;
    const pathId = p.id || `e${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    edits.push({ rid: baseRid, type: 'element', parent: '0.1', name: 'path', primaryWeight: (i + 1) * 10 });
    edits.push({ rid: `${baseRid}.1`, type: 'attr', parent: baseRid, name: 'stroke', chdata: p.stroke || '#000000', primaryWeight: 0 });
    edits.push({ rid: `${baseRid}.2`, type: 'attr', parent: baseRid, name: 'vector-effect', chdata: 'none', primaryWeight: 1 });
    edits.push({ rid: `${baseRid}.3`, type: 'attr', parent: baseRid, name: 'fill-rule', chdata: 'nonzero', primaryWeight: 2 });
    edits.push({ rid: `${baseRid}.4`, type: 'attr', parent: baseRid, name: 'fill-opacity', chdata: '0', primaryWeight: 3 });
    edits.push({ rid: `${baseRid}.5`, type: 'attr', parent: baseRid, name: 'd', chdata: '', primaryWeight: 4 });
    edits.push({ rid: `${baseRid}.6`, type: 'attr', parent: baseRid, name: 'fill', chdata: 'none', primaryWeight: 5 });
    edits.push({ rid: `${baseRid}.7`, type: 'attr', parent: baseRid, name: 'id', chdata: pathId, primaryWeight: 6 });
    edits.push({ rid: `${baseRid}.8`, type: 'attr', parent: baseRid, name: 'stroke-linecap', chdata: 'square', primaryWeight: 7 });
    edits.push({ rid: `${baseRid}.9`, type: 'attr', parent: baseRid, name: 'stroke-width', chdata: String(p.strokeWidth || 1), primaryWeight: 8 });
    
    const dRid = `${baseRid}.5`;
    const dData = p.d || '';
    let offset = 0;
    let version = 0;
    while (offset < dData.length) {
      const chunk = dData.substring(offset, offset + SXE_CHUNK_SIZE);
      version++;
      edits.push({
        rid: dRid,
        type: 'set',
        chdata: chunk,
        replacefrom: offset,
        replacen: offset === 0 ? 0 : 0,
        version
      });
      offset += SXE_CHUNK_SIZE;
    }
  }
  
  return edits;
}

export function sxeEditsToXml(sessionId: string, edits: SxePathEdit[]): any {
  const newEdits = edits.filter(e => e.type !== 'set');
  const setEdits = edits.filter(e => e.type === 'set');
  
  const newChildren = newEdits.map(e => {
    const attrs: any = { rid: e.rid };
    if (e.type === 'element') {
      attrs.type = 'element';
      attrs.parent = e.parent;
      if (e.name) attrs.name = e.name;
      if (e.primaryWeight != null) attrs['primary-weight'] = String(e.primaryWeight);
      return xml('new', attrs);
    } else {
      attrs.type = 'attr';
      attrs.parent = e.parent;
      if (e.name) attrs.name = e.name;
      if (e.chdata != null) attrs.chdata = e.chdata;
      if (e.primaryWeight != null) attrs['primary-weight'] = String(e.primaryWeight);
      return xml('new', attrs);
    }
  });
  
  const stanzas: any[] = [];
  
  if (newChildren.length > 0) {
    stanzas.push(xml('sxe', { xmlns: 'http://jabber.org/protocol/sxe', session: sessionId }, newChildren));
  }
  
  for (const setEdit of setEdits) {
    const setAttrs: any = { rid: setEdit.rid };
    if (setEdit.replacefrom != null) setAttrs.replacefrom = String(setEdit.replacefrom);
    if (setEdit.replacen != null) setAttrs.replacen = String(setEdit.replacen);
    if (setEdit.version != null) setAttrs.version = String(setEdit.version);
    if (setEdit.chdata != null) setAttrs.chdata = setEdit.chdata;
    
    stanzas.push(xml('sxe', { xmlns: 'http://jabber.org/protocol/sxe', session: sessionId }, xml('set', setAttrs)));
  }
  
  return stanzas;
}

export function convertSxeToWhiteboardData(sxeData: SxeData): {
  type: 'path' | 'move' | 'delete';
  paths?: WhiteboardPath[];
  moves?: WhiteboardMove[];
  deletes?: WhiteboardDelete[];
  rawPaths?: string[];
} {
  if (!sxeData.elements || sxeData.elements.length === 0) {
    return { type: 'path', paths: [], moves: [], deletes: [] };
  }
  
  const paths: WhiteboardPath[] = [];
  const moves: WhiteboardMove[] = [];
  const deletes: WhiteboardDelete[] = [];
  
  // Group element edits by rid, collect their attr children
  const elementsByRid: Record<string, any> = {};
  const attrEdits: any[] = [];
  const setEdits: any[] = [];
  
  for (const el of sxeData.elements) {
    if (el.type === 'remove') {
      deletes.push({ id: el.rid || el.id });
    } else if (el.type === 'element' || el.type === 'new') {
      if (el.name && el.parent !== undefined) {
        elementsByRid[el.rid || el.id] = { name: el.name, parent: el.parent };
      }
    } else if (el.type === 'attr') {
      attrEdits.push(el);
    } else if (el.type === 'set') {
      setEdits.push(el);
    }
  }
  
  // Apply <set> updates to existing attrs (PSI+ splits chdata > 1024 chars)
  for (const set of setEdits) {
    const targetRid = set.rid || set.parent;
    if (!targetRid) continue;
    
    const existingAttr = attrEdits.find(a => (a.rid === targetRid || a.parent === targetRid));
    if (existingAttr && set.chdata !== undefined) {
      if (set.replacen !== undefined && set.replacefrom !== undefined) {
        const from = parseInt(set.replacefrom, 10);
        const len = parseInt(set.replacen, 10);
        const existing = existingAttr.chdata || '';
        existingAttr.chdata = existing.substring(0, from) + set.chdata + existing.substring(from + len);
      } else {
        existingAttr.chdata = set.chdata;
      }
    } else if (set.chdata !== undefined) {
      // <set> targeting a rid not in our attrEdits — might be updating a previously seen attr
      // Store as a new attr edit for the target
      attrEdits.push({
        rid: targetRid,
        type: 'attr',
        parent: set.parent || targetRid,
        name: set.name,
        chdata: set.chdata
      });
    }
  }
  
  // Reconstruct paths from SXE element + attr edits
  for (const [rid, elem] of Object.entries(elementsByRid)) {
    if (elem.name === 'path') {
      const attrs: Record<string, string> = {};
      for (const attr of attrEdits) {
        if (attr.parent === rid && attr.name && attr.chdata !== undefined) {
          attrs[attr.name] = attr.chdata;
        }
      }
      
      if (attrs.d) {
        paths.push({
          d: attrs.d,
          stroke: attrs.stroke || '#000000',
          strokeWidth: attrs['stroke-width'] ? parseInt(attrs['stroke-width'], 10) : 1,
          fill: attrs.fill || 'none',
          id: rid
        });
      }
    } else if (elem.name === 'line' || elem.name === 'rect' || elem.name === 'circle' || elem.name === 'ellipse' || elem.name === 'polyline' || elem.name === 'polygon') {
      const attrs: Record<string, string> = {};
      for (const attr of attrEdits) {
        if (attr.parent === rid && attr.name && attr.chdata !== undefined) {
          attrs[attr.name] = attr.chdata;
        }
      }
      if (Object.keys(attrs).length > 0) {
        paths.push({
          d: '',
          stroke: attrs.stroke || '#000000',
          strokeWidth: attrs['stroke-width'] ? parseInt(attrs['stroke-width'], 10) : 1,
          fill: attrs.fill || 'none',
          elementType: elem.name,
          elementAttrs: attrs,
          id: rid
        });
      }
    }
  }
  
  const standalonePaths: string[] = [];
  for (const el of sxeData.elements) {
    if ((el.type === 'new' || el.type === 'set' || !el.type) && el.name === 'd' && el.chdata) {
      standalonePaths.push(el.chdata);
    }
  }
  
  if (paths.length > 0) {
    return { type: 'path', paths, moves, deletes, rawPaths: standalonePaths.length > 0 ? standalonePaths : undefined };
  }
  if (deletes.length > 0) {
    return { type: 'delete', paths, moves, deletes };
  }
  if (moves.length > 0) {
    return { type: 'move', paths, moves, deletes };
  }
  
  return { type: 'path', paths, moves, deletes, rawPaths: standalonePaths.length > 0 ? standalonePaths : undefined };
}

export function reconstructPathsFromState(session: { sxeNodes: Record<string, { name: string; parent: string }>; sxeAttrs: Record<string, { parent: string; name: string; chdata: string }>; deletes: any[] }): WhiteboardPath[] {
  const paths: WhiteboardPath[] = [];
  
  for (const [rid, node] of Object.entries(session.sxeNodes)) {
    if (node.name === 'path') {
      const attrs: Record<string, string> = {};
      for (const [attrRid, attr] of Object.entries(session.sxeAttrs)) {
        if (attr.parent === rid && attr.name && attr.chdata !== undefined) {
          attrs[attr.name] = attr.chdata;
        }
      }
      
      if (attrs.d && attrs.d.length > 0) {
        paths.push({
          d: attrs.d,
          stroke: attrs.stroke || '#000000',
          strokeWidth: attrs['stroke-width'] ? parseInt(attrs['stroke-width'], 10) : 1,
          fill: attrs.fill || 'none',
          id: rid
        });
      }
    } else if (node.name === 'line' || node.name === 'rect' || node.name === 'circle' || node.name === 'ellipse' || node.name === 'polyline' || node.name === 'polygon') {
      const attrs: Record<string, string> = {};
      for (const [attrRid, attr] of Object.entries(session.sxeAttrs)) {
        if (attr.parent === rid && attr.name && attr.chdata !== undefined) {
          attrs[attr.name] = attr.chdata;
        }
      }
      if (Object.keys(attrs).length > 0) {
        paths.push({
          d: '',
          stroke: attrs.stroke || '#000000',
          strokeWidth: attrs['stroke-width'] ? parseInt(attrs['stroke-width'], 10) : 1,
          fill: attrs.fill || 'none',
          elementType: node.name,
          elementAttrs: attrs,
          id: rid
        });
      }
    }
  }
  
  return paths;
}

export async function sendSxeInvitation(
  xmpp: any,
  to: string,
  isGroupChat: boolean = false
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const sessionId = `sxe${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const messageType = isGroupChat ? 'groupchat' : 'chat';
    
    const sxeElement = buildSxeXml({
      sessionId,
      type: 'invitation'
    });
    
    const message = xml('message', { type: messageType, to }, sxeElement);
    await xmpp.send(message);
    log.debug("SXE invitation sent", { to, sessionId });
    return { ok: true, sessionId };
  } catch (err: any) {
    log.error("SXE invitation failed", err);
    return { ok: false, error: err.message };
  }
}

export function parseSvgPathCommands(text: string): SvgPathCommand[] {
  const commands: SvgPathCommand[] = [];
  const tagPattern = /\[WHITEBOARD_DRAW\]\s*([\s\S]*?)\s*\[\/WHITEBOARD_DRAW\]/gi;
  
  let tagMatch;
  let index = 0;
  
  tagPattern.lastIndex = 0;
  while ((tagMatch = tagPattern.exec(text)) !== null) {
    const blockContent = tagMatch[1];
    if (!blockContent) continue;
    
    const lines = blockContent.split('\n');
    for (const line of lines) {
      let trimmed = line.trim();
      if (!trimmed) continue;

      let color: string | undefined;
      let width: number | undefined;

      const colorMatch = trimmed.match(/\s+with\s+(red|blue|green|black|#[0-9a-f]{6})/i);
      if (colorMatch) {
        const colorName = colorMatch[1].toLowerCase();
        if (colorName === 'red') color = '#ff0000';
        else if (colorName === 'blue') color = '#0000ff';
        else if (colorName === 'green') color = '#00ff00';
        else if (colorName === 'black') color = '#000000';
        else if (colorName.startsWith('#')) color = colorName;
        trimmed = trimmed.replace(/\s+with\s+(red|blue|green|black|#[0-9a-f]{6})/i, '').trim();
      }

      const widthMatch = trimmed.match(/\s+width\s+(\d+)/i);
      if (widthMatch) {
        width = parseInt(widthMatch[1], 10);
        trimmed = trimmed.replace(/\s+width\s+\d+/i, '').trim();
      }

      if (/^[Mm]\s*-?\d/.test(trimmed)) {
        commands.push({
          path: trimmed,
          color,
          width,
          index: index++
        });
      }
    }
  }
  
  return commands;
}
