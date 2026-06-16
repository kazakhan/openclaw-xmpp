// SECURITY (2.1.3, restore-old-design): extracted from src/liveness.ts
// (the 2.0.16-era liveness manager) into a small utility module.
// These two helpers are used by 42+ call sites in startXMPP.ts:
//
//   safeSend(xmpp, element, timeoutMs?) — timeout-safe wrapper around
//     xmpp.send().  Races the send against a setTimeout so a hung
//     TCP write (e.g. black-holed socket) settles deterministically
//     instead of blocking the caller forever.
//
//   findUnderlyingSocket(xmpp) — walks the @xmpp/connection ->
//     @xmpp/tls -> tls.TLSSocket -> net.Socket chain to find the
//     real TCP socket.  Used by a few call sites that need to call
//     sock.setKeepAlive() or sock.destroy() directly.
//
// The OLD design from D:\Downloads\xmppOLD used these helpers inline
// in startXmpp.ts (lines 18 and ~310 of that file).  This module is
// the same code, just extracted for clarity.

export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Timeout-safe wrapper around `xmpp.send()`.  The @xmpp/client
 * library does not apply a write timeout on stanza sends.  When the
 * underlying TCP socket is silently killed (e.g. by a NAT
 * idle-timeout, SIP ALG, or a TCP RST the OS hasn't surfaced to
 * user space yet), xmpp.send() can hang indefinitely.  This wrapper
 * races the send against a timeout so the caller always gets a
 * definitive settlement.
 *
 * The timer is cleared in a `finally` block to avoid leaking timers
 * when the send resolves before the timeout fires.
 */
export async function safeSend(
  xmpp: any,
  element: any,
  timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`safeSend: xmpp.send() timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([xmpp.send(element), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Walk the @xmpp/connection -> @xmpp/tls -> tls.TLSSocket -> net.Socket
 * chain to locate the real TCP socket.  Exposed for tests and for the
 * few call sites that need to call sock.setKeepAlive() or
 * sock.destroy() directly.
 */
export function findUnderlyingSocket(xmpp: any): any {
  let sock: any = (xmpp as any).socket;
  let depth = 0;
  while (sock && typeof sock.setKeepAlive !== "function") {
    sock = (sock as any).socket;
    depth++;
    if (depth > 8) return null;
  }
  return sock || null;
}
