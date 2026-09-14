// SECURITY (2.14.0): secure SFTP support.
//
// This re-introduces SFTP after it was removed in 2.0.15, but WITHOUT the
// original MITM vulnerability.  The old code used `hostVerifier: () => true`,
// which accepted any host key.  This implementation REQUIRES the operator to
// pin the server's host-key fingerprint and fails closed if it does not match
// (no silent accept, no insecure fallback).
//
// Auth reuses the (encrypted) XMPP password by default, or a separate
// `sftp.password`; the port defaults to 2222 and is configurable.

import { Client } from "ssh2";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { decryptPasswordFromConfig } from "./security/encryption.js";

export interface SftpConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  hostKeyFingerprint?: string;
  dataDir?: string;
}

export interface ResolvedSftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  hostKeyFingerprint: string;
  dataDir?: string;
}

export interface SftpResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Strip the `SHA256:`/`MD5:` prefix and any `=` padding, lower-cased. */
export function normalizeFingerprint(fp: string): string {
  return String(fp || "")
    .trim()
    .replace(/^(sha256|md5):/i, "")
    .replace(/=+$/, "")
    .toLowerCase();
}

/**
 * Verify a presented host key against the pinned fingerprint.
 * Supports OpenSSH `SHA256:<base64>` (recommended) and legacy `MD5:<hex>`
 * (colon-separated or not).  Returns false (fail closed) on any mismatch.
 */
export function verifyFingerprint(presentedKey: Buffer | string, expectedFp: string): boolean {
  const expected = normalizeFingerprint(expectedFp);
  if (!expected) return false;
  const keyBuf = Buffer.isBuffer(presentedKey) ? presentedKey : Buffer.from(String(presentedKey), "binary");
  const isMd5 = /^md5:/i.test(String(expectedFp).trim()) || /^[0-9a-f]{32}$/.test(expected.replace(/:/g, ""));
  try {
    if (isMd5) {
      const hex = crypto.createHash("md5").update(keyBuf).digest("hex");
      return hex === expected.replace(/:/g, "");
    }
    const b64 = crypto.createHash("sha256").update(keyBuf).digest("base64").replace(/=+$/, "").toLowerCase();
    return b64 === expected;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective SFTP settings from an account config.
 * Throws (fails closed) when SFTP is disabled or no host-key fingerprint is
 * configured — there is no way to run this insecurely.
 */
export function resolveSftpConfig(
  account: any,
  decryptedXmppPassword?: string,
): ResolvedSftpConfig {
  const sftp: SftpConfig = account?.sftp || {};
  if (sftp.enabled === false) throw new Error("SFTP is disabled for this account.");
  if (!sftp.hostKeyFingerprint || !String(sftp.hostKeyFingerprint).trim()) {
    throw new Error(
      "SFTP requires a pinned host key. Set channels.xmpp.accounts.default.sftp.hostKeyFingerprint " +
        "(e.g. SHA256:...) — refusing to connect without host key verification.",
    );
  }
  let password = decryptedXmppPassword || "";
  if (sftp.password) {
    password = sftp.password.startsWith("ENC:") ? decryptSftpPassword(sftp.password, account) : sftp.password;
  }
  return {
    host: sftp.host || account?.domain || "",
    port: Number(sftp.port || 2222),
    user: sftp.user || String(account?.jid || "").split("@")[0],
    password,
    hostKeyFingerprint: String(sftp.hostKeyFingerprint),
    dataDir: account?.dataDir,
  };
}

function decryptSftpPassword(enc: string, account: any): string {
  // Reuse the account's encryption key/salt (same as the XMPP password).
  try {
    return decryptPasswordFromConfig({ ...account, password: enc });
  } catch (err) {
    throw new Error(
      `Failed to decrypt sftp.password: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadSftpConfigFromDisk(): ResolvedSftpConfig {
  const home = os.homedir();
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(configPath)) throw new Error(`OpenClaw config not found: ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const account = config.channels?.xmpp?.accounts?.default;
  if (!account) throw new Error("XMPP account (channels.xmpp.accounts.default) not found");
  let decrypted = "";
  try {
    decrypted = decryptPasswordFromConfig(account);
  } catch {
    decrypted = account.password || "";
  }
  return resolveSftpConfig(account, decrypted);
}

function connectSftp(cfg: ResolvedSftpConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("error", (err: Error) => reject(err))
      .connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.user,
        password: cfg.password,
        readyTimeout: 15000,
        // SECURITY: pinned fingerprint, fail closed.
        hostVerifier: (key: Buffer) => verifyFingerprint(key, cfg.hostKeyFingerprint),
      });
  });
}

function withSftp<T>(
  cfg: ResolvedSftpConfig,
  fn: (sftp: any, done: (result: SftpResult<T>) => void) => void,
): Promise<SftpResult<T>> {
  return (async () => {
    let conn: Client | null = null;
    try {
      conn = await connectSftp(cfg);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return await new Promise<SftpResult<T>>((resolve) => {
      let settled = false;
      const finish = (result: SftpResult<T>) => {
        if (settled) return;
        settled = true;
        try { conn?.end(); } catch { /* ignore */ }
        resolve(result);
      };
      (conn as any).sftp((err: any, sftp: any) => {
        if (err) return finish({ ok: false, error: err.message });
        try {
          fn(sftp, finish);
        } catch (e: any) {
          finish({ ok: false, error: e?.message || String(e) });
        }
      });
    });
  })();
}

export async function sftpUpload(
  cfg: ResolvedSftpConfig,
  localPath: string,
  remoteName?: string,
): Promise<SftpResult<string>> {
  if (!fs.existsSync(localPath)) return { ok: false, error: `Local file not found: ${localPath}` };
  const remote = remoteName || path.basename(localPath);
  return withSftp<string>(cfg, (sftp, done) => {
    sftp.fastPut(localPath, remote, (err: any) => {
      if (err) return done({ ok: false, error: err.message });
      done({ ok: true, data: remote });
    });
  });
}

export async function sftpDownload(
  cfg: ResolvedSftpConfig,
  remoteName: string,
  localPath?: string,
): Promise<SftpResult<string>> {
  const downloadDir = cfg.dataDir
    ? path.join(cfg.dataDir, "downloads")
    : path.join(os.homedir(), ".openclaw", "extensions", "xmpp", "data", "downloads");
  const local = localPath || path.join(downloadDir, path.basename(remoteName));
  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
  } catch { /* ignore */ }
  return withSftp<string>(cfg, (sftp, done) => {
    sftp.fastGet(remoteName, local, (err: any) => {
      if (err) return done({ ok: false, error: err.message });
      done({ ok: true, data: local });
    });
  });
}

export async function sftpList(cfg: ResolvedSftpConfig, dir = "."): Promise<SftpResult<string[]>> {
  return withSftp<string[]>(cfg, (sftp, done) => {
    sftp.readdir(dir, (err: any, list: any[]) => {
      if (err) return done({ ok: false, error: err.message });
      done({ ok: true, data: (list || []).map((e) => e.filename) });
    });
  });
}

export async function sftpRemove(cfg: ResolvedSftpConfig, remoteName: string): Promise<SftpResult<string>> {
  return withSftp<string>(cfg, (sftp, done) => {
    sftp.unlink(remoteName, (err: any) => {
      if (err) return done({ ok: false, error: err.message });
      done({ ok: true, data: remoteName });
    });
  });
}
