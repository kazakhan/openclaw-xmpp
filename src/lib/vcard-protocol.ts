import { xml } from "@xmpp/client";
import type { StanzaElement } from "../types.js";

export interface VCardName {
  family?: string;
  given?: string;
  middle?: string;
  prefix?: string;
  suffix?: string;
}

export interface VCardPhone {
  types: string[];
  number: string;
}

export interface VCardEmail {
  types: string[];
  userid: string;
}

export interface VCardAddress {
  types: string[];
  pobox?: string;
  extadd?: string;
  street?: string;
  locality?: string;
  region?: string;
  pcode?: string;
  ctry?: string;
}

export interface VCardOrg {
  orgname?: string;
  orgunit?: string[];
}

export interface VCardPhoto {
  type?: string;
  binval?: string;
  extval?: string;
}

export interface VCardData {
  version?: string;
  fn?: string;
  n?: VCardName;
  nickname?: string;
  photo?: VCardPhoto;
  bday?: string;
  tel?: VCardPhone[];
  email?: VCardEmail[];
  adr?: VCardAddress[];
  jabberid?: string;
  mailer?: string;
  tz?: string;
  geo?: { lat?: string; lon?: string };
  title?: string;
  role?: string;
  org?: VCardOrg;
  logo?: VCardPhoto;
  categories?: string[];
  note?: string;
  uid?: string;
  url?: string;
  desc?: string;
  rev?: string;
  prodid?: string;
  sortString?: string;
  avatarUrl?: string;
  avatarMimeType?: string;
  avatarData?: string;
}

