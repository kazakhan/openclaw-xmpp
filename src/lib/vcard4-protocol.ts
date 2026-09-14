// SECURITY (2.14.5): XEP-0292 vCard4 over PEP.
//
// vCard4 (RFC 6350 XML) is a separate format from the legacy vcard-temp
// (XEP-0054).  This module builds/parses the `<vcard xmlns="urn:ietf:params:xml:ns:vcard-4.0">`
// payload published to the PEP node `urn:xmpp:vcard4` (feature
// `urn:xmpp:vcard4+notify`).  The avatar is published as a URL only
// (`<photo><uri>…</uri></photo>`), per the operator.

import { xml } from "@xmpp/client";
import type { VCardData } from "./vcard-protocol.js";

export const VCARD4_NS = "urn:ietf:params:xml:ns:vcard-4.0";
export const VCARD4_PEP_NODE = "urn:xmpp:vcard4";

const TYPE_PARAM = new Set([
  "home", "work", "cell", "voice", "fax", "video", "pager", "text",
  "textphone", "internet", "pref",
]);

function textProp(name: string, value?: string | null): any | null {
  return value ? xml(name, {}, xml("text", {}, value)) : null;
}

function typeParams(types?: string[]): any | null {
  const known = (types || []).map((t) => String(t).toLowerCase()).filter((t) => TYPE_PARAM.has(t));
  if (known.length === 0) return null;
  return xml("parameters", {}, known.map((t) => xml("type", {}, xml("text", {}, t))));
}

/**
 * Build a vCard4 payload element from VCardData.  Maps every available field.
 */
export function buildVCard4(data: VCardData): any {
  const kids: any[] = [];
  const push = (el: any) => { if (el) kids.push(el); };

  push(textProp("fn", data.fn));

  if (data.n && (data.n.family || data.n.given || data.n.middle || data.n.prefix || data.n.suffix)) {
    const n = xml("n", {}, []);
    if (data.n.family) n.append(xml("surname", {}, data.n.family));
    if (data.n.given) n.append(xml("given", {}, data.n.given));
    if (data.n.middle) n.append(xml("additional", {}, data.n.middle));
    if (data.n.prefix) n.append(xml("prefix", {}, data.n.prefix));
    if (data.n.suffix) n.append(xml("suffix", {}, data.n.suffix));
    push(n);
  }

  push(textProp("nickname", data.nickname));

  // Avatar: URL only.
  const avatarUrl = data.avatarUrl || data.photo?.extval;
  if (avatarUrl) push(xml("photo", {}, xml("uri", {}, avatarUrl)));
  else if (data.photo?.binval) push(xml("photo", {}, xml("data", {}, data.photo.binval)));

  if (data.bday) push(xml("bday", {}, xml("date", {}, data.bday)));
  if (data.url) push(xml("url", {}, xml("uri", {}, data.url)));

  const note = data.desc || data.note;
  push(textProp("note", note));
  if (data.desc && data.note && data.note !== data.desc) push(textProp("note", data.note));

  push(textProp("org", data.org?.orgname));
  push(textProp("title", data.title));
  push(textProp("role", data.role));
  push(textProp("tz", data.tz));

  if (data.tel) {
    for (const p of data.tel) {
      const el = xml("tel", {}, []);
      const params = typeParams(p.types);
      if (params) el.append(params);
      el.append(xml("uri", {}, `tel:${p.number}`));
      kids.push(el);
    }
  }

  if (data.email) {
    for (const e of data.email) {
      const el = xml("email", {}, []);
      const params = typeParams(e.types);
      if (params) el.append(params);
      el.append(xml("text", {}, e.userid));
      kids.push(el);
    }
  }

  if (data.adr) {
    for (const a of data.adr) {
      const el = xml("adr", {}, []);
      const params = typeParams(a.types);
      if (params) el.append(params);
      if (a.pobox) el.append(xml("pobox", {}, a.pobox));
      if (a.extadd) el.append(xml("ext", {}, a.extadd));
      if (a.street) el.append(xml("street", {}, a.street));
      if (a.locality) el.append(xml("locality", {}, a.locality));
      if (a.region) el.append(xml("region", {}, a.region));
      if (a.pcode) el.append(xml("code", {}, a.pcode));
      if (a.ctry) el.append(xml("country", {}, a.ctry));
      kids.push(el);
    }
  }

  if (data.categories && data.categories.length > 0) {
    const c = xml("categories", {}, []);
    for (const cat of data.categories) if (cat) c.append(xml("text", {}, cat));
    kids.push(c);
  }

  if (data.uid) push(xml("uid", {}, xml("text", {}, data.uid)));
  if (data.rev) push(xml("rev", {}, xml("timestamp", {}, data.rev)));
  push(textProp("prodid", data.prodid));

  return xml("vcard", { xmlns: VCARD4_NS }, kids);
}

