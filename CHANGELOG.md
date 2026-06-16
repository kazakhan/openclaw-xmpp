# Changelog

All notable changes to the OpenClaw XMPP plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.4] - 2026-06-16

**MUC rejoin conflict fix + groupchat "Dispatch SUCCESS
but no reply" fix — closes two real bugs on the broken
PC.**

After upgrading to 2.1.3, the operator's "other" PC
still saw two issues that 2.1.3's restore-old-design
did not address:

1. After ~40 minutes idle, the framework's
   health-monitor declared the connection "stale" and
   triggered a restart. The new connection came up
   with the SAME full JID (`bot@kazakhan.com/<resource>`)
   that the server still had on file, and the server
   kicked the new connection with
   `StreamError { condition: 'conflict', text: 'Replaced
   by new connection' }`. The library's
   `@xmpp/reconnect` tried again with the same full
   JID. The cycle repeated every 5 seconds forever.
2. The wrapper's `joinRoom()` set `joinedRooms` /
   `roomNicks` BEFORE the server confirmed the MUC
   presence. After a reconnect, the bot thought it was
   in the room and sent the reply, but the server
   silently dropped it because the bot was not actually
   a participant. The agent saw `Dispatch SUCCESS for
   stockee@conference` but the user never received a
   reply.

2.1.4 fixes both.

### Fix R1 (root cause of the conflict cycle) — random resource per `startXmpp()` call

**File:** `src/startXMPP.ts` (lines 60-83, `getDefaultResource`)

The previous default
(`cfg?.resource || cfg?.jid?.split("@")[0] || "openclaw"`)
was a STABLE resource. When the XMPP server still had
the old session in its active-connections list (which
happens when the server hasn't noticed the old TCP
socket is dead yet, e.g. NAT idle-timeout), the new
connection with the same full JID was kicked as a
duplicate.

The new default is
`openclaw-${crypto.randomBytes(3).toString("hex")}` —
a stable prefix plus a 6-hex-char random suffix per
`startXmpp()` call. 16M possible values; collision
requires two connections from the same JID in the same
millisecond, which is effectively zero. Explicit
`cfg.resource` is honoured verbatim (operator opt-in;
see the JSDoc at `src/lib/xmpp-connect.ts:5-30`).

Effect: every reconnect has a fresh full JID, so the
XMPP server treats it as a new session and never
raises "Replaced by new connection". The auto-join
callback in the gateway's `onOnline` re-joins MUC
rooms with the new full JID, so MUC participation is
restored automatically.

### Fix R2 (root cause of the 30-second `xmpp.stop()` hang) — `socket.destroy()` fast path

**File:** `src/startXMPP.ts` (lines 2592-2613, `xmppClient.stop`)

When the framework's health-monitor calls
`stopAccount`, the wrapper's `stop()` calls
`xmpp.stop()` → `disconnect(timeout=30000)` →
`socket.end()` and waits up to 30 seconds for the
FIN to be ACKed. On a dead or half-dead TCP socket
(typical after a NAT idle-timeout), the FIN never
gets ACKed and the framework's auto-restart is
delayed by up to 30 seconds. By the time the new
`startAccount` runs, the XMPP server's old session is
still alive and the conflict kicks in.

The new wrapper calls
`findUnderlyingSocket(xmpp).destroy()` BEFORE
`xmpp.stop()`. This is a hard close: the stream-close
stanza is best-effort and the framework has already
decided to stop the plugin, so we don't need a
graceful close. The fast path is wrapped in
try/catch and logged at debug level.

Effect: `xmppClient.stop()` returns in milliseconds
instead of up to 30 seconds. The framework's 5-second
auto-restart now fires on schedule.

### Fix R3 (root cause of the "Dispatch SUCCESS but no reply" MUC race) — `joinRoom()` awaits server self-presence

**Files:**
- `src/startXMPP.ts` (lines 286-308, hoisted declarations of `joinedRooms` / `roomNicks` / `pendingJoins`)
- `src/startXMPP.ts` (lines 612-680, presence-stanza handler: resolve on status 110, reject on `type="error"`)
- `src/startXMPP.ts` (lines 2573-2700, `joinRoom` / `leaveRoom` wrapper)

The previous `joinRoom()` did `xmpp.send(presence)`,
then immediately `joinedRooms.add()` and
`roomNicks.set()`, then logged `"room joined"`. It did
NOT wait for the server to send back self-presence
(XEP-0045 status code 110). On a fresh connection this
was fine (the server confirms quickly). After a
reconnect, the MUC server might reject the join
(nick conflict, room full, banned, or the bot's
stale MUC session hadn't been cleaned up). The
wrapper's `joinedRooms.add()` ran regardless, so the
bot THOUGHT it was in the room and tried to send a
groupchat reply. The server silently dropped the
message because the bot was not actually a
participant.

The new `joinRoom()`:

1. Sends the MUC presence.
2. Registers a `pendingJoins` Promise BEFORE the
   send, so the presence-stanza handler (which fires
   async on the same tick after `safeXmppSend`
   resolves) can find the Promise.
3. Awaits the Promise. The Promise resolves when the
   server sends `<presence>` with status code 110
   from `roomJid/<nick>` (XEP-0045 self-presence).
   The Promise rejects when the server sends
   `<presence type="error">` (e.g. nick conflict) or
   after a 5-second timeout.
4. `joinedRooms.add()` and `roomNicks.set()` are now
   called by the status-110 handler, NOT by the
   wrapper. This is what closes the race.

Effect: the bot's `joinedRooms` set only contains
rooms the server has actually accepted the bot into.
Outbound groupchat messages for these rooms are
accepted by the server.

### Fix R4 (root cause of the dead-code in `gateway.startAccount`) — delete the `_lastInboundAt` de-dup

**File:** `src/gateway.ts` (lines 71-103 deleted)

The 2.0.20 hotfix added a "refuse to start a second
concurrent connection" guard in `gateway.startAccount`
that read `(existingXmpp as any)._lastInboundAt`. The
2.1.3 liveness-manager removal had already stopped
maintaining this field, so the guard read `undefined`
and computed `idleMs = +Infinity`, falling into the
"stale, tear down" branch — which is exactly the bug
the guard was meant to prevent.

The guard was removed entirely. Concurrent-start
protection is now provided by:
1. `stopAccount()` always removes the client from
   `xmppClients` before returning, so the framework's
   "stop then start" sequence never leaves a stale
   entry.
2. `startXmpp()` uses a unique resource per call
   (Fix R1), so even if a concurrent start slipped
   through, the XMPP server would not raise
   `StreamError: conflict` because the two connections
   have different full JIDs.
3. `xmppClient.stop()` now does a `socket.destroy()`
   fast path (Fix R2) so the framework's auto-restart
   doesn't hang for 30 seconds on a dead socket.

### Files changed

- `src/startXMPP.ts` — Fix R1 (random resource),
  Fix R2 (fast stop), Fix R3 (MUC status 110 wait).
  Hoisted `joinedRooms` / `roomNicks` / `pendingJoins`
  declarations to before the `xmpp.on("error" |
  "offline" | ...)` registrations so the offline
  handler can clean up `pendingJoins` (and so the
  join-timeout timers don't leak across a deliberate
  stop).
- `src/gateway.ts` — Fix R4 (remove dead
  `_lastInboundAt` de-dup).
- `src/lib/xmpp-connect.ts` — JSDoc cross-reference
  to the startXMPP.ts fix so future contributors don't
  delete the random-resource code in startXMPP.ts and
  re-introduce the conflict cycle.
- `tests/v2.1.4-muc-rejoin-conflict.test.ts` — NEW
  (5 describe blocks, 12 assertions).
- `package.json` — version bump to 2.1.4.
- `CHANGELOG.md` — this entry.

### Verification

- `npx tsc --noEmit` — expect no new typecheck
  errors.
- `node --test tests/v2.1.4-muc-rejoin-conflict.test.ts
  tests/v2.1.3-restore-old-design.test.ts
  tests/v2.1.0-groupchat-dispatch.test.ts
  tests/critical-fixes.test.ts
  tests/high-severity.test.ts` — expect all pass.

### Rollback

All changes backed up to `_backups/` with the
`-v2.1.4-pre` suffix:

- `_backups/startXMPP.ts.backup-20260616-224038-v2.1.4-pre`
- `_backups/gateway.ts.backup-20260616-224038-v2.1.4-pre`
- `_backups/xmpp-connect.ts.backup-20260616-224038-v2.1.4-pre`
- `_backups/package.json.backup-20260616-224038-v2.1.4-pre`
- `_backups/CHANGELOG.md.backup-20260616-224038-v2.1.4-pre`

To roll back to 2.1.3:

```bash
cp _backups/startXMPP.ts.backup-20260616-224038-v2.1.4-pre src/startXMPP.ts
cp _backups/gateway.ts.backup-20260616-224038-v2.1.4-pre src/gateway.ts
cp _backups/xmpp-connect.ts.backup-20260616-224038-v2.1.4-pre src/lib/xmpp-connect.ts
cp _backups/package.json.backup-20260616-224038-v2.1.4-pre package.json
cp _backups/CHANGELOG.md.backup-20260616-224038-v2.1.4-pre CHANGELOG.md
rm tests/v2.1.4-muc-rejoin-conflict.test.ts
```

## [2.1.3] - 2026-06-16

**RESTORE THE OLD DESIGN — the liveness manager and all
keepalive mechanisms were the bug, not the fix.**

The 2.0.16+ code (re-introduced in 2.1.0, partially fixed in
2.1.1 and 2.1.2) replaced a simpler, working design with a
liveness manager and 5 keepalive mechanisms.  The operator
confirmed that the OLD design from
`D:\Downloads\xmppOLD\src\startXmpp.ts` works perfectly on
Windows 11 and Linux (the plugin stays connected for
days/weeks), and 2.0.16+ is the regression.  2.1.3 restores
the OLD design.

### Symptom (2.0.16 through 2.1.2)

The XMPP connection dies, the liveness manager tries to
reconnect, but the reconnect handler tears down the LIVE
connection.  The bot stays "online" in the liveness
manager's state but the actual socket is dead, so the bot
doesn't respond to messages.  The log fills with
`iq-ping: send failed {}`, `socket disconnected (clean=true,
event=unknown, ...)`, `SM keepalive: <r/> write failed`, and
similar noise from the 5 keepalive mechanisms (TCP, SM
`<r/>`, IQ-ping, whitespace, socket-idle watchdog).

### Root cause (confirmed by reading
`D:\Downloads\xmppOLD\src\startXmpp.ts`)

The 2.0.16 code did two things the OLD design did not:

1. **Disabled `@xmpp/reconnect`** with
   `(xmpp as any).reconnect.stop()`.  The OLD design used
   the built-in reconnect with a 5-second delay
   (`(xmpp as any).reconnect.delay = 5000`).

