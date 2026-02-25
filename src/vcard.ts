import fs from "fs";
import path from "path";
import { VCardData, VCardName, VCardPhone, VCardEmail, VCardAddress, VCardOrg, VCardPhoto } from "./types.js";

export class VCard {
  private vcardFile: string;
  private vcardData: VCardData;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.vcardFile = path.join(dataDir, "xmpp-vcard.json");
    this.vcardData = this.loadVCard();
  }

  private loadVCard(): VCardData {
    if (!fs.existsSync(this.vcardFile)) {
      return { version: "3.0" };
    }
    try {
      return JSON.parse(fs.readFileSync(this.vcardFile, "utf8"));
    } catch {
      return { version: "3.0" };
    }
  }

  private saveVCard() {
    try {
      this.vcardData.rev = new Date().toISOString();
      fs.writeFileSync(this.vcardFile, JSON.stringify(this.vcardData, null, 2));
    } catch (err) {
      console.error("Failed to save vCard:", err);
    }
  }

  // VERSION
  getVersion(): string | undefined {
    return this.vcardData.version || "3.0";
  }

  // FORMATTED NAME (FN) - Required
  getFN(): string | undefined {
    return this.vcardData.fn;
  }

  setFN(fn: string) {
    this.vcardData.fn = fn;
    this.saveVCard();
  }

  // STRUCTURED NAME (N)
  getN(): VCardName | undefined {
    return this.vcardData.n;
  }

  setN(name: VCardName) {
    this.vcardData.n = name;
    this.saveVCard();
  }

  // Build N from components
  setNameComponents(family: string, given: string, middle?: string, prefix?: string, suffix?: string) {
    this.vcardData.n = { family, given, middle, prefix, suffix };
    this.saveVCard();
  }

  // NICKNAME
  getNickname(): string | undefined {
    return this.vcardData.nickname;
  }

  setNickname(nickname: string) {
    this.vcardData.nickname = nickname;
    this.saveVCard();
  }

  // PHOTO
  getPhoto(): VCardPhoto | undefined {
    return this.vcardData.photo;
  }

  getPhotoUrl(): string | undefined {
    return this.vcardData.photo?.extval || this.vcardData.avatarUrl;
  }

  setPhotoUrl(url: string) {
    this.vcardData.photo = { extval: url };
    this.vcardData.avatarUrl = url;
    this.saveVCard();
  }

  setPhotoData(mimeType: string, data: string) {
    this.vcardData.photo = { type: mimeType, binval: data };
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.saveVCard();
  }

  // BIRTHDAY (BDAY)
  getBday(): string | undefined {
    return this.vcardData.bday;
  }

  setBday(bday: string) {
    this.vcardData.bday = bday;
    this.saveVCard();
  }

  // TELEPHONE (TEL) - Multi-value
  getTel(): VCardPhone[] {
    return this.vcardData.tel || [];
  }

  setTel(phones: VCardPhone[]) {
    this.vcardData.tel = phones;
    this.saveVCard();
  }

  addPhone(types: string[], number: string) {
    if (!this.vcardData.tel) this.vcardData.tel = [];
    this.vcardData.tel.push({ types, number });
    this.saveVCard();
  }

  removePhone(index: number) {
    if (this.vcardData.tel && this.vcardData.tel[index]) {
      this.vcardData.tel.splice(index, 1);
      this.saveVCard();
    }
  }

  // EMAIL - Multi-value
  getEmail(): VCardEmail[] {
    return this.vcardData.email || [];
  }

  setEmail(emails: VCardEmail[]) {
    this.vcardData.email = emails;
    this.saveVCard();
  }

  addEmail(types: string[], userid: string) {
    if (!this.vcardData.email) this.vcardData.email = [];
    this.vcardData.email.push({ types, userid });
    this.saveVCard();
  }

  removeEmail(index: number) {
    if (this.vcardData.email && this.vcardData.email[index]) {
      this.vcardData.email.splice(index, 1);
      this.saveVCard();
    }
  }

  // ADDRESS (ADR) - Multi-value
  getAdr(): VCardAddress[] {
    return this.vcardData.adr || [];
  }

  setAdr(addresses: VCardAddress[]) {
    this.vcardData.adr = addresses;
    this.saveVCard();
  }

  addAddress(address: VCardAddress) {
    if (!this.vcardData.adr) this.vcardData.adr = [];
    this.vcardData.adr.push(address);
    this.saveVCard();
  }

  removeAddress(index: number) {
    if (this.vcardData.adr && this.vcardData.adr[index]) {
      this.vcardData.adr.splice(index, 1);
      this.saveVCard();
    }
  }

  // JABBERID
  getJabberid(): string | undefined {
    return this.vcardData.jabberid;
  }

  setJabberid(jabberid: string) {
    this.vcardData.jabberid = jabberid;
    this.saveVCard();
  }

  // MAILER
  getMailer(): string | undefined {
    return this.vcardData.mailer;
  }

  setMailer(mailer: string) {
    this.vcardData.mailer = mailer;
    this.saveVCard();
  }

  // TIMEZONE (TZ)
  getTz(): string | undefined {
    return this.vcardData.tz;
  }

  setTz(tz: string) {
    this.vcardData.tz = tz;
    this.saveVCard();
  }

  // GEO
  getGeo(): { lat?: string; lon?: string } | undefined {
    return this.vcardData.geo;
  }

  setGeo(lat: string, lon: string) {
    this.vcardData.geo = { lat, lon };
    this.saveVCard();
  }

  // TITLE
  getTitle(): string | undefined {
    return this.vcardData.title;
  }

  setTitle(title: string) {
    this.vcardData.title = title;
    this.saveVCard();
  }

  // ROLE
  getRole(): string | undefined {
    return this.vcardData.role;
  }

  setRole(role: string) {
    this.vcardData.role = role;
    this.saveVCard();
  }

  // ORGANIZATION (ORG)
  getOrg(): VCardOrg | undefined {
    return this.vcardData.org;
  }

  setOrg(org: VCardOrg) {
    this.vcardData.org = org;
    this.saveVCard();
  }

  setOrgComponents(orgname: string, ...orgunits: string[]) {
    this.vcardData.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };
    this.saveVCard();
  }

  // LOGO
  getLogo(): VCardPhoto | undefined {
    return this.vcardData.logo;
  }

  setLogoUrl(url: string) {
    this.vcardData.logo = { extval: url };
    this.saveVCard();
  }

  setLogoData(mimeType: string, data: string) {
    this.vcardData.logo = { type: mimeType, binval: data };
    this.saveVCard();
  }

  // CATEGORIES
  getCategories(): string[] {
    return this.vcardData.categories || [];
  }

  setCategories(categories: string[]) {
    this.vcardData.categories = categories;
    this.saveVCard();
  }

  // NOTE
  getNote(): string | undefined {
    return this.vcardData.note;
  }

  setNote(note: string) {
    this.vcardData.note = note;
    this.saveVCard();
  }

  // UID
  getUid(): string | undefined {
    return this.vcardData.uid;
  }

  setUid(uid: string) {
    this.vcardData.uid = uid;
    this.saveVCard();
  }

  // URL
  getUrl(): string | undefined {
    return this.vcardData.url;
  }

  setUrl(url: string) {
    this.vcardData.url = url;
    this.saveVCard();
  }

  // DESC
  getDesc(): string | undefined {
    return this.vcardData.desc;
  }

  setDesc(desc: string) {
    this.vcardData.desc = desc;
    this.saveVCard();
  }

  // REV (auto-managed)
  getRev(): string | undefined {
    return this.vcardData.rev;
  }

  // PROdid
  getProdid(): string | undefined {
    return this.vcardData.prodid;
  }

  setProdid(prodid: string) {
    this.vcardData.prodid = prodid;
    this.saveVCard();
  }

  // SORT-STRING
  getSortString(): string | undefined {
    return this.vcardData.sortString;
  }

  setSortString(sortString: string) {
    this.vcardData.sortString = sortString;
    this.saveVCard();
  }

  // Get all vCard data for XML generation
  getData(): VCardData {
    return { ...this.vcardData };
  }

  // Legacy getters for backward compatibility
  getAvatarUrl(): string | undefined {
    return this.vcardData.avatarUrl || this.vcardData.photo?.extval;
  }

  setAvatarUrl(avatarUrl: string) {
    this.vcardData.avatarUrl = avatarUrl;
    this.vcardData.photo = { extval: avatarUrl };
    this.saveVCard();
  }

  getAvatarData(): { mimeType?: string; data?: string } | undefined {
    if (!this.vcardData.avatarData && !this.vcardData.photo?.binval) return undefined;
    return {
      mimeType: this.vcardData.avatarMimeType || this.vcardData.photo?.type,
      data: this.vcardData.avatarData || this.vcardData.photo?.binval,
    };
  }

  setAvatarData(mimeType: string, data: string) {
    this.vcardData.avatarMimeType = mimeType;
    this.vcardData.avatarData = data;
    this.vcardData.photo = { type: mimeType, binval: data };
    this.saveVCard();
  }

  // Set multiple fields at once
  update(fields: Partial<VCardData>) {
    Object.assign(this.vcardData, fields);
    this.saveVCard();
  }
}
