import fs from "fs";
import path from "path";
import { VCardData } from "./types.js";

export class VCard {
  private vcardFile: string;
  private vcardData: VCardData;
  
  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.vcardFile = path.join(dataDir, "xmpp-vcard.json");
    this.vcardData = this.loadVCard();
  }
  
  private loadVCard(): VCardData {
    if (!fs.existsSync(this.vcardFile)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.vcardFile, "utf8"));
    } catch {
      return {};
    }
  }
  
  private saveVCard(): void {
    try {
      fs.writeFileSync(this.vcardFile, JSON.stringify(this.vcardData, null, 2));
    } catch (err) {
      console.error("Failed to save vCard:", err);
    }
  }
  
  getFN(): string | undefined {
    return this.vcardData.fn;
  }
  
  setFN(fn: string): void {
    this.vcardData.fn = fn;
    this.saveVCard();
  }
  
  getNickname(): string | undefined {
    return this.vcardData.nickname;
  }
  
  setNickname(nickname: string): void {
    this.vcardData.nickname = nickname;
    this.saveVCard();
  }
  
  getURL(): string | undefined {
    return this.vcardData.url;
  }
  
  setURL(url: string): void {
    this.vcardData.url = url;
    this.saveVCard();
  }
  
  getDesc(): string | undefined {
    return this.vcardData.desc;
  }
  
  setDesc(desc: string): void {
    this.vcardData.desc = desc;
    this.saveVCard();
  }
  
  getAvatarUrl(): string | undefined {
    return this.vcardData.avatarUrl;
  }
  
  setAvatarUrl(avatarUrl: string): void {
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
  
  setAvatarData(mimeType: string, data: string): void {
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.saveVCard();
  }
  
  getData(): VCardData {
    return { ...this.vcardData };
  }
  
  update(fields: Partial<VCardData>): void {
    Object.assign(this.vcardData, fields);
    this.saveVCard();
  }
  
  buildVCardXml(xml: any, localPart: string): any {
    const fn = this.vcardData.fn || `ClawdBot (${localPart})`;
    const nickname = this.vcardData.nickname || localPart;
    const url = this.vcardData.url || "https://github.com/anomalyco/clawdbot";
    const desc = this.vcardData.desc || "ClawdBot XMPP Plugin - AI Assistant";
    const avatarUrl = this.vcardData.avatarUrl || "";
    
    const vcardXml = xml("vCard", { xmlns: "vcard-temp" },
      xml("FN", {}, fn),
      xml("NICKNAME", {}, nickname),
      xml("URL", {}, url),
      xml("DESC", {}, desc)
    );
    
    if (avatarUrl) {
      vcardXml.append(xml("PHOTO", {}, xml("URI", {}, avatarUrl)));
    }
    
    return vcardXml;
  }
}
