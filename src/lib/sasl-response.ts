// SECURITY (2.15.4): workaround for an @xmpp/sasl 0.13.6 bug.
//
// @xmpp/sasl builds the second leg of a multi-step SASL exchange as:
//   entity.send(xml("response", { xmlns: NS, mechanism: mech.name }, payload))
// RFC 6120 §6.4.2 defines <response/> with only `xmlns`; the extra
// `mechanism` attribute is illegal.  Prosody (and other strict servers) reject
// it with the SASL condition `malformed-request`, so authentication fails
// before the password is ever evaluated.
//
// Only multi-step mechanisms are affected: SCRAM-SHA-1 (server sends
// <challenge/>, client replies <response/>).  PLAIN is client-first and goes
// out via <auth/>, so it never hits the buggy branch.  Because @xmpp/client
// hardcodes the mechanism order (`{ scramsha1, plain, anonymous }`) and picks
// the first server-offered match, a server that advertises SCRAM-SHA-1 (as
// Prosody does) trips the bug — even though the password is correct.
//
// Fix: sanitize the outgoing <response/> at the transport boundary.  This lives
// in plugin code (not node_modules) so it survives reinstalls/updates, and does
// not force a mechanism (@xmpp/client's public API has no option for that).

export const SASL_NS = "urn:ietf:params:xml:ns:xmpp-sasl";

/**
 * Remove the illegal `mechanism` attribute from an outgoing SASL `<response/>`.
 * Returns true when an attribute was removed.  Never throws.
 */
export function stripSaslResponseMechanism(element: any): boolean {
  try {
    if (
      element &&
      element.name === "response" &&
      element.attrs &&
      element.attrs.mechanism !== undefined &&
      element.attrs.xmlns === SASL_NS
    ) {
      delete element.attrs.mechanism;
      return true;
    }
  } catch {
    /* never let a sanitizer failure block sending */
  }
  return false;
}

/**
 * Wrap `xmpp.send` so every outgoing SASL `<response/>` is corrected.
 * Idempotent (safe to call more than once).
 */
export function installSaslResponseFix(xmpp: any): void {
  if (!xmpp || typeof xmpp.send !== "function" || xmpp.__saslResponseFixed) {
    return;
  }
  const originalSend = xmpp.send.bind(xmpp);
  xmpp.send = (element: any, ...rest: any[]) => {
    stripSaslResponseMechanism(element);
    return originalSend(element, ...rest);
  };
  xmpp.__saslResponseFixed = true;
}
