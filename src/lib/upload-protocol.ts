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

export async function discoverUploadService(xmpp: XmppClient, domain: string): Promise<string | null> {
  const iqId = `disco-${Date.now()}`;

  return new Promise((resolve) => {
    let resolved = false;
    // SECURITY (2.0.17, M5): the 10-second timeout used to be left
    // unhandled — if the disco resolved early the timer kept the
    // event loop alive and fired 10s later to call xmpp.off() /
    // resolve(null) on an already-settled promise.  We now store the
    // handle and clearTimeout() on every path that resolves the
    // promise.
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };

    const handler = (stanza: StanzaElement) => {
      if (stanza.attrs.id === iqId && stanza.attrs.type === 'result') {
        resolved = true;
        xmpp.off('stanza', handler);
        cleanup();

        const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
        if (query) {
          const items = query.getChildren('item');
          for (const item of items) {
            const jid = item.attrs.jid;
            if (jid.includes('upload') || jid.includes('httpfile')) {
              resolve(jid);
              return;
            }
          }
        }
        resolve(null);
      } else if (stanza.attrs.id === iqId && stanza.attrs.type === 'error') {
        resolved = true;
        xmpp.off('stanza', handler);
        cleanup();
        // SECURITY (2.0.17, M6): explicit return so the
        // success-path's `jid.includes('upload')` loop above is
        // clearly unreachable from here.  Was previously missing,
        // which made the function harder to reason about.
        resolve(null);
        return;
      }
    };

    xmpp.on('stanza', handler);

    const discoStanza = xml("iq", { type: "get", to: domain, id: iqId },
      xml("query", { xmlns: "http://jabber.org/protocol/disco#items" })
    );

    xmpp.send(discoStanza).catch(() => {
      if (!resolved) {
        resolved = true;
        xmpp.off('stanza', handler);
        cleanup();
        resolve(null);
      }
    });

    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        xmpp.off('stanza', handler);
        resolve(null);
      }
    }, 10000);
  });
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

  let targetJid = cachedServiceJid;
  if (!targetJid) {
    targetJid = await discoverUploadService(xmpp, domain);
    if (!targetJid) {
      throw new Error("No HTTP Upload service available");
    }
  }

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

          log.debug("upload slot obtained");
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
      throw new Error(`HTTP upload failed: ${response.status} ${response.statusText}`);
    }

    log.debug("file uploaded successfully");
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
