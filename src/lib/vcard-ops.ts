import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Config } from "../config.js";
import { validators } from "../security/validation.js";
import { log } from "./logger.js";
import { requestUploadSlot, uploadFileViaHTTP } from "./upload-protocol.js";
import type { VCardData } from "./vcard-protocol.js";
import type { VCard } from "../vcard.js";

// SECURITY (2.14.7): vCard operations run against the gateway's EXISTING
// XMPP connection.  Previously the `openclaw xmpp vcard` CLI opened a second
// connection with the same JID+resource as the gateway, so the server kicked
// the bot (`StreamError: conflict, 'Replaced by new connection'`).  These ops
// are invoked either in-process (via the live client wrapper) or over the
// `xmpp.vcard` gateway RPC; neither opens a new socket.

export interface VCardServerLike {
  queryVCardFromServer: (targetJid: string) => Promise<any>;
  updateVCardOnServer: (updates: any) => Promise<boolean>;
  publishAvatar: (filePath: string, imageUrl: string) => Promise<boolean>;
  publishVCard4: (data: VCardData) => Promise<boolean>;
  queryVCard4: (targetJid?: string) => Promise<VCardData | null>;
}

export interface VCardOpDeps {
  xmpp: any;
  vcardServer: VCardServerLike;
  vcard: VCard;
  dataDir?: string;
  domain?: string;
  bareJid: string;
}

export interface VCardOpResult {
  ok: boolean;
  data?: VCardData | any;
  error?: string;
  url?: string;
}

// Field aliases accepted by `vcard set` (2.14.6 parity).
const FIELD_ALIASES: Record<string, string> = {
  birthday: "bday",
  timezone: "tz",
  jabber: "jabberid",
  "sort-string": "sortString",
  sortstring: "sortString",
  sort: "sortString",
};

async function applySet(deps: VCardOpDeps, field: string, value: string): Promise<void> {
  const f = field.toLowerCase();
  let updates: Record<string, any>;
  if (f === "geo") {
    const parts = value.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    if (parts.length < 2) throw new Error("geo requires '<lat> <lon>'");
    updates = { geo: { lat: parts[0], lon: parts[1] } };
  } else if (f === "categories" || f === "category") {
    updates = { categories: value.split(",").map((s) => s.trim()).filter(Boolean) };
  } else {
    const key = FIELD_ALIASES[f] || field;
    updates = { [key]: value };
  }
  await deps.vcardServer.updateVCardOnServer(updates);
  await deps.vcard.update(updates);
}

async function applyAvatar(
  deps: VCardOpDeps,
  source: string,
): Promise<{ url?: string }> {
  // URL source: set PHOTO as an external value via vcard-temp.
  if (validators.isValidUrl(source)) {
    const updates = { photo: { extval: source }, avatarUrl: source };
    await deps.vcardServer.updateVCardOnServer(updates);
    await deps.vcard.update(updates);
    return { url: source };
  }

  if (!fs.existsSync(source)) {
    throw new Error("File not found or invalid URL");
  }

  const stats = await fsp.stat(source);
  const size = stats.size;
  if (size > Config.MAX_FILE_SIZE) {
    throw new Error(`File too large: ${size} bytes (max ${Config.MAX_FILE_SIZE})`);
  }

  const filename = path.basename(source);
  const ext = path.extname(source).toLowerCase();
  let mimeType = "image/jpeg";
  if (ext === ".png") mimeType = "image/png";
  else if (ext === ".gif") mimeType = "image/gif";
  else if (ext === ".webp") mimeType = "image/webp";

  const fileBuffer = await fsp.readFile(source);
  const base64Data = fileBuffer.toString("base64");

  let imageUrl: string | undefined;
  try {
    const slot = await requestUploadSlot(deps.xmpp, deps.domain || "", filename, size, mimeType);
    await uploadFileViaHTTP(source, slot.putUrl, slot.headers);
    imageUrl = slot.getUrl;
  } catch (uploadErr: any) {
    log.debug("avatar HTTP Upload failed, embedding directly");
  }

  if (imageUrl) {
    try {
      await deps.vcardServer.publishAvatar(source, imageUrl);
    } catch {
      log.debug("avatar XEP-0084 publish failed (non-critical)");
    }
  }

  const updates: Record<string, any> = {
    avatarBinval: base64Data,
    avatarType: mimeType,
  };
  if (imageUrl) updates.avatarUrl = imageUrl;
  await deps.vcardServer.updateVCardOnServer(updates);

  const photo: Record<string, any> = { type: mimeType, binval: base64Data };
  if (imageUrl) photo.extval = imageUrl;
  await deps.vcard.update({
    photo,
    avatarMimeType: mimeType,
    avatarData: base64Data,
    ...(imageUrl ? { avatarUrl: imageUrl } : {}),
  });

  return { url: imageUrl };
}

