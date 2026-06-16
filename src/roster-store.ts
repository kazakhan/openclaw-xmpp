import fs from "fs";
import path from "path";
import { JsonStore } from "./jsonStore.js";

export interface RosterEntry {
  jid: string;
  nick: string;
  updatedAt: number;
}

interface RosterData {
  entries: RosterEntry[];
}

const ROSTER_FILE = "xmpp-roster.json";

export class RosterStore {
  private store: JsonStore<RosterData>;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const filePath = path.join(dataDir, ROSTER_FILE);
    this.store = new JsonStore<RosterData>({
      filePath,
      defaults: { entries: [] },
      onLoad: (d) => ({
        entries: Array.isArray(d?.entries) ? d.entries.filter((e: any) => e?.jid && typeof e?.nick === "string") : []
      })
    });
  }

  async setNick(jid: string, nick: string): Promise<void> {
    const bareJid = jid.split("/")[0].toLowerCase();
    const data = await this.store.get();
    const existingIndex = data.entries.findIndex((e) => e.jid === bareJid);
    const entries = [...data.entries];
    if (existingIndex >= 0) {
      entries[existingIndex] = { jid: bareJid, nick, updatedAt: Date.now() };
    } else {
      entries.push({ jid: bareJid, nick, updatedAt: Date.now() });
    }
    await this.store.set({ entries });
  }

  async getNick(jid: string): Promise<string | undefined> {
    const bareJid = jid.split("/")[0].toLowerCase();
    const data = await this.store.get();
    return data.entries.find((e) => e.jid === bareJid)?.nick;
  }

  async list(): Promise<RosterEntry[]> {
    const data = await this.store.get();
    return [...data.entries];
  }

  async remove(jid: string): Promise<boolean> {
    const bareJid = jid.split("/")[0].toLowerCase();
    const data = await this.store.get();
    const filtered = data.entries.filter((e) => e.jid !== bareJid);
    if (filtered.length === data.entries.length) return false;
    await this.store.set({ entries: filtered });
    return true;
  }
}
