import fs from "fs";
import path from "path";
import { decryptPasswordFromConfig } from "../security/encryption.js";

export function openclawConfigPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(home, ".openclaw", "openclaw.json");
}

/** Read the raw OpenClaw config (tts / media / models etc.). */
export function loadOpenclawConfigRaw(): any {
  const configPath = openclawConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

/** Persist the raw OpenClaw config (pretty JSON, atomic-ish write). */
export function saveOpenclawConfigRaw(config: any): void {
  const configPath = openclawConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, configPath);
}

export interface LoadedXmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  dataDir?: string;
  [key: string]: any;
}

export function loadXmppConfig(): LoadedXmppConfig {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const configPath = path.join(home, ".openclaw", "openclaw.json");

  if (!fs.existsSync(configPath)) {
    throw new Error("XMPP configuration not found at " + configPath);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const xmppAccount = config.channels?.xmpp?.accounts?.default;

  if (!xmppAccount) {
    throw new Error("XMPP account configuration not found in " + configPath);
  }

  let password: string;
  try {
    password = decryptPasswordFromConfig(xmppAccount);
  } catch {
    password = xmppAccount.password || "";
  }

  return {
    service: xmppAccount.service || "xmpp://localhost:5222",
    domain: xmppAccount.domain || "localhost",
    jid: xmppAccount.jid || "",
    password,
    dataDir: xmppAccount.dataDir,
  };
}