export async function runVCardOp(
  deps: VCardOpDeps,
  action: string,
  args: string[] = [],
): Promise<VCardOpResult> {
  try {
    switch (action) {
      case "get": {
        const data = await deps.vcardServer.queryVCardFromServer("");
        return { ok: true, data: data || {} };
      }
      case "set": {
        if (args.length < 1) return { ok: false, error: "set requires <field> <value>" };
        const field = args[0];
        const value = args.slice(1).join(" ");
        if (!value) return { ok: false, error: `missing value for ${field}` };
        await applySet(deps, field, value);
        return { ok: true };
      }
      case "avatar": {
        if (!args[0]) return { ok: false, error: "avatar requires <url-or-path>" };
        const { url } = await applyAvatar(deps, args[0]);
        return { ok: true, url };
      }
      case "name": {
        const [family, given, middle, prefix, suffix] = args;
        const updates = { n: { family, given, middle, prefix, suffix } };
        await deps.vcardServer.updateVCardOnServer(updates);
        await deps.vcard.update(updates);
        return { ok: true };
      }
      case "phone-add": {
        const [number, ...types] = args;
        if (!number) return { ok: false, error: "phone add requires <number>" };
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const tel = [...(current.tel || []), { types, number }];
        await deps.vcardServer.updateVCardOnServer({ tel });
        await deps.vcard.update({ tel });
        return { ok: true };
      }
      case "phone-remove": {
        const index = parseInt(args[0], 10);
        if (isNaN(index)) return { ok: false, error: "phone remove requires <index>" };
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const tel = [...(current.tel || [])];
        if (tel[index]) tel.splice(index, 1);
        await deps.vcardServer.updateVCardOnServer({ tel });
        await deps.vcard.update({ tel });
        return { ok: true };
      }
      case "email-add": {
        const [userid, ...types] = args;
        if (!userid) return { ok: false, error: "email add requires <address>" };
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const email = [...(current.email || []), { types, userid }];
        await deps.vcardServer.updateVCardOnServer({ email });
        await deps.vcard.update({ email });
        return { ok: true };
      }
      case "email-remove": {
        const index = parseInt(args[0], 10);
        if (isNaN(index)) return { ok: false, error: "email remove requires <index>" };
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const email = [...(current.email || [])];
        if (email[index]) email.splice(index, 1);
        await deps.vcardServer.updateVCardOnServer({ email });
        await deps.vcard.update({ email });
        return { ok: true };
      }
      case "address-add": {
        const [street, locality, region, pcode, ctry, ...types] = args;
        if (!street || !locality || !region || !pcode || !ctry) {
          return { ok: false, error: "address add requires <street> <city> <region> <postal> <country>" };
        }
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const adr = [...(current.adr || []), { types, street, locality, region, pcode, ctry }];
        await deps.vcardServer.updateVCardOnServer({ adr });
        await deps.vcard.update({ adr });
        return { ok: true };
      }
      case "address-remove": {
        const index = parseInt(args[0], 10);
        if (isNaN(index)) return { ok: false, error: "address remove requires <index>" };
        const current = (await deps.vcardServer.queryVCardFromServer("")) || {};
        const adr = [...(current.adr || [])];
        if (adr[index]) adr.splice(index, 1);
        await deps.vcardServer.updateVCardOnServer({ adr });
        await deps.vcard.update({ adr });
        return { ok: true };
      }
      case "org": {
        const [orgname, ...orgunits] = args;
        if (!orgname) return { ok: false, error: "org requires <orgname>" };
        const updates = { org: { orgname, orgunit: orgunits.length > 0 ? orgunits : undefined } };
        await deps.vcardServer.updateVCardOnServer(updates);
        await deps.vcard.update(updates);
        return { ok: true };
      }
      case "vcard4-get": {
        const data = await deps.vcardServer.queryVCard4();
        return { ok: true, data: data || {} };
      }
      case "vcard4-publish": {
        const data = await deps.vcard.getData();
        const published = await deps.vcardServer.publishVCard4(data);
        if (!published) return { ok: false, error: "vCard4 publish failed (no server ack)" };
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown vCard action: ${action}` };
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