export function parseVCard(vcardEl: StanzaElement): VCardData {
  const data: VCardData = { version: "3.0" };
  if (!vcardEl) return data;

  data.version = "3.0";

  const fn = vcardEl.getChild('FN');
  if (fn) data.fn = fn.text();

  const n = vcardEl.getChild('N');
  if (n) {
    data.n = {
      family: n.getChildText('FAMILY'),
      given: n.getChildText('GIVEN'),
      middle: n.getChildText('MIDDLE'),
      prefix: n.getChildText('PREFIX'),
      suffix: n.getChildText('SUFFIX')
    };
  }

  const nickname = vcardEl.getChild('NICKNAME');
  if (nickname) data.nickname = nickname.text();

  const photo = vcardEl.getChild('PHOTO');
  if (photo) {
    const extval = photo.getChild('EXTVAL');
    const uri = photo.getChild('URI');
    const binval = photo.getChild('BINVAL');
    const type = photo.getChild('TYPE');
    data.photo = {};
    if (extval) data.photo.extval = extval.text();
    else if (uri) data.photo.extval = uri.text();
    else if (binval) data.photo.binval = binval.text();
    if (type) data.photo.type = type.text();
    if (data.photo.extval) data.avatarUrl = data.photo.extval;
  }

  const bday = vcardEl.getChild('BDAY');
  if (bday) data.bday = bday.text();

  const telElements = vcardEl.getChildren('TEL');
  if (telElements && telElements.length > 0) {
    data.tel = telElements.map((tel: any) => {
      const types: string[] = [];
      if (tel.getChild('HOME')) types.push('HOME');
      if (tel.getChild('WORK')) types.push('WORK');
      if (tel.getChild('VOICE')) types.push('VOICE');
      if (tel.getChild('FAX')) types.push('FAX');
      if (tel.getChild('CELL')) types.push('CELL');
      if (tel.getChild('VIDEO')) types.push('VIDEO');
      if (tel.getChild('PAGER')) types.push('PAGER');
      if (tel.getChild('MSG')) types.push('MSG');
      if (tel.getChild('BBS')) types.push('BBS');
      if (tel.getChild('MODEM')) types.push('MODEM');
      if (tel.getChild('ISDN')) types.push('ISDN');
      if (tel.getChild('PCS')) types.push('PCS');
      if (tel.getChild('PREF')) types.push('PREF');
      const number = tel.getChild('NUMBER');
      return { types, number: number ? number.text() : '' };
    });
  }

  const emailElements = vcardEl.getChildren('EMAIL');
  if (emailElements && emailElements.length > 0) {
    data.email = emailElements.map((email: any) => {
      const types: string[] = [];
      if (email.getChild('HOME')) types.push('HOME');
      if (email.getChild('WORK')) types.push('WORK');
      if (email.getChild('INTERNET')) types.push('INTERNET');
      if (email.getChild('PREF')) types.push('PREF');
      if (email.getChild('X400')) types.push('X400');
      const userid = email.getChild('USERID');
      return { types, userid: userid ? userid.text() : '' };
    });
  }

  const adrElements = vcardEl.getChildren('ADR');
  if (adrElements && adrElements.length > 0) {
    data.adr = adrElements.map((adr: any) => {
      const types: string[] = [];
      if (adr.getChild('HOME')) types.push('HOME');
      if (adr.getChild('WORK')) types.push('WORK');
      if (adr.getChild('POSTAL')) types.push('POSTAL');
      if (adr.getChild('PARCEL')) types.push('PARCEL');
      if (adr.getChild('DOM')) types.push('DOM');
      if (adr.getChild('INTL')) types.push('INTL');
      if (adr.getChild('PREF')) types.push('PREF');
      return {
        types,
        pobox: adr.getChildText('POBOX'),
        extadd: adr.getChildText('EXTADD'),
        street: adr.getChildText('STREET'),
        locality: adr.getChildText('LOCALITY'),
        region: adr.getChildText('REGION'),
        pcode: adr.getChildText('PCODE'),
        ctry: adr.getChildText('CTRY')
      };
    });
  }

  const jabberid = vcardEl.getChild('JABBERID');
  if (jabberid) data.jabberid = jabberid.text();

  const mailer = vcardEl.getChild('MAILER');
  if (mailer) data.mailer = mailer.text();

  const tz = vcardEl.getChild('TZ');
  if (tz) data.tz = tz.text();

  const geo = vcardEl.getChild('GEO');
  if (geo) {
    const lat = geo.getChild('LAT');
    const lon = geo.getChild('LON');
    if (lat && lon) data.geo = { lat: lat.text(), lon: lon.text() };
  }

  const title = vcardEl.getChild('TITLE');
  if (title) data.title = title.text();

  const role = vcardEl.getChild('ROLE');
  if (role) data.role = role.text();

  const org = vcardEl.getChild('ORG');
  if (org) {
    const orgname = org.getChild('ORGNAME');
    const orgunit = org.getChild('ORGUNIT');
    data.org = {
      orgname: orgname ? orgname.text() : undefined,
      orgunit: orgunit ? [orgunit.text()] : undefined
    };
  }

  const logo = vcardEl.getChild('LOGO');
  if (logo) {
    const extval = logo.getChild('EXTVAL');
    const binval = logo.getChild('BINVAL');
    const type = logo.getChild('TYPE');
    data.logo = {};
    if (extval) data.logo.extval = extval.text();
    if (binval) data.logo.binval = binval.text();
    if (type) data.logo.type = type.text();
  }

  const categories = vcardEl.getChild('CATEGORIES');
  if (categories) {
    const keywords = categories.getChildren('KEYWORD');
    if (keywords) data.categories = keywords.map((k: any) => k.text());
  }

  const note = vcardEl.getChild('NOTE');
  if (note) data.note = note.text();

  const uid = vcardEl.getChild('UID');
  if (uid) data.uid = uid.text();

  const url = vcardEl.getChild('URL');
  if (url) data.url = url.text();

  const desc = vcardEl.getChild('DESC');
  if (desc) data.desc = desc.text();

  const rev = vcardEl.getChild('REV');
  if (rev) data.rev = rev.text();

  const prodid = vcardEl.getChild('PRODID');
  if (prodid) data.prodid = prodid.text();

  const sortString = vcardEl.getChild('SORT-STRING');
  if (sortString) data.sortString = sortString.text();

  return data;
}

