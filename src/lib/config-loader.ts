import fs from "fs";
import path from "path";
import { decryptPasswordFromConfig } from "../security/encryption.js";

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
