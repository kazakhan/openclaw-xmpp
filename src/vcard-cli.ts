import { xml } from "@xmpp/client";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { decryptPasswordFromConfig } from './security/encryption.js';
import { validators } from './security/validation.js';
import { Config } from './config.js';

interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
}

interface VCardName {
  family?: string;
  given?: string;
  middle?: string;
  prefix?: string;
  suffix?: string;
}

interface VCardPhone {
  types: string[];
  number: string;
}

interface VCardEmail {
  types: string[];
  userid: string;
}

interface VCardAddress {
  types: string[];
  pobox?: string;
  extadd?: string;
  street?: string;
  locality?: string;
  region?: string;
  pcode?: string;
  ctry?: string;
}

interface VCardOrg {
  orgname?: string;
  orgunit?: string[];
}

interface VCardPhoto {
  type?: string;
  binval?: string;
  extval?: string;
}

interface VCardData {
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

function loadXmppConfig(): XmppConfig {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
  
  try {
    const configData = require('fs').readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const xmppAccount = config.channels?.xmpp?.accounts?.default;
    
    if (xmppAccount) {
      let password: string;
      try {
        password = decryptPasswordFromConfig(xmppAccount);
      } catch (err) {
        password = xmppAccount.password || '';
      }
      
      return {
        service: xmppAccount.service || `xmpp://${xmppAccount.domain}:5222`,
        domain: xmppAccount.domain,
        jid: xmppAccount.jid,
        password: password
      };
    }
  } catch (e) {
  }
  
  throw new Error('XMPP configuration not found');
}

function parseVCard(vcardEl: any): VCardData {
  const data: VCardData = { version: "3.0" };
  if (!vcardEl) return data;

  // VERSION
  data.version = "3.0";

  // FN - Formatted Name
  const fn = vcardEl.getChild('FN');
  if (fn) data.fn = fn.text();

  // N - Structured Name
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

  // NICKNAME
  const nickname = vcardEl.getChild('NICKNAME');
  if (nickname) data.nickname = nickname.text();

  // PHOTO
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
    // Backward compatibility
    if (data.photo.extval) data.avatarUrl = data.photo.extval;
  }

  // BDAY
  const bday = vcardEl.getChild('BDAY');
  if (bday) data.bday = bday.text();

  // TEL - Phone numbers (multi-value)
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

  // EMAIL (multi-value)
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

  // ADR - Address (multi-value)
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

  // JABBERID
  const jabberid = vcardEl.getChild('JABBERID');
  if (jabberid) data.jabberid = jabberid.text();

  // MAILER
  const mailer = vcardEl.getChild('MAILER');
  if (mailer) data.mailer = mailer.text();

  // TZ - Timezone
  const tz = vcardEl.getChild('TZ');
  if (tz) data.tz = tz.text();

  // GEO
  const geo = vcardEl.getChild('GEO');
  if (geo) {
    const lat = geo.getChild('LAT');
    const lon = geo.getChild('LON');
    if (lat && lon) data.geo = { lat: lat.text(), lon: lon.text() };
  }

  // TITLE
  const title = vcardEl.getChild('TITLE');
  if (title) data.title = title.text();

  // ROLE
  const role = vcardEl.getChild('ROLE');
  if (role) data.role = role.text();

  // ORG
  const org = vcardEl.getChild('ORG');
  if (org) {
    const orgname = org.getChild('ORGNAME');
    const orgunit = org.getChild('ORGUNIT');
    data.org = {
      orgname: orgname ? orgname.text() : undefined,
      orgunit: orgunit ? [orgunit.text()] : undefined
    };
  }

  // LOGO
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

  // CATEGORIES
  const categories = vcardEl.getChild('CATEGORIES');
  if (categories) {
    const keywords = categories.getChildren('KEYWORD');
    if (keywords) data.categories = keywords.map((k: any) => k.text());
  }

  // NOTE
  const note = vcardEl.getChild('NOTE');
  if (note) data.note = note.text();

  // UID
  const uid = vcardEl.getChild('UID');
  if (uid) data.uid = uid.text();

  // URL
  const url = vcardEl.getChild('URL');
  if (url) data.url = url.text();

  // DESC
  const desc = vcardEl.getChild('DESC');
  if (desc) data.desc = desc.text();

  // REV
  const rev = vcardEl.getChild('REV');
  if (rev) data.rev = rev.text();

  // PRODID
  const prodid = vcardEl.getChild('PRODID');
  if (prodid) data.prodid = prodid.text();

  // SORT-STRING
  const sortString = vcardEl.getChild('SORT-STRING');
  if (sortString) data.sortString = sortString.text();

