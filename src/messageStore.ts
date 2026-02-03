import fs from "fs";
import path from "path";

export interface MessageEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  fromFullJid?: string;
  to: string;
  body: string;
  timestamp: number;
  accountId: string;
  nick?: string;
}

export interface MessageStoreMeta {
  roomJid?: string;
  chatJid?: string;
  created: string;
  updated: string;
  messageCount: number;
}

export interface MessageFile {
  meta: MessageStoreMeta;
  messages: MessageEntry[];
}

export interface SaveMessageOptions {
  direction: 'inbound' | 'outbound';
  type: 'groupchat' | 'chat';
  roomJid?: string;
  fromBareJid: string;
  fromFullJid?: string;
  fromNick?: string;
  to: string;
  body: string;
  timestamp?: number;
  accountId: string;
}

const MAX_MESSAGES_PER_FILE = 256;

export class MessageStore {
  private messagesDir: string;
  
  constructor(dataDir: string) {
    this.messagesDir = path.join(dataDir, 'messages');
    if (!fs.existsSync(this.messagesDir)) {
      fs.mkdirSync(this.messagesDir, { recursive: true });
    }
    
    const groupDir = path.join(this.messagesDir, 'group');
    const directDir = path.join(this.messagesDir, 'direct');
    if (!fs.existsSync(groupDir)) {
      fs.mkdirSync(groupDir, { recursive: true });
    }
    if (!fs.existsSync(directDir)) {
      fs.mkdirSync(directDir, { recursive: true });
    }
  }
  
  private getTodayDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  private getGroupFilePath(roomJid: string, date: string): string {
    const safeRoomName = roomJid.replace(/[^a-zA-Z0-9@._-]/g, '_');
    return path.join(this.messagesDir, 'group', safeRoomName, `${date}.json`);
  }
  
  private getDirectFilePath(jid: string): string {
    const safeJid = jid.replace(/[^a-zA-Z0-9@._-]/g, '_');
    return path.join(this.messagesDir, 'direct', `${safeJid}.json`);
  }
  
  private loadMessageFile(filePath: string): MessageFile {
    if (!fs.existsSync(filePath)) {
      return {
        meta: {
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          messageCount: 0
        },
        messages: []
      };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return {
        meta: {
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          messageCount: 0
        },
        messages: []
      };
    }
  }
  
  private saveMessageFile(filePath: string, data: MessageFile): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    data.meta.updated = new Date().toISOString();
    data.meta.messageCount = data.messages.length;
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  
  saveMessage(options: SaveMessageOptions): void {
    const timestamp = options.timestamp || Date.now();
    const messageId = `${timestamp}-${Math.random().toString(36).substring(2, 11)}`;
    
    if (options.type === 'groupchat' && options.roomJid) {
      const date = this.getTodayDate();
      const filePath = this.getGroupFilePath(options.roomJid, date);
      const data = this.loadMessageFile(filePath);
      
      const newMessage: MessageEntry = {
        id: messageId,
        direction: options.direction,
        from: options.fromNick || options.fromBareJid,
        fromFullJid: options.fromFullJid,
        to: options.to,
        body: options.body,
        timestamp,
        accountId: options.accountId
      };
      
      if (data.messages.length >= MAX_MESSAGES_PER_FILE) {
        data.messages.shift();
      }
      
      data.messages.push(newMessage);
      data.meta.roomJid = options.roomJid;
      this.saveMessageFile(filePath, data);
      
      console.log(`[MessageStore] Saved ${options.direction} message to group ${options.roomJid} on ${date}`);
    } else {
      const filePath = this.getDirectFilePath(options.fromBareJid);
      const data = this.loadMessageFile(filePath);
      
      const newMessage: MessageEntry = {
        id: messageId,
        direction: options.direction,
        from: options.fromBareJid,
        fromFullJid: options.fromFullJid,
        to: options.to,
        body: options.body,
        timestamp,
        accountId: options.accountId
      };
      
      if (data.messages.length >= MAX_MESSAGES_PER_FILE) {
        data.messages.shift();
      }
      
      data.messages.push(newMessage);
      data.meta.chatJid = options.fromBareJid;
      this.saveMessageFile(filePath, data);
      
      console.log(`[MessageStore] Saved ${options.direction} message from direct ${options.fromBareJid}`);
    }
  }
  
  getGroupchatMessages(roomJid: string, date?: string): MessageEntry[] {
    const targetDate = date || this.getTodayDate();
    const filePath = this.getGroupFilePath(roomJid, targetDate);
    const data = this.loadMessageFile(filePath);
    return data.messages;
  }
  
  getDirectMessages(jid: string): MessageEntry[] {
    const filePath = this.getDirectFilePath(jid);
    const data = this.loadMessageFile(filePath);
    return data.messages;
  }
  
  getRecentDirectMessages(jid: string, limit: number = 50): MessageEntry[] {
    const messages = this.getDirectMessages(jid);
    return messages.slice(-limit);
  }
  
  getRecentGroupchatMessages(roomJid: string, limit: number = 50): MessageEntry[] {
    const messages = this.getGroupchatMessages(roomJid);
    return messages.slice(-limit);
  }
  
  getDirectChatJIDs(): string[] {
    const directDir = path.join(this.messagesDir, 'direct');
    if (!fs.existsSync(directDir)) {
      return [];
    }
    
    const files = fs.readdirSync(directDir).filter(f => f.endsWith('.json'));
    return files.map(f => f.replace('.json', '_')).map(s => s.replace(/_/g, '.'));
  }
  
  getGroupChatRoomJIDs(): string[] {
    const groupDir = path.join(this.messagesDir, 'group');
    if (!fs.existsSync(groupDir)) {
      return [];
    }
    
    const rooms = fs.readdirSync(groupDir);
    return rooms.map(room => room.replace(/_/g, '.'));
  }
  
  getGroupChatDates(roomJid: string): string[] {
    const safeRoomName = roomJid.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const roomDir = path.join(this.messagesDir, 'group', safeRoomName);
    if (!fs.existsSync(roomDir)) {
      return [];
    }
    
    return fs.readdirSync(roomDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  }
  
  getStats(): { directChats: number; groupChats: number; totalMessages: number } {
    const directJids = this.getDirectChatJIDs();
    const groupRooms = this.getGroupChatRoomJIDs();
    
    let totalMessages = 0;
    for (const jid of directJids) {
      totalMessages += this.getDirectMessages(jid).length;
    }
    for (const room of groupRooms) {
      totalMessages += this.getGroupchatMessages(room).length;
    }
    
    return {
      directChats: directJids.length,
      groupChats: groupRooms.length,
      totalMessages
    };
  }
}