export function buildVCardStanza(data: VCardData, id: string): any {
  const vCardXml = xml("vCard", { xmlns: "vcard-temp" }, []);

  vCardXml.append(xml("VERSION", {}, data.version || "3.0"));

  if (data.fn) vCardXml.append(xml("FN", {}, data.fn));

  if (data.n) {
    const nXml = xml("N", {}, []);
    if (data.n.family) nXml.append(xml("FAMILY", {}, data.n.family));
    if (data.n.given) nXml.append(xml("GIVEN", {}, data.n.given));
    if (data.n.middle) nXml.append(xml("MIDDLE", {}, data.n.middle));
    if (data.n.prefix) nXml.append(xml("PREFIX", {}, data.n.prefix));
    if (data.n.suffix) nXml.append(xml("SUFFIX", {}, data.n.suffix));
    vCardXml.append(nXml);
  }

  if (data.nickname) vCardXml.append(xml("NICKNAME", {}, data.nickname));

  if (data.photo) {
    const photoXml = xml("PHOTO", {}, []);
    if (data.photo.type) photoXml.append(xml("TYPE", {}, data.photo.type));
    if (data.photo.binval) photoXml.append(xml("BINVAL", {}, data.photo.binval));
    if (data.photo.extval) photoXml.append(xml("EXTVAL", {}, data.photo.extval));
    else if (data.avatarUrl) photoXml.append(xml("EXTVAL", {}, data.avatarUrl));
    vCardXml.append(photoXml);
  } else if (data.avatarUrl) {
    vCardXml.append(xml("PHOTO", {}, xml("EXTVAL", {}, data.avatarUrl)));
  }

  if (data.bday) vCardXml.append(xml("BDAY", {}, data.bday));

  if (data.tel) {
    data.tel.forEach(phone => {
      const telXml = xml("TEL", {}, []);
      phone.types.forEach(t => {
        if (t === 'HOME') telXml.append(xml("HOME", {}, []));
        else if (t === 'WORK') telXml.append(xml("WORK", [], []));
        else if (t === 'VOICE') telXml.append(xml("VOICE", [], []));
        else if (t === 'FAX') telXml.append(xml("FAX", [], []));
        else if (t === 'CELL') telXml.append(xml("CELL", [], []));
        else if (t === 'VIDEO') telXml.append(xml("VIDEO", [], []));
        else if (t === 'PAGER') telXml.append(xml("PAGER", [], []));
        else if (t === 'MSG') telXml.append(xml("MSG", [], []));
        else if (t === 'BBS') telXml.append(xml("BBS", [], []));
        else if (t === 'MODEM') telXml.append(xml("MODEM", [], []));
        else if (t === 'ISDN') telXml.append(xml("ISDN", [], []));
        else if (t === 'PCS') telXml.append(xml("PCS", [], []));
        else if (t === 'PREF') telXml.append(xml("PREF", [], []));
      });
      if (phone.number) telXml.append(xml("NUMBER", {}, phone.number));
      vCardXml.append(telXml);
    });
  }

  if (data.email) {
    data.email.forEach(email => {
      const emailXml = xml("EMAIL", {}, []);
      email.types.forEach(t => {
        if (t === 'HOME') emailXml.append(xml("HOME", [], []));
        else if (t === 'WORK') emailXml.append(xml("WORK", [], []));
        else if (t === 'INTERNET') emailXml.append(xml("INTERNET", [], []));
        else if (t === 'PREF') emailXml.append(xml("PREF", [], []));
        else if (t === 'X400') emailXml.append(xml("X400", [], []));
      });
      if (email.userid) emailXml.append(xml("USERID", {}, email.userid));
      vCardXml.append(emailXml);
    });
  }

  if (data.adr) {
    data.adr.forEach(adr => {
      const adrXml = xml("ADR", {}, []);
      adr.types.forEach(t => {
        if (t === 'HOME') adrXml.append(xml("HOME", [], []));
        else if (t === 'WORK') adrXml.append(xml("WORK", [], []));
        else if (t === 'POSTAL') adrXml.append(xml("POSTAL", [], []));
        else if (t === 'PARCEL') adrXml.append(xml("PARCEL", [], []));
        else if (t === 'DOM') adrXml.append(xml("DOM", [], []));
        else if (t === 'INTL') adrXml.append(xml("INTL", [], []));
        else if (t === 'PREF') adrXml.append(xml("PREF", [], []));
      });
      if (adr.pobox) adrXml.append(xml("POBOX", {}, adr.pobox));
      if (adr.extadd) adrXml.append(xml("EXTADD", {}, adr.extadd));
      if (adr.street) adrXml.append(xml("STREET", {}, adr.street));
      if (adr.locality) adrXml.append(xml("LOCALITY", {}, adr.locality));
      if (adr.region) adrXml.append(xml("REGION", {}, adr.region));
      if (adr.pcode) adrXml.append(xml("PCODE", {}, adr.pcode));
      if (adr.ctry) adrXml.append(xml("CTRY", {}, adr.ctry));
      vCardXml.append(adrXml);
    });
  }

  if (data.jabberid) vCardXml.append(xml("JABBERID", {}, data.jabberid));
  if (data.mailer) vCardXml.append(xml("MAILER", {}, data.mailer));
  if (data.tz) vCardXml.append(xml("TZ", {}, data.tz));

  if (data.geo) {
    const geoXml = xml("GEO", {}, []);
    if (data.geo.lat) geoXml.append(xml("LAT", {}, data.geo.lat));
    if (data.geo.lon) geoXml.append(xml("LON", {}, data.geo.lon));
    vCardXml.append(geoXml);
  }

  if (data.title) vCardXml.append(xml("TITLE", {}, data.title));
  if (data.role) vCardXml.append(xml("ROLE", {}, data.role));

  if (data.org) {
    const orgXml = xml("ORG", {}, []);
    if (data.org.orgname) orgXml.append(xml("ORGNAME", {}, data.org.orgname));
    if (data.org.orgunit) {
      data.org.orgunit.forEach(unit => {
        if (unit) orgXml.append(xml("ORGUNIT", {}, unit));
      });
    }
    vCardXml.append(orgXml);
  }

  if (data.logo) {
    const logoXml = xml("LOGO", {}, []);
    if (data.logo.type) logoXml.append(xml("TYPE", {}, data.logo.type));
    if (data.logo.binval) logoXml.append(xml("BINVAL", {}, data.logo.binval));
    if (data.logo.extval) logoXml.append(xml("EXTVAL", {}, data.logo.extval));
    vCardXml.append(logoXml);
  }

  if (data.categories && data.categories.length > 0) {
    const catXml = xml("CATEGORIES", {}, []);
    data.categories.forEach(cat => {
      if (cat) catXml.append(xml("KEYWORD", {}, cat));
    });
    vCardXml.append(catXml);
  }

  if (data.note) vCardXml.append(xml("NOTE", {}, data.note));
  if (data.uid) vCardXml.append(xml("UID", {}, data.uid));
  if (data.url) vCardXml.append(xml("URL", {}, data.url));
  if (data.desc) vCardXml.append(xml("DESC", {}, data.desc));
  if (data.rev) vCardXml.append(xml("REV", {}, data.rev));
  if (data.prodid) vCardXml.append(xml("PRODID", {}, data.prodid));
  if (data.sortString) vCardXml.append(xml("SORT-STRING", {}, data.sortString));

  return xml("iq", { type: "set", id }, vCardXml);
}
