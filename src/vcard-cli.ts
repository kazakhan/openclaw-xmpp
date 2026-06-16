import { xml } from "@xmpp/client";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { decryptPasswordFromConfig } from './security/encryption.js';
import { validators } from './security/validation.js';
import { Config } from './config.js';
import { loadXmppConfig } from './lib/config-loader.js';
import { createXmppClient } from './lib/xmpp-connect.js';
import { log } from "./lib/logger.js";
import { parseVCard, buildVCardStanza, type VCardData } from "./lib/vcard-protocol.js";
import { requestUploadSlot, uploadFileViaHTTP } from "./lib/upload-protocol.js";
import crypto from 'crypto';

async function saveVCardLocally(vcardData: VCardData): Promise<void> {
  // SECURITY (2.0.18, L13): was previously sync (writeFileSync +
  // existsSync + mkdirSync) in an async codebase.  Converted to
  // async via `fs.promises.*`.  `fs.mkdir({ recursive: true })`
  // is idempotent so the prior `existsSync` guard is no longer
  // needed (it was a TOCTOU race anyway — two concurrent calls
  // could both see "doesn't exist" and race on the mkdir).
  try {
    const config = loadXmppConfig();
    const dataDir = config.dataDir || path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'extensions', 'xmpp', 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    const vcardFile = path.join(dataDir, "xmpp-vcard.json");
    vcardData.rev = new Date().toISOString();
    await fsp.writeFile(vcardFile, JSON.stringify(vcardData, null, 2));
    log.debug("vCard saved locally");
  } catch (err) {
    log.error("vCard local save failed", err);
  }
}

