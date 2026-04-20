import fs from "fs/promises";
import path from "path";
import { Config } from "./config.js";

const MAX_MESSAGES_PER_FILE = Config.MAX_MESSAGES_PER_FILE;

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

export class MessageStore {
  private messagesDir: string;
  private initialized: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.messagesDir = path.join(dataDir, 'messages');
    this.initialized = Promise.all([
      fs.mkdir(this.messagesDir, { recursive: true }),
      fs.mkdir(path.join(this.messagesDir, 'group'), { recursive: true }),
      fs.mkdir(path.join(this.messagesDir, 'direct'), { recursive: true }),
    ]).then(() => {});
  }

  private async whenReady(): Promise<void> {
    if (this.initialized) {
      await this.initialized;
      this.initialized = null;
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

  private async loadMessageFile(filePath: string): Promise<MessageFile> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          meta: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            messageCount: 0
          },
          messages: []
        };
      }
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

  private async saveMessageFile(filePath: string, data: MessageFile): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    data.meta.updated = new Date().toISOString();
    data.meta.messageCount = data.messages.length;

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async saveMessage(options: SaveMessageOptions): Promise<void> {
    await this.whenReady();

    const timestamp = options.timestamp || Date.now();
    const messageId = `${timestamp}-${Math.random().toString(36).substring(2, 11)}`;

    if (options.type === 'groupchat' && options.roomJid) {
      const date = this.getTodayDate();
      const filePath = this.getGroupFilePath(options.roomJid, date);
      const data = await this.loadMessageFile(filePath);

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
      await this.saveMessageFile(filePath, data);
    } else {
      const filePath = this.getDirectFilePath(options.fromBareJid);
      const data = await this.loadMessageFile(filePath);

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
      await this.saveMessageFile(filePath, data);
    }
  }

  async getGroupchatMessages(roomJid: string, date?: string): Promise<MessageEntry[]> {
    await this.whenReady();
    const targetDate = date || this.getTodayDate();
    const filePath = this.getGroupFilePath(roomJid, targetDate);
    const data = await this.loadMessageFile(filePath);
    return data.messages;
  }

  async getDirectMessages(jid: string): Promise<MessageEntry[]> {
    await this.whenReady();
    const filePath = this.getDirectFilePath(jid);
    const data = await this.loadMessageFile(filePath);
    return data.messages;
  }

  async getRecentDirectMessages(jid: string, limit: number = 50): Promise<MessageEntry[]> {
    const messages = await this.getDirectMessages(jid);
    return messages.slice(-limit);
  }

  async getRecentGroupchatMessages(roomJid: string, limit: number = 50): Promise<MessageEntry[]> {
    const messages = await this.getGroupchatMessages(roomJid);
    return messages.slice(-limit);
  }

  async getDirectChatJIDs(): Promise<string[]> {
    await this.whenReady();
    const directDir = path.join(this.messagesDir, 'direct');

    try {
      const files = await fs.readdir(directDir);
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', '_')).map(s => s.replace(/_/g, '.'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async getGroupChatRoomJIDs(): Promise<string[]> {
    await this.whenReady();
    const groupDir = path.join(this.messagesDir, 'group');

    try {
      const rooms = await fs.readdir(groupDir);
      return rooms.map(room => room.replace(/_/g, '.'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async getGroupChatDates(roomJid: string): Promise<string[]> {
    await this.whenReady();
    const safeRoomName = roomJid.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const roomDir = path.join(this.messagesDir, 'group', safeRoomName);

    try {
      const files = await fs.readdir(roomDir);
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async getStats(): Promise<{ directChats: number; groupChats: number; totalMessages: number }> {
    const directJids = await this.getDirectChatJIDs();
    const groupRooms = await this.getGroupChatRoomJIDs();

    let totalMessages = 0;
    for (const jid of directJids) {
      totalMessages += (await this.getDirectMessages(jid)).length;
    }
    for (const room of groupRooms) {
      totalMessages += (await this.getGroupchatMessages(room)).length;
    }

    return {
      directChats: directJids.length,
      groupChats: groupRooms.length,
      totalMessages
    };
  }
}