2. **Added a `xmpp.on("disconnect", ...)` handler that
   triggered reconnection**.  This handler fires for EVERY
   socket close, including stale sockets from previous
   connections.  When the first connection's socket close
   fires AFTER the second connection is online (due to
   async timing in `@xmpp/connection`'s `_end()`), the
   disconnect handler calls `liveness.onOffline()` which
   triggers the R3 fast-fail path, which calls `xmpp.stop()`
   on the SECOND (live) connection.  The R3 fast-fail was
   designed to reconnect the current connection when it
   gets kicked, but the disconnect event for the previous
   connection fires AFTER the new one is online, so the
   R3 fast-fail tears down the wrong connection.

The combination of (1) and (2) is what broke the
connection.  The 2.1.1 and 2.1.2 patches tried to fix the
symptom (the disconnect handler not triggering reconnection,
the IQ-ping's broken send detection) but did not address
the root cause (the disconnect handler existing at all).

### What 2.1.3 does

**Restores the OLD design from
`D:\Downloads\xmppOLD\src\startXmpp.ts`**:

1. **Re-enable `@xmpp/reconnect`** with `(xmpp as any).reconnect.delay = 5000`.
   The library handles reconnection via its own internal
   disconnect listener, with sensible defaults.

2. **Remove the `xmpp.on("disconnect", ...)` handler**
   entirely.  This was the source of the "stale-disconnect
   tears down the live connection" bug.  `@xmpp/reconnect`
   already listens for disconnect internally; we don't
   need to double-handle it.

3. **Remove the liveness manager** (deletes
   `src/liveness.ts`).  The manager and its 5 keepalive
   mechanisms (TCP, SM `<r/>`, IQ-ping, whitespace,
   socket-idle watchdog) are all gone.

4. **Keep the `safeSend` and `findUnderlyingSocket` helpers** in
   a new file `src/lib/xmpp-utils.ts`.  These are used by
   42+ call sites in `startXMPP.ts` and don't have
   anything to do with the liveness manager.

5. **Remove the keepalive config** (`TCP_KEEPALIVE_*`,
   `SM_KEEPALIVE_*`, `IQ_PING_*`, `WHITESPACE_KEEPALIVE_*`,
   `SOCKET_IDLE_TIMEOUT_MS`) from `config.ts`.  The OLD
   config didn't have any of these.

6. **Delete the `v2.0.19` and `v2.0.20` test files**.
   They assert the keepalive and reconnection logic
   that we're removing.  New test file
   `tests/v2.1.3-restore-old-design.test.ts` asserts the
   OLD design is in place (no `xmpp.reconnect.stop()`,
   no disconnect handler, no liveness manager, no
   keepalive config, `@xmpp/reconnect.delay = 5000`).

### Files changed

- `src/liveness.ts` — DELETED
- `src/lib/xmpp-utils.ts` — NEW (extracted `safeSend` and
  `findUnderlyingSocket` from the deleted liveness.ts)
- `src/startXMPP.ts` — restored OLD design: re-enabled
  `@xmpp/reconnect`, removed the disconnect handler,
  removed the liveness manager, removed all `liveness.*`
  calls, removed the `_lastInboundAt` wrapper property
  (the gateway de-dup is moot with the OLD design since
  `@xmpp/reconnect` handles reconnects on the same xmpp
  instance), removed `xmppClientRef`, removed the
  `setLastError` capture in the error handler
- `src/config.ts` — removed `TCP_KEEPALIVE_*`,
  `SM_KEEPALIVE_*`, `IQ_PING_*`, `WHITESPACE_KEEPALIVE_*`,
  `SOCKET_IDLE_TIMEOUT_MS`; kept `RECONNECT_*` for the
  custom `scheduleReconnect` fallback in `xmppClient.stop`
  and the gateway
- `tests/v2.0.19-connection-resilience.test.ts` — DELETED
- `tests/v2.0.20-double-start-guard.test.ts` — DELETED
- `tests/v2.1.3-restore-old-design.test.ts` — NEW (15
  assertions across 5 describe blocks)
- `tests/high-severity.test.ts` — H6 describe block
  rewritten to assert the OLD design (no liveness
  manager, no `liveness.*` calls, `safeSend` is in
  `src/lib/xmpp-utils.ts`)

### Verification

- `npx tsc --noEmit` — no new typecheck errors (5
  pre-existing module-resolution errors are unchanged)
- `node --test tests/v2.1.3-restore-old-design.test.ts
  tests/high-severity.test.ts tests/critical-fixes.test.ts`
  — 64/64 pass

### Operator-visible change

After 2.1.3, the log will be MUCH cleaner.  All the
keepalive noise (IQ-ping, SM, whitespace, socket-idle)
is gone.  The disconnect handler's "socket disconnected
(clean=true, ...)" spam is gone.  The reconnect is
handled by `@xmpp/reconnect` with its built-in 5-second
delay (you can change it by editing the `reconnect.delay
= 5000` line in `startXMPP.ts:96`).

If the XMPP server kicks the connection (e.g. "Replaced
by new connection" conflict from another client), the
log will show:

```
[XMPP] error
[XMPP] connection error {StreamError: conflict, 'Replaced by new connection', ...}
(@xmpp/reconnect handles the reconnect after 5 seconds)
[XMPP] online as <bare-jid>/<new-resource>
[Presence with XEP-0115 caps sent, ver=...]
[vCard registered with server]
```

No more `iq-ping: send failed {}` (the IQ-ping is gone).
No more `SM keepalive: <r/> write failed` (the SM
keepalive is gone).  No more `socket-idle: no inbound
bytes for 120s, destroying socket` (the socket-idle
watchdog is gone).  No more `whitespace-keepalive: write
FAILED` (the whitespace keepalive is gone — but you
might still see `whitespace-keepalive: write succeeded`
debug logs from the 2.1.2 setting; these are harmless
and can be ignored).  The reconnect is reliable
because it uses the library's tested
`@xmpp/reconnect` instead of our custom logic.

### Rollback

All changes backed up to `_backups/` with the
`-restore-old-design` suffix.  To roll back to 2.1.2
(where the bug was):
```bash
cp _backups/src/liveness.ts.backup-*-restore-old-design src/liveness.ts
cp _backups/src/startXMPP.ts.backup-*-restore-old-design src/startXMPP.ts
cp _backups/config.ts.backup-*-restore-old-design src/config.ts
cp _backups/tests/v2.0.19-connection-resilience.test.ts.backup-*-restore-old-design \
   tests/v2.0.19-connection-resilience.test.ts
cp _backups/tests/v2.0.20-double-start-guard.test.ts.backup-*-restore-old-design \
   tests/v2.0.20-double-start-guard.test.ts
cp _backups/package.json.backup-*-restore-old-design package.json
cp _backups/CHANGELOG.md.backup-*-restore-old-design CHANGELOG.md
```

To roll back to 2.1.0 (the last version with the
`startXmpp.ts` (camelCase) from `D:\Downloads\xmppOLD`):
just use the OLD code in `D:\Downloads\xmppOLD` directly.

## [2.1.2] - 2026-06-16

**Keepalive rewrite — strip the broken IQ-ping, fix the SM
keepalive, enable the whitespace keepalive, fix the gateway
de-dup.**

The 2.1.1 patch fixed the *recovery* path (disconnect
handler now triggers reconnection, IQ-ping watchdog now
arms its timer before sending) but did not fix the
*detection* path.  The operator's log showed 12 `iq-ping:
send failed {}` lines per minute, the iq-ping watchdog
itself firing at 20s with the wrong "send failed" message
coming from stale liveness managers, and the gateway
de-dup still allowing concurrent connections because
`_lastInboundAt` was being read from the wrong place.

2.1.2 takes a different approach: **remove the
keepalive mechanisms that don't work, fix the ones that
do, and make the gateway de-dup actually fire.**

### What 2.1.2 removes

**The XEP-0199 IQ-ping watchdog** (`setupIqPingWatchdog` in
`src/liveness.ts`).  It never worked:

- The `safeSend(xmpp, pingIq)` call rejected immediately
  on a black-holed socket with an empty error `{}`.
- The pong-timeout watchdog couldn't recover because the
  send itself was the failure.
- The v2.1.1 "arm the timer before send" fix made the
  watchdog fire at 20s, but the recovery path still
  depended on the disconnect handler, and the operator's
  log showed the watchdog firing without a reconnect
  following.

Removed: `_iqPingTimer`, `_iqPingTimeoutTimer`,
`_lastPingId` state; `setupIqPingWatchdog` function
(~80 lines); all `safeSend` ping calls; all references
in `stopLivenessTimers`, `installSocketDataWatch`, and
`onOnline`.  Net deletion: ~110 lines from `liveness.ts`.

### What 2.1.2 fixes

**The XEP-0198 SM keepalive** (the `<r/>` every 25s).
The v2.0.18 implementation was:

```ts
(xmpp as any).write(xmppXml("r", { xmlns: "urn:xmpp:sm:3" }))
```

This passed an Element object to
`Connection.write(string)`, which calls
`this.socket.write(string, ...)`.  Passing an Element
object to a method that expects a string either failed
silently or wrote garbage.  The catch handler logged
"SM keepalive: <r/> write failed" every 25s, and the
keepalive never reached the server.

Fixed: use `xmpp.send(xmppXml("r", ...))` instead.
`xmpp.send()` sets `element.parent = this.root` and
calls `element.toString()` before invoking `this.write()`
(see `node_modules/@xmpp/connection/index.js:311-315`).

### What 2.1.2 enables

**The XEP-0198 whitespace keepalive** (the literal `" "`
every 30s).  Previously disabled by default
(`WHITESPACE_KEEPALIVE_INTERVAL_MS: 0`).  Per XEP-0198 §4,
receiving entities MUST NOT generate an error upon
receiving whitespace, and stream management acks
(`<a/>`) are unaffected.  The whitespace keepalive:

- Keeps NAT mappings warm (prevents the "online but
  black-holed" symptom on SIP-ALG / NAT idle-timeout
  networks).
- Gives the server a heartbeat so half-open sockets
  are detected faster than the OS-level TCP keepalive
  (which is a no-op on Windows with the default
  KeepAliveTime=2h registry value).

30s is well under typical NAT idle-timeouts (60-300s)
and well under Prosody's 14-minute read-timeout
(`advertised_idle_timeout = 14*60` in
`mod_c2s.lua:63-67`).

This matches what Prosody's own c2s module does: it
sends a literal `' '` on `c2s-read-timeout` to probe
the connection.  The client should mirror this.

### What 2.1.2 fixes (the real root cause)

**The gateway's startAccount de-dup** (the actual cause
of the repeated conflicts).  The v2.0.20 de-dup reads
`(existingXmpp as any)._lastInboundAt` from the
xmppClient wrapper, but the liveness manager kept
`_lastInboundAt` on its private state — not on the
wrapper.  So the read always returned `undefined`,
`idleMs` was always `+Infinity`, and the de-dup never
fired.  Over a session, the gateway accumulated 11+
liveness managers (each with their own iq-ping
interval), each firing its own "send failed" line every
60s, each racing the others for the connection.

Fixed: the liveness manager now exposes an
`onInboundBytes(ts)` callback in `LivenessManagerOpts`.
`startXMPP.ts` passes a callback that stamps
`xmppClient._lastInboundAt = ts` on every inbound byte.
The wrapper initialises `_lastInboundAt = 0` (epoch) so
a fresh connection is correctly classified as
"idle since forever" until the first real inbound byte
arrives.

With the de-dup actually firing, concurrent
`startXmpp` calls are properly refused, and the
server-side "Replaced by new connection" conflict
stops happening entirely.

### What 2.1.2 adds

**Stale liveness manager cleanup**.  The
`xmppClient.stop()` wrapper now calls
`liveness.destroy()` before `xmpp.stop()`.  This clears
all timers (SM keepalive, whitespace keepalive,
socket-idle watchdog, reconnect timer) on shutdown, so
the old manager's intervals don't keep firing on a
zombie xmpp object after the gateway has decided to
start a new one.

### Files changed

- `src/config.ts` — `WHITESPACE_KEEPALIVE_INTERVAL_MS`
  0 → 30000
- `src/liveness.ts` — removed `setupIqPingWatchdog`
  (~80 lines), fixed `setupSmKeepalive`
  (`xmpp.write(element)` → `xmpp.send(element)`),
  added `onInboundBytes` to `LivenessManagerOpts`,
  added `opts.onInboundBytes?.(ts)` call in the socket
  data handler
- `src/startXMPP.ts` — added `xmppClientRef.current`
  closure, stamped `_lastInboundAt: 0` on the
  xmppClient wrapper, passed `onInboundBytes` callback
  to `createLivenessManager`, added
  `liveness.destroy()` call in `xmppClient.stop()`
- `tests/v2.0.19-connection-resilience.test.ts` —
  replaced R2 (iq-ping) and 2.1.1-iq-ping describe
  blocks with new v2.1.2 describe blocks (SM keepalive
  fix, de-dup fix, xmppClient.stop cleanup, whitespace
  keepalive enabled)

### Verification

- `npx tsc --noEmit` — no new typecheck errors (5
  pre-existing module-resolution errors are unchanged).
- `node --test tests/v2.0.19-connection-resilience.test.ts
  tests/v2.0.20-double-start-guard.test.ts
  tests/high-severity.test.ts` — 55/55 pass.

### Operator-visible changes

- The 12 `iq-ping: send failed {}` lines per minute
  are GONE (the iq-ping is removed).
- The `SM keepalive: <r/> write failed` lines every
  25s are GONE (the SM keepalive now uses `xmpp.send`
  correctly).
- A new `whitespace-keepalive: write succeeded` /
  `whitespace-keepalive: write FAILED` debug log
  every 30s.  This is normal — it's the keepalive
  working.
- The `online as` log on reconnect should now be
  followed by a single `Scheduling reconnect in Xms`
  log, then a successful reconnect, with NO noise in
  between.
- The gateway's `startAccount: an existing connection
  has been alive for the last Ns — refusing to start
  a second concurrent connection` warning will now
  appear when (and only when) the existing connection
  is actually alive (< 30s since last inbound byte).
  This is the de-dup working.

### Rollback

All changes backed up to `_backups/` with the
`-keepalive-rewrite` suffix.  To roll back:
```bash
cp _backups/src/liveness.ts.backup-*-keepalive-rewrite src/liveness.ts
cp _backups/src/startXMPP.ts.backup-*-keepalive-rewrite src/startXMPP.ts
cp _backups/config.ts.backup-*-keepalive-rewrite src/config.ts
cp _backups/gateway.ts.backup-*-keepalive-rewrite src/gateway.ts
cp _backups/tests/v2.0.19-connection-resilience.test.ts.backup-*-keepalive-rewrite \
   tests/v2.0.19-connection-resilience.test.ts
cp _backups/tests/v2.0.20-double-start-guard.test.ts.backup-*-keepalive-rewrite \
   tests/v2.0.20-double-start-guard.test.ts
cp _backups/CHANGELOG.md.backup-*-keepalive-rewrite CHANGELOG.md
cp _backups/package.json.backup-*-keepalive-rewrite package.json
```

## [2.1.1] - 2026-06-16

**XMPP reconnection lifecycle fix — the disconnect handler
finally triggers recovery.**

If you were seeing the XMPP connection silently die and never
recover (the `iq-ping: send failed {}` lines followed by
`socket-idle: no inbound bytes for 120s, destroying socket` and
then nothing — messages stop being dispatched for 2-3 minutes
per disconnect), this fix is for you.

### Symptom (present in 2.1.0)

```
10:51:20 [xmpp] online as <bare-jid/resource>
10:51:20 [xmpp] error
10:51:20 [ERROR] [xmpp] connection error {
  name: 'StreamError', condition: 'conflict',
  text: 'Replaced by new connection', ...
}
10:51:20 [WARN] [xmpp] socket disconnected (clean=true, ...)
10:52:20 [WARN] [xmpp] iq-ping: send failed {}
10:53:20 [ERROR] [xmpp] socket-idle: no inbound bytes for 120s, destroying socket
10:54:20 [WARN] [xmpp] iq-ping: send failed {}
10:55:20 [WARN] [xmpp] iq-ping: send failed {}
...
```

The connection is dead after the first conflict, but the liveness
manager never reconnects. The IQ-ping watchdog fires forever
with empty errors, the socket-idle watchdog fires once and
destroys a null socket (no-op), and the user is left with no
incoming messages until the gateway process is restarted.

### Root cause (three layered bugs)

1. **`@xmpp/client@0.13.x` does not emit an `offline` event for
   stream errors.** The README is explicit: "`offline` indicates
   that `xmpp` disconnected and no automatic attempt to reconnect
   will happen (after calling `xmpp.stop()`)." The library's
   `_status("offline", el)` is only called from `stop()` (see
   `node_modules/@xmpp/connection/index.js:277`). For a conflict
   stream error, the event sequence is `error` → `disconnect`,
   with no `offline` ever fired. The v2.0.19 disconnect handler
   only logged, so the liveness manager never knew to reconnect.

2. **The R3 fast-fail regex was checking the wrong place.** The
   regex `/conflict|Replaced by new connection/i` was run
   against `lastDisconnectReason` (a free-form string set from
   the *socket close* event, which is the same string for
   every clean disconnect: `clean=true event=unknown
   code=undefined reason=(no message) idleAtDisconnect=Xs`).
   The actual conflict text lives in the `error` event payload
   (`StreamError` with `condition: 'conflict'`, `text: 'Replaced
   by new connection'`). The regex never matched, so the R3
   fast-fail was dead code. Confirmed by
   `docs/CODE_REVIEW.md §18.2` ("R3's regex never matched").

3. **The IQ-ping watchdog was permanently dead after the first
   failed send.** The pong-timeout timer was set AFTER
   `await safeSend(...)`. If the send itself failed (the
   "online but black-holed" case the operator was hitting — OS
   thinks socket is open, bytes aren't being routed), the
   timeout was never set, so the watchdog could never fire.
   Every subsequent interval would just re-warn with the same
   empty error and the connection would never recover.

### What 2.1.1 changes

**File: `src/liveness.ts`**

- Adds `_lastError`, `_lastErrorCondition`, and
  `_userInitiatedStop` to the liveness manager state.
- Adds `setLastError(err)`, `setUserInitiatedStop(v)` public
  methods, plus `lastError` and `lastErrorCondition` getters.
- Rewrites the R3 fast-fail branch in `onOffline()`: instead
  of pattern-matching the disconnect-reason string, it checks
  `m._lastErrorCondition === "conflict"` or
  `/Replaced by new connection/i.test(m._lastError?.text)`.
- Adds a `user-initiated-stop` guard at the top of
  `onOffline()`: if a deliberate `xmpp.stop()` was issued, the
  disconnect event is recognised and no reconnect is scheduled.
- Arms the IQ-ping pong-timeout BEFORE calling `safeSend` so
  the watchdog fires even if the send fails immediately. The
  catch block now destroys the socket directly when
  `xmpp.status === "online"` (the "online but black-holed"
  case) — cutting recovery time from 20s (pong-timeout) to <1s.
- The liveness manager's own `xmpp.stop()` calls
  (`scheduleReconnect`, R3 fast-fail) now set
  `_userInitiatedStop = true` BEFORE the stop so the resulting
  disconnect event is recognised as deliberate.

**File: `src/startXMPP.ts`**

- The `xmpp.on("error", ...)` handler now also calls
  `liveness.setLastError(err)` to capture the
  `StreamError` payload.
- The `xmpp.on("disconnect", ...)` handler now also calls
  `liveness.onOffline()`. Combined with the
  `user-initiated-stop` guard, this is safe for both the
  deliberate-stop path (no reconnect) and the
  conflict/unclean-disconnect path (triggers R3 fast-fail
  or scheduleReconnect).
- The `xmppClient.stop()` wrapper sets
  `liveness.setUserInitiatedStop(true)` BEFORE
  `xmpp.stop()` so the disconnect event is recognised.

**File: `tests/v2.0.19-connection-resilience.test.ts`**

- Updated R3 test to assert the new error-condition check
  (the regex test is replaced with a `_lastErrorCondition`
  test, with a clear comment about why the old test was
  wrong).
- Added the `_userInitiatedStop` short-circuit test.
- Added 2.1.1-R3 describe block: asserts the new
  `setLastError` / `setUserInitiatedStop` plumbing.
- Added 2.1.1-iq-ping describe block: asserts the timeout is
  armed BEFORE the send and the catch block destroys the
  socket on send failure.

### Out of scope (deferred — these are real bugs but not
required to stop the drop-out cycle)

- The `startAccount` de-dup reads `_lastInboundAt` from
  `existingXmpp` (the wrapper), but the liveness manager
  stores it on its private state. The de-dup never
  fires its `idleMs < 30_000` branch. The conflict itself
  is a symptom of THIS bug — the second `startXmpp` is not
  refused. Fixing this requires exposing `_lastInboundAt`
  on the xmppClient wrapper.
- The SM keepalive in `setupSmKeepalive` calls
  `xmpp.write(xmppXml("r", ...))` (an Element object)
  on a method that expects a string. The keepalive either
  silently fails or writes garbage. Should be
  `xmpp.write(xmppXml("r", ...).toString())` or
  `xmpp.send(xmppXml("r", ...))`.
- The TCP keepalive is a no-op on Windows (default
  `KeepAliveTime` registry value is 2h, overrides
  socket-level setting). Either patch the registry or
  enable the whitespace keepalive by default
  (`WHITESPACE_KEEPALIVE_INTERVAL_MS = 30000`).
- The `WHITESPACE_KEEPALIVE_INTERVAL_MS` is 0 (disabled)
  by default. This is the exact mechanism the comment in
  `config.ts` describes as needed for SIP/ALG-affected
  networks. Enabling it (e.g. 30s) would have caught the
  user's symptom earlier.

### Verification

- `npx tsc --noEmit` — no new typecheck errors (5
  pre-existing module-resolution errors are unchanged).
- `node --test tests/v2.0.19-connection-resilience.test.ts
  tests/v2.0.20-double-start-guard.test.ts
  tests/high-severity.test.ts` — 50/50 pass.

### Rollback

All changes backed up to `_backups/` with the
`-disconnect-fix` suffix. To roll back:
```bash
cp _backups/src/liveness.ts.backup-*-disconnect-fix src/liveness.ts
cp _backups/src/startXMPP.ts.backup-*-disconnect-fix src/startXMPP.ts
cp _backups/tests/v2.0.19-connection-resilience.test.ts.backup-*-disconnect-fix \
   tests/v2.0.19-connection-resilience.test.ts
cp _backups/CHANGELOG.md.backup-*-disconnect-fix CHANGELOG.md
cp _backups/package.json.backup-*-disconnect-fix package.json
```

## [2.1.0] - 2026-06-15

**Groupchat dispatch hygiene — closes a gap in the v2.0.16 H9
`isSystemMessage` skip-dispatch guard.**

If you were seeing intermittent groupchat dispatch failures
("I get a response for the first message but not follow-up messages"
in MUC rooms), this fix is for you.  Direct messages (1:1 chats)
are unaffected; they worked correctly in all prior versions.

### Symptom (still present in 2.0.20)

Groupchat dispatch would intermittently fail.  In a MUC room, the
operator's log would show:

```
08:36:46 [ERROR] DISPATCH_ENTERED: from=general@conference.kazakhan.com bodyLen=297 type=groupchat
08:36:52 [ERROR] DISPATCH_ENTERED: from=general@conference.kazakhan.com bodyLen=9 type=groupchat
08:37:00 [INFO] Dispatch SUCCESS for general@conference.kazakhan.com
08:37:00 [DEBUG] GC_SEND: post groupchat success=true
08:39:03 [agent/embedded] [llm-idle-timeout] ollama/gemma4:e4b produced no reply before the idle watchdog; retrying same model
```

The bot would join a room, receive a room-subject change
(`<message type="groupchat"><subject>...</subject></message>`
with no `<body>`), and the bot's stanza handler would forward
the subject as a 297-char "message" to the agent.  The agent's
LLM would consume that slot.  When the next real user message
arrived 6 seconds later, the LLM was either still busy (with
its previous response) or its slot was already spent.  The
follow-up user message would either time out (LLM idle watchdog
= 120 s for `gemma4:e4b`) or share the slot with the room
subject, leaving the user with no visible reply for the message
they actually typed.

### Why v2.0.20 (and all prior) did not fix it

The v2.0.16 H9 patch introduced the `isSystemMessage: true`
skip-dispatch guard at `src/gateway.ts:282-285`.  That guard
correctly short-circuits the agent's LLM dispatch for system
messages.  But the patch only added `isSystemMessage: true` to
the **SXE / whiteboard** paths (lines 1056 and 1281).  The
**room-subject** path at `src/startXMPP.ts:1011` was overlooked.

The MUC room-subject handler still called:

```ts
onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, {
  type: messageType,
  room: from.split('/')[0],
  nick: '',
  botNick,
  roomSubject: subject,
  mediaUrls: [],
  mediaPaths: [],
  // <-- missing: isSystemMessage: true
});
```

…which the gateway treated as a real user message.  The agent's
LLM was invoked.  The LLM had no way to know that the 297-char
`[Room Subject: ...]` string was metadata, not a question from
a human.  It would respond, generating visible room traffic
that confused the next user-message dispatch.

### What v2.1.0 changes

Single-line fix in `src/startXMPP.ts:1011`:

```diff
-            onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [] });
+            onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [], isSystemMessage: true });
```

The room-subject change is still **persisted** to the message
store (so the room topic is preserved in the conversation
history), but the agent's LLM is no longer invoked.  The
existing `gateway.ts:282-285` guard short-circuits the
dispatch and calls `markAsProcessed`.

The `isSystemMessage: true` audit was performed on **all 9
`onMessage(` call sites** in `src/startXMPP.ts`.  Only the
room-subject path (line 1011) was missing the flag.  The
SXE/whiteboard paths (1056, 1281) were already correct.  The
whiteboard-update paths (1151, 1301) and all real user-message
paths (1420, 1459, 2338, 2345) correctly do **not** set
`isSystemMessage: true` — they represent real user input that
the LLM should respond to.

### Operator-facing impact

- **DMs:** no change.  DM dispatch was never affected by this
  bug.
- **Groupchat:** room subject changes no longer pollute the
  LLM context.  Real user messages after a subject change
  now dispatch correctly.
- **First message vs. follow-up:** the operator's
  symptom (first works, follow-up doesn't) should be resolved
  for typical room activity.  If your model is slow enough
  that the LLM idle watchdog (120 s default) still fires on
  long responses, that is an OpenClaw-side config concern;
  see "Known issues" below.

### Known issues (NOT fixed by v2.1.0)

These are documented in `docs/CODE_REVIEW.md` §19.  They are
out of scope for the xmpp plugin; they require OpenClaw
configuration changes or larger architectural work.

1. **LLM idle timeout (120 s default).**  Slow models like
   `ollama/gemma4:e4b` can take longer than 120 s to produce
   a reply, at which point OpenClaw's `[agent/embedded]
   [llm-idle-timeout]` watchdog retries (or aborts).  Workaround:
   increase `Config.LLM_IDLE_TIMEOUT_MS` in OpenClaw, or use
   a faster model.

2. **Concurrent dispatches race on a single LLM.**  If two
   messages arrive in quick succession, both call
   `mod.dispatchInboundReplyWithBase` and both compete for the
   same LLM.  The second dispatch may time out or share the
   slot.  Workaround: serialize dispatches via a per-account
   queue.  This is a larger architectural change; tracked as
   a future enhancement.

### Backups

All edited files were backed up with a timestamped suffix
prior to the v2.1.0 changes:

- `src/startXMPP.ts` → `_backups/startXMPP.ts.backup-20260616-094802`
- `package.json` → `_backups/package.json.backup-20260616-094802`
- `CHANGELOG.md` → `_backups/CHANGELOG.md.backup-20260616-094802`
- `docs/CODE_REVIEW.md` → `_backups/CODE_REVIEW.md.backup-20260616-094802`

### Rollback

See `_backups/ROLLBACK-2.1.0.md` for full step-by-step Windows
and Linux recipes.  The shortest path:

```bash
cp _backups/startXMPP.ts.backup-20260616-094802 src/startXMPP.ts
cp _backups/package.json.backup-20260616-094802 package.json
```

### Tests

New: `tests/v2.1.0-groupchat-dispatch.test.ts` (1 describe
block, 4 describe blocks: room subject isSystemMessage, real
user messages do not have isSystemMessage, gateway guard
remains in place, version bumped).  No regressions in the
existing 148 tests / 47 suites.

### Files changed

| File | Change |
|------|--------|
| `src/startXMPP.ts` | +1 token (`isSystemMessage: true`) at line 1011 |
| `package.json` | version: 2.0.20 → 2.1.0 |
| `CHANGELOG.md` | new entry at top (this one) |
| `docs/CODE_REVIEW.md` | new §19 |
| `tests/v2.1.0-groupchat-dispatch.test.ts` | new file |
| `_backups/ROLLBACK-2.1.0.md` | new file |

## [2.0.20] - 2026-06-15

**Hotfix for a regression that v2.0.19 did NOT fix.**
If your gateway was still seeing the
`StreamError { condition: 'conflict', text: 'Replaced by new
connection' }` cycle and the `iq-ping: send failed {}` spam
after upgrading to v2.0.19, this fix is for you.

### Symptom (still present in 2.0.19)

```
06:37:46 [health-monitor] [xmpp:default] health-monitor: restarting (reason: stale-socket)
06:37:46 [xmpp] [default] XMPP connection stopping
06:37:46 [xmpp] [default] auto-restart attempt 1/10 in 5s
06:37:46 [xmpp] shutting down gracefully
06:37:46 [xmpp] went offline
06:37:46 [WARN]  [xmpp] Scheduling reconnect in 1000ms (attempt 1)
06:37:46 [xmpp] scheduling reconnect in 1000ms (attempt 1)
06:37:46 [xmpp] connection stopped
06:37:46 [xmpp] gateway.startAccount called
06:37:46 [xmpp] [default] starting XMPP connection to xmpp://kazakhan.com:5222
06:37:47 [xmpp] online as
06:37:47 [xmpp] Presence with XEP-0115 caps sent, ver=n2FF8nQ27dnbenhIj7yaQa9FxtI=
06:37:47 [WARN]  [xmpp] TCP keepalive on Windows: ...
06:37:47 [xmpp] vCard registered with server
06:37:47 [ERROR] DISPATCH_ENTERED: from=jamie@kazakhan.com bodyLen=12 type=chat
06:37:48 [WARN]  [xmpp] iq-ping: send failed {} (x12)
06:37:48 [xmpp] online as
06:37:48 [xmpp] error
06:37:48 [ERROR] [xmpp] connection error {
  name: 'StreamError',
  condition: 'conflict',
  text: 'Replaced by new connection',
  ...
}
06:37:48 [xmpp] vCard registered with server
06:37:48 [WARN]  [xmpp] socket disconnected (clean=true, event=unknown, idle=0s)
06:38:18 [provider-transport-fetch] ... UND_ERR_SOCKET
```

### Why v2.0.19 did not fix it

The v2.0.19 fixes (R1 unique resource, R2 status-aware
iq-ping swallow, R3 fast-fail after conflict) were all
correct but addressed the wrong root cause:

- **R1 (unique resource)** helps when a **single process**
  reconnects and the @xmpp/client library internally
  renegotiates the stream.  It does not help when the
  health-monitor plugin (or anything external) calls
  `gateway.startAccount` for the same JID while a previous
  connection is still alive.  Two distinct connections from
  two distinct sources → the XMPP server kicks the older
  one regardless of resource uniqueness.
- **R2 (status-aware iq-ping swallow)** suppresses the
  `iq-ping: send failed {}` warn only when the xmpp client
  reports `status !== "online"`.  In the operator's log the
  xmpp client was in `"online"` state for all 12 send
  failures — the socket was black-holed by a middlebox but
  the xmpp client hadn't noticed yet.  R2's check never
  matched.
- **R3 (fast-fail after conflict)** checks the
  `lastDisconnectReason` string for "conflict" or
  "Replaced by new connection".  The actual `disconnect`
  event's reason was `clean=true event=unknown
  code=undefined reason=(no message)` — the conflict text
  appears in the `error` event, not the `disconnect`
  event.  R3's regex never matched.

### Root cause (v2.0.20)

The health-monitor plugin calls `gateway.startAccount` every
time it thinks the connection is "stale" (default: no inbound
bytes for ~30s).  The liveness manager inside the gateway
also has its own reconnect mechanism (the IQ-ping watchdog,
the socket-idle watchdog).  When both decide to reconnect
within seconds of each other, two concurrent
`gateway.startAccount` calls each invoke `startXmpp`, which
each opens a fresh connection.  The XMPP server sees two
streams from the same bare JID, kills the older one with
`StreamError { condition: 'conflict', text: 'Replaced by
new connection' }`, and the cycle continues.

### The fix (v2.0.20)

A single 5-line semantic change to `gateway.startAccount`
(`src/gateway.ts`):

1. Look up the existing client for the account.
2. Read its `_lastInboundAt` timestamp (already maintained
   by the liveness manager).
3. If inbound traffic was seen within
   `STALE_CONNECTION_TIMEOUT_MS = 30_000` (30s —
   comfortably above the SM keepalive interval of 25s and
   the IQ-ping interval of 60s, so a healthy connection
   always shows recent traffic), treat as alive and
   **refuse** the new `startAccount` (log a warning, return
   early).
4. If inbound traffic was seen > 30s ago OR no existing
   client, the previous code path runs: stop the dead
   client, then start a new one.

The liveness manager's own watchdogs (idle-socket at 120s)
handle the truly-dead-connection case.  If the operator
really needs to force a restart, they can restart the
gateway process — there is no escape-hatch flag in this
release.

### Why 30s and not 5s or 60s

- **5s** would be too aggressive: it would also reject
  healthy reconnects during the brief window between the
  liveness manager's IQ-ping (every 60s) and the next SM
  keepalive (every 25s).  A connection that just sent an
  SM `<r/>` (outbound) and is waiting for the next
  inbound would be falsely flagged as "stale".
- **60s** would be too conservative: it's exactly the
  IQ-ping interval, so a connection that just sent a ping
  but hasn't received the pong yet would be falsely
  flagged as "alive" (it isn't — the pong is what tells us
  the socket is healthy).
- **30s** is the sweet spot: it's well above the SM
  keepalive interval (25s), so a healthy connection
  always shows recent inbound traffic, and it's well below
  the IQ-ping interval (60s), so a stuck-on-pong
  connection is correctly flagged as stale.

### Why v2.0.19 was still worth shipping

Although v2.0.19 did not fix the operator's symptom, the
three fixes are still correct:

- **R1 (unique resource)** is correct and useful for
  single-process re-handshakes; it just isn't the operator's
  scenario.
- **R2 (status-aware iq-ping swallow)** is correct for the
  case it targets (offline/reconnect).  It just doesn't
  catch the "online but black-holed" case.  Future
  releases may add an additional check on
  `_lastSendErrorAt`.
- **R3 (fast-fail after conflict)** is correct in
  principle but checked the wrong event.  Future releases
  may wire it to the `error` event so the conflict text
  actually reaches the regex.

### Added

- `tests/v2.0.20-double-start-guard.test.ts` — 1
  source-level describe block, 5 assertions, all passing.
  Confirms:
  - `STALE_CONNECTION_TIMEOUT_MS = 30_000` is present.
  - `startAccount` reads `_lastInboundAt` from the existing
    client.
  - `startAccount` returns early when the existing client
    is alive.
  - `startAccount` proceeds with a new connection when the
    existing client is stale.
  - `startAccount` logs a warning explaining the refusal.

### Changed

- `package.json` — version bumped 2.0.19 → 2.0.20.
- `docs/CODE_REVIEW.md` — new §18 "Post-Review Fixes —
  v2.0.20 (this release)" added.

### Backups

All 4 modified files were backed up with the
`.backup-20260615-220000` suffix before editing:

- `src/gateway.ts.backup-20260615-220000`
- `package.json.backup-20260615-220000`
- `CHANGELOG.md.backup-20260615-220000`
- `docs/CODE_REVIEW.md.backup-20260615-220000`

### Verification performed before release

- `node --test tests/v2.0.20-double-start-guard.test.ts`
  → **5 / 5 pass**.
- Full regression:
  `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts
  tests/v2.0.19-connection-resilience.test.ts
  tests/v2.0.20-double-start-guard.test.ts` →
  **148 / 148 pass**, no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.19
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:353,358` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification grep:
  - `Select-String -Path src/gateway.ts -Pattern
    "STALE_CONNECTION_TIMEOUT_MS\s*=\s*30_000"` →
    **1 match**.  ✅

### Manual smoke test

To verify the fix on a running gateway:

1. Start the gateway and confirm a normal XMPP connection
   (no `Replaced by new connection` errors, no
   `iq-ping: send failed {}` spam).
2. Trigger the health-monitor's "stale" check (e.g. by
   calling its `restart` command or by waiting for the
   default stale window).
3. Confirm:
   - The main log shows:
     `[xmpp] [default] startAccount: an existing connection
     has been alive for the last <N>s — refusing to start a
     second concurrent connection.`
   - The XMPP server's active-sessions list still shows
     one entry for the gateway's JID (not two).
   - Inbound messages continue to be dispatched without
     the 2-3 minute gap from the conflict cycle.
4. To force a fresh start (e.g. after a known config
   change), restart the gateway process.

### Upgrade notes

- v2.0.20 is **backward-compatible** at the API level.  No
  config-file changes are required.
- Operators who want to override the 30s threshold can
  edit the `STALE_CONNECTION_TIMEOUT_MS` constant in
  `src/gateway.ts` directly.  Future releases may
  promote it to a `Config.*` field.
- The v2.0.19 fixes (R1, R2, R3) are still in place and
  still correct.  This release adds the missing piece:
  refuse to start a second concurrent connection.
- See `_backups/ROLLBACK-2.0.20.md` for rollback
  instructions.

## [2.0.19] - 2026-06-15

**Hotfix for a regression in v2.0.18 (and earlier releases).**
If your XMPP server's active-sessions list was showing two
sessions for the same resource, or your gateway stopped
dispatching messages for 2-3 minutes after a single
reconnect, this fix is for you.

### Symptom (reported by the operator)

```
21:03:23 [WARN]  [xmpp] TCP keepalive on Windows: ...  (first connection)
21:03:23 [info]  [xmpp] vCard registered with server
21:03:23 [info]  [xmpp] error
21:03:23 [ERROR] [xmpp] connection error {
  name: 'StreamError',
  condition: 'conflict',
  text: 'Replaced by new connection',
  ...
}
21:03:23 [info]  [xmpp] online as ...            (second connection)
21:03:23 [info]  [xmpp] Presence with XEP-0115 caps sent, ver=...
21:03:23 [WARN]  [xmpp] TCP keepalive on Windows: ...  (second connection)
21:03:23 [WARN]  [xmpp] socket disconnected (clean=true, event=unknown, ...)
21:03:23 [info]  [xmpp] vCard registered with server
21:04:23 [WARN]  [xmpp] iq-ping: send failed {}
21:05:23 [WARN]  [xmpp] iq-ping: send failed {}
21:05:23 [ERROR] [xmpp] socket-idle: no inbound bytes for 120s, destroying socket
21:06:23 [WARN]  [xmpp] iq-ping: send failed {}
... (no more inbound messages dispatched for 2-3 minutes)
```

### Root cause

`createXmppClient` (`src/lib/xmpp-connect.ts`) defaulted the
XMPP resource to `config.jid.split("@")[0]` — the bare-JID
local part.  This is **not unique** across reconnections.
Combined with the `@xmpp/client` library's internal stream
renegotiation (triggered by SM keepalive / IQ traffic), the
XMPP server saw a re-handshake as a "new connection" and
returned `StreamError { condition: 'conflict', text:
'Replaced by new connection' }`.  The first stream was
killed; the second survived but was then silently
black-holed by a middlebox / NAT / SIP-ALG, and the
watchdogs (60s IQ-ping + 120s socket-idle) took 2-3 minutes
to fire before the user saw a recovery.

### Three fixes

- **R1 — Unique resource per connection attempt**
  (`src/lib/xmpp-connect.ts`).  When `config.resource` is
  undefined, the default is now
  `` `openclaw-${crypto.randomBytes(3).toString("hex")}` ``
  — e.g. `openclaw-a3f2c1`.  16M possible values; collision
  requires two connections from the same JID in the same
  millisecond — effectively zero.  Operators who supply
  `config.resource` explicitly are honoured verbatim.  Added
  `import crypto from "crypto"`.

- **R2 — Status-aware iq-ping error swallow**
  (`src/liveness.ts`).  The `setupIqPingWatchdog` catch block
  now reads `xmpp.status` before warning.  When the xmpp
  client is in any state other than `"online"` (i.e. we're
  already in a disconnect / reconnect cycle), the
  `xmpp.send()` rejection has no useful properties (the log
  shows `iq-ping: send failed {}` with an empty error
  object) and is expected — the existing
  `onOffline()` / `scheduleReconnect()` machinery handles
  recovery.  A `debugLog` line preserves the diagnostic for
  post-mortem.

- **R3 — Fast-fail reconnect after a "conflict" / "Replaced"
  disconnect** (`src/liveness.ts`).  `onOffline()` now
  inspects `lastDisconnectReason` before scheduling a
  reconnect.  If the reason contains "conflict" or
  "Replaced by new connection", it skips the
  exponential-backoff `scheduleReconnect()` and triggers a
  direct `xmpp.start()` instead.  This drops the
  user-visible "messages stop being dispatched for 2-3
  minutes" recovery window to <1s.  The fast-fail branch
  clears `m._reconnectTimer` to prevent double-scheduling,
  and on failure falls back to `scheduleReconnect()`.

### Added

- `tests/v2.0.19-connection-resilience.test.ts` — 3
  source-level describe blocks (R1, R2, R3), 10 assertions,
  all passing.  Confirms the unique-resource format, the
  status-aware error swallow, and the fast-fail branch.

### Changed

- `package.json` — version bumped 2.0.18 → 2.0.19.
- `docs/CODE_REVIEW.md` — new §17 "Post-Review Fixes —
  v2.0.19 (this release)" (regression hotfix; out-of-band
  from the §4 cleanup).

### Backups

All 5 modified files were backed up with the
`.backup-20260615-210000` suffix before editing:

- `src/lib/xmpp-connect.ts.backup-20260615-210000`
- `src/liveness.ts.backup-20260615-210000`
- `package.json.backup-20260615-210000`
- `CHANGELOG.md.backup-20260615-210000`
- `docs/CODE_REVIEW.md.backup-20260615-210000`

### Verification performed before release

- `node --test tests/v2.0.19-connection-resilience.test.ts`
  → **10 / 10 pass**.
- Full regression: `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts
  tests/v2.0.19-connection-resilience.test.ts` → **143 /
  143 pass**, no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.18
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:319,324` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps:
  - `Select-String -Path src/lib/xmpp-connect.ts -Pattern
    "crypto\.randomBytes"` → **1 match** (R1).  ✅
  - `Select-String -Path src/lib/xmpp-connect.ts -Pattern
    "config\.resource \|\| .openclaw-"` → **1 match** (R1).  ✅
  - `Select-String -Path src/liveness.ts -Pattern
    "status !== \"online\""` → **1 match** (R2).  ✅
  - `Select-String -Path src/liveness.ts -Pattern
    "send rejected during status="` → **1 match** (R2).  ✅
  - `Select-String -Path src/liveness.ts -Pattern
    "Replaced by new connection|conflict.*reconnect"` → **1 match** (R3).  ✅

### Manual smoke test

To verify the fix on a running gateway:

1. Tail the cli-debug.log file
   (`~/.openclaw/extensions/xmpp/logs/cli-debug.log`).
2. Watch the operator's XMPP client's "active sessions" list
   (e.g. Conversations, Gajim, Dino).
3. Restart the gateway process.
4. Confirm:
   - The new connection's resource is `openclaw-<6 hex>`.
   - The previous session (if still in the active-sessions
     list) is cleanly disconnected.
   - No `Replaced by new connection` error in the main log.
   - Inbound messages are dispatched within seconds of the
     gateway restart (not 2-3 minutes later).

### Upgrade notes

- v2.0.19 is **backward-compatible** at the API level.  No
  config-file changes are required.
- Operators who previously set `config.resource`
  explicitly in their XMPP config are unaffected — the
  explicit value is honoured.
- Operators who relied on the bare-JID local part as the
  resource (e.g. for filtering their active-sessions list
  by resource) will now see resources like
  `openclaw-a3f2c1` instead of `alice`.  To restore the old
  behaviour, set `resource: "alice"` (or whatever local
  part you prefer) in your XMPP config.
- The new resource is regenerated on **every** connection
  attempt (initial + reconnect).  The XMPP server's
  active-sessions list will accumulate one entry per
  restart, but each entry is unique, so the server will
  not conflict-kick the previous one.
- See `_backups/ROLLBACK-2.0.19.md` for rollback
  instructions.

## [2.0.18] - 2026-06-15

Resolves **14 Low-severity** items from `docs/CODE_REVIEW.md` §4
(plus the two §9.3 whiteboard items M10/M11 that were deferred
from v2.0.17).  Test coverage provided by the new
`tests/low-severity.test.ts` (14 describe blocks, 36 assertions).
Full regression run (`node --test tests/*.test.ts`) →
**133 / 133 pass**, no regressions in earlier suites.

Note: `§4.8` (vcard-cli `success` flag) was already covered by
v2.0.17 M12's per-step `metadataOk`/`dataOk` flags.  `§4.15`
(inconsistent import style), `§4.16` (rate-limit off-by-one comment),
and `§4.18` (TS strict mode) were either already consistent or
deferred.  The `§9.3` row for `startXMPP.ts` file size and the
nonza-listener xmlns cache remain "deferred" — see §16 for details.

### Security

- **L7 — `sanitizeFilename` already covered H6 (2.0.16) and is
  not changed.**  This entry is a placeholder; the only change
  related to filename sanitization in 2.0.18 is the removal of
  the dead `rawPaths` field in whiteboard data.
- **L15 — `cli-debug.log` files removed from source tree**
  (`src/shared/index.ts` + `.gitignore` + filesystem).  The
  `debugLog()` function's default location changed from
  `process.cwd()/cli-debug.log` to
  `~/.openclaw/extensions/xmpp/logs/cli-debug.log`.  Two existing
  `cli-debug.log` files (3.3MB + 143KB) were deleted; `.gitignore`
  gained explicit `cli-debug.log` and `src/cli-debug.log` entries
  (in addition to the existing `*.log` rule) for belt-and-braces.

### Robustness

- **L4 — `quarantineDir` / `tempDir` defaults are now absolute
  paths** (`src/security/fileTransfer.ts`).  The previous defaults
  (`./quarantine`, `./temp`) were CWD-relative and depended on
  the process's launch directory, which varied by deployment
  (systemd, Docker, terminal).  New defaults:
  `~/.openclaw/extensions/xmpp/data/quarantine` and
  `~/.openclaw/extensions/xmpp/data/temp`.  Operators can still
  override via `FileTransferConfig`.  Added `import os from "os"`.
- **L5 — `secureDeleteFile` SSD limitation documented**
  (`src/security/fileTransfer.ts`).  The function overwrites the
  file with zeros via `fs.writeSync`, but on SSD with
  wear-leveling and on journaling filesystems (ext4, NTFS, APFS)
  the original blocks may be retained indefinitely.  Added a
  comment at the top of the function explaining the limitation
  and pointing operators to LUKS / FileVault / BitLocker for
  high-security use cases.
- **L9 — vCard IQs now use `sendReceive` instead of hard-coded
  sleeps** (`src/vcard-cli.ts`).  The previous pattern
  (`xmpp.on('stanza', handler)` + `setTimeout(800)`) was both
  slow (vCard with N fields took `(N+1) * 1.1` seconds) and
  unreliable (too short on slow connections).  Replaced with a
  `sendReceive(xmpp, stanza, timeoutMs = 5000)` helper that
  resolves on the matching `<iq type="result"/>` and rejects on
  `<iq type="error"/>`.  **11 call sites refactored** (8
  `setVCard*` variants, 2 `publishAvatar` IQs, 1 `getVCard`).
  The 300ms post-SET sleeps were also removed (no functional
  purpose; the IQ stream is already ordered by the `stanzas`
  event).
- **L13 — `saveVCardLocally` is now async** (`src/vcard-cli.ts`).
  Converted from `fs.writeFileSync`/`fs.existsSync`/`fs.mkdirSync`
  to `fsp.writeFile`/`fsp.mkdir({ recursive: true })`.  All 10
  call sites updated to `await saveVCardLocally(vcard)`.  The
  prior `existsSync` guard was removed because
  `fsp.mkdir({ recursive: true })` is idempotent.
- **L14 — `withConnection` wraps `xmpp.start()` in try/catch**
  (`src/vcard-cli.ts`).  Previously a rejection from
  `xmpp.start()` (e.g. bad credentials) was racy with the
  `'error'` event listener; a real start failure could be
  silently swallowed.  Now: `try { await xmpp.start(); } catch
  (err) { try { await xmpp.stop(); } catch {}; throw err; }`.

### Concurrency

- **L11 — `state.ts` exports are now strongly typed**
  (`src/state.ts`).  `xmppClients: Map<string, any>` →
  `Map<string, XmppClient>`; `contactsStore: Map<string, any>` →
  `Map<string, Contacts>`.  Type-only imports of `XmppClient`
  (from `./types.js`) and `Contacts` (from `./contacts.js`).
  No runtime change; downstream type narrowing now works
  without `as any` casts.

### Code quality

- **L1 — `xmppClientModule` is now a function-local `const`**
  (`src/startXMPP.ts`).  Removed the module-level `let
  xmppClientModule: any = null;` and the `if (!xmppClientModule) {
  ... }` lazy-init block.  The import is now at the top of
  `startXmpp()`; Node's module cache makes the second invocation
  a no-op.  Scope reduced; no behaviour change.
- **L2 — SM `<r/>` keepalive uses `xml()` builder**
  (`src/liveness.ts`).  Replaced
  `xmpp.write("<r xmlns='urn:xmpp:sm:3'/>")` with
  `xmpp.write(xmppXml("r", { xmlns: "urn:xmpp:sm:3" }))`.
  Added `import { xml as xmppXml } from "@xmpp/client"`.
  Consistent with the rest of the codebase.
- **L3 — `_setLastInboundAt` on SM `<r/>` write now has a
  comment** (`src/liveness.ts`).  Documents the choice: the
  idle-socket watchdog's purpose is to detect "no bytes received",
  and resetting on a successful *outbound* write is conservative
  — it prevents the watchdog from firing during normal
  request/response traffic where we *are* doing I/O even if the
  server hasn't replied yet.  No behaviour change.
- **L6 — Whiteboard `attrEdits.push` refactored** (`src/whiteboard.ts`).
  Extracted the new attr entry to a `const newAttr = { ... }`
  before the `push` call, with an explanatory comment.  The
  previous inline `attrEdits.push({ ... })` was actually safe
  (Array.find() is not affected by Array.push()) but the pattern
  was hard to read.
- **L7 — Whiteboard `rawPaths` field removed**
  (`src/whiteboard.ts`).  The `rawPaths?: string[]` field on the
  `convertSxeToWhiteboardData` return type was set but never read
  by any consumer (verified via `grep`).  The `standalonePaths`
  loop, the field, and the two `rawPaths:` assignments in the
  return statements were removed.  **Behaviour change**: any
  external (out-of-repo) consumer of `WhiteboardData.rawPaths`
  will get `undefined`; no internal consumer was affected.
- **L10 — `recordInboundSession` skip now logs a warning**
  (`src/gateway.ts`).  Previously, if the runtime channel session
  was unavailable, the file notification path was silently
  skipped.  Now: an `else { log.warn(...) }` branch surfaces the
  skipped path so operators can investigate.
- **L12 — `commands.ts` JID validation extracted**
  (`src/commands.ts`).  Added a `requireJid(jid, usage)` helper.
  Two subcommand sites (`add` and `remove`) now use the helper
  instead of inlining `if (!jid || !jid.includes('@'))`.

### Operational

- **L15** (already described under Security)

### Added

- `tests/low-severity.test.ts` — 14 source-level describe
  blocks (L1, L2, L3, L4, L5, L6, L7, L9, L10, L11, L12, L13,
  L14, L15), 36 assertions, all passing.
- `_backups/ROLLBACK-2.0.18.md` — full-rollback (Windows +
  Linux) and per-fix-partial-rollback recipes.

### Changed

- `package.json` — version bumped 2.0.17 → 2.0.18.
- `docs/CODE_REVIEW.md` — §9.4 status column updated
  (`❌ Still/NEW` → `✅ FIXED (2.0.18)` for the 14 in-scope
  items); new §16 "Post-Review Fixes — v2.0.18 (this release)"
  added.

### Backups

All 13 modified source files were backed up with the
`.backup-20260615-200000` suffix before editing:

- `src/startXMPP.ts.backup-20260615-200000`
- `src/liveness.ts.backup-20260615-200000`
- `src/security/fileTransfer.ts.backup-20260615-200000`
- `src/whiteboard.ts.backup-20260615-200000`
- `src/gateway.ts.backup-20260615-200000`
- `src/state.ts.backup-20260615-200000`
- `src/commands.ts.backup-20260615-200000`
- `src/vcard-cli.ts.backup-20260615-200000`
- `src/shared/index.ts.backup-20260615-200000`
- `.gitignore.backup-20260615-200000`
- `package.json.backup-20260615-200000`
- `CHANGELOG.md.backup-20260615-200000`
- `docs/CODE_REVIEW.md.backup-20260615-200000`

### Verification performed before release

- `node --test tests/low-severity.test.ts` → **36 / 36 pass**.
- Full regression: `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts` →
  **133 / 133 pass**, no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.17
  (`index.ts`, `setup-entry.ts`, `src/cli-metadata.ts`,
  `src/gateway.ts:319,324` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps:
  - `Select-String -Path src/startXMPP.ts -Pattern "let
    xmppClientModule"` → **0 matches** (L1).  ✅
  - `Select-String -Path src/liveness.ts -Pattern "<r xmlns="` →
    **0 matches** (L2).  ✅
  - `Select-String -Path src/security/fileTransfer.ts -Pattern
    "'\.\/quarantine'|'\\.\\/temp'"` → **0 matches** (L4).  ✅
  - `Select-String -Path src/whiteboard.ts -Pattern
    "rawPaths|standalonePaths"` → **0 matches** (L7).  ✅
  - `Select-String -Path src/vcard-cli.ts -Pattern "setTimeout\\(
    r, (800|500|300) \\)"` → **0 matches** (L9).  ✅
  - `Select-String -Path src/vcard-cli.ts -Pattern "writeFileSync"`
    → **0 matches** (L13).  ✅
  - `Select-String -Path src/state.ts -Pattern "Map<string, any>"`
    → **0 matches** (L11).  ✅
  - `Select-String -Path src/commands.ts -Pattern
    "requireJid"` → **2 matches** (helper + 2 call sites — L12).  ✅
  - `Test-Path cli-debug.log; Test-Path src/cli-debug.log` → both
    **NOT FOUND** (L15).  ✅
  - `Select-String -Path .gitignore -Pattern "cli-debug.log"` → at
    least **2 matches** (L15).  ✅
  - `Select-String -Path src/shared/index.ts -Pattern "os\\.homedir
    \\(\\)"` → **1 match** (L15).  ✅

### Upgrade notes

- v2.0.18 is **backward-compatible** at the API level.  No
  config-file changes are required.  Two operator-visible
  changes:
  1. `quarantineDir` and `tempDir` defaults moved from
     CWD-relative (`./quarantine`, `./temp`) to absolute paths
     under `~/.openclaw/extensions/xmpp/data/`.  Operators
     who relied on the old CWD-relative path should add the
     override in their config.
  2. `debugLog()` writes to
     `~/.openclaw/extensions/xmpp/logs/cli-debug.log` by
     default.  Operators who had tooling watching the CWD path
     should either call `setDebugLogDir(...)` to point at the
     old location, or update their tooling.
- **vCard workflow speedup**: GET IQs that previously waited
  800ms now wait for the actual response (typically <100ms
  on a local LAN).  A full `setVCard + set + save` cycle
  drops from `(N+1) * 1.1` seconds to <500ms.
- **Whiteboard `rawPaths` removal**: external consumers (out of
  this repo) that read `convertSxeToWhiteboardData(...)`.`rawPaths`
  will get `undefined`.  The field was never read by any
  consumer in this repo (verified via `grep`).
- See `_backups/ROLLBACK-2.0.18.md` for rollback instructions.

## [2.0.17] - 2026-06-15

Resolves **10 Medium-severity** items from `docs/CODE_REVIEW.md` §3
(prose) and §9.3 (prioritized table).  Test coverage provided by the
new `tests/medium-severity.test.ts` (10 describe blocks, 29
assertions).  Full regression run (`node --test tests/*.test.ts`) →
**97 / 97 pass**, no regressions in earlier suites.

Note: `3.2` (xmpp.send hang) and `3.3` (queue singleton) were
already resolved in v2.0.16 (H2, H4) and `3.13` (whiteboard
`isSystemMessage`) was resolved in v2.0.16 (H9).  The whiteboard
items `M10`/`M11` are deferred to v2.0.18 alongside the §4
Low-severity cleanup.

### Security

- **M7 — `Contacts.add()` validates JID format**
  (`src/contacts.ts`).  Calls `validators.isValidJid(bareJid)` and
  returns `false` on a malformed JID (e.g. `alice@@example.com`).
  Previously the JSON store happily accepted any string.
- **M2 — `PersistentQueue.save()` no longer swallows write errors**
  (`src/lib/persistent-queue.ts`).  The bare `catch {}` is replaced
  with `catch (err) { log.error(\`[PersistentQueue] failed to write
  ${this.filePath}:\`, err); }` so a full disk / locked file is
  visible in the main log instead of silently dropping queue
  writes.

### Robustness

- **M3 — `clearOld` moves unprocessed messages to a dead-letter
  array** (`src/lib/persistent-queue.ts`).  Previously an unprocessed
  message older than `maxAgeMs` was silently dropped on
  `clearOld()`.  Now such messages are appended to
  `this.deadLetter[]` (capped at `DEAD_LETTER_MAX = 500`) and
  persisted to `<dataDir>/message-queue.dead-letter.json`.
  New: `getDeadLetter()` and `clearDeadLetter()` accessors.
- **M5 — `setTimeout` handles in upload-discovery are cleared on
  early resolve** (`src/lib/upload-protocol.ts`).  Both
  `discoverUploadService` (10s) and `requestUploadSlot` (30s) now
  store the timer handle and call `clearTimeout(timer)` in the
  resolve / error / send-rejection paths so the event loop can
  exit promptly when the gateway is otherwise idle.
- **M6 — `discoverUploadService` error branch has explicit
  `return;`** (`src/lib/upload-protocol.ts`).  Cosmetic; was
  unreachable from the outer `if/else if` but made the function
  harder to reason about.
- **M9 — `services.startXmpp()` is now wrapped in `Promise.race`
  with a 60-second timeout** (`src/gateway.ts`).  Previously a
  hung TCP/TLS/SASL/SM handshake could block `startAccount`
  forever, holding the abort signal.  Now a 60s timeout surfaces
  the failure, and the caller's `abortSignal` is wired to
  `xmpp.stop()` so an early abort tears the client down
  immediately.  The inner `startXmppPromise` and the timeout
  promise are raced; on success or failure the timer and abort
  listener are both removed in `clearStartXmppGuards()`.
- **M14 — `vcard-cli.publishAvatar` uses per-step flags, not a
  single `success` reused across both handlers**
  (`src/vcard-cli.ts`).  Previously the second handler (`dataOk`)
  could leak a `success = true` from the first handler's
  (`metadataOk`) leftover state.  Now both flags default to
  `false` and the return value is `metadataOk && dataOk`, so a
  partial failure naturally reports `false`.

### Concurrency

- **M4 — `JsonStore` per-instance write-chain serialises
  set/update/clear** (`src/jsonStore.ts`).  Two concurrent
  `set()` calls (e.g. two simultaneous contact adds) could race:
  each loads the same baseline, each mutates, the second
  `save()` overwrites the first.  Each instance now holds a
  `writeChain: Promise<void>` and routes every write through
  `enqueueWrite()` which appends to the chain.  The chain is
  fail-open: one step throwing does not poison subsequent steps
  (the chain itself is `.catch(() => {})`-ed).  No new
  `package.json` dependencies.

### Operational

- **M1 — gateway diagnostic logs are no longer at `error` level**
  (`src/gateway.ts`).  The 5 `log.error` calls emitting
  `DISPATCH_ENTERED`, `GC_DELIVER`, and `GC_SEND: pre/post`
  were downgraded to `log.debug`.  The real `DISPATCH BLOCK
  FAILED` error path remains `log.error`.  This prevents the
  monitoring stack (Promtail/Datadog) from alerting on routine
  per-message diagnostics.
- **M8 — Roster is now persisted** (`src/roster-store.ts` new,
  `src/commands.ts`).  The in-memory-only `roster` map and the
  no-op `saveRoster()` were replaced with a `RosterStore` class
  backed by a `JsonStore` at `<dataDir>/xmpp-roster.json`.  The
  `/xmpp nick <jid> <name>` and `/xmpp roster` subcommands now
  actually persist and read.

### Added

- `src/roster-store.ts` (~50 lines) — `RosterStore` class with
  `setNick`, `getNick`, `list`, `remove`.  Backed by
  `xmpp-roster.json`.
- `tests/medium-severity.test.ts` — 10 source-level describe
  blocks (M1, M2, M3, M4, M5, M6, M7, M8, M9, M12), 29
  assertions, all passing.  Includes a re-implementation of the
  M4 chain pattern that verifies the `set()` calls are
  serialised in submission order.
- `_backups/ROLLBACK-2.0.17.md` — full-rollback (Windows +
  Linux) and per-fix-partial-rollback recipes.

### Changed

- `package.json` — version bumped 2.0.16 → 2.0.17.
- `docs/CODE_REVIEW.md` — §9.3 status column updated
  (`❌ NEW/Still/Worse` → `✅ FIXED (2.0.17)`); new §15
  "Post-Review Fixes — v2.0.17 (this release)" added.

### Backups

All 10 modified source files were backed up with the
`.backup-20260615-180000` suffix before editing:

- `src/gateway.ts.backup-20260615-180000`
- `src/lib/persistent-queue.ts.backup-20260615-180000`
- `src/jsonStore.ts.backup-20260615-180000`
- `src/lib/upload-protocol.ts.backup-20260615-180000`
- `src/contacts.ts.backup-20260615-180000`
- `src/commands.ts.backup-20260615-180000`
- `src/vcard-cli.ts.backup-20260615-180000`
- `package.json.backup-20260615-180000`
- `CHANGELOG.md.backup-20260615-180000`
- `docs/CODE_REVIEW.md.backup-20260615-180000`

### Verification performed before release

- `node --test tests/medium-severity.test.ts` → **29 / 29 pass**.
- Full regression: `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts` → **97 / 97 pass**, no
  regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.16
  (`index.ts`, `setup-entry.ts`, `src/cli-metadata.ts`,
  `src/gateway.ts:312/317` — subpath import resolution +
  `===` comparison narrowing, both pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps:
  - `Select-String -Path src/gateway.ts -Pattern
    "log\.error.*DISPATCH_ENTERED|log\.error.*GC_DELIVER|
    log\.error.*GC_SEND"` → **0 matches** for diagnostics.  The
    real `DISPATCH BLOCK FAILED` error still uses `log.error`.
    ✅
  - `Select-String -Path src/lib/persistent-queue.ts -Pattern
    "catch \{\s*\}"` → **0 matches**.  ✅
  - `Select-String -Path src/lib/persistent-queue.ts -Pattern
    "deadLetter|getDeadLetter|DEAD_LETTER"` → 21 matches
    (new feature).  ✅
  - `Select-String -Path src/jsonStore.ts -Pattern
    "writeChain|enqueueWrite"` → 8 matches (new feature).  ✅
  - `Select-String -Path src/lib/upload-protocol.ts -Pattern
    "let timer|clearTimeout\(timer\)"` → 4 matches (2
    functions × 2 each).  ✅
  - `Select-String -Path src/contacts.ts -Pattern
    "isValidJid|validators"` → 3 matches (import + use).  ✅
  - `Test-Path src/roster-store.ts` → **True**.  ✅
  - `Select-String -Path src/gateway.ts -Pattern
    "START_XMPP_TIMEOUT_MS|Promise\.race"` → 5 matches.  ✅
  - `Select-String -Path src/vcard-cli.ts -Pattern
    "metadataOk|dataOk"` → 7 matches.  ✅

### Upgrade notes

- v2.0.17 is **backward-compatible** at the API level.  No
  config-file changes are required.
- **Roster migration**: existing operator workflows that
  pre-set nicks via the now-persistent store will pick up
  their entries on the next `setNick` call; old in-memory nicks
  are not migrated (they were never on disk in v2.0.15/16).
- **Dead-letter queue**: a new file
  `<dataDir>/message-queue.dead-letter.json` may appear on
  the first `clearOld()` after upgrade if any unprocessed
  messages older than 24h exist.  Operators can inspect it
  via `getDeadLetter()` or `clearDeadLetter()`.
- See `_backups/ROLLBACK-2.0.17.md` for rollback instructions.

## [2.0.16] - 2026-06-15

Resolves **all 9 High-severity** items from `docs/CODE_REVIEW.md` §9.2
(prior to this release they were all `❌ NEW`).  Test coverage
provided by the new `tests/high-severity.test.ts` (9 describe
blocks, 26 assertions).  Full regression run
(`node --test tests/*.test.ts`) → **68 / 68 pass**.

### Security

- **H1 — `encrypt-password` no longer echoes the password**
  (`src/commands.ts`). The subcommand used
  `readline.createInterface(...).question('', password)`, which
  echoes the password to the terminal character-by-character as
  the user types it. Replaced with a `for await (const chunk of
  process.stdin)` loop so the password is read silently from stdin
  (pipelines / `<<<` heredocs work). The `--password "..."` argv
  path still works but emits a deprecation warning. Backward-compat
  preserved — subcommand name unchanged.
- **H2 — `xmpp.send()` is now timeout-safe** (`src/liveness.ts` new,
  `src/startXMPP.ts`). Every `await xmpp.send(...)` (43+ call sites)
  is now `await safeXmppSend(xmpp, ...)`. The new helper uses
  `Promise.race` and clears the timer in a `finally` block so the
  v2.0.4 `Promise.race` timer-leak is explicitly fixed. Default
  timeout 30s, per-call override via `{ timeoutMs }`.
- **H3 — Nonza listener parent check** (`src/startXMPP.ts`). The
  listener now early-returns when `el?.parent !== xmpp.root`, so a
  nested `<sm>` inside a `<message>` reply no longer triggers the
  SM-negotiation path. Parse errors are now logged via
  `xmppLog.error(...)` instead of being silently swallowed.
- **H4 — Per-`dataDir` queue map** (`src/queue-bridge.ts`). The
  module-level `let messageQueue` singleton (which ignored
  `dataDir` after the first call) is replaced with
  `queueByDir: Map<string, PersistentQueue>`. Multi-account
  deployments now keep their queues isolated.
- **H5 — `xmppClient` hoisted to `let null`** (`src/startXMPP.ts`).
  The binding is now `let xmppClient: any = null` at the top of
  `startXmpp`; the defensive guard in the online listener is
  `xmppClient == null` and is documented as belt-and-braces
  defence-in-depth.
- **H6 — Liveness extracted to `src/liveness.ts`** (new, ~400
  lines). All keepalive state (`pingTimer`, `reconnectTimer`,
  `socketIdleTimer`, `lastInboundAt`, …) plus `safeSend()`,
  `findUnderlyingSocket()`, and the `onOnline`/`onOffline`/
  `setSmNegotiated`/`setLastDisconnectReason`/`forceReconnect`
  mutators are now in a self-contained module. `startXMPP.ts` line
  count dropped from 2,791 to ~2,580.
- **H7 — `sanitizeFilename` strips leading dots; dangerous
  extensions widened** (`src/security/validation.ts`,
  `src/security/fileTransfer.ts`). The sanitiser now applies
  `.replace(/^\.+/, '_')` so `.htaccess`, `.env`, `.git`, `.npmrc`
  are written as `_htaccess`, `_env`, etc. `dangerousExtensions`
  was augmented with 13 extensions covering XSS vectors
  (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.xsl`, `.xslt`,
  `.swf`, `.jnlp`) and additional shell/script extensions (`.com`,
  `.vbs`, `.wsf`, `.ps1`, `.bash`, `.ksh`, `.csh`).
- **H8 — Rate-limit map: 10k cap + 60s eviction**
  (`src/shared/index.ts`). Added `RATE_LIMIT_MAP_CAP = 10_000` and
  `RATE_LIMIT_EVICT_INTERVAL_MS = 60_000`. The cap is enforced
  before every rate-limit decision; the eviction timer is
  `interval.unref()`-ed so it does not keep the event loop alive.
- **H9 — `isSystemMessage` short-circuits the AI dispatcher**
  (`src/gateway.ts`). Whiteboard auto-draw and similar
  instructive events are now logged-and-returned before reaching
  the agent, eliminating spurious LLM traffic. The flag is
  preserved on the `ctxPayload` as `IsSystemMessage` for
  downstream telemetry.

### Added

- `src/liveness.ts` — self-contained liveness module
  (~400 lines, exports `createLivenessManager`, `LivenessManager`,
  `safeSend`, `DEFAULT_SEND_TIMEOUT_MS`).
- `tests/high-severity.test.ts` — 9 source-level describe blocks
  (H1-H9), 26 assertions, all passing.
- `_backups/ROLLBACK-2.0.16.md` — full-rollback (Windows + Linux)
  and per-fix-partial-rollback recipes.

### Changed

- `package.json` — version bumped 2.0.15 → 2.0.16.
- `docs/CODE_REVIEW.md` — §9.2 status column updated
  (`❌ NEW` → `✅ FIXED (2.0.16)`); new §14 "Post-Review Fixes —
  v2.0.16 (this release)" added.

### Backups

All 9 modified source files were backed up with the
`.backup-20260615-150000` suffix before editing:

- `src/commands.ts.backup-20260615-150000`
- `src/startXMPP.ts.backup-20260615-150000`
- `src/queue-bridge.ts.backup-20260615-150000`
- `src/security/validation.ts.backup-20260615-150000`
- `src/security/fileTransfer.ts.backup-20260615-150000`
- `src/shared/index.ts.backup-20260615-150000`
- `src/gateway.ts.backup-20260615-150000`
- `package.json.backup-20260615-150000`
- `docs/CODE_REVIEW.md.backup-20260615-150000`

### Verification performed before release

- `node --test tests/high-severity.test.ts` → **26 / 26 pass**.
- Full regression: `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts` →
  **68 / 68 pass**, no regressions in earlier suites.
- `npx tsc --noEmit` on the modified files only: **PASS**. The
  pre-existing TypeScript errors in `index.ts`, `setup-entry.ts`,
  `src/cli-metadata.ts`, and `src/gateway.ts` (unrelated
  `openclaw/plugin-sdk/*` subpath import resolution issues) are
  re-confirmed pre-existing.
- Final verification greps:
  - `Select-String -Path src/commands.ts -Pattern "readline"`
    → only the new `for await` loop reference; no
    `readline.createInterface` or `args.push("--token" |
    "--password")`. ✅
  - `Select-String -Path src/startXMPP.ts -Pattern "await
    xmpp\.send\("` → **0 matches**. ✅
  - `Select-String -Path src/startXMPP.ts -Pattern
    "process\.execPath"` → **0 matches**. ✅
  - `Select-String -Path src/gateway.ts -Pattern "putUrl\.replace"`
    → **0 matches**. ✅
  - `Select-String -Path src/gateway.ts -Pattern "f\.replace\('\.json'"` → **0 matches**. ✅

### Upgrade notes

- v2.0.16 is **backward-compatible** at the API level. No
  config-file changes are required. The `encrypt-password`
  subcommand gains a stdin path but the argv path still works
  (with a deprecation warning). The new `src/liveness.ts` module
  is internal-only and is not re-exported from `index.ts`.
- Operators who pipe the password via stdin should use a heredoc
  or pipe from a password manager:
  `printf '%s' "$PASSWORD" | openclaw xmpp encrypt-password`.
- See `_backups/ROLLBACK-2.0.16.md` for rollback instructions.

## [2.0.15] - 2026-06-15

### Security (Critical)

- **SFTP feature removed entirely** (`src/sftp.ts`, `src/commands.ts`,
  `src/types.ts`, `package.json`, `tests/*`). The SSH connection had
  `hostVerifier: () => true` which disabled host key verification
  entirely — a man-in-the-middle on the routing path could intercept
  the connection, present any host key, and steal the plaintext
  XMPP password. The whole feature was removed rather than patched
  because the SSH-only nature made a known_hosts workflow awkward
  and the user elected to drop the feature. The `xmpp sftp` CLI
  subcommand is preserved as a removal-stub that emits a clear
  error. The `ssh2` dependency has been removed from
  `package.json`. **Breaking change** for any operator who scripted
  around the `xmpp sftp` subcommand.

- **HTTPS preserved for XEP-0363 uploads**
  (`src/lib/upload-protocol.ts:171`). The previous code rewrote
  `https://put-url` to `http://put-url` before calling `fetch()`,
  sending upload bodies in cleartext. Now `fetch()` is called with
  the slot URL as-is. If the operator's server only advertises
  HTTP upload slots, the upload will still go through HTTP (operator
  misconfiguration), but the plugin will never silently downgrade
  an HTTPS slot. **Behavioural change:** operators whose upload
  service was silently HTTP-only will now see `fetch failed` and
  must fix the server. Documented in `_backups/ROLLBACK-2.0.15.md`.

- **SVG attribute escaping in whiteboard** (`src/whiteboard-cli.ts`).
  `parseSvgPath` and `sendWhiteboardMessage` interpolated
  user-controlled path data, stroke, and strokeWidth directly into
  SVG `<path>` attribute values, allowing a payload like
  `M10,10" onclick="alert(1)" x="M0,0` to inject arbitrary
  attributes (XSS) into the rendered SVG. The new `escapeAttr()`
  helper escapes the four attribute-context characters
  (`&`, `"`, `<`, `>`) before interpolation. Tested with a payload
  containing the XSS injection.

### Security (Medium)

- **Gateway RPC auth no longer on argv**
  (`src/gateway-client.ts:60-110`). The previous code passed
  `--token <token>` and `--password <password>` as command-line
  arguments to the spawned `openclaw gateway call` subprocess.
  These arguments are visible in `ps`, `wmic process get
  commandline`, Task Manager, and `/proc/<pid>/cmdline` for the
  duration of every RPC (up to 30s). The new code passes them
  as env vars on the spawn (`OPENCLAW_GATEWAY_TOKEN` and
  `OPENCLAW_GATEWAY_PASSWORD`) and emits a one-time warning that
  the residual risk on Linux is that the env vars are visible
  in `/proc/<pid>/environ`. The `openclaw` CLI as of 2026.6.6 does
  not yet read these env vars, so the gateway RPC will fail
  until the CLI is updated. The operator must either (a) set
  `OPENCLAW_GATEWAY_TOKEN` in the parent shell and let the
  plugin read it from there, or (b) wait for an upstream CLI
  release. See `_backups/ROLLBACK-2.0.15.md` for the explicit
  rollback if the new behaviour is unworkable.

### Security (CLI)

- **`cli-encrypt.ts` reads password from stdin**
  (`src/cli-encrypt.ts`). The previous implementation took the
  password from argv (`args[1]`), making it visible in process
  listings and shell history. The new primary path reads the
  password from stdin. The argv path is retained for
  backward-compatibility with the documented
  `echo "mypassword" | npx tsx …` invocation, but emits a
  deprecation warning to stderr. The implementation also gains
  support for the explicit `--config <path>` / `-c <path>` flag
  (the previous version's `args[2]` fallback didn't match the
  documented form).

### Fixed

- **`xmpp start` spawned the wrong process**
  (`src/commands.ts:67-86`). The previous code was
  `spawn(process.execPath, [process.argv[0], "gateway"], …)`
  which translates to `node.exe node.exe gateway` — the second
  `node.exe` is interpreted as a script name. The new
  `startGateway()` helper spawns `openclaw` directly, with a
  `cmd.exe /c openclaw gateway` wrapper on Windows so that PATH
  lookup works. The helper is exported, returns
  `{ ok: true, pid } | { ok: false, error }` so the caller can
  print a clean error, and supports a `_setSpawnForTests`
  injection hook.

- **`MessageStore.getDirectChatJIDs()` produced malformed JIDs**
  (`src/messageStore.ts:198-209`). The old code used a lossy
  `jid.replace(/[^a-zA-Z0-9@._-]/g, '_')` to derive a filename
  and then tried to round-trip with
  `f.replace('.json', '_').map(s => s.replace(/_/g, '.'))`. This
  mangled `user_at_domain.com` into `user.at.domain.com.`
  (replacing every `_` with `.`, including those in the original
  JID, and adding a trailing dot). The new code uses a
  bijective percent-encoding (`encodeJidForFilename` /
  `decodeJidFromFilename`) for the three characters legal in a
  JID but reserved in a filename: `.`, `/`, `_`. A
  best-effort `migrateLegacyFilenames()` runs in the constructor
  to rename pre-2.0.15 files. Files that cannot be safely
  renamed (because the old algorithm was lossy) are left in
  place; the `meta.chatJid` field on the file's metadata
  remains the canonical JID for those records.

- **`index.ts` gateway RPC handlers now `await` async client methods**
  (`index.ts:29-101`). The previous code called
  `client.joinRoom`, `client.leaveRoom`, `client.inviteToRoom`,
  and `client.send` / `client.sendGroupchat` without `await`,
  returning `ok: true` to the RPC caller before the underlying
  XMPP stanza was sent. Any rejection (e.g. a dead socket) was
  silently lost. The four handlers are now `async` and `await`
  the inner call so errors are propagated back to the caller
  via the RPC response. **Behavioural change:** operators who
  relied on the silent `ok: true` will now see real errors
  propagated.

### Added

- **`tests/critical-fixes.test.ts`** — 21 source-level tests
  covering Fix 1.1, Fix 1.4, Fix 1.6, Fix 1.7, Fix 1.8.
- **`tests/message-store-jid.test.ts`** — 13 tests covering
  Fix 1.5 (encoding, decoding, source-level assertions, a
  1000-iteration fuzz).
- **`tests/gateway-rpc.test.ts`** — 3 source-level tests
  covering Fix 1.2.
- **`tests/cli-encrypt.test.ts`** — 5 source-level tests
  covering Fix 1.3.
- **`_backups/ROLLBACK-2.0.15.md`** — full rollback procedure
  (Windows + Linux), partial-rollback matrix, verification
  greps, diagnostic-capture checklist.

### Backups

- `src/sftp.ts.backup-20260615-140000` (preserved for the rare
  case where SFTP is restored; the file was deleted in 2.0.15)
- `src/commands.ts.backup-20260615-140000`
- `index.ts.backup-20260615-140000`
- `src/messageStore.ts.backup-20260615-140000`
- `src/lib/upload-protocol.ts.backup-20260615-140000`
- `src/whiteboard-cli.ts.backup-20260615-140000`
- `src/cli-encrypt.ts.backup-20260615-140000`
- `src/gateway-client.ts.backup-20260615-140000`
- `src/types.ts.backup-20260615-140000`
- `src/lib/config-loader.ts.backup-20260615-140000`
- `tests/test.sh.backup-20260615-140000`
- `tests/test.ps1.backup-20260615-140000`
- `tests/test-common.sh.backup-20260615-140000`
- `tests/test-common.ps1.backup-20260615-140000`
- `tests/README.md.backup-20260615-140000`
- `package.json.backup-20260615-140000`
- `CHANGELOG.md.backup-20260615-140000`

### Notes

- All 8 critical issues from `docs/CODE_REVIEW.md` §1 (the
  v2.0.14 review) are addressed in this release.
- The pre-existing TypeScript errors in `index.ts:4`,
  `setup-entry.ts:1`, `src/cli-metadata.ts:8`, and
  `src/gateway.ts:271` (unrelated `openclaw/plugin-sdk/*`
  subpath import resolution) remain; they are not introduced
  by 2.0.15.
- The fix for §1.2 (gateway RPC) is best-effort: the `openclaw`
  CLI as of 2026.6.6 does not honour the env-var auth. An
  upstream CLI release is required to fully close the
  `/proc/<pid>/environ` residual risk on Linux.

## [2.0.14] - 2026-06-15

### Fixed

- **"Disconnected. Unexpected EOF while reading" on networks with SIP ALG /
  aggressive NAT idle timeouts** (`src/startXMPP.ts`, `src/config.ts`).

  Two PCs on a different network (both Windows, SIP ALG enabled on the
  router and unmodifiable) were dropping the XMPP stream after 30-90s
  of idleness.  The Prosody server reported "Disconnected. Unexpected EOF
  while reading" because the OS believed the TCP connection was still
  alive (no FIN/RST was sent) but the network path had silently dropped
  every packet in both directions.

  PCs on the original network (Win10, Win11, Linux) were unaffected.
  This release layers four independent liveness mechanisms so that if one
  is blocked or black-holed by a middlebox, the others still keep the
  NAT mapping warm and the socket is force-closed if it ever goes silent:

  1. **OS-level TCP keepalive on the underlying `net.Socket`** — the
     socket chain is walked (`@xmpp/tls/lib/Socket` -> `tls.TLSSocket`
     -> `net.Socket`) and `setKeepAlive(true, delaySec)` is called.  On
     Linux this is `TCP_KEEPIDLE`; on Windows it requires the
     `HKLM\System\CurrentControlSet\Services\Tcpip\Parameters\KeepAliveTime`
     registry key to be lowered to be effective (a warning is now
     logged on `win32` platforms explaining this).

  2. **Client-initiated XEP-0199 IQ ping with a pong-timeout watchdog**
     — every `Config.IQ_PING_INTERVAL_MS` (60s default) the plugin sends
     an IQ ping to the server.  If NO inbound bytes are received within
     `Config.IQ_PING_TIMEOUT_MS` (20s default), the underlying socket is
     `destroy()`-ed and the `disconnect` -> `offline` -> `scheduleReconnect`
     chain runs.  This catches the "OS thinks socket is open but the
     network has dropped it" failure mode that TCP keepalive misses.

  3. **XEP-0198 `<r/>` SM keepalive at `Config.SM_KEEPALIVE_INTERVAL_MS`**
     (25s, down from 30s) — the previous 30s was right on the edge of
     common 30-60s NAT idle timeouts.  `<r/>` is now only sent after SM
     is observed to be negotiated (via a `nonza` listener that tracks
     `<sm/>`, `<enabled/>`, and `<failed/>`); sending it to a server
     that hasn't negotiated SM would generate a stream:error and break
     the session.

  4. **Idle-socket watchdog (`Config.SOCKET_IDLE_TIMEOUT_MS`, 120s
     default)** — installs `data` / `end` / `error` listeners directly
     on the underlying `net.Socket` to stamp `lastInboundAt` on every
     received byte.  If no bytes have been received for the configured
     timeout, the socket is `destroy(new Error("idle-timeout"))`-ed and
     reconnection is scheduled.  This is the belt-and-braces safety net
     for the case where all of the above keepalive packets themselves
     get black-holed by a middlebox.

  5. **Optional SIP-ALG whitespace keepalive** (`Config.WHITESPACE_KEEPALIVE_INTERVAL_MS`,
     0 = disabled, recommended 45000 for SIP-ALG networks) — sends a
     single space character over the wire at the configured interval.
     This is the cheapest possible "still here" signal and is recognised
     by XEP-0198 SM as a no-op that still counts as activity.  Disabled
     by default; enable it on networks known to have SIP ALG or routers
     that aggressively re-bind idle NAT mappings.

### Added

- **Configurable keepalive tunables** in `src/config.ts`:
  - `TCP_KEEPALIVE_ENABLED` (default `true`)
  - `TCP_KEEPALIVE_INITIAL_DELAY_MS` (default `30000`)
  - `SM_KEEPALIVE_INTERVAL_MS` (default `25000`, was hard-coded `30000`)
  - `IQ_PING_INTERVAL_MS` (default `60000`)
  - `IQ_PING_TIMEOUT_MS` (default `20000`)
  - `SOCKET_IDLE_TIMEOUT_MS` (default `120000`)
  - `WHITESPACE_KEEPALIVE_INTERVAL_MS` (default `0` = disabled)

- **`lastDisconnectReason` is preserved across reconnect cycles** and
  logged on the next `online` event so the correlation between "why did
  the previous attempt die?" and "the new connection is up" is visible
  in `cli-debug.log`.

- **Defensive `typeof` guard** around the `xmppClient` reference in the
  `online` handler.  The `xmppClient` is declared as `const` later in
  the function; the guard makes it impossible for a future refactor to
  regress into a temporal-dead-zone crash if the declaration order is
  ever changed.

### Diagnostics

- The `disconnect` event now also logs the idle time (seconds since
  `lastInboundAt`) at the moment of the disconnect, which directly
  points at idle-timeout-induced drops.
- Each new liveness timer logs its creation, interval, and what it
  targets, so it's clear from `cli-debug.log` which timer is firing
  and which socket type it was bound to.
- Windows platform emits a one-time warning that the TCP-keepalive
  effectiveness depends on the `KeepAliveTime` registry key.

### Backups

- `src/startXMPP.ts.backup-20260615-130417`
- `src/config.ts.backup-20260615-130417`
- `package.json.backup-20260615-130417`
- `CHANGELOG.md.backup-20260615-130417`
- See `_backups/ROLLBACK-2.0.14.md` for full rollback procedure.

## [2.0.13] - 2026-06-15

### Changed

- **Added diagnostic logging for disconnect tracing** (`src/startXMPP.ts`):
  - SM `<r/>` keepalive timer now logs each send attempt and result to `cli-debug.log`
  - TCP keepalive socket chain walk logs each step (socket types, depth reached)
  - XEP-0199 ping response handler logs received ping requests with sender JID
  - Disconnect event logs full detail (clean/dirty, event type, code, reason message)
  - These help identify whether keepalives are actually reaching the network and what
    triggers the disconnect on affected networks

- **Set `connected` + `lastTransportActivityAt` runtime status** (`src/gateway.ts`):
  - Plugin now sets `connected: true` and `lastTransportActivityAt` on startup
  - Sets `connected: false` on stop (both graceful and abort)
  - Updates `lastTransportActivityAt` after each outbound message send
  - This gives the gateway's health monitor visibility into XMPP connection liveness

### Backups
- `src/startXMPP.ts.backup-20260615-103213`
- `src/gateway.ts.backup-20260615-103213`

## [2.0.12] - 2026-06-15

### Fixed

- **TCP keepalive now correctly targets the underlying TCP socket** (`src/startXMPP.ts`):
  After STARTTLS negotiation `xmpp.socket` is an `@xmpp/tls/lib/Socket` wrapper that
  does not expose `setKeepAlive()`. The previous fix silently skipped keepalive setup
  because the `typeof sock.setKeepAlive === "function"` guard returned false on the
  wrapper. Now walks the socket chain (`wrapper -> tls.TLSSocket -> net.Socket`) to
  find the actual socket, then enables TCP keepalive at a 30-second interval.

- **Added XEP-0198 stream management `<r/>` keepalive** (`src/startXMPP.ts`):
  Periodically sends `<r xmlns='urn:xmpp:sm:3'/>` every 30 seconds to generate
  actual XMPP traffic. The server responds with `<a/>`, keeping NAT/firewall
  mappings alive even on networks with aggressive idle timeouts. Unlike XEP-0199
  pings, this does not require the server to support IQ pings — stream management
  is already enabled. Timer is cleaned up on disconnect and restarted on reconnect.

### Backups
- `src/startXMPP.ts.backup-20260615-080144`

## [2.0.11] - 2026-06-12

### Changed

- **Removed all XEP-0199 XMPP ping functionality** (`src/startXMPP.ts`): The XMPP server at `kazakhan.com:5222` does not respond to `urn:xmpp:ping` IQ-get stanzas. Every ping attempt timed out after 30 seconds, filling the log with `ping failed (N consecutive)` warnings every 30 seconds — 48 lines of noise per 24 hours with no value. The pings were not keeping the connection alive (the connection was already stable without them after v2.0.10 removed the reconnect-on-failure trigger).

  **Removed code (was ~60 lines across 8 locations):**
  - Module-level constants `PING_INTERVAL_MS` (30s), `PING_TIMEOUT_MS` (30s)
  - Module-level variables `isRunning`, `pingTimer`, `pingOutstanding`, `consecutivePingFailures`
  - Functions `sendPing()` (async, sends IQ-get, polls for result), `schedulePing()` (setInterval wrapper), `stopPingTimer()` (clearTimeout + reset)
  - Call sites: `online` handler (`isRunning = true; schedulePing();`), `offline` handler (`isRunning = false; stopPingTimer();`), `xmppClient.stop()` (`stopPingTimer(); isRunning = false;`), `xmpp.start().catch()` (`isRunning = false;`)

  **Connection keepalive preserved**: The underlying TCP socket is maintained by `@xmpp/client`'s own transport layer. The `offline` event (fires on genuine disconnection) still triggers `scheduleReconnect()`, and the `error` event handler still logs transport errors. NAT/firewall keepalive (if needed in the future) should be implemented at the TCP level (e.g., `TCP_KEEPALIVE` socket option) rather than with application-level stanzas.

### Backups
- `_backups/2.0.11_20260612_215438/` — pre-edit `src/startXMPP.ts`, `package.json`

## [2.0.9] - 2026-06-12

### Fixed

- **Added `process.on('unhandledRejection')` handler to diagnose and prevent gateway crash** (`src/startXMPP.ts:31-38`): The gateway process was crashing silently after ~18 seconds of uptime with no error message in the console or log. The only evidence was that the JSON log file stopped being written (last entry: `"agent runtime plugins pre-warmed"`) and the PowerShell prompt returned.

  **Root cause diagnosis**: The crash is consistent with an **unhandled promise rejection** in an async callback — in Node.js v15+, unhandled rejections terminate the process with exit code 1 and NO console output if the rejection happens in a timing where stdout/stderr has already been consumed by the gateway's structured logger.

  **Fix**: Added a module-level `process.on('unhandledRejection', ...)` handler that:
  - Logs the rejection reason and stack trace via the XMPP plugin's `log.error()` (visible in both the gateway log file and console)
  - **Prevents process termination** — attaching any handler overrides Node.js v15+'s default `--unhandled-rejections=throw` behavior, keeping the gateway alive even if an async callback rejects unexpectedly
  - Catches rejections from ANY async callback in the plugin: stanza handlers, ping timers, reconnect timers, file transfers, etc.
  - Is registered at module load time (before any async code runs), so no rejection can escape it

  **Note**: This is a diagnostic safety net, not a root-cause fix. The `isRunning = true` fix in v2.0.8 should prevent the original 60-second idle disconnect (which would trigger the offline handler and potentially the crash). If the crash persists after v2.0.9, the handler will print the exact rejection reason and stack trace, enabling a precise fix.

### Backups
- `_backups/2.0.9_20260612_204031/` — pre-edit `src/startXMPP.ts`, `package.json`

## [2.0.10] - 2026-06-12

### Fixed

- **Removed ping-failure reconnect trigger from `schedulePing()`** (`src/startXMPP.ts:334-338`): The 3-strikes policy (`consecutivePingFailures >= 3`) was tearing down a healthy connection and forcing reconnect every ~90 seconds. The XMPP server at `kazakhan.com:5222` is alive and the TCP socket is fine — it simply doesn't respond to `urn:xmpp:ping` IQ-get stanzas. `xmpp.send()` succeeds (proving the connection works), but no `type="result"` ever comes back, so the 30-second polling loop in `sendPing()` always times out.

  **Fix**: Removed the reconnect escalation entirely. Ping failures now just log and reschedule — the TCP-level keepalive effect of sending actual bytes on the wire is the real value of the ping mechanism, not the server's response. The only triggers for reconnection remain the `offline` event (fires when the transport genuinely dies) and the initial `xmpp.start().catch()` handler.

- **Logged actual ping send error** (`src/startXMPP.ts:312-313`): The `catch` block in `sendPing()` now logs the real error via `xmppLog.error("ping send error", err)`, so if the server stops responding or a real transport error occurs, the exact reason will appear in the gateway log.

### Backups
- `_backups/2.0.10_20260612_213727/` — pre-edit `src/startXMPP.ts`, `package.json`

## [2.0.8] - 2026-06-12

### Fixed

- **Reverted `tsconfig.json` module resolution** (`tsconfig.json:4-5`): Changed `"module": "Node16"` / `"moduleResolution": "Node16"` back to `"module": "ES2020"` / `"moduleResolution": "node"` (matching the working v2.0.0 install on the old machine). The `Node16` settings changed how the gateway's TypeScript loader resolves imports at runtime, which could cause missing-module errors or incorrect compilation in edge cases.

- **Restored built-in reconnect delay** (`src/startXMPP.ts:213-215`): Added back `if ((xmpp as any).reconnect) { (xmpp as any).reconnect.delay = 5000; }` which was removed in v2.0.3 (code review fix #3.1). The old working install had this setting, and removing it changed the `@xmpp/client` built-in reconnect behavior from a 5-second delay to an aggressive default (~1s), potentially causing rapid reconnect cycles.

- **Added `isRunning = true` in online handler** (`src/startXMPP.ts:348`): The module-level `let isRunning = false` (line 27) was never set to `true` anywhere in the file, which meant `sendPing()` always returned `false` immediately and `schedulePing()`'s timer callback always bailed at the `if (!isRunning) return;` check. No pings ever fired. This is now set to `true` when the `online` event fires, enabling the 30-second ping keepalive to actually work.

## [2.0.7] - 2026-06-12

### Fixed

- **Removed `Promise.race` from `sendPing()` (crash root cause)**: The v2.0.4 addition of `Promise.race` between `xmpp.send()` and a 30-second timeout caused an **unhandled promise rejection** that crashed the gateway process. When the timeout fired first (while `xmpp.send()` hung on a dead connection), the race was decided, but `xmpp.send()` remained pending. On its eventual rejection, Node.js emitted `unhandledRejection` and crashed with exit code 1. Reverted to the v2.0.3 approach — plain `await xmpp.send(...)` inside a `try/catch` — which has zero risk of unhandled rejections. The 30s polling loop (`PING_TIMEOUT_MS`) still guards against unresponsive connections.

### Remaining changes from v2.0.3 (not affecting crash stability)

- `RECONNECT_MAX_MS` reduced from 60000 to 15000 (vanity improvement, not involved in crash)
- All v2.0.4/2.0.5/2.0.6 additions (`Promise.race`, transport handlers, health check) are now fully reverted

## [2.0.6] - 2026-06-12

### Fixed

- **Timeout leak in `sendPing()` caused process crash after ~60 seconds** (`src/startXMPP.ts:313`): The v2.0.4 `Promise.race` timeout discarded the `setTimeout` handle. When `xmpp.send()` settled first (winning the race), the 30-second timeout was never cancelled. 30 seconds later, `reject()` fired on an already-settled Promise, triggering an unhandledPromiseRejection that crashed Node.js with exit code 1. Combined with other timers, this produced the ~60-second crash the user observed.

  **Fix**: Captured the timeout handle (`sendTimer`) and `clearTimeout(sendTimer)` immediately after the `Promise.race` settles on both success and failure paths (`try` and `catch`). The timer can never fire after the race is decided.

- **Removed transport-level event handlers** (`disconnect`/`close`/`end`): These were added in v2.0.4 but fired during normal `xmpp.stop()` calls inside `scheduleReconnect()`, causing double-reconnect loops and log noise.

- **Removed early health check timeout** (2s after `online`): Added in v2.0.4, this fired during gateway boot and could trigger `scheduleReconnect()` before plugin initialization completed.

### Backups

- `_backups/2.0.6_20260612_190022/` — pre-edit source files

## [2.0.5] - 2026-06-12

### Fixed

- **Early health check did not trigger reconnection** (`src/startXMPP.ts:431`): The v2.0.4 health check ping ran 2s after `online` and correctly detected that the connection was already dead (`sendPing()` returned `false`), but only logged a warning — it never called `scheduleReconnect()`. The `catch` block had reconnect logic, but `sendPing()` does not throw on failure (it returns `false`). This left the plugin in `isRunning = true` state indefinitely, waiting for 3 regular ping failures before eventually reconnecting.

  **Fix**: Added reconnection logic (`isRunning = false`, `stopPingTimer()`, `scheduleReconnect()`) to the `!ok` (returned `false`) branch of the health check, matching the existing logic in the `catch` branch.

## [2.0.4] - 2026-06-12

### Fixed — Reliability

- **`xmpp.send()` hangs forever on dead TCP socket** (`src/startXMPP.ts:283`): When the server silently kills the connection (e.g., NAT/firewall idle timeout ~60s), `xmpp.send()` in `sendPing()` never settled — the promise hung indefinitely. The 30-second polling loop at lines 286-290 was never reached because `await xmpp.send(...)` blocked forever. This silently killed the entire keepalive mechanism: no more pings fired, no reconnection triggered, and the plugin appeared connected while being dead.

  **Fix**: Wrapped `xmpp.send(...)` with `Promise.race()` against a 30-second timeout (`SEND_TIMEOUT_MS`). If the `send` doesn't settle within 30 seconds, the promise rejects with `"ping send timeout"`, `sendPing()` returns `false`, and the ping failure/retry logic proceeds normally.

- **Missing transport-level event handlers** (`src/startXMPP.ts:257-284`): The code handled only `@xmpp/client`'s `offline` event (line 245). The underlying TCP transport can emit `disconnect`, `close`, or `end` without `offline` firing, depending on the failure mode. Without handlers for these events, a broken connection was never detected and never reconnected — no log messages were produced.

  **Fix**: Added three new event handlers (`disconnect`, `close`, `end`) that each log a warning, set `isRunning = false`, stop the ping timer, and call `scheduleReconnect()`. Each handler guards against double-invocation by checking `isRunning` before proceeding.

- **Reconnect backoff max was 60 seconds** (`src/startXMPP.ts:22`): `RECONNECT_MAX_MS = 60000` caused the reconnection backoff to plateau at 60-second intervals after 6 failed attempts. This meant a long silent period during retry loops, creating the appearance of a permanently dead connection.

  **Fix**: Reduced `RECONNECT_MAX_MS` from `60000` to `15000` (15 seconds). The backoff sequence is now: 1s, 2s, 4s, 8s, 15s (capped), 15s, 15s...

- **No early health check after connect** (`src/startXMPP.ts`): After the `online` event fired, the first ping was not scheduled until `PING_INTERVAL_MS` (30s) later. If the connection was broken between `online` and the first ping, the plugin would be unresponsive for up to 30 seconds before detecting the failure.

  **Fix**: Added a `setTimeout(..., 2000)` inside the `online` handler that fires a health check ping 2 seconds after connection. If the ping fails, it triggers immediate reconnection. This detects early connection failures (e.g., server dropping the socket right after accepting it) within 2 seconds instead of 30+.

## [2.0.3] - 2026-06-12

### Fixed — Critical

- **Undefined `inviter` variable in conference invite handler** (`src/startXMPP.ts:1171`): The `shouldAcceptInvite()` call and subsequent log warning referenced `inviter` which was never declared. Added `const inviter = from;` using the stanza sender's full JID (available from the message handler scope). Previously, receiving a MUC room invitation via body-parsed `jabber:x:conference` would throw a `ReferenceError`.

- **Undefined `log` variable in `sendSxeInvitation()`** (`src/whiteboard.ts:815,818`): The function used `log.debug()` and `log.error()` but never imported `log`. Added `import { log } from "./lib/logger.js"` at the top of the file. Previously, any SXE whiteboard invitation would throw a `ReferenceError`.

- **Duplicate interface declarations in `src/gateway.ts:24-33`**: `LifecycleDeps` and `LifecycleServices` were each declared twice. TypeScript merges same-named interfaces, so the second declarations (with wider `any` types) silently overrode the properly-typed first declarations. Removed the second pair of declarations, restoring type safety to the `GatewayLifecycle` constructor.

### Fixed — High Severity

- **`moduleResolution: "node"` blocks subpath imports** (`tsconfig.json`): Changed `"module": "ES2020"` → `"Node16"` and `"moduleResolution": "node"` → `"Node16"`. This resolves 6 `TS2307` errors for imports from `openclaw/plugin-sdk/*` (subpath exports), enabling proper type checking of SDK-dependent code.

- **`sendMedia()` destructures `Record<string, unknown>` without narrowing** (`src/outbound.ts:125`): The function extracted `to`, `text`, `mediaUrl`, `accountId`, `deps` from untyped params, leading to 5 type errors when calling `.includes()`, `.split()`, etc. Rewrote the function signature with early type assertions for all used fields. Also added explicit `Promise<...>` return type.

- **Ping failure logging invisible in gateway logs** (`src/startXMPP.ts:311-327`): Ping success/failure used only `xmppLog` (child logger) which writes to a namespace not captured in the main gateway log. Added `log.info("XMPP ping succeeded")` and `log.warn("XMPP ping failed (attempt N/3)")` so keepalive events appear in the main log.

- **`vcard-cli.ts` missing `crypto` import and wrong argument order** (`src/vcard-cli.ts:11,83,203`): Added `import crypto from 'crypto'` (the file used `crypto.createHash` without importing the module, which would throw `ReferenceError` at runtime). Fixed `requestUploadSlot(xmpp, filename, size)` → `requestUploadSlot(xmpp, xmppConfig.domain, filename, size)` — the second parameter is `domain`, not `filename`; the `domain` argument was omitted entirely.

- **`sendFileWithHTTPUpload()` missing `xmpp` and `domain` arguments** (`src/startXMPP.ts:2490`): The call passed `(to, filePath, text, isGroupChat)` but the function expects `(xmpp, to, filePath, domain, text, isGroupChat)`. Fixed to `sendFileWithHTTPUpload(xmpp, to, filePath, cfg.domain, text, isGroupChat)`.

- **`security/adapter.ts` imports non-existent `ChannelSecurityAdapter`** (`src/security/adapter.ts:1`): `openclaw/plugin-sdk` no longer exports `ChannelSecurityAdapter` (it exports `ChannelSetupAdapter`). Replaced the import with a local interface definition matching the actual usage pattern (`collectWarnings`, `collectAuditFindings`).

- **`gateway.ts:130-131` — `runtime.channel.session` methods not callable**: `PluginRuntime.channel.session` is typed as `Record<string, unknown>`, so `.resolveStorePath()` and `.recordInboundSession()` return `unknown`. Added a typed cast for the session object at point of use.

### Fixed — Medium Severity

- **Conflicting reconnect mechanisms** (`src/startXMPP.ts:213-217`): Removed the block that set built-in `@xmpp/client` reconnect delay to 5000ms. The custom `scheduleReconnect()` with exponential backoff is the single source of truth for reconnection. Previously, both mechanisms could race, causing rapid connect/disconnect cycles on network issues.

- **Ping failure triggers full reconnect on single miss** (`src/startXMPP.ts:258,304-328`): Previously, one failed ping immediately tore down the connection via `scheduleReconnect()`. Changed to track `consecutivePingFailures` counter — only triggers reconnect after 3 consecutive failures. On success, counter resets to 0. Also resets on `online` event.

- **`StanzaElement.text()` type mismatch** (`src/types.ts:211`): The interface declared `getText(): string` but `@xmpp/client`'s actual API is `.text()`. Renamed to match reality, fixing 20+ type errors in `vcard-protocol.ts`.

- **`WhiteboardPath` missing `fill`, `elementType`, `elementAttrs`** (`src/types.ts:122-127`, `src/whiteboard.ts:3-8`): Added these three optional properties to both interface declarations. The properties are used in `reconstructPathsFromState()` but were missing from the type, causing 4 type errors.

- **`upload-protocol.ts` uses non-existent `.getText()`** (`src/lib/upload-protocol.ts:123`): Changed `header.getText()` → `header.text()` to match the actual `@xmpp/client` API (which has `.text()`, not `.getText()`).

- **`gateway.ts` type mismatches in `accountId` usage** (`src/gateway.ts:108,135`): Replaced `config.accountId` with `account.accountId` — the `accountId` is on the account object, not the config object.

- **`AccountSnapshot` timestamp types too narrow** (`src/types.ts:257-258`): Changed `lastStartAt` and `lastStopAt` from `string | null` to `number | string | null` since `Date.now()` returns a number and the runtime stores timestamps as numbers.

- **`XmppConfig` missing `session` and `accountId` fields** (`src/types.ts:1-14`): Added optional `session`, `enabled`, and `accountId` properties to match runtime usage in `gateway.ts`.

- **Queue flush on shutdown** (`src/queue-bridge.ts:39-42`, `src/channel-plugin.ts:7,116-118`): Added `flushQueue()` export to `queue-bridge.ts`. Updated `channel-plugin.ts`'s `stopAccount` wrapper to call `await flushQueue()` before stopping the gateway lifecycle, ensuring the message queue is persisted before shutdown.

- **`index.ts:140-141,144` — `jid` typed as `unknown`** (`index.ts:127-128`): The gateway method handler destructured `jid` and `message` from untyped params, causing `includes()`/`split()` calls to fail type checking. Added explicit `as string` type assertions.

### TypeScript compilation results

- **Before v2.0.3**: 39 type errors, suppressed by `noEmitOnError: false`
- **After v2.0.3**: **0 type errors** — `npx tsc` completes cleanly

### Files changed
| File | Issues |
|------|--------|
| `tsconfig.json` | 2.1/2.2 — moduleResolution fix |
| `src/types.ts` | 3.3, 3.4, 3.5 — StanzaElement, WhiteboardPath, AccountSnapshot, XmppConfig |
| `src/startXMPP.ts` | 1.1, 2.4, 3.1, 3.2, (extra) — inviter, ping logging, reconnect, ping retry, sendFileWithHTTPUpload |
| `src/whiteboard.ts` | 1.2, 3.4 — log import, WhiteboardPath fill |
| `src/gateway.ts` | 1.3, 3.5 — duplicate interfaces, accountId, session cast |
| `src/outbound.ts` | 2.3 — sendMedia type assertions |
| `src/vcard-cli.ts` | 2.5 — crypto import, requestUploadSlot args |
| `src/lib/upload-protocol.ts` | 3.3 — getText → text |
| `src/queue-bridge.ts` | 3.5 — flushQueue export |
| `src/channel-plugin.ts` | 3.5 — flushQueue on stopAccount |
| `src/security/adapter.ts` | 2.5 — ChannelSecurityAdapter local interface |
| `index.ts` | 2.3 — jid/message type assertions |

### Backups (for rollback)
- `_backups/2.0.3_20260612_170302/` — all 9 pre-edit source files

## [2.0.2] - 2026-06-11

### Fixed

- **Install scripts use deprecated `--dangerously-force-unsafe-install` flag**: Both `install.ps1` (line 72) and `install.sh` (line 49) passed `--dangerously-force-unsafe-install` to `openclaw plugins install`. This flag was deprecated in a later CLI build and is now a no-op. When the plugin was already tracked, `openclaw plugins install --link` would exit with code 1 and the message *"plugin already exists... delete it first"*, which the scripts' error handling (`$ErrorActionPreference = "Stop"` / `set -euo pipefail`) treated as a fatal failure.

### Changed

- **`install.ps1` line 72**: Replaced `openclaw plugins install --link --dangerously-force-unsafe-install $PluginDir` with `openclaw plugins install --link --force $PluginDir`.
- **`install.sh` line 49**: Replaced `openclaw plugins install --link --dangerously-force-unsafe-install "$PLUGIN_DIR"` with `openclaw plugins install --link --force "$PLUGIN_DIR"`.

#### Backups (for rollback)
- `_backups/2.0.2_20260611_212551/install.ps1.bak` — pre-edit `install.ps1` (110 lines, `--dangerously-force-unsafe-install`)
- `_backups/2.0.2_20260611_212551/install.sh.bak` — pre-edit `install.sh` (78 lines, `--dangerously-force-unsafe-install`)

## [2.0.1] - 2026-06-11

### Fixed

- **ECONNRESET disconnection after ~2 minutes**: Reduced XMPP ping keepalive interval (`PING_INTERVAL_MS`) from **5 minutes** to **30 seconds** in `src/startXMPP.ts:18`. The XMPP server (kazakhan.com:5222) was resetting idle TCP connections after ~138 seconds of inactivity. The previous 5-minute ping interval meant the first XEP-0199 keepalive ping never fired before the server dropped the connection. With the interval reduced to 30 seconds, a stanza-level ping is sent well before the server's idle timeout, keeping the connection alive.

#### Root Cause
The `PING_INTERVAL_MS` constant was set to `5 * 60 * 1000` (300,000ms). The XMPP server has an idle timeout of approximately 138 seconds (~2m 18s). The ping timer was set to fire the first ping after 5 minutes of being online — but the server would already have killed the TCP connection by then. The `ECONNRESET` triggered the `offline` event, which stopped the ping timer and scheduled an exponential-backoff reconnect. The connection would come back up but the same cycle repeated every ~2 minutes.

#### Verification
- Before: `openclaw gateway call health` shows `lastError: null` but logs reveal `ECONNRESET` every ~138s, followed by reconnect/recovery.
- After: Connection stays alive past the 2-minute mark. Health endpoint shows `running: true`, `lastError: null` continuously for >3.5 minutes (verified at time of release). Log shows no `ECONNRESET` entries from the 30s-ping session.

#### Files changed
- `src/startXMPP.ts` — line 17-18: comment and value for `PING_INTERVAL_MS` changed from `5 * 60 * 1000` to `30 * 1000`, with comment updated from "5 minutes" to "30 seconds".

#### Backups (for rollback)
- `_backups/2.0.1_20260611_154945/src-startXMPP.ts.bak` — pre-edit `src/startXMPP.ts` (2533 lines, unchanged except for PING_INTERVAL_MS)

#### Rollback procedure
1. `openclaw gateway stop`
2. `Copy-Item -Force _backups/2.0.1_20260611_154945/src-startXMPP.ts.bak src/startXMPP.ts`
3. `npx tsc`
4. `openclaw gateway start`

## [2.0.0] - 2026-06-07

### Changed - BREAKING: Migrated to OpenClaw 2026.6.1 bundled channel entry contract

#### Root Cause
After upgrading the host OpenClaw CLI from 2026.5.7 to 2026.6.1, the XMPP plugin was still being *discovered* (`openclaw plugins list` showed it as `Status: loaded`, `Shape: plain-capability`, `Capability: channel: xmpp`) but the gateway never started the channel. `openclaw gateway call health` reported `"channels": {}`, `"channelOrder": []`, `"channelLabels": {}` — the XMPP plugin was loaded but its `gateway.startAccount` was never invoked.

The legacy `register(api) -> api.registerChannel({ plugin })` shape from OpenClaw 2026.5.x is still accepted by the 2026.6.1 loader, but the new SDK no longer activates the channel on the old contract. The plugin's `openclaw.plugin.json` lacked `activation` and `channelEnvVars`, and the inline `configSchema` was rejected by the new bundling contract, so the SDK skipped the channel-start step.

The `install.ps1` post-build step also silently failed: it issued `openclaw config set plugins.entries.xmpp.source "extensions/xmpp"`, but in 2026.6.1 the `source` key is no longer valid (the new `openclaw plugins install` command replaces it). The script piped both lines through `| Out-Null` and never checked `$LASTEXITCODE`, so the failure was hidden and the install "hung" with no visible error.

#### What changed

- **Migrated to the bundled-channel-entry contract** (`defineBundledChannelEntry` / `defineBundledChannelSetupEntry` from `openclaw/plugin-sdk/channel-entry-contract`), matching the pattern used by the bundled `matrix` and `msteams` plugins.
  - **New** `channel-plugin-api.ts` (root) — re-exports `xmppChannelPlugin` from `./src/channel-plugin.js`.
  - **New** `runtime-setter-api.ts` (root) — re-exports `setXmppRuntime` from `./src/state.js`.
  - **New** `secret-contract-api.ts` (root) — re-exports `channelSecrets` from `./src/secret-contract.js`.
  - **New** `setup-plugin-api.ts` (root) — re-exports `xmppSetupPlugin` from `./src/setup-plugin.js`.
  - **Rewritten** `index.ts` (root) — thin `defineBundledChannelEntry({ id, name, description, importMetaUrl, plugin, secrets, runtime, registerCliMetadata, registerFull })`. Re-exports `xmppClients`, `contactsStore`, `getPluginRuntime`, `setXmppRuntime`, `isPluginRegistered`, `addToQueue`, `getUnprocessedMessages`, `markAsProcessed`, `clearOldMessages` for backward compatibility with `src/outbound.ts`.
  - **Rewritten** `setup-entry.ts` (root) — thin `defineBundledChannelSetupEntry({ importMetaUrl, plugin, secrets, runtime })`.
- **Extracted channel plugin definition** to `src/channel-plugin.ts` (new) — owns the `xmppChannelPlugin` object (id, meta, capabilities, messaging, configSchema, config, status, security, outbound, gateway). The `gateway.startAccount` and `gateway.stopAccount` are now bound to a `GatewayLifecycle` instance that reads from the shared state module.
- **Extracted state globals** to `src/state.ts` (new) — `xmppClients`, `contactsStore`, `pluginRuntime`, `pluginRegistered` plus `getPluginRuntime()`, `setXmppRuntime()`, `isPluginRegistered()`, `markPluginRegistered()`. This guarantees a single Map instance is shared between the channel lifecycle, the outbound senders, and the CLI handlers.
- **Extracted persistent queue helpers** to `src/queue-bridge.ts` (new) — `addToQueue`, `markAsProcessed`, `getUnprocessedMessages`, `clearOldMessages`, `getMessageQueue()`. Previously inlined in `index.ts` and not accessible to `src/cli-metadata.ts`.
- **Extracted gateway methods** to `registerXmppGatewayMethods(api)` in the new `index.ts` — passes the function as `registerFull` so the new SDK calls it at `registrationMode: "full"`. The full set of `xmpp.joinRoom`, `xmpp.leaveRoom`, `xmpp.getJoinedRooms`, `xmpp.inviteToRoom`, `xmpp.removeContact`, `xmpp.sendMessage` is preserved.
- **Extracted CLI registration** to `src/cli-metadata.ts` (new) — defines `registerXmppCliMetadata(api)` which calls `api.registerCli(...)` with the `xmpp` command and the existing `registerXmppCli` from `src/commands.ts`. The "commands: xmpp" descriptor is preserved.
- **New** `src/secret-contract.ts` — minimal `channelSecrets` stub with a `secretTargetRegistryEntries` entry for `channels.xmpp.accounts.*.password` and a no-op `collectRuntimeConfigAssignments`. The XMPP plugin does not need to actively rewrite config on secret resolve, but the entry is wired so the new SDK can discover the secret surface.
- **New** `src/setup-plugin.ts` — minimal `xmppSetupPlugin` for the setup-entry path. Same shape as the channel plugin (id, meta, capabilities, config, configSchema) but without the runtime/gateway bindings.
- **`openclaw.plugin.json`** — added `commandAliases: [{ name: "xmpp" }]`, `activation: { onStartup: true, onCommands: ["xmpp"] }`, and `channelEnvVars.xmpp: ["XMPP_SERVICE", "XMPP_DOMAIN", "XMPP_JID", "XMPP_PASSWORD", "XMPP_DATADIR", "XMPP_RESOURCE", "XMPP_ADMIN_JID", "XMPP_NICK"]`. Kept the full `configSchema` and `channelConfigs.xmpp` blocks (the XMPP account schema is non-trivial and matrix's empty-shell `additionalProperties: false` does not match).
- **`package.json`** — bumped version to `2.0.0`, `compat.pluginApi` to `>=2026.6.1`, `compat.minGatewayVersion` to `2026.6.1`, `build.openclawVersion` to `2026.6.1`, `build.pluginSdkVersion` to `2026.6.1`. Kept `openclaw.extensions: ["./index.ts"]` and `openclaw.setupEntry: "./setup-entry.ts"`.
- **`tsconfig.json`** — `include` now lists the four new root-level entry files (`channel-plugin-api.ts`, `runtime-setter-api.ts`, `secret-contract-api.ts`, `setup-plugin-api.ts`) and `exclude` now skips `_backups`, `_trash`, `tests` so the build doesn't pick up old state.
- **`install.ps1`** — replaced the broken `openclaw config set plugins.entries.xmpp.source "extensions/xmpp"` + `openclaw config set plugins.entries.xmpp.enabled true` pair with `openclaw plugins install --link --dangerously-force-unsafe-install "$PluginDir"`. Added `$ErrorActionPreference = "Stop"` at the top, removed `| Out-Null` from the install/registration lines, and added `$LASTEXITCODE` checks after every step so failures surface as exceptions instead of silent hangs. Replaced the `cmd /c mklink /J` call with the native `New-Item -ItemType Junction` cmdlet. Captures `npx tsc` output to `.tsc.log` and warns on error (preserves the existing `noEmitOnError: false` behavior). Final step now recommends `openclaw gateway restart` instead of starting a duplicate foreground gateway.
- **`install.sh`** — same fix in bash: replaced the `--force` install with `--dangerously-force-unsafe-install` (the new 2026.6.1 install command rejects `--force` on `--link`, and the plugin's CLI command needs the unsafe-install override for the `child_process` usage in `src/commands.ts` and `src/gateway-client.ts`). Added `set -euo pipefail`. Wires `openclaw config set plugins.entries.xmpp.enabled true` and `openclaw config set messages.groupChat.visibleReplies automatic` after install (both with `|| true` so a transient config error doesn't fail the whole install).

#### Backups (pre-edit, for rollback)
- `_backups/2.0.0_20260607_103340/index.ts.bak` — pre-edit `index.ts` (legacy `register(api)` shape, 14635 bytes)
- `_backups/2.0.0_20260607_103340/setup-entry.ts.bak` — pre-edit `setup-entry.ts` (38 bytes)
- `_backups/2.0.0_20260607_103340/openclaw.plugin.json.bak` — pre-edit plugin manifest (2723 bytes, legacy shape with inline full account configSchema)
- `_backups/2.0.0_20260607_103340/package.json.bak` — pre-edit `package.json` (1236 bytes, version 1.3.1)
- `_backups/2.0.0_20260607_103340/install.ps1.bak` — pre-edit `install.ps1` (3568 bytes, broken `config set` flow)
- `_backups/2.0.0_20260607_103340/install.sh.bak` — pre-edit `install.sh` (2067 bytes, `openclaw plugins install --force`)
- `_backups/2.0.0_20260607_103340/src-gateway.ts.bak` — pre-edit `src/gateway.ts` (18779 bytes, unchanged by this release but kept for cross-reference)
- `_backups/2.0.0_20260607_103340/src-outbound.ts.bak` — pre-edit `src/outbound.ts` (6737 bytes, unchanged by this release)
- `_backups/2.0.0_20260607_103340/CHANGELOG.md.bak` — pre-edit `CHANGELOG.md` (64589 bytes)

#### Rollback procedure
1. `Stop-Process -Id <gateway-pid> -Force` (or `openclaw gateway stop`).
2. `Copy-Item -Force _backups/2.0.0_20260607_103340/*.bak -Destination .` (renaming each `.bak` back to its original name).
3. `Remove-Item -Recurse -Force dist` and `npx tsc`.
4. `openclaw plugins install --link --force C:/Users/kazak/.openclaw/extensions/xmpp` (use the old `--force` flag because the pre-2.0.0 manifest doesn't have the unsafe-install override).
5. `openclaw gateway restart`.

#### Verification (after upgrade)
- `openclaw plugins inspect xmpp` → `Version: 2.0.0`, `Status: loaded`, `Shape: plain-capability`, `Capabilities: channel: xmpp`, `Commands: xmpp`.
- `openclaw channels list` → `XMPP default (clawdbothome@kazakhan.com): installed, configured, enabled, token=config`.
- `openclaw gateway call health` → `"channels": { "xmpp": { "running": true, "lastStartAt": 1780793277668, "lastError": null, ... } }` (previously empty `{}`).
- `openclaw-2026-06-07.log` shows: `http server listening (5 plugins: ..., xmpp; 9.8s)` → `XMPP gateway.startAccount called` → `starting XMPP connection to xmpp://kazakhan.com:5222` → `loaded 10 contacts` → `XMPP online as clawdbothome@kazakhan.com/clawdbothome` → `Presence with XEP-0115 caps sent` → `vCard registered with server`.
- Pre-upgrade: 0/5 channels, `channels: {}`; post-upgrade: 1/5 channels, `channels: { xmpp: { running: true } }`.

#### Known issues (out of scope for this release)
- `dist/index.js` and the root `index.ts` still emit TypeScript errors from pre-existing `src/` files (e.g. duplicate `LifecycleDeps`/`LifecycleServices` interfaces in `src/gateway.ts:12-33`, undefined `inviter` in `src/startXMPP.ts:1172-1173`, `vcard-protocol.ts` stanza-type drift). These were already present in 1.x and are non-blocking because `tsconfig.json` keeps `noEmitOnError: false`. The compiled `dist/` is functional and the channel runs end-to-end.
- The `cli-debug.log` files (`./cli-debug.log` and `./dist/cli-debug.log`) are no longer auto-trimmed. The pre-1.x logging behaviour (`setDebugLogDir(__dirname)` writing to `dist/cli-debug.log`) is preserved as-is.

## [1.9.2] - 2026-05-08

### Fixed
- **Windows ESM import resolution**: Compiled `dist/` JS couldn't resolve `import("openclaw/plugin-sdk/...")` because the `openclaw` package isn't in the plugin's `node_modules/`. Added junction symlink in `install.ps1` and `noEmitOnError: false` in tsconfig.

#### Changes
- **`install.ps1`**:
  - Added junction creation linking global npm `openclaw` into `node_modules\openclaw` so compiled JS resolves SDK imports
  - Replaced `openclaw plugins install` (fails with EBUSY on Windows) with direct config-based registration via `config set plugins.entries.xmpp.source`
  - Removed `--noEmitOnError false` flag (now handled by tsconfig.json)
- **`tsconfig.json`**:
  - Added `noEmitOnError: false` to emit JS files despite pre-existing type errors (required for Windows tsc compatibility)
- **`src/whiteboard-session.ts`**:
  - Restored from `_backups/` (accidentally moved during cleanup — actively imported by `startXMPP.ts`)

#### Backups
- `install.ps1.backup_20260508_175731` - Before adding junction creation for global openclaw
- `tsconfig.json.backup_20260506_131654` - Before adding noEmitOnError: false

## [1.9.1] - 2026-05-05

### Fixed
- **XMPP connection TimeoutError after OpenClaw 2026.5.x upgrade**: Increased connection timeout from 2s to 30s.
- **Agent not replying to messages — rewritten dispatch to use modern pipeline**: The hand-rolled `simpleDispatcher` + `dispatchReplyFromConfig` approach was incompatible with OpenClaw 2026.5.3's reply dispatch pipeline. Replaced with the modern `dispatchInboundReplyWithBase` pattern (same approach used by IRC plugin).

#### Root Causes
1. The `@xmpp/connection` has a hardcoded 2-second default timeout for stream opening. Under OpenClaw 2026.5.x's jiti-based TypeScript loader, plugin initialization can take longer, causing the connection attempt to time out.

2. **Primary reply dispatch failure — incompatible with OpenClaw 2026.5.3**: The hand-rolled `simpleDispatcher` + `dispatchReplyFromConfig` approach bypassed the turn kernel that OpenClaw 2026.5.3 now requires. The dispatch was missing `sendToolResult`, had wrong return types, wrong `getQueuedCounts` keys (`toolResult` vs `tool`), missing `getFailedCounts`, and missing `markComplete`. Even with all those fixed, the low-level approach doesn't go through the proper route resolution, session recording, and reply pipeline orchestration that modern OpenClaw expects.

3. **Groupchat replies silently suppressed**: OpenClaw 2026.5.3's `resolveSourceReplyDeliveryMode` defaults group/channel messages to `"message_tool_only"`, which sets `suppressDelivery = true`. The agent response is stored in the session (visible in OpenClaw webchat) but the channel's `deliver` callback is never invoked. Direct messages default to `"automatic"` so they work. Fix: set `messages.groupChat.visibleReplies = "automatic"` in config.

#### Changes
- **`src/gateway.ts`**:
  - Rewrote message dispatch: replaced hand-rolled `buildContextPayload` + `recordInboundSession` + `dispatchReplyFromConfig` + `simpleDispatcher` + fallback methods with `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/inbound-reply-dispatch`
  - Uses `runtime.channel.routing.resolveAgentRoute()` for proper route resolution (replaces hardcoded `agentId: "main"`)
  - Uses `runtime.channel.reply.finalizeInboundContext()` for context normalization (replaces `buildContextPayload`)
  - Uses `dispatchInboundReplyWithBase()` which orchestrates session recording, turn kernel dispatch, and reply delivery
  - Provides `deliver` callback for XMPP send with whiteboard (SXE/SWB) and message persistence support
  - Removed 250+ lines of legacy dispatch code (simpleDispatcher, Method 1, Method 2, fallback methods)
  - Added try-catch with error logging around the dispatch block
  - Fixed `core` parameter: was `channelRuntime` instead of `{ channel: channelRuntime }`
  - Added `onRecordError` and `onDispatchError` callbacks
- **`src/startXMPP.ts`**:
  - Increased connection timeout from 2s to 30s (`xmpp.timeout = 30000`)
  - Added `scheduleReconnect()` with exponential backoff (base=1s, max=60s, factor=2) — checks `xmpp.status` before calling `stop()`
  - Unified ping-failure, offline, and initial start failure to use `scheduleReconnect()`
- **`setup-entry.ts`**: Fixed from `export default {}` to `export { default } from "./index.js"`
- **`openclaw.plugin.json`**: Added `channelConfigs.xmpp` with permissive `{ "type": "object" }` schema
- **`tsconfig.json`**: Created TypeScript compiler configuration
- **`package.json`**: Updated build/typecheck scripts to use tsconfig.json
- **`README.md`**: Rewrote installation for 2026.5.4+, added troubleshooting section
- **`install.sh` / `install.ps1`**: Created install scripts
- **`dist/` directory deleted**: Old compiled JS was shadowing `.ts` sources
- **OpenClaw config**: Set `messages.groupChat.visibleReplies = "automatic"` to fix groupchat delivery

#### Backups
- `src/startXMPP.ts.backup_20260425_110028_eoffix` - Before EOF reconnection fix
- `src/startXMPP.ts.backup_20260505_073729_initfix` - Before init timeout/reconnect fix
- `src/startXMPP.ts.backup_20260505_143824_brokenreconnect` - Before revert to original connection code
- `src/startXMPP.ts.backup_20260505_144535_reconn` - Before adding status-checked reconnection
- `openclaw.plugin.json.backup_20260505_073729_initfix` - Before channelConfigs addition
- `openclaw.plugin.json.backup_20260505_074505_schemafix` - Before schema strictness fix
- `openclaw.plugin.json.backup_20260505_074909_permissive` - Before schema replaced with { type: object }
- `src/gateway.ts.backup_20260505_084759_modern` - Before rewrite to dispatchInboundReplyWithBase pipeline
- `src/gateway.ts.backup_20260505_092847_corefix` - Before core param fix
- `README.md.backup_20260505_195408` - Before README rewrite
- `dist.backup_20260505_102210.zip` - Before deleting old compiled JS

## [1.8.9] - 2026-04-06

### Fixed
- **CLI Message Command**: The `openclaw xmpp msg <jid> <message>` command now works correctly with OpenClaw 2026.4.x.

#### Root Cause
The CLI command was attempting to send messages via `openclaw message send --channel xmpp`, which spawns a subprocess that loads its own plugin registry. In OpenClaw 2026.4.x, the XMPP plugin wasn't being properly discovered/registered in this CLI subprocess context, resulting in "unsupported channel: xmpp" error.

#### Changes
- **`src/commands.ts`**:
  - Changed message sending mechanism from spawning `openclaw message send` subprocess to using gateway RPC
  - Added `sendViaGatewayRpc()` function that calls `callGatewayRpc("xmpp.sendMessage", { jid, message })`
  - The CLI now communicates directly with the gateway instead of spawning a new CLI process

- **`index.ts`**:
  - Added new `xmpp.sendMessage` gateway method (lines 1125-1158) to handle message sending from CLI
  - Gateway method detects groupchat vs direct messages and routes appropriately

- **`src/gateway-client.ts`**:
  - Made `callGatewayRpc()` function public (exported) so it can be used by commands.ts

- **`openclaw.plugin.json`**:
  - Updated manifest with proper channel format for OpenClaw 2026.4.x compatibility

- **`package.json`**:
  - Added new OpenClaw metadata structure with `channel`, `compat`, and `build` fields

### Fixed
- **Groupchat (MUC) Message Support**: The CLI command now correctly sends messages to groupchat rooms like `general@conference.kazakhan.com`.

#### Root Cause
The new `xmpp.sendMessage` gateway method only used `client.send()` which is for direct messages. Groupchat messages require `client.sendGroupchat()`.

#### Changes
- **`index.ts`** (xmpp.sendMessage gateway method):
  - Added detection for groupchat JIDs (contains `@conference.`)
  - Added detection for private messages in groupchat (contains `/` after conference domain)
  - Use `sendGroupchat()` for public groupchat messages
  - Use `send()` for direct messages and private messages in groupchat

#### Example
```bash
# Direct message - works
openclaw xmpp msg jamie@kazakhan.com "Hello"

# Groupchat message - now works
openclaw xmpp msg general@conference.kazakhan.com "Hello room"
```

## [1.8.8] - 2026-03-02

### Added
- **Enhanced In-Chat vCard Commands**: The in-chat `/vcard` command now supports all fields available in the CLI commands, making it easier for admins to manage vCard directly from XMPP.

#### New Commands
- `/vcard set birthday <YYYY-MM-DD>` - Set Birthday
- `/vcard set title <value>` - Set Job Title
- `/vcard set role <value>` - Set Job Role
- `/vcard set timezone <value>` - Set Timezone
- `/vcard name <family> <given> [middle] [prefix] [suffix]` - Set structured name
- `/vcard phone add <number> [type...]` - Add phone number
- `/vcard phone remove <index>` - Remove phone number
- `/vcard email add <address> [type...]` - Add email address
- `/vcard email remove <index>` - Remove email address
- `/vcard address add <street> <city> <region> <postal> <country> [type]` - Add address
- `/vcard address remove <index>` - Remove address
- `/vcard org <orgname> [orgunit...]` - Set organization
- `/vcard get` - Now shows all vCard fields including phone, email, address, organization

#### Changes
- **`src/startXMPP.ts`**:
  - Updated help text to show all available commands
  - Added handlers for new subcommands: name, phone, email, address, org
  - Updated `get` command to display all vCard fields
  - Added support for simple fields: birthday, title, role, timezone

### Fixed
- **vCard Local Storage**: CLI vCard commands now save to local file (`data/xmpp-vcard.json`) in addition to updating the XMPP server. This fixes the issue where copying the plugin code to another PC would reset the vCard on the server because the local file wasn't being updated.

#### Changes
- **`src/vcard-cli.ts`**:
  - Added `dataDir` to `XmppConfig` interface
  - Updated `loadXmppConfig()` to return `dataDir` from config (with default fallback)
  - Added `saveVCardLocally()` helper function to save vCard to local JSON file
  - Updated all vCard modification functions to call `saveVCardLocally()` after server update:
    - `setVCard()`
    - `setVCardAvatar()`
    - `setVCardName()`
    - `addVCardPhone()`
    - `removeVCardPhone()`
    - `addVCardEmail()`
    - `removeVCardEmail()`
    - `addVCardAddress()`
    - `removeVCardAddress()`
    - `setVCardOrg()`

### Added
- **Auto-Join Groupchat Rooms**: The bot can now automatically join configured groupchat rooms on startup.

#### How It Works
- Add room JIDs to the `rooms` array in the account configuration
- When the XMPP connection is established, the bot will join each configured room
- Uses the account's `nick` setting for the nickname in each room

#### Configuration
```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "rooms": [
            "room1@conference.your-server.com",
            "room2@conference.your-server.com"
          ]
        }
      }
    }
  }
}
```

#### Changes
- **`src/startXMPP.ts`**:
  - Added optional `onOnline` callback parameter to `startXmpp()` function
  - Callback is invoked when XMPP connection is established (after vCard registration)
- **`index.ts`**:
  - Added `onOnline` callback implementation that iterates through `config.rooms` and joins each room
  - Each room join is attempted sequentially with error handling per-room

#### Technical Details
- The auto-join happens in the "online" event handler, ensuring the XMPP connection is fully established
- If joining a room fails, the bot continues trying other rooms and logs the error
- The nickname used is from the account's `nick` config (or JID local part if not set)

## [1.8.7] - 2026-02-26

### Fixed
- **Groupchat Nickname**: Bot now uses the correct nickname when joining groupchat rooms.

#### Root Cause
The bot was attempting to query the XMPP server for its own vCard nickname at startup, but this query was failing or returning null due to timing issues. The server query was unnecessary since the nickname is already known locally from the CLI command `openclaw xmpp vcard set nickname <nick>`.

#### Changes
- **`src/startXMPP.ts`**:
  - Simplified `getDefaultNick()` to use the local vCard value directly instead of querying the server
  - Removed broken server vCard query code
  - The bot now uses the nickname set via CLI command (`vcard set nickname X`) which is stored locally and registered to the server

#### Technical Details
- The CLI command `openclaw xmpp vcard set nickname X` saves the nickname to a local vCard file and registers it with the XMPP server
- The bot now reads this local value directly instead of attempting to query the server for its own vCard
- This fixes the issue where bots on different machines would join with incorrect/old nicknames

## [1.8.6] - 2026-02-26

### Added
- **Room Topic/Subject Notifications**: Bot now receives room topic notifications when joining a groupchat and when the room subject changes.

#### How It Works
- When the bot joins a groupchat room, it receives the current room subject (if set)
- When the room subject is changed by someone, the bot receives a notification
- The topic is delivered as a special message: `[Room Subject: My Topic]`

#### Technical Details
- In XMPP MUC (groupchat), room subjects are sent as `<subject>` elements in message stanzas (not in the body)
- The bot now extracts the subject element and forwards it to the agent when:
  - Joining a room (subject-only message with no body)
  - Subject change event (subject present, no body)
- Regular groupchat messages do NOT include the subject to avoid noise

#### Changes
- **`src/startXMPP.ts`**:
  - Added extraction of subject from message stanza: `stanza.getChildText("subject")`
  - Added handling for subject-only messages (room subject events)
  - Logs: `📝 Room Subject changed to: ${subject}`
  - Forwards subject as `[Room Subject: ${subject}]` to agent

## [1.8.5] - 2026-02-26

### Fixed
- **Groupchat Nickname**: Bot now uses nickname from vCard when joining groupchat rooms via invite.

#### Root Cause
When the bot was invited to a groupchat room, it would join using its JID local part (e.g., "clawdbothome") instead of a friendly nickname. The `getDefaultNick()` function was only checking `cfg.nick` config and falling back to JID, ignoring the vCard nickname.

#### Changes
- **`src/startXMPP.ts`**:
  - Modified `getDefaultNick()` function to check vCard nickname with the following priority:
    1. `cfg.nick` (from config)
    2. `vCard.nickname` (from vCard - set via `openclaw xmpp vcard set nickname <nick>`)
    3. JID local part (fallback)
    4. `"openclaw"` (final fallback)
  - Added debug logging to track which nickname source is being used

#### Usage
Users can now set the bot's groupchat nickname using:
```
openclaw xmpp vcard set nickname MyBot
```
This nickname will be used when the bot joins rooms via invite. The config `nick` option still takes precedence if set.

## [1.8.4] - 2026-02-26

### Fixed
- **Reply Routing Between Public and Private Groupchat Messages**: Fixed issue where after exchanging private messages in a groupchat, subsequent public groupchat messages would receive replies in the private chat instead of the main room.

#### Root Cause
The XMPP plugin was setting incorrect values for `To` and `OriginatingTo` in the message context. Both were set to the bot's JID (`xmpp:bot@domain.com`) instead of the appropriate reply destination. Openclaw uses these fields to determine where to send replies:

```javascript
const lastToRaw = ctx.OriginatingTo || ctx.To || baseEntry?.lastTo;
```

Since both fields pointed to the bot's JID, Openclaw would use the session's cached `lastTo` value (which was set to the private message recipient during the private message exchange), causing all subsequent replies to go to the private chat.

#### Changes
- **`index.ts`**:
  - Updated `buildContextPayload` function to set correct `To` and `OriginatingTo` values:
    - Public groupchat messages (`type="groupchat"`): `To: xmpp:room@conference.domain`
    - Private messages in groupchat (`type="chat"`): `To: xmpp:room@conference.domain/nick`
    - Direct messages: `To: xmpp:sender@domain.com`
  - Added proper nick extraction from the message `from` field

- **`src/register.ts`**:
  - Applied same fix to `buildContextPayload` function for consistency

#### Technical Details
- The fix ensures each message type correctly tells Openclaw where replies should go
- Public groupchat messages now have `OriginatingTo: xmpp:room@conference.domain` so replies go to the room
- Private messages in groupchat have `OriginatingTo: xmpp:room@conference.domain/nick` so replies go to the specific user
- Session key remains the same for both message types to maintain shared memory context
- Openclaw now properly updates `lastTo` via `updateLastRoute` for each message type

## [1.8.3] - 2026-02-26

### Fixed
- **Private Message Replies in Groupchat**: Fixed issue where replies to private messages in groupchat were being sent to the entire room instead of to the specific user.

#### Root Cause
When an agent received a private message in a groupchat (from `room@conference.domain/nick`), the reply was being sent using `sendGroupchat()` which broadcasts to everyone in the room. This caused:
1. The private reply to be visible to all room members
2. XMPP server returning `bad-request` error because sending to `room/nick` via groupchat is invalid

#### Changes
- **`index.ts`**:
  - Updated both dispatch methods (`dispatchReplyFromConfig` and `dispatchReplyWithBufferedBlockDispatcher`) to detect private messages in groupchat
  - Logic change: Check if target JID contains both `@conference.` AND `/nick` to identify private messages
  - Private messages now use `send(room/nick, text)` instead of `sendGroupchat(room, text)`

- **`src/register.ts`**:
  - Updated `sendReply` function to properly route private messages in groupchat
  - Uses `sendGroupchat()` for public groupchat messages
  - Uses `send()` for private messages (room/nick format)

#### Technical Details
- Detection: `isPrivateInGroupchat = isGroupChatRoom && hasNick`
- `isGroupChatRoom`: target JID contains `@conference.`
- `hasNick`: target JID contains `/` (and doesn't end with `/`)
- Public groupchat reply: `xmpp.sendGroupchat(roomJid, text)` - sends as `type="groupchat"`
- Private groupchat reply: `xmpp.send(roomJid/nick, text)` - sends as `type="chat"` (private)

## [1.8.2] - 2026-02-26

### Fixed
- **Groupchat Message Handling**: Agents now correctly identify groupchat messages as channel conversations instead of direct messages.
- **Private Messages in Groupchat**: Agents can now send and receive private messages within groupchat rooms.

#### Root Cause
Previously, all XMPP messages were sent to Openclaw with `ChatType: "direct"`, regardless of whether they came from a direct chat or a groupchat (MUC) room. This caused agents to behave as if they were in 1-on-1 conversations when they were actually in groupchats, leading to confusion.

Additionally, when sending messages to `room@conference.domain/nick` (a private message to a specific occupant), the code was incorrectly stripping the nick and sending to the entire room.

#### Changes
- **`index.ts`**: 
  - Updated channel capabilities to include `"channel"` chat type alongside `"direct"`
  - Changed message `ChatType` from hardcoded `"direct"` to dynamic: `"channel"` for groupchat messages, `"direct"` for direct messages
  - Updated conversation label to show room name for groupchat messages (e.g., "XMPP Groupchat: room@conference.example.com")
  - Fixed outbound messaging to properly handle private messages in groupchat:
    - `room@conference.domain` (room only) → uses `sendGroupchat()` (everyone sees it)
    - `room@conference.domain/nick` (private) → uses `send()` (only nick sees it)
  - Fixed reply routing: replies to private messages in groupchat now go to `room/nick` instead of just `room`

- **`src/register.ts`**:
  - Updated channel capabilities to include `"channel"` chat type
  - Fixed outbound messaging to handle private messages in groupchat correctly
  - Fixed reply routing for private messages

- **`src/startXMPP.ts`**:
  - Improved inbound message detection to identify groupchat messages even when XMPP stanza type is "chat" (private messages within MUC use type="chat")
  - Now detects messages from groupchat by checking if `from` contains `@conference.` in addition to checking stanza type

#### Technical Details
- Groupchat messages are identified by the XMPP stanza type `"groupchat"` (per XEP-0045 MUC standard) OR by detecting `@conference.` in the sender JID
- Private messages within groupchat (MUC) are sent as `type="chat"` with `from="room/nick"`, which is now properly detected
- The fix passes the correct `ChatType` to Openclaw's `recordInboundSession` call, enabling proper session handling for group conversations
- Outbound replies use the appropriate method based on message context:
  - Public groupchat messages: `sendGroupchat(room, text)`
  - Private messages in groupchat: `send(room/nick, text)` (sends privately to specific user)
  - Direct messages: `send(jid, text)`

## [1.8.1] - 2026-02-26

### Fixed
- **vCard Get Command**: Updated `openclaw xmpp vcard get` to display all vCard fields.

#### Changed
- `src/commands.ts` - Expanded vCard display output to show all fields:
  - FN, Name (structured), Nickname
  - Birthday, Title, Role, Timezone
  - URL, Description, Avatar URL
  - Phone numbers (multi-value with types)
  - Emails (multi-value with types)
  - Addresses (multi-value with types)
  - Organization

#### Output Example
```
Current vCard:
  FN: Clawd
  Name: Mr. John David Smith III
  Nickname: Clawd
  Birthday: 1990-05-15
  Title: Software Engineer
  Role: Developer
  Timezone: -05:00
  URL: https://example.com
  Desc: Test description
  Avatar URL: https://example.com/avatar.jpg
  Phone 1: +61412345678 (CELL)
  Phone 2: +60987654321 (WORK, VOICE)
  Email 1: home@example.com (HOME)
  Email 2: work@example.com (WORK, PREF)
  Address 1: 123 Main St, Boston, MA, 02101, USA (HOME)
  Organization: Acme Inc (Engineering)
```

## [1.8.0] - 2026-02-25

### Added
- **vCard CLI Commands**: Extended vCard management commands following XEP-0054 standard.

#### New CLI Commands
```
openclaw xmpp vcard set birthday <YYYY-MM-DD>  - Set Birthday
openclaw xmpp vcard set title <value>           - Set Job Title
openclaw xmpp vcard set role <value>            - Set Job Role
openclaw xmpp vcard set timezone <offset>       - Set Timezone (e.g., -05:00)
openclaw xmpp vcard name <family> <given> [middle] [prefix] [suffix]  - Set structured name
openclaw xmpp vcard phone add <number> [type...]  - Add phone (types: home work voice fax cell video pager msg)
openclaw xmpp vcard phone remove <index>         - Remove phone by index
openclaw xmpp vcard email add <address> [type...] - Add email (types: home work internet pref)
openclaw xmpp vcard email remove <index>        - Remove email by index
openclaw xmpp vcard address add <street> <city> <region> <postal> <country> [type...] - Add address
openclaw xmpp vcard address remove <index>      - Remove address by index
openclaw xmpp vcard org <orgname> [orgunit...]  - Set organization
```

#### CLI Syntax Change
- Changed from flag-based to positional arguments to avoid Commander.js option parsing issues
- Old (broken): `openclaw xmpp vcard phone add +61412345678 --cell`
- New (working): `openclaw xmpp vcard phone add +61412345678 cell`

#### Changes
- `src/commands.ts` - Added command handlers for name, phone, email, address, org subcommands
- `src/vcard-cli.ts` - Added export functions: setVCardName, addVCardPhone, removeVCardPhone, addVCardEmail, removeVCardEmail, addVCardAddress, removeVCardAddress, setVCardOrg
- `tests/test.sh` - Added tests 5.4-5.15 for all new vCard fields
- `tests/test.ps1` - Added tests 5.4-5.15 for all new vCard fields
- `tests/test-common.sh` - Updated restore_vcard for new fields (birthday, title, role)
- `tests/test-common.ps1` - Updated restore_vcard for new fields (birthday, title, role)

#### Test Coverage
- Birthday, title, role, timezone fields
- Structured name (family, given, middle, prefix, suffix)
- Phone numbers (multiple, with types)
- Email addresses (multiple, with types)
- Addresses (multiple, with types)
- Organization (orgname, orgunit)

## [1.7.9] - 2026-02-25

### Changed
- **vCard Implementation (XEP-0054)**: Comprehensive vCard implementation following the vcard-temp standard.

#### New Fields Implemented
All XEP-0054 fields now supported:

| Category | Fields |
|----------|--------|
| Required | VERSION (3.0), FN |
| Name | N (family, given, middle, prefix, suffix) |
| Basic | NICKNAME, PHOTO, BDAY |
| Contact | TEL (multi), EMAIL (multi), ADR (multi), JABBERID, MAILER, TZ, GEO |
| Professional | TITLE, ROLE, ORG (orgname, orgunit), LOGO |
| Other | CATEGORIES, NOTE, UID, URL, DESC, REV, PRODID, SORT-STRING |

#### Changes
- `src/types.ts` - Added comprehensive VCardData interface with VCardName, VCardPhone, VCardEmail, VCardAddress, VCardOrg, VCardPhoto
- `src/vcard.ts` - Complete rewrite with getters/setters for all fields, multi-value support for TEL/EMAIL/ADR
- `src/vcard-cli.ts` - Updated parseVCard() and buildVCardStanza() to handle all XEP-0054 fields

#### New Methods in VCard Class
- getN()/setN()/setNameComponents() - Structured name
- getTel()/setTel()/addPhone()/removePhone() - Phone numbers (multi-value)
- getEmail()/setEmail()/addEmail()/removeEmail() - Emails (multi-value)
- getAdr()/setAdr()/addAddress()/removeAddress() - Addresses (multi-value)
- getBday()/setBday() - Birthday
- getJabberid()/setJabberid() - XMPP ID (auto-populated from config)
- getTitle()/setTitle() - Job title
- getRole()/setRole() - Job role
- getOrg()/setOrg()/setOrgComponents() - Organization
- getTz()/setTz() - Timezone
- getGeo()/setGeo() - Geographic position
- getLogo()/setLogoUrl()/setLogoData() - Organization logo
- getCategories()/setCategories() - Keywords
- getNote()/setNote() - Note
- getUid()/setUid() - Unique identifier
- getProdid()/setProdid() - Product ID
- getSortString()/setSortString() - Sort string

#### Backward Compatibility
- avatarUrl/avatarData still work as aliases for photo
- getURL()/setURL() aliased to getUrl()/setUrl()

## [1.7.8] - 2026-02-25

### Changed
- **Central Configuration**: Created centralized config file with all hardcoded values.

#### New Files
- `src/config.ts` - Central configuration module with all application constants

#### Configuration Values
- File Transfer: `MAX_FILE_SIZE` (10MB), `MAX_CONCURRENT_TRANSFERS` (3)
- Message Store: `MAX_MESSAGES_PER_FILE` (256), `MESSAGE_QUEUE_MAX_SIZE` (100), `MESSAGE_CLEANUP_MAX_AGE_MS` (24h)
- Rate Limiting: `RATE_LIMIT_MAX_REQUESTS` (10), `RATE_LIMIT_WINDOW_MS` (60s)
- Session Timeouts: `IBB_SESSION_TIMEOUT_MS` (5min), `IBB_CLEANUP_INTERVAL_MS` (60s)
- Logging: `DEBUG_LOG_FILE` ('cli-debug.log')

#### Changes
- `index.ts` - Now imports from Config: MAX_CONCURRENT_TRANSFERS, MESSAGE_QUEUE_MAX_SIZE
- `src/shared/index.ts` - Now imports from Config: RATE_LIMIT constants, MAX_FILE_SIZE
- `src/startXMPP.ts` - Now imports from Config: IBB_SESSION_TIMEOUT_MS, IBB_CLEANUP_INTERVAL_MS
- `src/fileTransfer.ts` - Now imports from Config: MAX_FILE_SIZE
- `src/vcard-cli.ts` - Now imports from Config: MAX_FILE_SIZE
- `src/messageStore.ts` - Now imports from Config: MAX_MESSAGES_PER_FILE

#### Benefits
- Single source of truth for all configuration values
- Easy to modify settings without searching through multiple files
- Consistent values across all modules

## [1.7.7] - 2026-02-25

### Fixed
- **Non-Atomic Message Counter**: Replaced non-atomic counter-based message IDs with cryptographically secure UUIDs.

#### Changes
- `index.ts` - Added `import crypto from "crypto"`
- `index.ts:493` - Changed from `const uniqueMessageId = \`xmpp-${Date.now()}-${++messageCounter}\`` to `const uniqueMessageId = \`xmpp-${crypto.randomUUID()}\``
- Removed local `messageCounter` variable

#### Issue
The previous implementation used a simple counter incremented with `++messageCounter` which is not thread-safe and could produce duplicate IDs under concurrent message processing.

#### Solution
Now uses `crypto.randomUUID()` which generates cryptographically secure, unique UUIDs guaranteed to be unique across all messages.

### Fixed
- **IBB Session Memory Leak**: Added automatic cleanup for stale In-Band Bytestream (IBB) file transfer sessions.

#### Changes
- `src/startXMPP.ts:255-260` - Added `IBB_SESSION_TIMEOUT_MS` constant (5 minutes)
- `src/startXMPP.ts:262-270` - Added `cleanupIbbSessions()` function to remove sessions older than timeout
- `src/startXMPP.ts:272-273` - Added interval to run cleanup every 60 seconds
- `src/startXMPP.ts:444` - Added `createdAt: Date.now()` to session objects
- `src/startXMPP.ts:208-211` - Added cleanup on XMPP offline event

#### Issue
The `ibbSessions` Map was never cleaned up, causing unbounded memory growth as sessions accumulated over time.

#### Solution
- Sessions now track their creation time via `createdAt` timestamp
- A periodic cleanup runs every 60 seconds, removing sessions older than 5 minutes
- Cleanup is triggered when XMPP goes offline

### Fixed
- **Joined Rooms Memory Leak**: Added automatic cleanup for rooms when bot is kicked or leaves.

#### Changes
- `src/startXMPP.ts:374-380` - Added detection and cleanup when bot is removed from room

#### Issue
When the bot was kicked or left a room, the `joinedRooms` Set and `roomNicks` Map were not updated, causing stale entries.

#### Solution
The presence handler now checks if the unavailable presence is for the bot's nick in a room, and if so, removes that room from both tracking collections.

## [1.7.6] - 2026-02-25

### Changed
- **Code Deduplication**: Consolidated duplicate functions into shared module.

#### New Files
- `src/shared/index.ts` - New shared utilities module containing:

#### Consolidated Functions
- `sanitize(message: string)` - Redacts sensitive data (passwords, credentials, API keys) from logs
- `debugLog(msg: string)` - File logger with configurable directory via `setDebugLogDir()`
- `checkRateLimit(jid: string)` - Rate limiting (10 requests per minute per JID)
- `downloadFile(url, tempDir, options)` - File download with security features
- `processInboundFiles(urls, dataDir, options)` - Batch file processing

#### Consolidated Constants
- `MAX_FILE_SIZE` - 10MB file size limit
- `RATE_LIMIT_MAX_REQUESTS` - 10 requests per window
- `RATE_LIMIT_WINDOW_MS` - 60 second window

#### Changes
- `index.ts` - Removed local implementations of sanitize(), debugLog(), checkRateLimit()
- `index.ts` - Added import from `./src/shared/index.js`
- `index.ts` - Added `setDebugLogDir(__dirname)` to configure log location
- `src/startXMPP.ts` - Removed local implementations of sanitize(), debugLog(), checkRateLimit(), downloadFile(), processInboundFiles()
- `src/startXMPP.ts` - Added import from `./shared/index.js`
- `src/startXMPP.ts:785` - Fixed call to `processInboundFiles([url], cfg.dataDir)` to include required dataDir parameter

#### Notes
- The shared `downloadFile()` includes security features: URL validation, filename sanitization, path traversal protection, and file size limits
- Debug log directory can be configured via `setDebugLogDir()` for different contexts (plugin dir vs cwd)

## [1.7.5] - 2026-02-25

### Security
- **Missing Import at File Top**: Fixed critical import order bug in validation module.

#### Changes
- `src/security/validation.ts:1` - Moved `import path from "path"` from end of file to top

#### Issue
The `path` module was imported at the end of the file (line 61) but used at line 25 in the `isSafePath()` function. This could cause runtime errors depending on import order.

#### Solution
Moved the import to the top of the file with other imports.

### Security
- **Unique Installation Salt**: Implemented unique salt per installation for password encryption.

#### Changes
- `src/security/encryption.ts:11-30` - Added `getInstallationSalt(dataDir)` function
- `src/security/encryption.ts:9` - Changed `SALT` constant to `DEFAULT_SALT` for fallback
- `src/security/encryption.ts:11` - Added `SALT_FILE_NAME` constant (`.xmpp-plugin-salt`)
- `src/security/encryption.ts:135-153` - Added `getOrCreateEncryptionSalt()` function with backward compatibility
- `src/security/encryption.ts:30` - Added `encryptionSalt` field to `XmppAccountConfig` interface

#### Algorithm
- On first encryption with a new dataDir, generates a random 32-byte salt
- Stores salt in `{dataDir}/.xmpp-plugin-salt` with secure file permissions (0o600)
- For existing encrypted passwords without salt in config, uses `DEFAULT_SALT` for backward compatibility

#### Backward Compatibility
- Existing encrypted passwords continue to work (fall back to default salt)
- New encryptions use the unique installation salt
- Salt can be explicitly set in config via `encryptionSalt` field

#### Example Config with Salt
```json
{
  "encryptionKey": "DpldYiYd/JrF5zw6L5H3Fj5dm8dKuHrkm6gb2s4pHuo=",
  "encryptionSalt": "186f00791f0c95fd6e66936885f540c569a4d8bde775a7fa7877133275081a0c"
}
```

## [1.7.2] - 2026-02-08

### Added
- **Jabber:x:Conference Auto-Join**: Added automatic room joining for direct invitations sent via jabber:x:conference namespace.

#### Feature
The XMPP plugin now automatically detects and accepts room invitations delivered through the jabber:x:conference namespace (XEP-0248). When a message contains an invite in the body (sometimes escaped as `&lt;x xmlns='jabber:x:conference'...`), the plugin extracts the room JID, password, and reason, then sends MUC presence to join the room.

#### Problem
When other XMPP clients send room invitations using the jabber:x:conference namespace, the invite XML element may appear escaped inside the message body rather than as a proper child element. This caused:
- Invite detection to fail (`stanza.getChild('x', 'jabber:x:conference')` returned null)
- Invites to be dispatched to the AI agent instead of being handled locally
- The AI would respond with a message addressed to the room, resulting in "not in room" errors

#### Solution
Added body content inspection to detect escaped jabber:x:conference invites:
```typescript
if (body && (body.includes('jabber:x:conference') || body.includes('&lt;x'))) {
  const jidMatch = body.match(/jid=['"]([^'"]+)['"]/);
  const passwordMatch = body.match(/password=['"]([^'"]+)['"]/);
  const reasonMatch = body.match(/reason=['"]([^'"]+)['"]/);
  // Auto-join room...
}
```

#### Changes
- `index.ts:1163-1200` - Added jabber:x:conference invite detection and auto-join logic
- Detects invites whether XML is escaped (`&lt;x...&gt;`) or unescaped
- Extracts room JID, optional password, and reason from invite attributes
- Sends MUC presence to join room with default nickname
- Tracks joined room in `joinedRooms` Set and nickname in `roomNicks` Map
- Returns early to prevent invite from being dispatched to AI agent

#### Example Invite Format
```xml
<x xmlns='jabber:x:conference'
   jid='darkcave@macbeth.shakespeare.lit'
   password='cauldronburn'
   reason='Hey Hecate, this is the place for all good witches!'/>
```

#### Notes
- Follows same auto-join behavior as MUC invites (`http://jabber.org/protocol/muc#user` namespace)
- No additional configuration required - invites are automatically detected and accepted
- Room password is included in MUC presence if specified in invite

## [1.7.1] - 2026-02-08

### Fixed
- **XMPP Direct Invitations**: Fixed `openclaw xmpp invite` command to properly send direct room invitations using jabber:x:conference namespace.

#### Bug
The invite command was generating malformed XML where invitation attributes (jid, reason, password) were passed as a child node instead of being spread as attributes on the `<x>` element. This resulted in invalid XML that XMPP clients couldn't parse.

#### Root Cause
In `index.ts`, the XML construction used incorrect parameter passing:
```typescript
xml("x", { xmlns: "jabber:x:conference" }, inviteAttrs) // WRONG - inviteAttrs as child node
```

#### Solution
Changed to spread operator to properly format attributes:
```typescript
xml("x", { xmlns: "jabber:x:conference", ...inviteAttrs }) // CORRECT - spread as attributes
```

#### Changes
- `index.ts:~1820` - Fixed XML attribute spreading in `xmppClient.inviteToRoom()` method
- Added debug logging for invite XML generation and transmission
- Command now generates correct XML format:
  ```xml
  <message to="contact@domain.com">
    <x xmlns="jabber:x:conference" jid="room@conference.domain" [reason="..."] [password="..."]/>
  </message>
  ```

#### New Command Syntax
- `openclaw xmpp invite <contact> <room> [reason] [--password <password>]`

### Fixed
- **CLI xmpp join command**: Fixed the `openclaw xmpp join` command to properly connect to the running gateway instead of spawning a child process that failed to access the XMPP client. The command now uses `openclaw gateway call` to invoke RPC methods on the gateway process, which has direct access to the XMPP client. Added three new gateway RPC methods: `xmpp.joinRoom`, `xmpp.leaveRoom`, and `xmpp.getJoinedRooms`. Removed the failed `internal-join` subcommand and `joinViaGateway()` function that attempted to route through child processes.

## [1.6.8] - 2026-02-08

### Fixed
- **Message Queue Processing Bug**: Fixed critical race condition in `xmpp poll` command where messages were being marked as processed immediately when dispatch was initiated, not when it succeeded. This caused messages to disappear from the poll queue even when dispatch failed asynchronously.

#### Changes
- `index.ts:341` - Changed queue ordering from `unshift()` to `push()` for proper FIFO ordering
- `index.ts:2189-2191` - Added `dispatchSuccess` and `dispatchError` tracking variables at callback scope
- `index.ts:2465-2545` - Restructured dispatch methods to properly await results and verify success before marking messages as processed
- `index.ts:2570-2631` - Updated fallback methods (ctx methods and dispatchInboundMessage) to use same success tracking pattern

#### Root Cause
The original code used fire-and-forget dispatch with `.then()`/`.catch()` handlers, but called `markAsProcessed(messageId)` immediately after dispatch was initiated, not after it completed successfully. This meant:
- If dispatch failed asynchronously, the message was already marked as processed
- Failed messages were lost and not visible in `xmpp poll`
- No retry mechanism existed for failed dispatches

#### Solution
- Converted fire-and-forget dispatch to proper `await` patterns
- Only call `markAsProcessed()` when dispatch actually succeeds
- Added `dispatchSuccess` boolean flag to track outcome
- Log clear error messages when dispatch fails
- Messages now remain in queue when dispatch fails, allowing retry via `xmpp poll`

### Added
- **Missing CLI Command**: Implemented `openclaw xmpp add <jid> [name]` command for adding contacts to whitelist

#### New Commands
- `openclaw xmpp add <jid> [name]` - Add contact to whitelist (required for bot responses)
- `openclaw xmpp contacts` - List whitelisted contacts

#### Changes
- `src/commands.ts` - Added `getContacts` parameter to `registerXmppCli` function
- `src/commands.ts` - Added `add <jid> [name]` command implementation using Contacts class
- `src/commands.ts` - Added `contacts` command to list whitelisted contacts
- `src/commands.ts` - Updated legacy `registerCommands` function to include `getContacts`
- `index.ts` - Added `contactsStore` global Map for Contacts instances by account ID
- `index.ts` - Stores contacts instance when created for CLI access
- `index.ts` - Updated `registerXmppCli` call to provide `getContacts` callback

#### Features
- Validates JID format (must contain `@` symbol)
- Handles duplicate contacts (updates name if already exists)
- Uses existing `Contacts` class for persistent JSON storage
- Provides clear success/error feedback to user
- Works with both direct Contacts instance and fallback instantiation

#### Usage
```bash
# Add a contact
openclaw xmpp add sarah@kazakhan.com

# Add a contact with custom name
openclaw xmpp add sarah@kazakhan.com "Sarah"

# List whitelisted contacts
openclaw xmpp contacts
```

## [1.6.7] - 2026-02-07

### Security
- **Enhanced File Transfer Security**: Implemented comprehensive file transfer security layer with MIME type validation, quarantine system, malware scanning hook, secure temp files, per-user quotas, and SHA-256 integrity verification.

#### New Files
- `src/security/fileTransfer.ts` - Comprehensive file transfer security module with validation, quarantine, and malware detection

#### New Interface: `FileTransferConfig`
- `maxFileSizeMB: number` - Maximum file size for transfers (default: 10MB)
- `maxUploadSizeMB: number` - Maximum upload size (default: 10MB)
- `maxDownloadSizeMB: number` - Maximum download size (default: 10MB)
- `allowedMimeTypes: string[]` - Array of permitted MIME types
- `quarantineDir: string` - Directory for quarantined files
- `enableVirusScan: boolean` - Enable malware scanning (default: false)
- `userQuotaMB: number` - Per-user storage quota (default: 100MB)
- `tempDir: string` - Directory for temporary files

#### New Interface: `FileValidationResult`
- `valid: boolean` - Whether file passed validation
- `error?: string` - Error message if validation failed
- `fileId?: string` - Sanitized filename
- `hash?: string` - SHA-256 file hash
- `size?: number` - File size in bytes
- `mimeType?: string` - Detected MIME type
- `quarantined?: boolean` - Whether file was quarantined

#### New Interface: `QuarantineEntry`
- `fileId: string` - Unique quarantine identifier
- `originalPath: string` - Original file path
- `quarantinePath: string` - Quarantined file path
- `timestamp: number` - When file was quarantined
- `reason: string` - Reason for quarantine
- `hash: string` - SHA-256 hash of file
- `size: number` - File size in bytes

#### New Class: `SecureFileTransfer`

**Constructor**
- `constructor(config?: Partial<FileTransferConfig>)` - Creates instance with merged config, initializes temp/quarantine dirs

**Public Methods**
- `calculateHash(filePath: string): Promise<string>` - Calculates SHA-256 hash of file
- `calculateHashFromBuffer(buffer: Buffer): Promise<string>` - Calculates SHA-256 hash from buffer
- `detectMimeType(filename: string, buffer?: Buffer): string` - Detects MIME type from extension or magic bytes
- `isAllowedMimeType(mimeType: string): boolean` - Checks if MIME type is allowed
- `getFileExtension(filename: string): string` - Returns lowercase file extension
- `validateFilename(filename: string): FileValidationResult` - Validates and sanitizes filename, blocks dangerous extensions (.exe, .bat, .cmd, .sh, .php, .js, .py, .pif, .msi, .dll, .scr, .jar)
- `validateFileSize(size: number, isUpload?: boolean): FileValidationResult` - Validates file size against limits
- `validateIncomingFile(filePath: string, metadata): Promise<FileValidationResult>` - Complete validation: size, MIME type, quota, malware scan, hash calculation
- `quarantineFile(filePath: string, reason: string): Promise<void>` - Moves file to quarantine with metadata logging
- `getQuarantineLog(): QuarantineEntry[]` - Returns all quarantine entries
- `clearQuarantineLog(): void` - Clears quarantine log
- `scanForMalware(filePath: string): Promise<{ clean: boolean; details?: string }>` - Scans for suspicious patterns (eval(base64_decode), $_GET/POST/REQUEST, shell_exec, system, etc.)
- `createTempFile(prefix?: string): string` - Creates secure temp file with random suffix
- `secureDeleteFile(filePath: string): Promise<boolean>` - Overwrites file with zeros before deletion
- `getUserUsage(userId: string)` - Returns user storage usage statistics
- `cleanupOldTempFiles(maxAgeMs?: number): number` - Deletes temp files older than maxAgeMs
- `getStats()` - Returns security module statistics

#### Allowed MIME Types
- Images: image/jpeg, image/png, image/gif, image/webp
- Documents: application/pdf, text/plain, text/markdown, text/html, text/csv
- Data: application/json, application/zip
- Audio: audio/mpeg, audio/wav
- Video: video/mp4, video/webm

#### Dangerous Extensions Blocked
- Executables: .exe, .bat, .cmd, .sh
- Scripts: .php, .js, .py, .pif
- System: .msi, .dll, .scr, .jar

#### Factory Function
- `createSecureFileTransfer(config?: Partial<FileTransferConfig>): SecureFileTransfer` - Creates SecureFileTransfer instance

#### Default Configuration
```typescript
{
  maxFileSizeMB: 10,
  maxUploadSizeMB: 10,
  maxDownloadSizeMB: 10,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/html', 'text/csv', 'application/json', 'application/zip', 'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm'],
  quarantineDir: './quarantine',
  enableVirusScan: false,
  userQuotaMB: 100,
  tempDir: './temp'
}
```

#### Magic Byte Detection
- JPEG: ffd8
- PNG: 89504e47
- GIF: 47494638
- PDF: 25504446
- ZIP: 504b34
- WAV: 52494646
- WebM: 1a45dfa3

#### Malware Patterns Detected
- PHP shells: eval(base64_decode)
- Web shell patterns: $_GET, $_POST, $_REQUEST
- Base64 encoded scripts in HTML
- Privilege escalation: chmod, exec, shell_exec, system, passthru

#### Usage Example
```typescript
import { createSecureFileTransfer } from './security/fileTransfer.js';

const secureTransfer = createSecureFileTransfer({
  maxFileSizeMB: 10,
  quarantineDir: './quarantine',
  tempDir: './temp',
  enableVirusScan: true
});

// Validate incoming file
const result = await secureTransfer.validateIncomingFile('/path/to/file.jpg', {
  size: 1024,
  mimeType: 'image/jpeg',
  userId: 'user@example.com'
});

if (!result.valid) {
  console.error('File rejected:', result.error);
  if (result.quarantined) {
    console.log('File was quarantined');
  }
  return;
}

console.log('File validated:', result.hash);

// Get user quota usage
const usage = secureTransfer.getUserUsage('user@example.com');
console.log(`Used: ${usage.usedMB}MB / ${usage.limitMB}MB (${usage.percentage}%)`);
```

#### Backward Compatibility
- Existing file transfers continue to work unchanged
- Default config uses permissive settings (virus scan disabled by default)
- Only files failing validation are affected
- Quarantine and temp directories created automatically

## [1.6.6] - 2026-02-07

### Security
- **Password Encryption at Rest**: Implemented AES-256-GCM encryption for XMPP account passwords in configuration files to protect credentials at rest.

#### New Files
- `src/security/encryption.ts` - Password encryption utilities with AES-256-GCM authenticated encryption

#### New Class: `PasswordEncryption`
- `constructor(key: string)` - Creates encryptor with PBKDF2-SHA512 key derivation (100,000 iterations)
- `encrypt(plaintext: string)` - Encrypts plaintext, returns `{ success: boolean, encrypted?: string, error?: string }`
- `decrypt(encryptedData: string)` - Decrypts ciphertext, returns `{ success: boolean, decrypted?: string, error?: string }`

#### New Functions
- `generateEncryptionKey()` - Generates random 32-byte base64 encryption key
- `createEncryptor(key: string)` - Factory function to create PasswordEncryption instance
- `getOrCreateEncryptionKey(config)` - Returns existing encryptionKey from config or generates new one
- `encryptPasswordWithKey(password, key)` - Encrypts password with given key, returns `ENC:hexdata` format
- `decryptPasswordWithKey(encryptedPassword, key)` - Decrypts password with given key, handles `ENC:` prefix
- `decryptPasswordFromConfig(config)` - Decrypts password from XMPP account config using config's encryptionKey
- `encryptPasswordInConfig(config, password)` - Encrypts password and returns updated config object with encryptionKey and encrypted password
- `isEncryptedPassword(value)` - Checks if value starts with `ENC:` prefix
- `updateConfigWithEncryptedPassword(configPath, password)` - Reads config, encrypts password, writes back to file

#### Algorithm Details
- **Encryption**: AES-256-GCM authenticated encryption
- **Key Derivation**: PBKDF2-SHA512 with 100,000 iterations and salt `'xmpp-plugin-salt-v1'`
- **IV**: 16 bytes random per encryption
- **Auth Tag**: 16 bytes GCM authentication tag
- **Output Format**: `ENC:hex(iv + authTag + ciphertext)` where all components are hex-encoded

#### Config Changes
- New field `encryptionKey`: Base64-encoded 32-byte encryption key (auto-generated if not present)
- Password field now supports:
  - Plaintext password (backward compatible)
  - Encrypted password with `ENC:` prefix (new format)
- Config path: `~/.openclaw/openclaw.json` (cross-platform, respects USERPROFILE on Windows)

#### CLI Command
- `openclaw xmpp encrypt-password` - Interactive command to encrypt password in config file
  - Prompts for plaintext password (hidden input)
  - Reads config from `~/.openclaw/openclaw.json`
  - Generates encryptionKey if not present
  - Encrypts password with PBKDF2-derived key
  - Updates config with encryptionKey and encrypted password
  - Example usage:
    ```
    $ openclaw xmpp encrypt-password
    Enter plaintext password (hidden): ********
    Password encrypted successfully!
    Config file: C:\Users\username\.openclaw\openclaw.json
    Updated fields: encryptionKey, password (ENC:...)
    ```

#### Updated Files
- `index.ts` - Added import and decryption at XMPP client initialization
  - Decrypts password before passing to XMPP client with try/catch error handling
  - Logs decryption failures to debug log
- `src/sftp.ts` - Updated `loadXmppConfig()` to decrypt password for SFTP connections
  - Added import from `./security/encryption.js`
  - Decrypts password with try/catch, falls back to plaintext for backward compatibility
- `src/ftp.ts` - Updated `loadXmppConfig()` to decrypt password for FTP connections
  - Added import from `./security/encryption.js`
  - Decrypts password with try/catch, falls back to plaintext for backward compatibility
- `src/vcard-cli.ts` - Updated `loadXmppConfig()` to decrypt password for vCard operations
  - Added import from `./security/encryption.js`
  - Decrypts password with try/catch, falls back to plaintext for backward compatibility
- `src/commands.ts` - Added `encrypt-password` subcommand under `xmpp`
  - Uses `encryptPasswordInConfig()` to encrypt and update config
  - Reads/writes config from `~/.openclaw/openclaw.json`

#### Backward Compatibility
- Plaintext passwords in config continue to work unchanged
- Encrypted passwords automatically detected by `ENC:` prefix
- Decryption failures fall back to returning plaintext value
- Encryption key auto-generated if not present in config
- No migration required for existing plaintext configs

#### Config Example
```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "enabled": true,
          "service": "xmpp://example.com:5222",
          "domain": "example.com",
          "jid": "bot@example.com",
          "password": "ENC:a1b2c3d4e5f6...",
          "encryptionKey": "Xk9sLm2v8Yq4...",
          "adminJid": "admin@example.com"
        }
      }
    }
  }
}
```

## [1.6.5] - 2026-02-07

### Security
- **Debug Logs Sanitized**: Created `src/security/logging.ts` with:
  - `secureLog` object with `info()`, `debug()`, `error()`, `warn()` methods
  - Automatic sanitization of passwords, credentials, API keys
  - Metadata sanitization for objects
  - DEBUG environment variable support
  Updated `index.ts`:
  - `debugLog()` function now sanitizes messages before writing to log file
  - Sensitive patterns automatically redacted as `[REDACTED]`

## [1.6.4] - 2026-02-07

### Fixed
- **Whiteboard Command**: Added missing `/whiteboard` command handler for AI image generation and URL sharing
- **Unknown Target Error**: Added `looksLikeId` function to target resolver so bare JIDs (e.g., `user@domain.com`) are recognized as valid messaging targets

## [1.3.0] - 2026-02-05

### Added
- **FTP File Management**: CLI commands to upload, download, list, and delete files via FTP using same credentials as XMPP server
  - `openclaw xmpp ftp upload <local-path> [remote-name]` - Upload file to FTP (overwrites existing)
  - `openclaw xmpp ftp download <remote-name> [local-path]` - Download file from FTP
  - `openclaw xmpp ftp ls` - List files in your folder
  - `openclaw xmpp ftp rm <remote-name>` - Delete file
  - `openclaw xmpp ftp help` - Show FTP help

### Configuration
Add `ftpPort` to your XMPP account config for FTP file management:
```json
{
  "xmpp": {
    "accounts": {
      "default": {
        "ftpPort": 17323
      }
    }
  }
}
```

## [1.6.4] - 2026-02-07

### Security
- **Comprehensive Input Validation Implemented**: Created `src/security/validation.ts` with validators:
  - `isValidJid()` - Validates JID format (RFC 7622)
  - `sanitizeFilename()` - Sanitizes filenames, prevents path traversal
  - `isSafePath()` - Validates paths don't escape base directory
  - `sanitizeForHtml()` - Prevents XSS attacks
  - `sanitizeMessage()` - Sanitizes message content
  - `isValidUrl()` - Validates URL format
  - `sanitizeJid()` - Normalizes JIDs
  Applied validators in `index.ts`:
  - `downloadFile()` - Uses URL validation and filename sanitization
  - IBB file transfers - Uses filename sanitization and path validation
  - All file paths validated before use

## [1.6.3] - 2026-02-07

### Security
**Enable SFTP (SSH File Transfer)**
- **Issue**: `ftp.ts:54,85,114,139` used `secure: false` allowing plaintext FTP credentials and file data transmission
- **Solution**: Replaced FTP with SFTP over SSH using the `ssh2` package
- **Changes**:
  - Created `src/sftp.ts` with full SFTP implementation using SSH2
  - Updated `src/commands.ts` to use sftp command instead of ftp
  - Maintained same CLI interface: upload, download, ls, rm
  - Uses encrypted XMPP password from security/encryption module
- **SFTP Configuration**:
  - Host: kazakhan.com
  - Port: 2211 (SSH)
  - Username: XMPP JID (local part)
  - Password: Decrypted from encrypted config
  - Directory: Home directory
- **New Files**:
  - `src/sftp.ts` - SFTP implementation using ssh2 package
- **CLI Commands**:
  - `openclaw xmpp sftp upload <local-path> [remote-name]` - Upload file
  - `openclaw xmpp sftp download <remote-name> [local-path]` - Download file
  - `openclaw xmpp sftp ls` - List files
  - `openclaw xmpp sftp rm <remote-name>` - Delete file
  - `openclaw xmpp sftp help` - Show help
- **Backward Compatibility**:
  - Old `src/ftp.ts` preserved as fallback for FTP functionality

## [1.6.2] - 2026-02-07

### Security
**Add File Size Limits to File Transfers**
- **Issue**: No limits on file sizes in IBB transfers, HTTP uploads, or file downloads, allowing potential DoS attacks through disk space exhaustion
- **Solution**: Implemented comprehensive file size limits across all file transfer methods:
  - **IBB Transfers** (`index.ts`): Added `validateFileSize()` check in SI file transfer handler before accepting transfers
  - **HTTP Uploads** (`fileTransfer.ts`): Added size validation in `requestUploadSlot()` and `sendFileWithHTTPUpload()` functions
  - **File Downloads** (`index.ts`): Added size validation in `downloadFile()` using Content-Length header and actual buffer size
  - **Concurrent Download Limits**: Added `MAX_CONCURRENT_DOWNLOADS = 3` limit per user with `activeDownloads` tracking
- **New Configuration**:
  - `MAX_FILE_SIZE_MB = 10` (10MB limit)
  - `MAX_CONCURRENT_DOWNLOADS = 3` per user
- **Affected Functions**:
  - `validateFileSize(size)` - Validates file size against limit
  - `checkConcurrentDownloadLimit(remoteJid)` - Enforces concurrent download limit
  - Updated `downloadFile()` to track and limit downloads
  - Updated `requestUploadSlot()` to validate sizes
  - Updated SI file transfer handler to reject oversized files

## [1.6.1] - 2026-02-07

### Security
**Remove Auto-Subscription Approval**
- **Issue**: `index.ts:6647-6680` automatically approved ALL subscription requests and added senders as contacts, allowing any XMPP user to become a contact
- **Solution**: Modified subscription handler to require admin approval:
  - Existing contacts are still auto-approved (backward compatible)
  - New requests are queued in `pendingSubscriptions` Map
  - Admins receive XMPP notifications of pending requests
  - Added CLI commands: `openclaw xmpp subscriptions pending|approve|deny`
- **New Files/Modules**:
  - `PendingSubscription` interface for tracking pending requests
  - `approveSubscription()` helper function to approve and add contacts
  - `denySubscription()` helper function to reject requests
- **Behavior Change**: Any XMPP user can no longer auto-subscribe; must be approved by admin

## [1.6.0] - 2026-02-07

### Security
**Enable TLS Certificate Verification**
- **Issue**: `index.ts:452` had `tls: { rejectUnauthorized: false }` which disabled certificate verification, making connections vulnerable to MITM attacks
- **Solution**: Removed the insecure TLS configuration. XMPP client now properly validates server certificates by default
- **Risk**: If connecting to servers with self-signed certificates, add the server's certificate to the system's trust store

## [1.2.0] - 2026-02-04

### Security
- **Path Traversal Protection**: Added filename sanitization for file downloads and IBB transfers to prevent directory traversal attacks
- **Rate Limiting**: Added per-JID rate limiting (10 commands/minute) to prevent abuse
- **Message Queue Limits**: Queue limited to 100 messages to prevent memory exhaustion
- **Error Message Sanitization**: Replaced internal error details with generic user-friendly messages

### Added
- **Message Persistence**: Inbound and outbound messages now saved to `data/messages/direct/<jid>.json` and `data/messages/group/<room>/<date>.json`
- **MessageStore Integration**: Uses MessageStore class for reliable JSON persistence with max 256 messages per file

### Removed
- **Nick-to-JID Mapping**: Removed `/mapnick` command and `nickToJidMap` session mapping functionality

### Fixed
- **TypeScript Errors**: Fixed duplicate `xmppClients` export, missing type properties, and hoisting issues
- **CLI Registration**: Fixed import path for commands module
- **Outbound Message Saving**: Fixed saving to recipient's conversation file instead of bot's file
- **Dispatch Blocking**: Made dispatch fire-and-forget to prevent gateway from blocking on slow agent responses

### Known Issues
- AI occasionally makes catastrophic mistakes by using git commands without permission, overwriting local changes, and failing to maintain proper backups

## [1.1.0] - 2026-02-03

### Fixed
- **CLI Registration**: Fixed `registerCli` callback to properly register XMPP commands
- **Message Routing**: `openclaw xmpp msg` now routes through gateway to agents via `openclaw message send --channel xmpp`
- **Auto-Join**: Disabled auto-join by default to prevent connection drops on non-existent rooms; requires `autoJoinRooms: true` in config
- **Connection Stability**: Added keepalive presence pings and offline handler to prevent ECONNRESET errors

### Changed
- **CLI Commands**: Simplified command structure with proper Commander.js pattern
- **Message Archive**: Removed conflicting `messages` subcommand to avoid clashes with openclaw built-in commands

## [1.0.0] - 2026-01-31

### Added
- **Initial release** of OpenClaw XMPP plugin with full XMPP protocol support
- **XMPP Client Core**: Complete implementation using `@xmpp/client` library
- **Multi-User Chat (MUC)**: Join, participate, and manage group chat rooms
- **Direct Messaging**: 1:1 chat with individual users
- **Presence Management**: Online/offline status with subscription handling
- **Auto-Reconnection**: Automatic reconnection on network issues
- **TLS Support**: Secure connections with configurable certificate verification

### Contact & Roster Management
- **Contact Storage**: Persistent JSON storage of XMPP contacts with names
- **Admin Management**: Privileged commands for configured admin JIDs
- **Subscription Handling**: Auto-approve subscription requests and establish mutual subscriptions
- **Roster CLI Commands**: `openclaw xmpp roster` and `openclaw xmpp nick` for roster management

### File Transfer
- **HTTP Upload (XEP-0363)**: Send files via HTTP Upload protocol with server slot negotiation
- **SI File Transfer (XEP-0096)**: Receive files via In-Band Bytestreams (IBB) with session management
- **Out-of-Band Data (XEP-0066)**: Support for file attachments via URLs
- **File Download**: Automatic download of files from URLs to local storage
- **Auto-Accept Transfers**: Automatically accept and save incoming file transfers

### Whiteboard & Media Integration
- **Image Generation**: `/whiteboard draw <prompt>` - Request image generation from AI agents
- **Image Sharing**: `/whiteboard send <url>` - Share images via file transfer
- **Status Checking**: `/whiteboard status` - Check whiteboard capabilities
- **Media Forwarding**: Automatically forward attached media to agent processing

### Room & Conference Management
- **Room Auto-Join**: Automatically join configured rooms on startup
- **MUC Invite Handling**: Auto-accept room invitations with configurable nicknames
- **Room Configuration**: Automatic configuration of newly created rooms
- **Room Commands**: `/join`, `/leave`, `/invite`, `/rooms` for room management

### Administration & Commands
- **Slash Command System**: Comprehensive command system with chat/groupchat differentiation
- **Plugin Commands**: `/list`, `/add`, `/remove`, `/admins`, `/whoami`, `/vcard`, `/help`
- **Contact-Based Security**: Only contacts can use bot commands in direct chat
- **Admin-Only Commands**: Restricted commands for privileged users in direct chat only
- **Command Permissions**: Groupchat limits to plugin commands only, ignores other slash commands

### vCard Profile (XEP-0054)
- **Profile Management**: Set and retrieve vCard profile information via `/vcard` commands
- **Configurable Fields**: Full name, nickname, URL, description, avatar URL
- **Dynamic Updates**: Update vCard fields via `/vcard set` commands
- **Automatic Responses**: Respond to vCard requests with configured profile
- **Persistent Storage**: vCard data saved to JSON file for persistence

### CLI Integration
- **Status Monitoring**: `openclaw xmpp status` - Check connection status
- **Message Sending**: `openclaw xmpp msg <jid> <message>` - Send direct messages
- **Room Management**: `openclaw xmpp join <room> [nick]` - Join MUC rooms
- **Queue Operations**: `openclaw xmpp poll|clear|queue` - Manage message queue
- **Roster Access**: `openclaw xmpp roster` - View current roster
- **Nick Management**: `openclaw xmpp nick <jid> <name>` - Set roster nicknames
- **vCard Commands**: `openclaw xmpp vcard get|set <field> <value>` - Manage vCard profile

### Message Queue System
- **Inbound Queue**: Temporary storage for inbound messages awaiting agent processing
- **Queue Management**: Poll, clear, and monitor message queue via CLI
- **Age-Based Cleanup**: Automatic cleanup of old messages (24-hour default)
- **Multi-Account Support**: Queue separation for multiple XMPP accounts
- **Queue Statistics**: Track processed and unprocessed messages

### Technical Implementation
- **TypeScript**: Fully typed implementation running natively in OpenClaw
- **Modular Architecture**: Separated concerns with Contacts, VCard, and command handlers
- **Persistent Storage**: JSON-based storage for contacts, admins, and vCard data
- **Error Handling**: Comprehensive error catching and logging
- **Runtime Integration**: Full OpenClaw channel plugin architecture
- **Multi-Account Ready**: Support for multiple XMPP accounts configuration

### Configuration
- **Server Settings**: XMPP service, domain, JID, password, and resource configuration
- **vCard Defaults**: Optional vCard profile with full name, nickname, URL, description, avatar
- **Room Management**: Array of MUC rooms for auto-join on connection
- **Admin Access**: Admin JID configuration for privileged commands
- **Data Directory**: Configurable path for contacts, downloads, and plugin data storage
## [2026-06-13 12:38:04] - Fix unexpected EOF disconnects on different networks

### Changed
- src/startXMPP.ts:
  - Disable built-in @xmpp/reconnect to prevent race conditions with custom scheduleReconnect
  - Register XEP-0199 ping response handler via iqCallee.get("urn:xmpp:ping", ...)
    so the plugin responds to Prosody server pings (ping_interval=300s)
  - Enable TCP keepalive (30s interval on the TCP socket) to prevent NAT/firewall
    idle timeouts from silently dropping connections
  - Add disconnect event listener that logs clean/dirty state and event type
    to diagnose whether disconnects are network-initiated (unclean)

### Rationale
The "Unexpected EOF while reading" error occurs when the server's TCP connection
is forcibly closed without a proper </stream:stream> tag. This happens when:
1. NAT/firewall equipment drops idle connections (no keepalive existed before)
2. The server's pings went unanswered (no ping handler was registered)
3. Dual reconnect systems raced, potentially creating duplicate connections

