import fs from "fs";
import path from "path";

interface ContactEntry {
  jid: string;
  name: string;
}

export class Contacts {
  private contactsFile: string;
  private adminsFile: string;
  private contactsCache: Array<{ jid: string; name: string }>;
  private adminsCache: Set<string>;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.contactsFile = path.join(dataDir, "xmpp-contacts.json");
    this.adminsFile = path.join(dataDir, "xmpp-admins.json");
    this.contactsCache = this.loadContacts();
    this.adminsCache = this.loadAdmins();
  }

  private loadContacts(): Array<{ jid: string; name: string }> {
    if (!fs.existsSync(this.contactsFile)) {
      return [];
    }
    try {
      return JSON.parse(fs.readFileSync(this.contactsFile, "utf8"));
    } catch {
      return [];
    }
  }

  private loadAdmins(): Set<string> {
    if (!fs.existsSync(this.adminsFile)) {
      return new Set();
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.adminsFile, "utf8"));
      return new Set(Array.isArray(data) ? data : []);
    } catch {
      return new Set();
    }
  }

  private saveContacts(): void {
    try {
      fs.writeFileSync(this.contactsFile, JSON.stringify(this.contactsCache, null, 2));
    } catch (err) {
      console.error("Failed to save contacts:", err);
    }
  }

  private saveAdmins(): void {
    try {
      fs.writeFileSync(this.adminsFile, JSON.stringify(Array.from(this.adminsCache), null, 2));
    } catch (err) {
      console.error("Failed to save admins:", err);
    }
  }

  list(): Array<{ jid: string; name: string }> {
    return this.contactsCache;
  }

  exists(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    return this.contactsCache.some(c => c.jid === bareJid);
  }

  add(jid: string, name?: string): boolean {
    const bareJid = jid.split('/')[0];

    const existingIndex = this.contactsCache.findIndex(c => c.jid === bareJid);
    if (existingIndex >= 0) {
      this.contactsCache[existingIndex].name = name || this.contactsCache[existingIndex].name || bareJid.split('@')[0];
    } else {
      this.contactsCache.push({
        jid: bareJid,
        name: name || bareJid.split('@')[0]
      });
    }
    this.saveContacts();
    return true;
  }

  remove(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    const initialLength = this.contactsCache.length;
    this.contactsCache = this.contactsCache.filter(c => c.jid !== bareJid);
    if (this.contactsCache.length < initialLength) {
      this.saveContacts();
      return true;
    }
    return false;
  }

  getName(jid: string): string | undefined {
    const bareJid = jid.split('/')[0];
    const contact = this.contactsCache.find(c => c.jid === bareJid);
    return contact?.name;
  }

  isAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    return this.adminsCache.has(bareJid);
  }

  addAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    this.adminsCache.add(bareJid);
    this.saveAdmins();
    return true;
  }

  removeAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    const result = this.adminsCache.delete(bareJid);
    if (result) {
      this.saveAdmins();
    }
    return result;
  }

  listAdmins(): string[] {
    return Array.from(this.adminsCache);
  }

  getAllJids(): string[] {
    return this.contactsCache.map(c => c.jid);
  }
}
