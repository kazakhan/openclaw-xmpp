import fs from "fs";
import path from "path";
import { xml } from "@xmpp/client";
import { log } from "./logger.js";
import type { StanzaElement, XmppClient } from "../types.js";

export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  headers?: Record<string, string>;
}

export interface UploadContext {
  xmpp: XmppClient;
  domain: string;
  dataDir?: string;
}

function discoItems(xmpp: XmppClient, jid: string, timeoutMs = 10000): Promise<string[] | null> {
  const id = `disco-items-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string[] | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      xmpp.off('stanza', handler);
      resolve(value);
    };
    const handler = (stanza: StanzaElement) => {
      if (stanza.attrs.id !== id) return;
      if (stanza.attrs.type === 'result') {
        const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
        const items = query?.getChildren('item') ?? [];
        finish(items.map((i: any) => i.attrs?.jid).filter(Boolean));
      } else {
        finish(null);
      }
    };
    xmpp.on('stanza', handler);
    xmpp.send(
      xml('iq', { type: 'get', to: jid, id },
        xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' }),
      ),
    ).catch(() => finish(null));
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function discoInfoHasUpload(xmpp: XmppClient, jid: string, timeoutMs = 6000): Promise<boolean> {
  const id = `disco-info-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      xmpp.off('stanza', handler);
      resolve(value);
    };
    const handler = (stanza: StanzaElement) => {
      if (stanza.attrs.id !== id) return;
      if (stanza.attrs.type === 'result') {
        const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#info');
        const features = query?.getChildren('feature') ?? [];
        finish(features.some((f: any) => f.attrs?.var === 'urn:xmpp:http:upload:0'));
      } else {
        finish(false);
      }
    };
    xmpp.on('stanza', handler);
    xmpp.send(
      xml('iq', { type: 'get', to: jid, id },
        xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' }),
      ),
    ).catch(() => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function discoverUploadService(xmpp: XmppClient, domain: string): Promise<string | null> {
  const items = await discoItems(xmpp, domain);
  if (!items || items.length === 0) return null;

  // Prefer a component that actually advertises XEP-0363 (not just one whose
  // JID happens to contain "upload").
  const named = items.filter((jid) => /upload|httpfile/i.test(jid));
  for (const jid of [...named, ...items]) {
    if (await discoInfoHasUpload(xmpp, jid)) {
      log.info(`upload: discovered service ${jid} (feature)`);
      return jid;
    }
  }
  if (named.length > 0) {
    log.info(`upload: discovered service ${named[0]} (name)`);
    return named[0];
  }
  return null;
}

/**
 * Resolve the HTTP Upload component: explicit config wins, then disco#items,
 * then the conventional `upload.<domain>` / `httpupload.<domain>` candidates.
 */
export async function resolveUploadService(
  xmpp: XmppClient,
  domain: string,
  configuredJid?: string | null,
): Promise<string | null> {
  const configured = configuredJid?.trim();
  if (configured) {
    log.info(`upload: using configured service ${configured}`);
    return configured;
  }
  const discovered = await discoverUploadService(xmpp, domain);
  if (discovered) return discovered;
  for (const candidate of [`upload.${domain}`, `httpupload.${domain}`]) {
    if (await discoInfoHasUpload(xmpp, candidate)) {
      log.info(`upload: using fallback service ${candidate}`);
      return candidate;
    }
  }
  log.warn(`upload: no HTTP Upload service found for ${domain}`);
  return null;
}

export async function requestUploadSlot(
  xmpp: XmppClient,
  domain: string,
  filename: string,
  size: number,
  _contentType?: string,
  cachedServiceJid?: string | null
): Promise<UploadSlot> {
  log.debug("upload slot requested", { filename, size });

  const targetJid = await resolveUploadService(xmpp, domain, cachedServiceJid ?? null);
  if (!targetJid) {
    throw new Error(`No HTTP Upload service available for domain ${domain || "(unknown)"}`);
  }
  log.info(`upload: requesting slot from ${targetJid} for ${filename} (${size} bytes)`);

  const finalTarget = targetJid;

  const iqId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const requestStanza = xml("iq", { type: "get", to: finalTarget, id: iqId },
    xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
  );

  return new Promise((resolve, reject) => {
    let responseReceived = false;
    // SECURITY (2.0.17, M5): the 30-second timeout used to leak
    // the timer handle.  Store the handle and clearTimeout() on
    // every resolve/reject path so the event loop can exit
    // promptly when the gateway is otherwise idle.
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };

    const handler = (stanza: StanzaElement) => {
      if (stanza.attrs.id === iqId && stanza.attrs.type === 'result') {
        responseReceived = true;
        xmpp.off('stanza', handler);
        cleanup();

        try {
          const slot = stanza.getChild("slot", "urn:xmpp:http:upload:0");
          if (!slot) {
            reject(new Error("No upload slot in response"));
            return;
          }

          const putElement = slot.getChild("put");
          const getElement = slot.getChild("get");
          const putUrl = putElement?.attrs?.url;
          const getUrl = getElement?.attrs?.url;

          if (!putUrl || !getUrl) {
            reject(new Error("Missing put or get URL in slot"));
            return;
          }

          const putHeaders: Record<string, string> = {};
          if (putElement) {
            const headerElements = putElement.getChildren("header");
            for (const header of headerElements) {
              const name = header.attrs.name;
              const value = header.text()?.trim();
              if (name && value) {
                putHeaders[name] = value;
              }
            }
          }

          log.info(`upload: slot obtained (put=${putUrl})`);
          resolve({ putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined });
        } catch (err) {
          reject(err);
        }
      } else if (stanza.attrs.id === iqId && stanza.attrs.type === 'error') {
        responseReceived = true;
        xmpp.off('stanza', handler);
        cleanup();
        const errorEl = stanza.getChild('error');
        let errorDetails = 'Unknown error';
        if (errorEl) {
          const errorText = errorEl.getChildText('text', 'urn:ietf:params:xml:ns:xmpp-stanzas');
          const errorCondition = errorEl.children.find((c: any) => c.name && c.name !== 'text')?.name;
          errorDetails = errorText || errorCondition || `Error type: ${errorEl.attrs.type}`;
        }
        log.warn(`upload: slot request failed: ${errorDetails}`);
        reject(new Error(`Upload slot request failed: ${errorDetails}`));
      }
    };

    xmpp.on('stanza', handler);

    xmpp.send(requestStanza).catch((err: any) => {
      if (!responseReceived) {
        responseReceived = true;
        xmpp.off('stanza', handler);
        cleanup();
        reject(err);
      }
    });

    timer = setTimeout(() => {
      if (!responseReceived) {
        responseReceived = true;
        xmpp.off('stanza', handler);
        reject(new Error("Upload slot request timeout"));
      }
    }, 30000);
  });
}

