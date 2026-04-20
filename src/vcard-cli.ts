import { xml } from "@xmpp/client";
import path from "path";
import fs from "fs";
import { decryptPasswordFromConfig } from './security/encryption.js';
import { validators } from './security/validation.js';
import { Config } from './config.js';
import { loadXmppConfig } from './lib/config-loader.js';
import { createXmppClient } from './lib/xmpp-connect.js';
import { log } from "./lib/logger.js";
import { parseVCard, buildVCardStanza, type VCardData } from "./lib/vcard-protocol.js";
import { requestUploadSlot, uploadFileViaHTTP } from "./lib/upload-protocol.js";

function saveVCardLocally(vcardData: VCardData): void {
  try {
    const config = loadXmppConfig();
    const dataDir = config.dataDir || path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'extensions', 'xmpp', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const vcardFile = path.join(dataDir, "xmpp-vcard.json");
    vcardData.rev = new Date().toISOString();
    fs.writeFileSync(vcardFile, JSON.stringify(vcardData, null, 2));
    log.debug("vCard saved locally");
  } catch (err) {
    log.error("vCard local save failed", err);
  }
}

async function withConnection<T>(fn: (xmpp: any) => Promise<T>): Promise<T> {
  const config = loadXmppConfig();
  const xmpp = createXmppClient(config);
  
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
      
      saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

const MAX_FILE_SIZE = Config.MAX_FILE_SIZE;

async function publishAvatar(xmpp: any, imageUrl: string, mimeType: string, base64Data: string): Promise<boolean> {
  const config = loadXmppConfig();
  const bareJid = config.jid.split('/')[0];
  const hash = crypto.createHash('sha1').update(Buffer.from(base64Data, 'base64')).digest('hex');
  const size = Buffer.from(base64Data, 'base64').length;
  let success = false;

  try {
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
    log.error('[Avatar] PEP publish error:', err);
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
          log.debug("avatar HTTP Upload failed, embedding directly");
        }
      }

      try {
        await publishAvatar(xmpp, imageUrl, mimeType, base64Data);
      } catch (pepErr: any) {
        log.debug(`avatar XEP-0084 publish failed (non-critical)`);
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

      saveVCardLocally(vcard);

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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
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
      
      saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
