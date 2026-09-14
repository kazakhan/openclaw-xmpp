import { client } from "@xmpp/client";
import os from "os";
import { installSaslResponseFix } from "./sasl-response.js";

export interface XmppConnectConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
}

// SECURITY (2.11.0): the random-resource strategy implemented in
// this file was, in v2.1.3, only used by the short-lived CLI tools
// (`vcard-cli.ts`, `whiteboard-cli.ts`).  v2.1.4 extended the same
// random resource to the long-lived gateway connection in
// `src/startXMPP.ts` to dodge the `StreamError: conflict, 'Replaced
// by new connection'` cycle on NAT networks where the server hadn't
// noticed the old TCP socket was dead yet.
//
// v2.11.0 reverts BOTH call sites to a STABLE, sanitized hostname
// resource so the bot's full JID is predictable (operator request).
// A stable resource is safe because v2.11.0 also re-enables keepalive
// (TCP setKeepAlive + XMPP whitespace) in startXMPP.ts so the socket
// no longer idles out.  Operators who supply `config.resource`
// explicitly are still honoured verbatim.  Keep these two call sites
// in sync; do not reintroduce a random suffix.

function sanitizeResource(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
}

export function createXmppClient(config: XmppConnectConfig) {
  const xmpp = client({
    service: config.service,
    domain: config.domain,
    username: config.jid.split("@")[0],
    password: config.password,
    // SECURITY (2.11.0): stable, sanitized hostname resource (e.g.
    // `archbox`).  See the module comment above.  Operators who
    // supply `config.resource` explicitly are honoured verbatim
    // (e.g. for filtering the active-sessions list by resource).
    resource: config.resource || sanitizeResource(os.hostname()) || "openclaw",
  });
  // SECURITY (2.15.4): fix @xmpp/sasl's malformed SASL <response/> stanza.
  installSaslResponseFix(xmpp);
  return xmpp;
}
