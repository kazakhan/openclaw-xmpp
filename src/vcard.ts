import fs from "fs";
import path from "path";
import { VCardData } from "./types.js";

export class VCard {
  private vcardFile: string;
  private vcardData: {
    fn?: string;
    nickname?: string;
    url?: string;
    desc?: string;
    avatarUrl?: string;
    avatarMimeType?: string;
    avatarData?: string; // base64
  };

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.vcardFile = path.join(dataDir, "xmpp-vcard.json");
    this.vcardData = this.loadVCard();
  }

  private loadVCard() {
    if (!fs.existsSync(this.vcardFile)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.vcardFile, "utf8"));
    } catch {
      return {};
    }
  }

  private saveVCard() {
    try {
      fs.writeFileSync(this.vcardFile, JSON.stringify(this.vcardData, null, 2));
    } catch (err) {
      console.error("Failed to save vCard:", err);
    }
  }

  getFN(): string | undefined {
    return this.vcardData.fn;
  }

  setFN(fn: string) {
    this.vcardData.fn = fn;
    this.saveVCard();
  }

  getNickname(): string | undefined {
    return this.vcardData.nickname;
  }

  setNickname(nickname: string) {
    this.vcardData.nickname = nickname;
    this.saveVCard();
  }

  getURL(): string | undefined {
    return this.vcardData.url;
  }

  setURL(url: string) {
    this.vcardData.url = url;
    this.saveVCard();
  }

  getDesc(): string | undefined {
    return this.vcardData.desc;
  }

  setDesc(desc: string) {
    this.vcardData.desc = desc;
    this.saveVCard();
  }

  getAvatarUrl(): string | undefined {
    return this.vcardData.avatarUrl;
  }

  setAvatarUrl(avatarUrl: string) {
    this.vcardData.avatarUrl = avatarUrl;
    this.saveVCard();
  }

  getAvatarData(): { mimeType?: string; data?: string } | undefined {
    if (!this.vcardData.avatarData) return undefined;
    return {
      mimeType: this.vcardData.avatarMimeType,
      data: this.vcardData.avatarData,
    };
  }

  setAvatarData(mimeType: string, data: string) {
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.saveVCard();
  }

  // Get all vCard data for XML generation
  getData() {
    return { ...this.vcardData };
  }

  // Set multiple fields at once
  update(fields: Partial<typeof this.vcardData>) {
    Object.assign(this.vcardData, fields);
    this.saveVCard();
  }
}
