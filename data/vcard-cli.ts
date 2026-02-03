import { xml } from "@xmpp/client";
import path from "path";

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
}

function loadXmppConfig(): XmppConfig {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.clawdbot', 'clawdbot.json');
  
  try {
    const configData = require('fs').readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const xmppAccount = config.channels?.xmpp?.accounts?.default;
    
    if (xmppAccount) {
      return {
        service: xmppAccount.service || `xmpp://${xmppAccount.domain}:5222`,
        domain: xmppAccount.domain,
        jid: xmppAccount.jid,
        password: xmppAccount.password
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
    const uri = photo.getChild('URI');
    if (uri) data.avatarUrl = uri.text();
  }
  
  return data;
}

function buildVCardStanza(data: VCardData, id: string) {
  const vCardXml = xml("vCard", { xmlns: "vcard-temp" }, []);
  
  if (data.fn) vCardXml.append(xml("FN", {}, data.fn));
  if (data.nickname) vCardXml.append(xml("NICKNAME", {}, data.nickname));
  if (data.url) vCardXml.append(xml("URL", {}, data.url));
  if (data.desc) vCardXml.append(xml("DESC", {}, data.desc));
  if (data.avatarUrl) vCardXml.append(xml("PHOTO", {}, xml("URI", {}, data.avatarUrl)));
  
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