/** Parse a vCard4 `<vcard>` element back into VCardData (for `get`). */
export function parseVCard4(vcardEl: any): VCardData {
  const data: VCardData = {};
  if (!vcardEl) return data;
  const t = (el: any, name: string): string | undefined =>
    el?.getChild?.(name)?.getChildText?.("text") || undefined;

  data.fn = t(vcardEl, "fn");
  data.nickname = t(vcardEl, "nickname");

  const n = vcardEl.getChild?.("n");
  if (n) {
    data.n = {
      family: n.getChildText("surname") || undefined,
      given: n.getChildText("given") || undefined,
      middle: n.getChildText("additional") || undefined,
      prefix: n.getChildText("prefix") || undefined,
      suffix: n.getChildText("suffix") || undefined,
    };
  }

  const photo = vcardEl.getChild?.("photo");
  if (photo) {
    const uri = photo.getChildText("uri");
    const bin = photo.getChildText("data");
    if (uri) { data.avatarUrl = uri; data.photo = { extval: uri }; }
    else if (bin) data.photo = { binval: bin };
  }

  const bday = vcardEl.getChild?.("bday");
  if (bday) data.bday = bday.getChildText("date") || bday.getChildText("date-and-or-time") || undefined;

  data.url = vcardEl.getChild?.("url")?.getChildText("uri") || undefined;
  data.desc = t(vcardEl, "note");
  data.org = vcardEl.getChild?.("org") ? { orgname: t(vcardEl, "org") } : undefined;
  data.title = t(vcardEl, "title");
  data.role = t(vcardEl, "role");
  data.tz = t(vcardEl, "tz");
  data.uid = t(vcardEl, "uid");

  const rev = vcardEl.getChild?.("rev");
  if (rev) data.rev = rev.getChildText("timestamp") || undefined;

  const tz2 = vcardEl.getChild?.("tel");
  if (tz2) {
    data.tel = (vcardEl.getChildren?.("tel") || []).map((el: any) => {
      const types = (el.getChild("parameters")?.getChildren("type") || []).map((tt: any) => tt.getChildText("text")).filter(Boolean);
      const uri = el.getChildText("uri") || "";
      return { types, number: uri.replace(/^tel:/, "") };
    });
  }
  if (vcardEl.getChild?.("email")) {
    data.email = (vcardEl.getChildren("email") || []).map((el: any) => ({
      types: (el.getChild("parameters")?.getChildren("type") || []).map((tt: any) => tt.getChildText("text")).filter(Boolean),
      userid: el.getChildText("text") || "",
    }));
  }
  if (vcardEl.getChild?.("adr")) {
    data.adr = (vcardEl.getChildren("adr") || []).map((el: any) => ({
      types: (el.getChild("parameters")?.getChildren("type") || []).map((tt: any) => tt.getChildText("text")).filter(Boolean),
      pobox: el.getChildText("pobox") || undefined,
      extadd: el.getChildText("ext") || undefined,
      street: el.getChildText("street") || undefined,
      locality: el.getChildText("locality") || undefined,
      region: el.getChildText("region") || undefined,
      pcode: el.getChildText("code") || undefined,
      ctry: el.getChildText("country") || undefined,
    }));
  }
  if (vcardEl.getChild?.("categories")) {
    data.categories = (vcardEl.getChildren("categories") || []).map((el: any) => el.getChildText("text")).filter(Boolean);
  }

  return data;
}