  return data;
}

function buildVCardStanza(data: VCardData, id: string) {
  const vCardXml = xml("vCard", { xmlns: "vcard-temp" }, []);

  // VERSION (required for vCard 3.0)
  vCardXml.append(xml("VERSION", {}, data.version || "3.0"));

  // FN - Formatted Name (required)
  if (data.fn) vCardXml.append(xml("FN", {}, data.fn));

  // N - Structured Name
  if (data.n) {
    const nXml = xml("N", {}, []);
    if (data.n.family) nXml.append(xml("FAMILY", {}, data.n.family));
    if (data.n.given) nXml.append(xml("GIVEN", {}, data.n.given));
    if (data.n.middle) nXml.append(xml("MIDDLE", {}, data.n.middle));
    if (data.n.prefix) nXml.append(xml("PREFIX", {}, data.n.prefix));
    if (data.n.suffix) nXml.append(xml("SUFFIX", {}, data.n.suffix));
    vCardXml.append(nXml);
  }

  // NICKNAME
  if (data.nickname) vCardXml.append(xml("NICKNAME", {}, data.nickname));

  // PHOTO
  if (data.photo) {
    const photoXml = xml("PHOTO", {}, []);
    if (data.photo.type) photoXml.append(xml("TYPE", {}, data.photo.type));
    if (data.photo.binval) photoXml.append(xml("BINVAL", {}, data.photo.binval));
    if (data.photo.extval) photoXml.append(xml("EXTVAL", {}, data.photo.extval));
    // Backward compatibility
    else if (data.avatarUrl) photoXml.append(xml("EXTVAL", {}, data.avatarUrl));
    vCardXml.append(photoXml);
  } else if (data.avatarUrl) {
    vCardXml.append(xml("PHOTO", {}, xml("EXTVAL", {}, data.avatarUrl)));
  }

  // BDAY
  if (data.bday) vCardXml.append(xml("BDAY", {}, data.bday));

  // TEL - Phone numbers (multi-value)
  if (data.tel) {
    data.tel.forEach(phone => {
      const telXml = xml("TEL", {}, []);
      phone.types.forEach(t => {
        if (t === 'HOME') telXml.append(xml("HOME", {}, []));
        else if (t === 'WORK') telXml.append(xml("WORK", {}, []));
        else if (t === 'VOICE') telXml.append(xml("VOICE", {}, []));
        else if (t === 'FAX') telXml.append(xml("FAX", {}, []));
        else if (t === 'CELL') telXml.append(xml("CELL", {}, []));
        else if (t === 'VIDEO') telXml.append(xml("VIDEO", {}, []));
        else if (t === 'PAGER') telXml.append(xml("PAGER", {}, []));
        else if (t === 'MSG') telXml.append(xml("MSG", {}, []));
        else if (t === 'BBS') telXml.append(xml("BBS", {}, []));
        else if (t === 'MODEM') telXml.append(xml("MODEM", {}, []));
        else if (t === 'ISDN') telXml.append(xml("ISDN", {}, []));
        else if (t === 'PCS') telXml.append(xml("PCS", {}, []));
        else if (t === 'PREF') telXml.append(xml("PREF", {}, []));
      });
      if (phone.number) telXml.append(xml("NUMBER", {}, phone.number));
      vCardXml.append(telXml);
    });
  }

  // EMAIL (multi-value)
  if (data.email) {
    data.email.forEach(email => {
      const emailXml = xml("EMAIL", {}, []);
      email.types.forEach(t => {
        if (t === 'HOME') emailXml.append(xml("HOME", {}, []));
        else if (t === 'WORK') emailXml.append(xml("WORK", {}, []));
        else if (t === 'INTERNET') emailXml.append(xml("INTERNET", {}, []));
        else if (t === 'PREF') emailXml.append(xml("PREF", {}, []));
        else if (t === 'X400') emailXml.append(xml("X400", {}, []));
      });
      if (email.userid) emailXml.append(xml("USERID", {}, email.userid));
      vCardXml.append(emailXml);
    });
  }

  // ADR - Address (multi-value)
  if (data.adr) {
    data.adr.forEach(adr => {
      const adrXml = xml("ADR", {}, []);
      adr.types.forEach(t => {
        if (t === 'HOME') adrXml.append(xml("HOME", {}, []));
        else if (t === 'WORK') adrXml.append(xml("WORK", {}, []));
        else if (t === 'POSTAL') adrXml.append(xml("POSTAL", {}, []));
        else if (t === 'PARCEL') adrXml.append(xml("PARCEL", {}, []));
        else if (t === 'DOM') adrXml.append(xml("DOM", {}, []));
        else if (t === 'INTL') adrXml.append(xml("INTL", {}, []));
        else if (t === 'PREF') adrXml.append(xml("PREF", {}, []));
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

  // JABBERID
  if (data.jabberid) vCardXml.append(xml("JABBERID", {}, data.jabberid));

  // MAILER
  if (data.mailer) vCardXml.append(xml("MAILER", {}, data.mailer));

  // TZ - Timezone
  if (data.tz) vCardXml.append(xml("TZ", {}, data.tz));

  // GEO
  if (data.geo) {
    const geoXml = xml("GEO", {}, []);
    if (data.geo.lat) geoXml.append(xml("LAT", {}, data.geo.lat));
    if (data.geo.lon) geoXml.append(xml("LON", {}, data.geo.lon));
    vCardXml.append(geoXml);
  }

  // TITLE
  if (data.title) vCardXml.append(xml("TITLE", {}, data.title));

  // ROLE
  if (data.role) vCardXml.append(xml("ROLE", {}, data.role));

  // ORG
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

  // LOGO
  if (data.logo) {
    const logoXml = xml("LOGO", {}, []);
    if (data.logo.type) logoXml.append(xml("TYPE", {}, data.logo.type));
    if (data.logo.binval) logoXml.append(xml("BINVAL", {}, data.logo.binval));
    if (data.logo.extval) logoXml.append(xml("EXTVAL", {}, data.logo.extval));
    vCardXml.append(logoXml);
  }

  // CATEGORIES
  if (data.categories && data.categories.length > 0) {
    const catXml = xml("CATEGORIES", {}, []);
    data.categories.forEach(cat => {
      if (cat) catXml.append(xml("KEYWORD", {}, cat));
    });
    vCardXml.append(catXml);
  }

  // NOTE
  if (data.note) vCardXml.append(xml("NOTE", {}, data.note));

  // UID
  if (data.uid) vCardXml.append(xml("UID", {}, data.uid));

  // URL
  if (data.url) vCardXml.append(xml("URL", {}, data.url));

  // DESC
  if (data.desc) vCardXml.append(xml("DESC", {}, data.desc));

  // REV (auto-set by server, but include if present)
  if (data.rev) vCardXml.append(xml("REV", {}, data.rev));

  // PRODID
  if (data.prodid) vCardXml.append(xml("PRODID", {}, data.prodid));

  // SORT-STRING
  if (data.sortString) vCardXml.append(xml("SORT-STRING", {}, data.sortString));

  return xml("iq", { type: "set", id }, vCardXml);
}

async function withConnection<T>(fn: (xmpp: any) => Promise<T>): Promise<T> {
  const config = loadXmppConfig();
  const { client } = await import('@xmpp/client');
  
  const xmpp = client({
    service: config.service,
    domain: config.domain,
    username: config.jid.split('@')[0],
    password: config.password
  });
  
  (xmpp as any).domain = config.domain;
  
  let error: Error | null = null;
  xmpp.on('error', (err: Error) => error = err);
  
  await xmpp.start();
  if (error) { await xmpp.stop(); throw error; }
  
  try {
    return await fn(xmpp);
  } finally {
    await xmpp.stop();
  }
}

export async function setVCard(field: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      (vcard as any)[field] = value;
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

const MAX_FILE_SIZE = Config.MAX_FILE_SIZE;

async function requestUploadSlot(xmpp: any, filename: string, size: number): Promise<{ putUrl: string; getUrl: string; headers?: Record<string, string> }> {
  const id = `upload-${Date.now()}`;
  const targetJid = xmpp.domain;
  
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    
    const handler = (stanza: any) => {
      if (stanza.attrs.id === id && stanza.attrs.type === 'result') {
        responseReceived = true;
        xmpp.off('stanza', handler);
        
        try {
          const slot = stanza.getChild('slot', 'urn:xmpp:http:upload:0');
          if (!slot) {
            reject(new Error('No upload slot in response'));
            return;
          }
          
          const putElement = slot.getChild('put');
          const getElement = slot.getChild('get');
          const putUrl = putElement?.attrs?.url;
          const getUrl = getElement?.attrs?.url;
          
          if (!putUrl || !getUrl) {
            reject(new Error('Missing put or get URL in slot'));
            return;
          }
          
          const putHeaders: Record<string, string> = {};
          if (putElement) {
            const headerElements = putElement.getChildren('header');
            for (const header of headerElements) {
              const name = header.attrs.name;
              const value = header.getText();
              if (name && value) {
                putHeaders[name] = value;
              }
            }
          }
          
          resolve({ putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined });
        } catch (err) {
          reject(err);
        }
      } else if (stanza.attrs.id === id && stanza.attrs.type === 'error') {
        responseReceived = true;
        xmpp.off('stanza', handler);
        const errorEl = stanza.getChild('error');
        let errorDetails = 'Unknown error';
        if (errorEl) {
          const errorText = errorEl.getChildText('text', 'urn:ietf:params:xml:ns:xmpp-stanzas');
          const errorCondition = errorEl.children.find((c: any) => c.name && c.name !== 'text')?.name;
          errorDetails = errorText || errorCondition || `Error type: ${errorEl.attrs.type}`;
        }
        reject(new Error(`Upload slot request failed: ${errorDetails}`));
      }
    };
    
    xmpp.on('stanza', handler);
    
    xmpp.send(xml("iq", { type: "get", id, to: targetJid },
      xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
    )).catch((err: any) => {
      if (!responseReceived) {
        xmpp.off('stanza', handler);
        reject(err);
      }
    });
    
    setTimeout(() => {
      if (!responseReceived) {
        xmpp.off('stanza', handler);
        reject(new Error('Upload slot request timeout'));
      }
    }, 30000);
  });
}

async function uploadFileViaHTTP(filePath: string, putUrl: string): Promise<void> {
  const httpPutUrl = putUrl.replace(/^https:\/\//, 'http://');
  const fileBuffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'application/octet-stream';
  if (ext === '.png') contentType = 'image/png';
  else if (ext === '.gif') contentType = 'image/gif';
  else if (ext === '.webp') contentType = 'image/webp';
  else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';

  const response = await fetch(httpPutUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': fileBuffer.length.toString() },
    body: fileBuffer
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }
}

async function publishAvatar(xmpp: any, imageUrl: string, mimeType: string, base64Data: string): Promise<boolean> {
  const config = loadXmppConfig();
  const bareJid = config.jid.split('/')[0];
  const hash = crypto.createHash('sha1').update(Buffer.from(base64Data, 'base64')).digest('hex');
  const size = Buffer.from(base64Data, 'base64').length;
  let success = false;

  try {
    // Publish metadata to urn:xmpp:avatar:metadata
    const metadataId = `avatar-meta-${Date.now()}`;
    const metadataHandler = (stanza: any) => {
      if (stanza.attrs.id === metadataId && stanza.attrs.type === 'result') {
        success = true;
      }
    };
    xmpp.on('stanza', metadataHandler);

    await xmpp.send(xml("iq", { type: "set", to: bareJid, id: metadataId },
      xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
        xml("publish", { node: "urn:xmpp:avatar:metadata" },
          xml("item", { id: hash },
            xml("metadata", { xmlns: "urn:xmpp:avatar:metadata" },
              xml("info", { bytes: size.toString(), id: hash, type: mimeType })
            )
          )
        )
      )
    ));
    await new Promise(r => setTimeout(r, 500));
    xmpp.off('stanza', metadataHandler);

    // Publish actual avatar data to urn:xmpp:avatar:data
    const dataId = `avatar-data-${Date.now()}`;
    const dataHandler = (stanza: any) => {
      if (stanza.attrs.id === dataId && stanza.attrs.type === 'result') {
        success = true;
      }
    };
    xmpp.on('stanza', dataHandler);

    await xmpp.send(xml("iq", { type: "set", to: bareJid, id: dataId },
      xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
        xml("publish", { node: "urn:xmpp:avatar:data" },
          xml("item", { id: hash },
            xml("data", { xmlns: "urn:xmpp:avatar:data" }, base64Data)
          )
        )
      )
    ));
    await new Promise(r => setTimeout(r, 500));
    xmpp.off('stanza', dataHandler);
  } catch (err) {
    console.error('[Avatar] PEP publish error:', err);
  }

  return success;
}

export async function setVCardAvatar(source: string): Promise<{ ok: boolean; error?: string; url?: string }> {
  let filePath: string;
  let imageUrl: string;
  let isUrlInput = false;

  try {
    if (validators.isValidUrl(source)) {
      isUrlInput = true;
      const tempDir = path.join(process.env.TEMP || process.env.TMP || '/tmp', 'openclaw-avatar');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const response = await fetch(source);
      if (!response.ok) {
        return { ok: false, error: `Download failed: ${response.status} ${response.statusText}` };
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const fileSize = parseInt(contentLength, 10);
        if (fileSize > MAX_FILE_SIZE) {
          return { ok: false, error: `File too large: ${fileSize} bytes` };
        }
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FILE_SIZE) {
        return { ok: false, error: `File too large: ${buffer.byteLength} bytes` };
      }

      const urlObj = new URL(source);
      let filename = path.basename(urlObj.pathname) || `avatar_${Date.now()}.jpg`;
      filename = validators.sanitizeFilename(filename);
      if (!validators.isSafePath(filename, tempDir)) {
        filename = `avatar_${Date.now()}.jpg`;
      }

      filePath = path.join(tempDir, filename);
      await fs.promises.writeFile(filePath, Buffer.from(buffer));
      imageUrl = source;
    } else if (fs.existsSync(source)) {
      filePath = source;
    } else {
      return { ok: false, error: 'File not found or invalid URL' };
    }
  } catch (err: any) {
    return { ok: false, error: err.message };
  }

  try {
    return await withConnection(async (xmpp) => {
      const stats = await fs.promises.stat(filePath);
      const size = stats.size;
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';

      const fileBuffer = await fs.promises.readFile(filePath);
      const base64Data = fileBuffer.toString('base64');

      if (!isUrlInput) {
        try {
          const slot = await requestUploadSlot(xmpp, filename, size);
          await uploadFileViaHTTP(filePath, slot.putUrl);
          imageUrl = slot.getUrl;
        } catch (uploadErr: any) {
          console.log(`[Avatar] HTTP Upload failed (${uploadErr.message}), embedding directly`);
        }
      }

      try {
        await publishAvatar(xmpp, imageUrl, mimeType, base64Data);
      } catch (pepErr: any) {
        console.log(`[Avatar] XEP-0084 publish failed (non-critical): ${pepErr.message}`);
      }

      const getId = `v1-${Date.now()}`;
      let response: any = null;
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);

      const vcard = parseVCard(response?.getChild('vCard'));
      (vcard as any).avatarUrl = imageUrl;
      (vcard as any).avatarBinval = base64Data;
      (vcard as any).avatarType = mimeType;

      const vcardId = `s1-${Date.now()}`;
      await xmpp.send(xml("iq", { type: "set", id: vcardId },
        xml("vCard", { xmlns: "vcard-temp" },
          vcard.fn ? xml("FN", {}, vcard.fn) : null,
          vcard.nickname ? xml("NICKNAME", {}, vcard.nickname) : null,
          vcard.url ? xml("URL", {}, vcard.url) : null,
          vcard.desc ? xml("DESC", {}, vcard.desc) : null,
          xml("PHOTO", {},
            xml("TYPE", {}, mimeType),
            xml("BINVAL", {}, base64Data),
            xml("EXTVAL", {}, imageUrl)
          )
        )
      ));
      await new Promise(r => setTimeout(r, 300));

      return { ok: true, url: imageUrl };
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function getVCard(): Promise<{ ok: boolean; data?: VCardData; error?: string }> {
  try {
    const result = await withConnection(async (xmpp) => {
      const id = `g1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === id && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      return parseVCard(response?.getChild('vCard'));
    });
    
    return { ok: true, data: result };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// Extended vCard set functions for complex fields

export async function setVCardName(
  family: string,
  given: string,
  middle?: string,
  prefix?: string,
  suffix?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      vcard.n = { family, given, middle, prefix, suffix };
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function addVCardPhone(
  types: string[],
  number: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.tel) vcard.tel = [];
      vcard.tel.push({ types, number });
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardPhone(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.tel && vcard.tel[index]) {
        vcard.tel.splice(index, 1);
      }
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function addVCardEmail(
  types: string[],
  userid: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.email) vcard.email = [];
      vcard.email.push({ types, userid });
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardEmail(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.email && vcard.email[index]) {
        vcard.email.splice(index, 1);
      }
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function addVCardAddress(
  types: string[],
  street: string,
  locality: string,
  region: string,
  pcode: string,
  ctry: string,
  pobox?: string,
  extadd?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.adr) vcard.adr = [];
      vcard.adr.push({ types, street, locality, region, pcode, ctry, pobox, extadd });
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardAddress(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.adr && vcard.adr[index]) {
        vcard.adr.splice(index, 1);
      }
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function setVCardOrg(
  orgname: string,
  ...orgunits: string[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      const getId = `v1-${Date.now()}`;
      let response: any = null;
      
      const handler = (stanza: any) => {
        if (stanza.attrs.id === getId && stanza.attrs.type === 'result') response = stanza;
      };
      xmpp.on('stanza', handler);
      
      await xmpp.send(xml("iq", { type: "get", id: getId }, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise(r => setTimeout(r, 800));
      xmpp.off('stanza', handler);
      
      const vcard = parseVCard(response?.getChild('vCard'));
      vcard.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };
      
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await new Promise(r => setTimeout(r, 300));
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
