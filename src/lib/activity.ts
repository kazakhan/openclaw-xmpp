// SECURITY (2.16.3): throttled transport-activity reporter.
//
// OpenClaw's channel health monitor restarts an account whose
// `lastTransportActivityAt` is older than 30 min (`stale-socket`).  The plugin
// reports activity on inbound stanzas, successful sends, and keepalive writes;
// this throttles those reports so a busy socket doesn't spam setStatus.

export const ACTIVITY_REPORT_INTERVAL_MS = 60_000;

/**
 * Returns a reporter that invokes `fn` at most once per `intervalMs`.
 * Returns `true` when it actually reported (handy for tests).
 */
export function createThrottledReporter(
  fn: (() => void) | undefined,
  intervalMs: number = ACTIVITY_REPORT_INTERVAL_MS,
  now: () => number = Date.now,
): () => boolean {
  let last = 0;
  return () => {
    if (!fn) return false;
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    try {
      fn();
    } catch {
      /* best-effort — never let activity reporting throw */
    }
    return true;
  };
}