export async function uploadFileViaHTTP(filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> {
  log.debug("file upload via HTTP starting");

  try {
    // SECURITY: as of 2.0.15 we no longer rewrite https:// -> http://.  The
    // previous rewrite sent avatar / file-upload bodies in cleartext over
    // the network, even when the XEP-0363 upload slot advertised HTTPS.
    // The slot URL is used as-is so that the operator's TLS guarantees
    // are preserved end-to-end.  If the server returns an HTTP URL the
    // upload will still go through plain HTTP (operator misconfiguration),
    // but the plugin will never silently downgrade an HTTPS slot.
    const fileBuffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    // SECURITY (2.18.9): audio voice notes must advertise their real type so
    // Psi+ renders an inline player (mp3 is what the operator confirmed works).
    else if (ext === '.mp3' || ext === '.mpeg') contentType = 'audio/mpeg';
    else if (ext === '.ogg' || ext === '.oga' || ext === '.opus') contentType = 'audio/ogg';
    else if (ext === '.m4a' || ext === '.mp4') contentType = 'audio/mp4';
    else if (ext === '.wav') contentType = 'audio/wav';
    else if (ext === '.webm') contentType = 'audio/webm';
    else if (ext === '.aac') contentType = 'audio/aac';
    else if (ext === '.flac') contentType = 'audio/flac';

    const fetchHeaders: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (headers) {
      Object.assign(fetchHeaders, headers);
    }

    log.warn("HTTP upload URL: " + putUrl);
    log.warn("HTTP upload headers: " + JSON.stringify(fetchHeaders));
    try { new URL(putUrl); } catch (urlErr: any) {
      log.error("Invalid putUrl: " + (urlErr?.message || String(urlErr)));
    }
    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: fetchHeaders,
      body: fileBuffer,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `HTTP upload failed: ${response.status} ${response.statusText}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`,
      );
    }

    log.info(`upload: PUT ok (${response.status})`);
  } catch (err: any) {
    const details = { message: err?.message, code: err?.code, cause: err?.cause };
    log.error("File upload failed: " + JSON.stringify(details));
    throw err;
  }
}

export async function sendFileWithHTTPUpload(
  xmpp: any,
  to: string,
  filePath: string,
  domain: string,
  text?: string,
  isGroupChat?: boolean,
  dataDir?: string,
  cachedServiceJid?: string | null
): Promise<void> {
  try {
    const stats = await fs.promises.stat(filePath);
    const filename = path.basename(filePath);
    const size = stats.size;

    const slot = await requestUploadSlot(xmpp, domain, filename, size, undefined, cachedServiceJid);

    await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);

    if (dataDir) {
      const downloadsDir = path.join(dataDir, 'downloads');
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }
      const localPath = path.join(downloadsDir, filename);
      await fs.promises.copyFile(filePath, localPath);
      log.debug(`File saved locally to: ${localPath}`);
    }

    const messageType = isGroupChat ? "groupchat" : "chat";
    const message = xml("message", { type: messageType, to },
      text ? xml("body", {}, text) : null,
      xml("x", { xmlns: "jabber:x:oob" },
        xml("url", {}, slot.getUrl)
      )
    );

    await xmpp.send(message);
    log.debug("file sent via HTTP upload", { to });
  } catch (err) {
    log.error("Failed to send file via HTTP Upload: " + (err?.message || String(err)));
    throw err;
  }
}
