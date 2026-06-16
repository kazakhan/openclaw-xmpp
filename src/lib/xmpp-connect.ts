import client from "@xmpp/client";
import crypto from "crypto";

export interface XmppConnectConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
}

// SECURITY (2.1.4): the random-resource strategy
// implemented in this file was, in v2.1.3, only used by
// the short-lived CLI tools (`vcard-cli.ts`,
// `whiteboard-cli.ts`).  The long-lived gateway
// connection in `src/startXMPP.ts` had its own inline
// `client({...})` call with a STABLE resource
// (`cfg.resource || jid.split("@")[0]`), which is what
// caused the `StreamError: conflict, 'Replaced by new
// connection'` cycle on networks where the XMPP server
// hadn't noticed the old TCP socket was dead yet.
//
// As of v2.1.4, the inline `getDefaultResource()` in
// `src/startXMPP.ts:60-83` uses the SAME random-resource
// strategy as this file.  This JSDoc exists so a future
// contributor doesn't "fix" the duplicate by deleting
// the random-resource code in startXMPP.ts (which would
// re-introduce the conflict cycle).
//
// If you want to refactor both call sites to share this
// function, the right move is to delete the inline
// `getDefaultResource()` in startXMPP.ts and import
// from this file instead.  Do not delete the random
// suffix in either place.

export function createXmppClient(config: XmppConnectConfig) {
  return client({
    service: config.service,
    domain: config.domain,
    username: config.jid.split("@")[0],
    password: config.password,
    // SECURITY (2.0.19, regression fix): the previous default
    // (`config.jid.split("@")[0]`) was the bare-JID local part, which
    // is NOT unique across reconnections.  Combined with the
    // @xmpp/client library's internal stream renegotiation (e.g.
    // when SM is established or an IQ crosses the wire), the XMPP
    // server would see a re-handshake as a new connection and kill
    // the old one with `StreamError { condition: 'conflict',
    // text: 'Replaced by new connection' }`.  The user-visible
    // symptom: after a single reconnect, messages stop being
    // dispatched for 2-3 minutes (until the watchdogs fire).
    //
    // We now generate a stable-prefix + 6-hex-char random suffix.
    // 16M possible values; collision requires two connections
    // from the same JID in the same millisecond — effectively
    // zero.  Operators who supply `config.resource` explicitly are
    // honoured verbatim (e.g. for operators who filter their
    // active-sessions list by resource).
    resource: config.resource || `openclaw-${crypto.randomBytes(3).toString("hex")}`,
  });
}
