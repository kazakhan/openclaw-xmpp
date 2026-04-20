import fs from "fs/promises";
import path from "path";
import { VCardData, VCardName, VCardPhone, VCardEmail, VCardAddress, VCardOrg, VCardPhoto } from "./types.js";

export class VCard {
  private vcardFile: string;
  private vcardData: VCardData;
  private initialized: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.vcardFile = path.join(dataDir, "xmpp-vcard.json");
    this.initialized = fs.mkdir(dataDir, { recursive: true })
      .then(() => this.loadVCard())
      .then((d) => { this.vcardData = d; });
  }

  private async whenReady(): Promise<void> {
    if (this.initialized) {
      await this.initialized;
      this.initialized = null;
    }
  }

  private async loadVCard(): Promise<VCardData> {
    try {
      const content = await fs.readFile(this.vcardFile, "utf8");
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: "3.0" };
      }
      return { version: "3.0" };
    }
  }

  private async saveVCard(): Promise<void> {
    try {
      this.vcardData.rev = new Date().toISOString();
      await fs.writeFile(this.vcardFile, JSON.stringify(this.vcardData, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save vCard:", err);
    }
  }

  // VERSION
  async getVersion(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.version || "3.0";
  }

  // FORMATTED NAME (FN) - Required
  async getFN(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.fn;
  }

  async setFN(fn: string): Promise<void> {
    await this.whenReady();
    this.vcardData.fn = fn;
    await this.saveVCard();
  }

  // STRUCTURED NAME (N)
  async getN(): Promise<VCardName | undefined> {
    await this.whenReady();
    return this.vcardData.n;
  }

  async setN(name: VCardName): Promise<void> {
    await this.whenReady();
    this.vcardData.n = name;
    await this.saveVCard();
  }

  // Build N from components
  async setNameComponents(family: string, given: string, middle?: string, prefix?: string, suffix?: string): Promise<void> {
    await this.whenReady();
    this.vcardData.n = { family, given, middle, prefix, suffix };
    await this.saveVCard();
  }

  // NICKNAME
  async getNickname(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.nickname;
  }

  async setNickname(nickname: string): Promise<void> {
    await this.whenReady();
    this.vcardData.nickname = nickname;
    await this.saveVCard();
  }

  // PHOTO
  async getPhoto(): Promise<VCardPhoto | undefined> {
    await this.whenReady();
    return this.vcardData.photo;
  }

  async getPhotoUrl(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.photo?.extval || this.vcardData.avatarUrl;
  }

  async setPhotoUrl(url: string): Promise<void> {
    await this.whenReady();
    this.vcardData.photo = { extval: url };
    this.vcardData.avatarUrl = url;
    await this.saveVCard();
  }

  async setPhotoData(mimeType: string, data: string): Promise<void> {
    await this.whenReady();
    this.vcardData.photo = { type: mimeType, binval: data };
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    await this.saveVCard();
  }

  // BIRTHDAY (BDAY)
  async getBday(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.bday;
  }

  async setBday(bday: string): Promise<void> {
    await this.whenReady();
    this.vcardData.bday = bday;
    await this.saveVCard();
  }

  // TELEPHONE (TEL) - Multi-value
  async getTel(): Promise<VCardPhone[]> {
    await this.whenReady();
    return this.vcardData.tel || [];
  }

  async setTel(phones: VCardPhone[]): Promise<void> {
    await this.whenReady();
    this.vcardData.tel = phones;
    await this.saveVCard();
  }

  async addPhone(types: string[], number: string): Promise<void> {
    await this.whenReady();
    if (!this.vcardData.tel) this.vcardData.tel = [];
    this.vcardData.tel.push({ types, number });
    await this.saveVCard();
  }

  async removePhone(index: number): Promise<void> {
    await this.whenReady();
    if (this.vcardData.tel && this.vcardData.tel[index]) {
      this.vcardData.tel.splice(index, 1);
      await this.saveVCard();
    }
  }

  // EMAIL - Multi-value
  async getEmail(): Promise<VCardEmail[]> {
    await this.whenReady();
    return this.vcardData.email || [];
  }

  async setEmail(emails: VCardEmail[]): Promise<void> {
    await this.whenReady();
    this.vcardData.email = emails;
    await this.saveVCard();
  }

  async addEmail(types: string[], userid: string): Promise<void> {
    await this.whenReady();
    if (!this.vcardData.email) this.vcardData.email = [];
    this.vcardData.email.push({ types, userid });
    await this.saveVCard();
  }

  async removeEmail(index: number): Promise<void> {
    await this.whenReady();
    if (this.vcardData.email && this.vcardData.email[index]) {
      this.vcardData.email.splice(index, 1);
      await this.saveVCard();
    }
  }

  // ADDRESS (ADR) - Multi-value
  async getAdr(): Promise<VCardAddress[]> {
    await this.whenReady();
    return this.vcardData.adr || [];
  }

  async setAdr(addresses: VCardAddress[]): Promise<void> {
    await this.whenReady();
    this.vcardData.adr = addresses;
    await this.saveVCard();
  }

  async addAddress(address: VCardAddress): Promise<void> {
    await this.whenReady();
    if (!this.vcardData.adr) this.vcardData.adr = [];
    this.vcardData.adr.push(address);
    await this.saveVCard();
  }

  async removeAddress(index: number): Promise<void> {
    await this.whenReady();
    if (this.vcardData.adr && this.vcardData.adr[index]) {
      this.vcardData.adr.splice(index, 1);
      await this.saveVCard();
    }
  }

  // JABBERID
  async getJabberid(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.jabberid;
  }

  async setJabberid(jabberid: string): Promise<void> {
    await this.whenReady();
    this.vcardData.jabberid = jabberid;
    await this.saveVCard();
  }

  // MAILER
  async getMailer(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.mailer;
  }

  async setMailer(mailer: string): Promise<void> {
    await this.whenReady();
    this.vcardData.mailer = mailer;
    await this.saveVCard();
  }

  // TIMEZONE (TZ)
  async getTz(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.tz;
  }

  async setTz(tz: string): Promise<void> {
    await this.whenReady();
    this.vcardData.tz = tz;
    await this.saveVCard();
  }

  // GEO
  async getGeo(): Promise<{ lat?: string; lon?: string } | undefined> {
    await this.whenReady();
    return this.vcardData.geo;
  }

  async setGeo(lat: string, lon: string): Promise<void> {
    await this.whenReady();
    this.vcardData.geo = { lat, lon };
    await this.saveVCard();
  }

  // TITLE
  async getTitle(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.title;
  }

  async setTitle(title: string): Promise<void> {
    await this.whenReady();
    this.vcardData.title = title;
    await this.saveVCard();
  }

  // ROLE
  async getRole(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.role;
  }

  async setRole(role: string): Promise<void> {
    await this.whenReady();
    this.vcardData.role = role;
    await this.saveVCard();
  }

  // ORGANIZATION (ORG)
  async getOrg(): Promise<VCardOrg | undefined> {
    await this.whenReady();
    return this.vcardData.org;
  }

  async setOrg(org: VCardOrg): Promise<void> {
    await this.whenReady();
    this.vcardData.org = org;
    await this.saveVCard();
  }

  async setOrgComponents(orgname: string, ...orgunits: string[]): Promise<void> {
    await this.whenReady();
    this.vcardData.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };
    await this.saveVCard();
  }

  // LOGO
  async getLogo(): Promise<VCardPhoto | undefined> {
    await this.whenReady();
    return this.vcardData.logo;
  }

  async setLogoUrl(url: string): Promise<void> {
    await this.whenReady();
    this.vcardData.logo = { extval: url };
    await this.saveVCard();
  }

  async setLogoData(mimeType: string, data: string): Promise<void> {
    await this.whenReady();
    this.vcardData.logo = { type: mimeType, binval: data };
    await this.saveVCard();
  }

  // CATEGORIES
  async getCategories(): Promise<string[]> {
    await this.whenReady();
    return this.vcardData.categories || [];
  }

  async setCategories(categories: string[]): Promise<void> {
    await this.whenReady();
    this.vcardData.categories = categories;
    await this.saveVCard();
  }

  // NOTE
  async getNote(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.note;
  }

  async setNote(note: string): Promise<void> {
    await this.whenReady();
    this.vcardData.note = note;
    await this.saveVCard();
  }

  // UID
  async getUid(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.uid;
  }

  async setUid(uid: string): Promise<void> {
    await this.whenReady();
    this.vcardData.uid = uid;
    await this.saveVCard();
  }

  // URL
  async getUrl(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.url;
  }

  async setUrl(url: string): Promise<void> {
    await this.whenReady();
    this.vcardData.url = url;
    await this.saveVCard();
  }

  // DESC
  async getDesc(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.desc;
  }

  async setDesc(desc: string): Promise<void> {
    await this.whenReady();
    this.vcardData.desc = desc;
    await this.saveVCard();
  }

  // REV (auto-managed)
  async getRev(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.rev;
  }

  // PROdid
  async getProdid(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.prodid;
  }

  async setProdiD(prodid: string): Promise<void> {
    await this.whenReady();
    this.vcardData.prodid = prodid;
    await this.saveVCard();
  }

  // SORT-STRING
  async getSortString(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.sortString;
  }

  async setSortString(sortString: string): Promise<void> {
    await this.whenReady();
    this.vcardData.sortString = sortString;
    await this.saveVCard();
  }

  // Get all vCard data for XML generation
  async getData(): Promise<VCardData> {
    await this.whenReady();
    return { ...this.vcardData };
  }

  // Legacy getters for backward compatibility
  async getAvatarUrl(): Promise<string | undefined> {
    await this.whenReady();
    return this.vcardData.avatarUrl || this.vcardData.photo?.extval;
  }

  async setAvatarUrl(avatarUrl: string): Promise<void> {
    await this.whenReady();
    this.vcardData.avatarUrl = avatarUrl;
    this.vcardData.photo = { extval: avatarUrl };
    await this.saveVCard();
  }

  async getAvatarData(): Promise<{ mimeType?: string; data?: string } | undefined> {
    await this.whenReady();
    if (!this.vcardData.avatarData && !this.vcardData.photo?.binval) return undefined;
    return {
      mimeType: this.vcardData.avatarMimeType || this.vcardData.photo?.type,
      data: this.vcardData.avatarData || this.vcardData.photo?.binval,
    };
  }

  async setAvatarData(mimeType: string, data: string): Promise<void> {
    await this.whenReady();
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.vcardData.photo = { type: mimeType, binval: data };
    await this.saveVCard();
  }

  // Set multiple fields at once
  async update(fields: Partial<VCardData>): Promise<void> {
    await this.whenReady();
    Object.assign(this.vcardData, fields);
    await this.saveVCard();
  }
}
