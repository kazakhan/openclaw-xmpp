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
  "vcard-temp",
  // PEP notifications (XEP-0292 vCard4 + XEP-0084 avatar)
  "urn:xmpp:vcard4+notify",
  "urn:xmpp:avatar:metadata+notify",
  "urn:xmpp:avatar:data+notify"
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
  // SECURITY (2.1.3): these are kept for the custom scheduleReconnect
  // fallback in xmppClient.stop() and the gateway.  Primary
  // reconnection is handled by @xmpp/reconnect (delay 5000ms, set in
  // startXMPP.ts).  The OLD design from D:\Downloads\xmppOLD used
  // exactly these values.
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 60000,
  RECONNECT_BACKOFF_FACTOR: 2,

  // Keepalive (2.11.0): the v2.1.3 "restore old design" removed ALL
  // keepalive, which let NAT/firewall idle timers silently kill the
  // TCP socket every ~15-20 minutes.  @xmpp/reconnect then re-armed
  // with a fresh random resource, causing constant dropouts and the
  // "agent doesn't respond after reconnect" complaint.  v2.11.0
  // re-introduces a stable hostname resource AND keepalive (TCP-level
  // setKeepAlive + XMPP whitespace) so the connection stays alive and
  // the stable resource never trips the server "Replaced by new
  // connection" conflict.
  TCP_KEEPALIVE_MS: 20000,
  WHITESPACE_KEEPALIVE_MS: 25000,

  // ask_user (2.16.1): minimum timeout the plugin enforces via a
  // `before_tool_call` hook, so an XMPP round-trip has time to answer.
  // OpenClaw's own default is 900s (clamp 30-3600).
  ASK_USER_MIN_TIMEOUT_SECONDS: 900,

  // Presence / status (2.15.0).  Per-account overrides live in
  // `xmpp.accounts.<id>.presence`; these are the defaults.
  PRESENCE: {
    enabled: true,
    defaultShow: "available",
    defaultStatus: "",
    thinkingShow: "dnd",
    thinkingStatus: "Thinking…",
    toolShow: "dnd",
    toolStatus: "Running {tool}…",
    minIntervalSeconds: 5,
    manualTtlSeconds: 0,
    restoreOnReconnect: true,
  },
};

export type Config = typeof Config;
