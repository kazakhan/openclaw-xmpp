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

interface VCardData {
  fn?: string;
  nickname?: string;
  url?: string;
  desc?: string;
  avatarUrl?: string;
  avatarBinval?: string;
  avatarType?: string;
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
  const data: VCardData = {};
  if (!vcardEl) return data;
  
  const fn = vcardEl.getChild('FN');
  const nickname = vcardEl.getChild('NICKNAME');
  const url = vcardEl.getChild('URL');
  const desc = vcardEl.getChild('DESC');
  const photo = vcardEl.getChild('PHOTO');
  
  if (fn) data.fn = fn.text();
  if (nickname) data.nickname = nickname.text();
  if (url) data.url = url.text();
  if (desc) data.desc = desc.text();
  if (photo) {
    // Support both URI (legacy) and EXTVAL (preferred)
    const extval = photo.getChild('EXTVAL');
    const uri = photo.getChild('URI');
    if (extval) data.avatarUrl = extval.text();
    else if (uri) data.avatarUrl = uri.text();
  }
  
  return data;
}

function buildVCardStanza(data: VCardData, id: string) {
  const vCardXml = xml("vCard", { xmlns: "vcard-temp" }, []);
  
  if (data.fn) vCardXml.append(xml("FN", {}, data.fn));
  if (data.nickname) vCardXml.append(xml("NICKNAME", {}, data.nickname));
  if (data.url) vCardXml.append(xml("URL", {}, data.url));
  if (data.desc) vCardXml.append(xml("DESC", {}, data.desc));
  if (data.avatarUrl) {
    // Use EXTVAL for URL reference (more compatible than URI)
    vCardXml.append(xml("PHOTO", {}, xml("EXTVAL", {}, data.avatarUrl)));
  }
  
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
