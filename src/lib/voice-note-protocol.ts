// SECURITY (2.18.9): pure XMPP voice-note / media-share protocol helpers.
//
// Kept dependency-free of the plugin's runtime modules (only `@xmpp/client` and
// `node:path`) so `node --test` can import it directly.  The upload/send side
// lives in `voice-note.ts`.

import path from "node:path";
import { xml } from "@xmpp/client";

export function mimeForAudioExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".mp3":
    case ".mpeg":
      return "audio/mpeg";
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}

/** Add `?mode=stream` so Psi+ plays the file inline instead of downloading it. */
export function withStreamMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("mode", "stream");
    return u.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}mode=stream`;
  }
}

/** Normalize an inbound shared-media URL (http(s) only; drop mode/fragment). */
export function normalizeSharedMediaUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.searchParams.get("mode") === "stream") u.searchParams.delete("mode");
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Extract every HTTP(S) media source from a stanza: SIMS/XEP-0447
 * `<reference uri=…>` / `<url-data target=…>` and OOB `<url>`.
 */
export function extractSharedMediaUrls(stanza: any): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeSharedMediaUrl(value);
    if (normalized) found.add(normalized);
  };
  const visit = (el: any, depth = 0): void => {
    if (!el || typeof el !== "object" || depth > 8) return;
    const name = el.name;
    const attrs = el.attrs || {};
    if (name === "reference") add(attrs.uri);
    else if (name === "url-data") add(attrs.target);
    else if (name === "url") {
      const text = typeof el.text === "function" ? el.text() : "";
      add(text);
    }
    const kids = Array.isArray(el.children) ? el.children : [];
    for (const child of kids) visit(child, depth + 1);
  };
  visit(stanza);
  return [...found];
}

export interface SimsVoiceMessageParams {
  to: string;
  messageType: "chat" | "groupchat";
  caption?: string;
  url: string;
  filename: string;
  size: number;
  sha256Base64: string;
  mediaType: string;
}

/** Build the single `<message>` that carries the text plus the inline voice note. */
export function buildSimsVoiceMessage(params: SimsVoiceMessageParams): any {
  const { to, messageType, caption, url, filename, size, sha256Base64, mediaType } = params;
  const cleanCaption = (caption || "").trim();
  const body = cleanCaption ? `${cleanCaption}\n${url}` : url;
  const start = cleanCaption ? cleanCaption.length + 1 : 0;
  const end = start + url.length;

  const fileEl = xml(
    "file",
    { xmlns: "urn:xmpp:jingle:apps:file-transfer:5" },
    xml("name", {}, filename),
    xml("hash", { xmlns: "urn:xmpp:hashes:2", algo: "sha-256" }, sha256Base64),
    xml("media-type", {}, mediaType),
    xml("size", {}, String(size)),
  );

  const reference = xml(
    "reference",
    { xmlns: "urn:xmpp:reference:0", type: "data" },
    xml(
      "media-sharing",
      { xmlns: "urn:xmpp:sims:1" },
      fileEl,
      xml(
        "sources",
        {},
        xml("reference", { xmlns: "urn:xmpp:reference:0", type: "data", uri: url }),
      ),
    ),
  );

  const fallbackSims = xml(
    "fallback",
    { xmlns: "urn:xmpp:fallback:0", for: "urn:xmpp:sims:1" },
    xml("body", { start: String(start), end: String(end) }),
  );
  const fallbackOob = xml(
    "fallback",
    { xmlns: "urn:xmpp:fallback:0", for: "jabber:x:oob" },
    xml("body", { start: String(start), end: String(end) }),
  );
  const oob = xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, url));

  return xml(
    "message",
    { type: messageType, to },
    xml("body", {}, body),
    reference,
    fallbackSims,
    fallbackOob,
    oob,
  );
}

/** True when a media path is an audio file produced by TTS (OpenClaw names it `voice.<ext>`). */
export function isVoiceMediaPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (![".mp3", ".ogg", ".oga", ".opus", ".m4a", ".wav", ".webm", ".aac", ".flac"].includes(ext)) {
    return false;
  }
  return base === `voice${ext}` || /^voice[-_.]/.test(base) || /audio|voice|speech/.test(base);
}
