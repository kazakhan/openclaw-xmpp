// SECURITY (2.18.9): send a local audio file as an inline XMPP voice note.
//
// The wire format (XEP-0385 SIMS) and inbound URL extraction are pure helpers in
// `voice-note-protocol.ts` (testable under `node --test`).  This module adds the
// XEP-0363 HTTP upload + send side.

import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { log } from "./logger.js";
import { requestUploadSlot, uploadFileViaHTTP } from "./upload-protocol.js";
import { safeSend } from "./xmpp-utils.js";
import {
  buildSimsVoiceMessage,
  mimeForAudioExt,
  withStreamMode,
  isVoiceMediaPath,
} from "./voice-note-protocol.js";

export {
  buildSimsVoiceMessage,
  extractSharedMediaUrls,
  isVoiceMediaPath,
  mimeForAudioExt,
  normalizeSharedMediaUrl,
  withStreamMode,
} from "./voice-note-protocol.js";

/**
 * Transcode an audio file to mp3 with system ffmpeg.  Ollama's OpenAI-compatible
 * `/v1/audio/speech` only emits wav/pcm, but Psi+ plays mp3 inline.  Returns the
 * temp mp3 path, or null when ffmpeg is unavailable/fails (caller falls back to
 * the original format).
 */
async function transcodeToMp3(inputPath: string): Promise<string | null> {
  const outPath = path.join(os.tmpdir(), `xmpp-voice-${crypto.randomUUID()}.mp3`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-sn",
    "-dn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-f",
    "mp3",
    outPath,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", args, { stdio: "ignore", windowsHide: true });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return outPath;
  } catch (err) {
    log.warn("voice note: ffmpeg mp3 transcode failed; sending original format", err);
    try {
      await fs.unlink(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Upload a local audio file (XEP-0363) and send it as a single SIMS voice-note
 * message (text + inline player).  Returns the public stream URL.
 */
export async function sendVoiceNote(params: {
  xmpp: any;
  to: string;
  filePath: string;
  caption?: string;
  isGroupChat?: boolean;
  cachedServiceJid?: string | null;
}): Promise<{ url: string }> {
  const { xmpp, to, filePath, caption, isGroupChat } = params;

  // SECURITY (2.18.11): `outbound` passes the plugin wrapper (which exposes the
  // real @xmpp client as `get xmpp()` but has no `.on`/`.off`, and whose
  // `send(to, body)` takes two args).  Normalize to the raw client so XEP-0363
  // discovery (`xmpp.on('stanza')`) and Element sends work.
  const raw = xmpp && typeof xmpp.on === "function" ? xmpp : xmpp?.xmpp;
  if (!raw) throw new Error("XMPP client not available");

  // Prefer mp3 for inline playback (Psi+ plays mp3; Ollama emits wav/pcm).
  let uploadPath = filePath;
  let tempMp3: string | null = null;
  let ext = (path.extname(filePath) || ".mp3").toLowerCase();
  if (ext !== ".mp3") {
    const mp3 = await transcodeToMp3(filePath);
    if (mp3) {
      uploadPath = mp3;
      tempMp3 = mp3;
      ext = ".mp3";
    }
  }

  try {
    const stats = await fs.stat(uploadPath);
    const filename = `voice${ext}`;
    const mediaType = mimeForAudioExt(ext);
    const domain = String(to).replace(/^xmpp:/, "").split("@")[1]?.split("/")[0] || "";

    const slot = await requestUploadSlot(
      raw,
      domain,
      filename,
      stats.size,
      mediaType,
      params.cachedServiceJid ?? null,
    );
    await uploadFileViaHTTP(uploadPath, slot.putUrl, slot.headers);

    const url = withStreamMode(slot.getUrl);
    const buffer = await fs.readFile(uploadPath);
    const sha256Base64 = crypto.createHash("sha256").update(buffer).digest("base64");
    const messageType: "chat" | "groupchat" = isGroupChat ? "groupchat" : "chat";
    const target = isGroupChat
      ? String(to).replace(/^xmpp:/, "").split("/")[0]
      : String(to).replace(/^xmpp:/, "");

    const message = buildSimsVoiceMessage({
      to: target,
      messageType,
      caption,
      url,
      filename,
      size: stats.size,
      sha256Base64,
      mediaType,
    });

    await safeSend(raw, message);
    log.info("voice note sent", { to: target, mediaType, bytes: stats.size });
    return { url };
  } finally {
    if (tempMp3) {
      try {
        await fs.unlink(tempMp3);
      } catch {
        /* ignore */
      }
    }
  }
}
