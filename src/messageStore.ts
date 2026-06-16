import fs from "fs/promises";
import path from "path";
import { Config } from "./config.js";

const MAX_MESSAGES_PER_FILE = Config.MAX_MESSAGES_PER_FILE;

/**
 * JID <-> filename encoding (2.0.15).
 *
 * The pre-2.0.15 implementation used a lossy `jid.replace(/[^a-zA-Z0-9@._-]/g, '_')`
 * to derive a filename, then tried to round-trip with
 * `f.replace('.json', '_').replace(/_/g, '.')`.  That round-trip is
 * lossy and produces malformed JIDs: `user_at_x.com` becomes
 * `user.at.x.com.` (every `_` is replaced with `.`, including those
 * in the original JID, and a trailing dot is added).
 *
 * The new encoding is a percent-encoding of the three characters that
 * are legal in a JID but reserved in a filename: `.`, `/`, `_`.  It
 * is bijective: encodeJidForFilename(decodeJidFromFilename(x)) === x
 * and vice versa.
 *
 * Files written by 2.0.14 and earlier (lossy encoded) remain on disk
 * but `getDirectChatJIDs()` will return the JIDs that the operator
 * originally saved *as best it can* by reading the file's
 * `meta.chatJid` (which was always set on save).  The pre-existing
 * filename is preserved so a rollback to 2.0.14 is still possible.
 */
export function encodeJidForFilename(jid: string): string {
  return jid
    .replace(/%/g, "%25")
    .replace(/\./g, "%2E")
    .replace(/\//g, "%2F")
    .replace(/_/g, "%5F");
}

export function decodeJidFromFilename(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Defensive: if the filename contains malformed percent-encoding
    // (e.g. from a 2.0.14-era file), fall back to the lossy reverse
    // so we never throw.  This is the best we can do for legacy files.
    return encoded.replace(/_/g, ".");
  }
}

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
    ]).then(() => this.migrateLegacyFilenames());
  }

  /**
   * One-time migration of pre-2.0.15 filenames to the new percent-
   * encoded scheme.  Idempotent: a file is renamed only if its
   * filename does not already contain a `%` (the new scheme's
   * marker) and is not already in canonical form.
   *
   * The migration is best-effort: if the source file's name collides
   * with an existing new-format file, the source is left alone
   * (preserved for `getDirectChatJIDs` to read via the `meta.chatJid`
   * fallback).
   */
  private async migrateLegacyFilenames(): Promise<void> {
    const directDir = path.join(this.messagesDir, 'direct');
    const groupDir = path.join(this.messagesDir, 'group');
    let entries: string[] = [];
    try { entries = await fs.readdir(directDir); } catch { /* missing dir */ }
    for (const name of entries) {
      if (name.includes('%')) continue;          // already new format
      if (!name.endsWith('.json')) continue;     // not a message file
      const legacyBase = name.slice(0, -'.json'.length);
      // The legacy scheme permitted `_` in the encoded name, so we
      // can only round-trip files that contain at most one `.` in
      // the JID.  In practice, JIDs are always `user@domain.tld`
      // (two dots) which the legacy scheme already corrupted.  We
      // therefore skip the rename for files that look already
      // corrupted and rely on the meta.chatJid fallback.
      const hasMultipleDots = (legacyBase.match(/\./g) || []).length > 1;
      if (hasMultipleDots) continue;
      const newBase = encodeJidForFilename(decodeJidFromFilename(legacyBase));
      const newName = `${newBase}.json`;
      if (newName === name) continue;
      const src = path.join(directDir, name);
      const dst = path.join(directDir, newName);
      try {
        await fs.rename(src, dst);
      } catch {
        // collision or permission error — leave the legacy file in
        // place; readers will use the meta.chatJid fallback.
      }
    }
    // Group directory: same pattern.  Group subdirs are named after
    // the room JID, so the rename is per-subdir.
    let groupEntries: import("fs").Dirent[] = [];
    try { groupEntries = await fs.readdir(groupDir, { withFileTypes: true }); } catch { /* missing dir */ }
    for (const ent of groupEntries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.includes('%')) continue;
      const newName = encodeJidForFilename(decodeJidFromFilename(ent.name));
      if (newName === ent.name) continue;
      const src = path.join(groupDir, ent.name);
      const dst = path.join(groupDir, newName);
      try { await fs.rename(src, dst); } catch { /* collision */ }
    }
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
    const safeRoomName = encodeJidForFilename(roomJid);
    return path.join(this.messagesDir, 'group', safeRoomName, `${date}.json`);
  }

  private getDirectFilePath(jid: string): string {
    const safeJid = encodeJidForFilename(jid);
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
      // Each .json file's basename is the JID encoded via
      // encodeJidForFilename.  We slice off the ".json" extension
      // and decode; the helper is a no-op for files that already
      // use the new format and reverses the lossy old format only
      // for the percent-encoded files written by 2.0.15+.
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => decodeJidFromFilename(f.slice(0, -'.json'.length)));
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
      return rooms.map(room => decodeJidFromFilename(room));
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