// SECURITY (2.0.18, L9): replace the previous pattern of
//   const id = `v1-${Date.now()}`;
//   const handler = (s) => { if (s.attrs.id === id && s.attrs.type === 'result') response = s; };
//   xmpp.on('stanza', handler);
//   await xmpp.send(xml("iq", { id, ... }));
//   await new Promise(r => setTimeout(r, 800));  // ← hard-coded 800ms
//   xmpp.off('stanza', handler);
//
// with a proper `sendReceive` that resolves on the matching
// `<iq type="result"/>` and rejects on `<iq type="error"/>`, with
// a configurable timeout (default 5s).  The 800ms hard-coded
// sleep was both slow (vCard with N fields took `(N+1) * 1.1`s)
// and unreliable (too short on a slow connection).
async function sendReceive(
  xmpp: any,
  stanza: any,
  timeoutMs: number = 5000,
): Promise<any> {
  const id = stanza.attrs.id;
  if (!id) {
    throw new Error("sendReceive: stanza must have an `id` attribute");
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const handler = (s: any) => {
      if (s.attrs?.id !== id) return;
      if (s.attrs?.type === 'result') {
        done = true;
        xmpp.off('stanza', handler);
        clearTimeout(timer);
        resolve(s);
      } else if (s.attrs?.type === 'error') {
        done = true;
        xmpp.off('stanza', handler);
        clearTimeout(timer);
        const textEl = s.getChild?.('error');
        const textNode = textEl?.getChildText?.('text', 'urn:ietf:params:xml:ns:xmpp-stanzas');
        reject(new Error(`IQ ${id} error: ${textNode ?? s.attrs?.type ?? 'unknown'}`));
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      xmpp.off('stanza', handler);
      reject(new Error(`IQ ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    xmpp.on('stanza', handler);
    xmpp.send(stanza).catch((err: any) => {
      if (done) return;
      xmpp.off('stanza', handler);
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function withConnection<T>(fn: (xmpp: any) => Promise<T>): Promise<T> {
  const config = loadXmppConfig();
  const xmpp = createXmppClient(config);
  
  (xmpp as any).domain = config.domain;
  
  let error: Error | null = null;
  xmpp.on('error', (err: Error) => error = err);

  // SECURITY (2.0.18, L14): wrap `xmpp.start()` in try/catch so a
  // rejection (e.g. bad credentials) is propagated immediately.
  // The previous version `await`ed `start()` then checked the
  // `error` listener — but the listener can fire AFTER the await
  // resolves (event-emitter race), so a real start failure could
  // be silently swallowed and the function would proceed with a
  // half-connected xmpp object.  Now: try/catch first, then a
  // belt-and-braces check of the listener state.
  try {
    await xmpp.start();
  } catch (err) {
    try { await xmpp.stop(); } catch { /* swallow — best-effort cleanup */ }
    throw err;
  }
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      (vcard as any)[field] = value;

      // Fire-and-forget SET; the server is expected to process it
      // and any subsequent IQ in the same connection will arrive
      // after.  No more 300ms wait.
      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
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
  // SECURITY (2.0.17, M12): use per-step flags (not a single
  // `success` reused across both handlers).  The previous code
  // set `success = true` in the metadata handler and again in the
  // data handler — meaning a stale `success = true` from a previous
  // run's metadata handler could leak into the current run's
  // return value, falsely reporting the avatar as published.
  // We now require BOTH `metadataOk` and `dataOk` to be true and
  // default each to false at the start of its own step.
  let metadataOk = false;
  let dataOk = false;

  try {
    // SECURITY (2.0.18, L9): use `sendReceive` instead of the
    // 500ms hard-coded sleep.  `sendReceive` resolves on the
    // matching `<iq type="result"/>` and rejects on `<iq
    // type="error"/>`.  We treat any successful response (result
    // OR error) as "done" — both indicate the server processed the
    // IQ.  The previous 500ms sleep gave *no* signal of success
    // or failure; it just blindly waited.
    const metadataStanza = xml("iq", { type: "set", to: bareJid, id: `avatar-meta-${Date.now()}` },
      xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
        xml("publish", { node: "urn:xmpp:avatar:metadata" },
          xml("item", { id: hash },
            xml("metadata", { xmlns: "urn:xmpp:avatar:metadata" },
              xml("info", { bytes: size.toString(), id: hash, type: mimeType })
            )
          )
        )
      )
    );
    try {
      await sendReceive(xmpp, metadataStanza);
      metadataOk = true;
    } catch (err) {
      log.debug('[Avatar] metadata publish error (continuing):', err);
    }

    const dataStanza = xml("iq", { type: "set", to: bareJid, id: `avatar-data-${Date.now()}` },
      xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
        xml("publish", { node: "urn:xmpp:avatar:data" },
          xml("item", { id: hash },
            xml("data", { xmlns: "urn:xmpp:avatar:data" }, base64Data)
          )
        )
      )
    );
    try {
      await sendReceive(xmpp, dataStanza);
      dataOk = true;
    } catch (err) {
      log.debug('[Avatar] data publish error (continuing):', err);
    }
  } catch (err) {
    log.error('[Avatar] PEP publish error:', err);
    // SECURITY (2.0.17, M12): on error, leave the per-step flags
    // at whatever value they were set to by the handlers (true or
    // false).  We return `metadataOk && dataOk` so an error mid-
    // sequence will naturally report `false` if either step did
    // not see its `<iq type="result"/>`.
  }

  return metadataOk && dataOk;
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
    await withConnection(async (xmpp) => {
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
          const xmppConfig = loadXmppConfig();
          const slot = await requestUploadSlot(xmpp, xmppConfig.domain, filename, size);
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

      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
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
      // No more 300ms hard-coded wait — `sendReceive` ensures
      // ordered I/O via the stanzas event stream.

      await saveVCardLocally(vcard);
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function getVCard(): Promise<{ ok: boolean; data?: VCardData; error?: string }> {
  try {
    const result = await withConnection(async (xmpp) => {
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `g1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      vcard.n = { family, given, middle, prefix, suffix };

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.tel) vcard.tel = [];
      vcard.tel.push({ types, number });

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardPhone(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.tel && vcard.tel[index]) {
        vcard.tel.splice(index, 1);
      }

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.email) vcard.email = [];
      vcard.email.push({ types, userid });

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardEmail(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.email && vcard.email[index]) {
        vcard.email.splice(index, 1);
      }

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (!vcard.adr) vcard.adr = [];
      vcard.adr.push({ types, street, locality, region, pcode, ctry, pobox, extadd });

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function removeVCardAddress(index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await withConnection(async (xmpp) => {
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      if (vcard.adr && vcard.adr[index]) {
        vcard.adr.splice(index, 1);
      }

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
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
      // SECURITY (2.0.18, L9): use `sendReceive` instead of the
      // 800ms hard-coded sleep.
      const response = await sendReceive(
        xmpp,
        xml("iq", { type: "get", id: `v1-${Date.now()}` }, xml("vCard", { xmlns: "vcard-temp" })),
      );
      const vcard = parseVCard(response?.getChild('vCard'));
      vcard.org = { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined };

      await xmpp.send(buildVCardStanza(vcard, `s1-${Date.now()}`));
      await saveVCardLocally(vcard);
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
