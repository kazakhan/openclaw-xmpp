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
  
  async list(): Promise<Contact[]> {
    return this.contactsStore.get();
  }
  
  async exists(jid: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    return (await this.contactsStore.get()).some(c => c.jid === bareJid);
  }
  
  async add(jid: string, name?: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    const contacts = await this.contactsStore.get();
    const existingIndex = contacts.findIndex(c => c.jid === bareJid);
    
    if (existingIndex >= 0) {
      const updatedContacts = [...contacts];
      updatedContacts[existingIndex].name = name || updatedContacts[existingIndex].name || bareJid.split('@')[0];
      await this.contactsStore.set(updatedContacts);
    } else {
      const newContact: ContactEntry = {
        jid: bareJid,
        name: name || bareJid.split('@')[0]
      };
      await this.contactsStore.set([...contacts, newContact]);
    }
    return true;
  }
  
  async remove(jid: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    const contacts = await this.contactsStore.get();
    const initialLength = contacts.length;
    const updatedContacts = contacts.filter(c => c.jid !== bareJid);
    
    if (updatedContacts.length < initialLength) {
      await this.contactsStore.set(updatedContacts);
      return true;
    }
    return false;
  }
  
  async getName(jid: string): Promise<string | undefined> {
    const bareJid = jid.split('/')[0];
    const contact = (await this.contactsStore.get()).find(c => c.jid === bareJid);
    return contact?.name;
  }
  
  async isAdmin(jid: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    return (await this.adminsStore.get()).includes(bareJid);
  }
  
  async addAdmin(jid: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    const admins = await this.adminsStore.get();
    if (!admins.includes(bareJid)) {
      await this.adminsStore.set([...admins, bareJid]);
    }
    return true;
  }
  
  async removeAdmin(jid: string): Promise<boolean> {
    const bareJid = jid.split('/')[0];
    const admins = await this.adminsStore.get();
    const updatedAdmins = admins.filter(a => a !== bareJid);
    
    if (updatedAdmins.length < admins.length) {
      await this.adminsStore.set(updatedAdmins);
      return true;
    }
    return false;
  }
  
  async listAdmins(): Promise<string[]> {
    return this.adminsStore.get();
  }
  
  async getAllJids(): Promise<string[]> {
    return (await this.contactsStore.get()).map(c => c.jid);
  }
}
