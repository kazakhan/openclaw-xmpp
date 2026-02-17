import fs from "fs";
import path from "path";
import { JsonStore } from "./jsonStore.js";
import { Contact, ContactsData } from "./types.js";

interface ContactEntry {
  jid: string;
  name: string;
}

export class Contacts {
  private contactsStore: JsonStore<ContactEntry[]>;
  private adminsStore: JsonStore<string[]>;
  
  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const contactsFile = path.join(dataDir, "xmpp-contacts.json");
    const adminsFile = path.join(dataDir, "xmpp-admins.json");
    
    this.contactsStore = new JsonStore<ContactEntry[]>({
      filePath: contactsFile,
      defaults: [],
      onLoad: (data) => Array.isArray(data) ? data : []
    });
    
    this.adminsStore = new JsonStore<string[]>({
      filePath: adminsFile,
      defaults: [],
      onLoad: (data) => Array.isArray(data) ? data : []
    });
  }
  
  list(): Contact[] {
    return this.contactsStore.get();
  }
  
  exists(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    return this.contactsStore.get().some(c => c.jid === bareJid);
  }
  
  add(jid: string, name?: string): boolean {
    const bareJid = jid.split('/')[0];
    const contacts = this.contactsStore.get();
    const existingIndex = contacts.findIndex(c => c.jid === bareJid);
    
    if (existingIndex >= 0) {
      const updatedContacts = [...contacts];
      updatedContacts[existingIndex].name = name || updatedContacts[existingIndex].name || bareJid.split('@')[0];
      this.contactsStore.set(updatedContacts);
    } else {
      const newContact: ContactEntry = {
        jid: bareJid,
        name: name || bareJid.split('@')[0]
      };
      this.contactsStore.set([...contacts, newContact]);
    }
    return true;
  }
  
  remove(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    const contacts = this.contactsStore.get();
    const initialLength = contacts.length;
    const updatedContacts = contacts.filter(c => c.jid !== bareJid);
    
    if (updatedContacts.length < initialLength) {
      this.contactsStore.set(updatedContacts);
      return true;
    }
    return false;
  }
  
  getName(jid: string): string | undefined {
    const bareJid = jid.split('/')[0];
    const contact = this.contactsStore.get().find(c => c.jid === bareJid);
    return contact?.name;
  }
  
  isAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    return this.adminsStore.get().includes(bareJid);
  }
  
  addAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    const admins = this.adminsStore.get();
    if (!admins.includes(bareJid)) {
      this.adminsStore.set([...admins, bareJid]);
    }
    return true;
  }
  
  removeAdmin(jid: string): boolean {
    const bareJid = jid.split('/')[0];
    const admins = this.adminsStore.get();
    const updatedAdmins = admins.filter(a => a !== bareJid);
    
    if (updatedAdmins.length < admins.length) {
      this.adminsStore.set(updatedAdmins);
      return true;
    }
    return false;
  }
  
  listAdmins(): string[] {
    return this.adminsStore.get();
  }
  
  getAllJids(): string[] {
    return this.contactsStore.get().map(c => c.jid);
  }
}
