import * as crypto from "crypto";

// XEP-0115 Entity Capabilities
const CAPS_IDENTITY = {
  category: "client",
  type: "bot",
  name: "OpenClaw AI Assistant"
};

const CAPS_FEATURES = [
  "http://jabber.org/protocol/caps",
  "http://jabber.org/protocol/disco#info",
  "http://jabber.org/protocol/muc",
  "http://jabber.org/protocol/si/profile/file-transfer",
  "http://jabber.org/protocol/bytestreams",
  "http://jabber.org/protocol/ibb",
  "http://jabber.org/protocol/sxe",
  "http://jabber.org/protocol/swb",
  "http://www.w3.org/2000/svg",
  "vcard-temp"
];

function computeCapsVer(): string {
  const parts: string[] = [];
  const idStr = `${CAPS_IDENTITY.category}/${CAPS_IDENTITY.type}//${CAPS_IDENTITY.name}`;
  parts.push(idStr);
  const sortedFeatures = [...CAPS_FEATURES].sort();
  parts.push(...sortedFeatures);
  const S = parts.map(p => p + "<").join("");
  return crypto.createHash("sha-1").update(S, "utf-8").digest("base64");
}

export const CapsInfo = {
  node: "https://github.com/anomalyco/openclaw",
  ver: computeCapsVer(),
  hash: "sha-1" as const,
  xmlns: "http://jabber.org/protocol/caps",
  identity: CAPS_IDENTITY,
  features: CAPS_FEATURES
};

export const Config = {
  // File Transfer Settings
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_CONCURRENT_TRANSFERS: 3,

  // Message Store Settings
  MAX_MESSAGES_PER_FILE: 256,
  MESSAGE_QUEUE_MAX_SIZE: 100,
  MESSAGE_CLEANUP_MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours

  // Rate Limiting
  RATE_LIMIT_MAX_REQUESTS: 10,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute

  // Session Timeouts
  IBB_SESSION_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  IBB_CLEANUP_INTERVAL_MS: 60 * 1000, // 1 minute

  // Whiteboard Settings
  WHITEBOARD_SESSION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
  WHITEBOARD_CLEANUP_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  WHITEBOARD_FORWARD_DELAY_MS: 2500, // 2.5 seconds

  // Logging
  DEBUG_LOG_FILE: 'cli-debug.log',

  // Security
  MAX_MESSAGE_BODY_SIZE: 64 * 1024,  // 64KB max inbound message body

  // Reconnection
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 60000,
  RECONNECT_BACKOFF_FACTOR: 2,
};

export type Config = typeof Config;
