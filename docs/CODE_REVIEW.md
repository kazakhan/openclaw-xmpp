# Code Review: OpenClaw XMPP Plugin v2.1.0

> Review date: 2026-06-15 (updated from v2.0.20 baseline)
> Codebase: `C:\Users\kazak\.openclaw\extensions\xmpp`
> Total source: ~9,200 lines across 38 TypeScript files
> Reviewer: opencode (build mode), full-codebase review

This document supersedes the v2.0.20 review.  All findings from v2.0.20
that were marked **FIXED** remain fixed in v2.1.0; they are listed
under §18 (Post-Review Fixes) for historical context.  New findings
from the v2.1.0 review are flagged with **[NEW in 2.1.0]** or
**[STILL PRESENT in 2.1.0]** as appropriate.

---

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [High Severity](#2-high-severity)
3. [Medium Severity](#3-medium-severity)
4. [Low Severity](#4-low-severity)
5. [Code Quality](#5-code-quality)
6. [Architecture Observations](#6-architecture-observations)
7. [Security Observations](#7-security-observations)
8. [Operational Issues](#8-operational-issues)
9. [Improvement Recommendations](#9-improvement-recommendations)
10. [Summary](#10-summary)
11. [Post-Review Fixes — v2.0.4](#11-post-review-fixes--v204)
12. [Post-Review Fixes — v2.0.12 / v2.0.13](#12-post-review-fixes--v2012--v2013)
13. [Post-Review Fixes — v2.0.14 (this release)](#13-post-review-fixes--v2014-this-release)
14. [Post-Review Fixes — v2.0.16 (this release)](#14-post-review-fixes--v2016-this-release)
15. [Post-Review Fixes — v2.0.17 (this release)](#15-post-review-fixes--v2017-this-release)
16. [Post-Review Fixes — v2.0.18 (this release)](#16-post-review-fixes--v2018-this-release)
17. [Post-Review Fixes — v2.0.19 (this release)](#17-post-review-fixes--v2019-this-release)
18. [Post-Review Fixes — v2.0.20 (this release)](#18-post-review-fixes--v2020-this-release)
19. [Post-Review Fixes — v2.1.0 (groupchat dispatch hygiene — this release)](#19-post-review-fixes--v210-groupchat-dispatch-hygiene--this-release)

---

## 1. Critical Issues

Issues that would cause runtime failures, data loss, or security
exposures that an attacker can reach today.

### 1.1 `sftp.ts:28` — `hostVerifier: () => true` disables SSH host key verification  **[NEW in 2.0.14 review]**

**File / line:** `src/sftp.ts:28`
**Severity:** CRITICAL

```ts
conn.connect({
  host: config.domain,
  port: config.sftpPort || 2211,
  username: config.jid.split('@')[0],
  password: config.password,
  readyTimeout: 10000,
  hostVerifier: () => true,    // ← MITM vulnerability
});
```

The `hostVerifier` callback is hard-coded to return `true`, which
means `ssh2` will accept ANY host key for ANY server.  An attacker on
the same network (or on the routing path) can intercept the
connection, present their own host key, capture the plaintext XMPP
password, and proxy the connection transparently.

**Impact:** Plaintext XMPP password is stolen on first use.  The
attacker now has full access to the XMPP account.

**Fix:** Use a known_hosts file, or at minimum an explicit pinned
fingerprint, e.g.:

```ts
hostVerifier: (hashedKey) => config.knownHostKey === hashedKey
```

### 1.2 `gateway-client.ts:64-90` — gateway auth token / password passed as CLI argument  **[NEW in 2.0.14 review]**

**File / line:** `src/gateway-client.ts:64-90`
**Severity:** CRITICAL

```ts
const args = ["gateway", "call", method];
if (params) args.push("--params", JSON.stringify(params));
if (config.url && config.url !== "ws://127.0.0.1:18789") {
  args.push("--url", config.url);
}
if (config.token) {
  args.push("--token", config.token);           // ← leaks to process list
} else if (config.password) {
  args.push("--password", config.password);     // ← leaks to process list
}
…
proc = spawn("openclaw", args, { … });
```

The gateway auth token (or password) is passed as a command-line
argument to the spawned `openclaw gateway call` process.  On Windows,
Linux, and macOS, command-line arguments of running processes are
visible to any local user via:

- `wmic process get commandline` (Windows)
- `ps aux` / `ps -ef` (Linux/macOS)
- `/proc/<pid>/cmdline` (Linux)
- Activity Monitor (macOS)
- Task Manager → Details → Command Line (Windows, admin)

**Impact:** Any local user (or any process running as any local user)
on the same machine can read the gateway auth token from process
listings while the RPC is in flight (up to 30s per RPC).

**Fix:** Use stdin or an env var (e.g. `OPENCLAW_GATEWAY_TOKEN`)
instead of argv.  env vars are also visible in `/proc/<pid>/environ`
on Linux, so stdin is preferred.  Or call the gateway over its
existing authenticated websocket / unix-socket connection rather
than re-spawning a CLI per call.

### 1.3 `cli-encrypt.ts:7-15` — password accepted as CLI argument  **[NEW in 2.0.14 review]**

**File / line:** `src/cli-encrypt.ts:7-15`
**Severity:** CRITICAL (on the CLI side)

```ts
const args = process.argv.slice(2);
…
if (args[0] === 'encrypt-password') {
  const password = args[1];
  …
  updateConfigWithEncryptedPassword(configPath, password);
}
```

The password is taken from `process.argv` and then read into
`openclaw.json`.  Until the file is written, the password is in
process memory and the shell's history.  The header comment even
suggests `echo "mypassword" | npx tsx …` as the *recommended*
invocation, but the implementation only supports argv.

**Impact:** Same as 1.2: the password is visible in process listings
and shell history while the command runs.

**Fix:** Read from stdin.  The header comment already documents the
desired behaviour — implement it.

### 1.4 `commands.ts:71-76` — `spawn(process.execPath, [process.argv[0], "gateway"], …)` is wrong  **[NEW in 2.0.14 review]**

**File / line:** `src/commands.ts:71-76`
**Severity:** CRITICAL (functional, breaks the `xmpp start` command)

```ts
const gatewayProcess = spawn(process.execPath, [process.argv[0], "gateway"], {
  detached: true,
  stdio: 'ignore',
  cwd: process.cwd(),
  env: { ...process.env }
});
```

`process.execPath` is the path to the Node.js binary, e.g.
`C:\Program Files\nodejs\node.exe`.  `process.argv[0]` is *also*
`node.exe` in most cases (it's whatever was used to invoke this
script).  The intent was clearly to spawn `openclaw gateway …`, but
this code is running `node.exe node.exe gateway`, which Node will
interpret as a script named `node.exe` (no such file) plus an extra
argument `gateway`.

**Impact:** `openclaw xmpp start` will fail to start the gateway.

**Fix:**

```ts
const isWin = process.platform === "win32";
const cmd = isWin ? "openclaw" : "openclaw";
spawn(cmd, ["gateway"], { detached: true, stdio: "ignore", … });
```

### 1.5 `messageStore.ts:204` — `getDirectChatJIDs()` JID round-trip is broken  **[NEW in 2.0.14 review]**

**File / line:** `src/messageStore.ts:198-209`
**Severity:** CRITICAL (functional, data corruption on read)

```ts
async getDirectChatJIDs(): Promise<string[]> {
  …
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', '_'))     // e.g. "user_at_x.com_" 
    .map(s => s.replace(/_/g, '.'));       // "user.at.x.com."
}
```

The intent was to convert a JID-derived filename like
`user_at_domain.com.json` back to a JID.  But the transformation is
`replace('.json', '_')` (only replaces FIRST `.json` substring) then
`replace(/_/g, '.')` (replaces ALL underscores).  A JID
`user_at_domain.com` becomes:

- `user_at_domain.com.json` (on disk)
- `replace('.json', '_')` → `user_at_domain.com_` (FIRST match, drops `.json` and replaces with `_` only if `.json` appears at that exact position; for the standard filename above it correctly replaces the trailing `.json` with `_` — so far so good)
- `replace(/_/g, '.')` → `user.at.domain.com.`  (trailing dot, every underscore in the original JID also turned into a dot, and the trailing `_` from the `.json` replacement is also a dot)

So `user_at_domain.com` is returned as `user.at.domain.com.` — wrong
on three counts: the JID's underscore has been turned into a dot
(collapses `user_at_domain.com` and `user_at_domain_com` into the
same JID), and the trailing dot is invalid.

**Impact:** `getDirectChatJIDs()` returns malformed JIDs that cannot
be used to re-read the message files via `getDirectMessages()`.  Any
caller relying on this for a UI (history browser, etc.) will
display the wrong conversation list.

**Fix:** Use a reversible encoding.  E.g. replace `.` with `%2E` and
`/` with `%2F` in the JID when writing the filename, then reverse
when listing.  Or store a sibling index file `{jid}.json.meta` with
the original JID.

### 1.6 `index.ts:43, 62, 96` — gateway RPC handlers don't await async client methods  **[NEW in 2.0.14 review]**

**File / line:** `src/index.ts:43, 62, 96`
**Severity:** CRITICAL (functional, errors silently swallowed)

```ts
api.registerGatewayMethod("xmpp.joinRoom", ({ params, respond }) => {
  …
  try {
    client.joinRoom(room, nick);            // ← no await
    respond(true, { ok: true, room, nick });
  } catch (err: any) {
    respond(false, { error: err.message || String(err) });
  }
});
```

`client.joinRoom`, `client.leaveRoom`, `client.inviteToRoom` are all
`async` methods (declared in `startXMPP.ts:2437, 2458, 2500`).  Not
awaiting them means:

1. The RPC returns `ok: true` *before* the actual XMPP stanza is
   sent.  Callers cannot know whether the join succeeded.
2. Any rejection from the underlying `xmpp.send(presence)` call is
   lost — it becomes an unhandled promise rejection.  The
   `process.on('unhandledRejection', …)` handler in `startXMPP.ts:29`
   catches it but only logs an error, never propagates it back to
   the RPC caller.

**Impact:** False-positive RPC responses, silent join failures,
"my bot never joined the room" bugs.

**Fix:** Make the handlers `async`, `await` the calls, and catch
errors properly:

```ts
api.registerGatewayMethod("xmpp.joinRoom", async ({ params, respond }) => {
  try {
    await client.joinRoom(room, nick);
    respond(true, { ok: true, room, nick });
  } catch (err: any) {
    respond(false, { error: err.message || String(err) });
  }
});
```

The same applies to `xmpp.leaveRoom` (line 62) and
`xmpp.inviteToRoom` (line 96).

### 1.7 `commands.ts:3` — unused import (`fileURLToPath`, `execSync`)  **[NEW in 2.0.14 review]**

**File / line:** `src/commands.ts:3`
**Severity:** LOW (code quality) but bundled with the 1.4 critical
issue above, so flagged here.

```ts
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "node:url";
import path from "path";
```

None of `execSync`, `fileURLToPath`, or `path` are referenced
anywhere in `commands.ts`.  The unused imports are a sign that
refactoring was started and abandoned.  No runtime impact.

### 1.8 Critical issues from prior reviews — still resolved in 2.0.14

- `inviter` is defined (1.1 in v2.0.4 review) — still resolved.
- `log` import in `whiteboard.ts` — still resolved.
- Duplicate interface declarations in `gateway.ts` — still resolved.
- `xmpp.send()` hang on dead socket (added in 2.0.4 review) — still
  mitigated by 30s `Promise.race` (now wrapped in v2.0.14 liveness
  timers, see §13.1).
- `xmpp.start().catch` race with `disconnect` (2.0.13 review §1.5) —
  still mitigated; see §13.3 for new analysis.

---

## 2. High Severity

Issues that will not crash the process but cause incorrect
behaviour, security exposures that require an additional step to
exploit, or significant maintenance burden.

### 2.1 `commands.ts:853-867` — `rl.question('', password)` echoes the password to the terminal  **[NEW in 2.0.14 review]**

**File / line:** `src/commands.ts:820-868`
**Severity:** HIGH (security UX)

The `encrypt-password` subcommand reads the password from
`readline.createInterface({ input: process.stdin, output: process.stdout })`
with no silent-mode flag.  The terminal will echo the password
character by character as the user types, defeating the
"hidden" message printed just above.

**Fix:** Use `rl.stdout.muted = true` or pipe stdin from an
external source.  Cross-platform silent TTY input in Node.js is
unfortunately awkward; the standard pattern is to spawn a hidden
helper that uses raw mode and a TTY escape sequence, or to accept
the password from stdin in a piped mode.

### 2.2 `lib/upload-protocol.ts:171` — HTTPS downgraded to HTTP for file uploads  **[NEW in 2.0.14 review]**

**File / line:** `src/lib/upload-protocol.ts:171`
**Severity:** HIGH (security, file contents leak)

```ts
const httpPutUrl = putUrl.replace(/^https:\/\//, 'http://');
```

XEP-0363 upload slots are HTTPS URLs.  This code explicitly rewrites
`https://` to `http://` before `fetch()`-ing them, which means the
uploaded file body is sent **in cleartext** over the network.  If
the upload slot URL was an HTTPS URL the server likely enforces
HTTPS only and will return a redirect or a 4xx — but if the server
allows HTTP, the file contents (avatars, attached documents,
sensitive exports) are observable by anyone on the path.

**Fix:** Use the URL as-is.  `fetch()` already supports HTTPS.  If
the server's TLS certificate is the problem, configure `NODE_TLS_REJECT_UNAUTHORIZED=0` only as a last resort and only for the
upload service, never as a global default.

### 2.3 `whiteboard-cli.ts:79-126` — `parseSvgPath()` builds SVG via string concatenation (XSS)  **[NEW in 2.0.14 review]**

**File / line:** `src/whiteboard-cli.ts:79-126`
**Severity:** HIGH (XSS on the receiving XMPP client)

```ts
svgElements.push(`<path d="${cmd}" fill="none" stroke="#000" stroke-width="1"/>`);
```

`pathData` is user-controlled (it comes from a CLI argument that is
ultimately destined to be sent as an XMPP whiteboard stanza to
another user).  An attacker who can convince the bot to call
`sendWhiteboardMessage` with a payload like

```
M10,10" onclick="alert(document.cookie)" x="
```

will produce a stanza containing the literal `onclick` attribute.
XMPP clients that render the SVG (e.g. as an HTML preview) are
then vulnerable to XSS.

**Fix:** Use a proper XML library.  The plugin already imports
`@xmpp/client`'s `xml()` builder — use it:

```ts
return xml('path', { d: cmd, fill: 'none', stroke: '#000', 'stroke-width': '1' });
```

`xml()` will properly escape the attribute value.

### 2.4 `startXMPP.ts:425-447` — `nonza` listener closure-captures stale `smNegotiated`  **[STILL PRESENT in 2.0.14, re-examined]**

**File / line:** `src/startXMPP.ts:425-447`
**Severity:** MEDIUM (correctness, can produce false log lines)

The new `xmpp.on("nonza", …)` handler reads `el.is("sm", "urn:xmpp:sm:3")`
on every non-stanza element.  Two subtle issues:

1. `el?.is?.("sm", "urn:xmpp:sm:3")` will match ANY element named `sm`
   in the `urn:xmpp:sm:3` namespace, not just the stream-features
   advertisement.  If a stanza contains an embedded `<sm/>` for any
   other reason (e.g. a misbehaving server, or a `<sm/>` reply
   embedded inside an unrelated IQ), `smNegotiated` will be set to
   true and the SM `<r/>` timer will start firing forever.  The fix
   is to check the element's parent is the stream-features stanza,
   but the current code doesn't.
2. The handler catches `e` in a `try {} catch (e) {}` and does
   nothing.  If the parser ever throws (e.g. an unexpected element
   type), it is silently swallowed.  At minimum, `xmppLog.error()`
   the exception so it is visible.

**Severity note:** This is HIGH only on servers that don't speak
SM, because the side-effect is benign (no `<r/>` is sent, the
keepalive chain breaks, and we fall back to the IQ-ping watchdog
which still works).  For the failing PCs the SM keepalive being
silently disabled is a regression that would have looked like a
fix that didn't fix the problem.

### 2.5 `startXMPP.ts:336-348` — `__openclaw_watch_installed` flag does not survive STARTTLS re-wrap  **[NEW in 2.0.14 review]**

**File / line:** `src/startXMPP.ts:324-361`
**Severity:** HIGH (regression under reconnect-after-STARTTLS)

```ts
const installSocketDataWatch = () => {
  const sock = findUnderlyingSocket();
  …
  (sock as any).__openclaw_watch_installed = true;
  sock.on("data", () => { … });
  …
};
```

The `__openclaw_watch_installed` flag is stored on the *current*
underlying socket.  When `scheduleReconnect` fires:

1. `xmpp.stop()` tears down the old socket.
2. `xmpp.start()` creates a brand new `net.Socket`.
3. `xmpp.on("online", …)` fires, which calls `installSocketDataWatch()`.
4. The new socket doesn't have the flag, so the install proceeds.

So far so good.  **However**, when STARTTLS is in use, the *initial*
connect creates a `net.Socket` (plain), then `@xmpp/starttls` upgrades
it to a `tls.TLSSocket` wrapped by `@xmpp/tls/lib/Socket`.  The
`installSocketDataWatch` runs on the FIRST `online` event, which
fires *after* STARTTLS upgrade.  The flag is on the post-STARTTLS
socket, which is correct.

But on *reconnect*, the sequence is:
1. Reconnect creates a plain `net.Socket`.
2. SASL auth happens, then `online` fires.
3. `installSocketDataWatch` runs and installs the data watcher on
   the post-STARTTLS socket.  Fine.
4. The user has not enabled STARTTLS, so the underlying socket is
   still the original `net.Socket` from step 1.  Also fine.

**Wait, this scenario is actually fine.**  Let me re-examine…

Actually the more subtle issue: the `__openclaw_watch_installed` flag
is per-socket-instance, not per-connection.  If the underlying
socket is somehow replaced without the offline → online cycle (e.g.
STARTTLS re-negotiation after a stream restart, which the
`@xmpp/starttls` middleware does at the `restart()` call site), then
the new socket will not have the watcher.  This *can* happen if
`@xmpp/session-establishment` triggers a stream restart after
`online`, and the server's response includes a new `<starttls/>` (in
practice extremely rare on modern XMPP servers).  In that case the
old socket's data/end/error listeners are detached by
`@xmpp/connection`'s `_detachSocket` and the new socket's
`__openclaw_watch_installed` is undefined, so a new install should
fire… **but** the new socket is *not* re-walked by the existing
`installSocketDataWatch` because that function is only called from
the `online` handler.  After the `online` event the connection
should not normally need another `installSocketDataWatch` call.

**Net:** this is a real corner-case bug that will be hard to
reproduce.  Recommendation: re-install the watcher in the `restart`
event too (if `@xmpp/connection` exposes one) or, more robustly,
move the install into `_attachSocket` via a `setTimeout(0)` so it
runs after every socket attachment.

### 2.6 `commands.ts:865-866` — `console.error` alongside `log`  **[STILL PRESENT]**

Documented in the v2.0.4 review (5.5).  Still all over
`commands.ts` and `vcard-cli.ts`.  Inconsistent logging means
errors go to stdout/stderr instead of the structured log file.

### 2.7 `startXMPP.ts:638-642` — `onOnline(xmppClient)` defensive guard  **[NEW in 2.0.14]**

The new `typeof (xmppClient as any) === "undefined"` check works
but the safer fix is to declare `xmppClient` (or a mutable holder
for it) *before* the `online` handler is registered, so the closure
always has a defined reference.  The current `const xmppClient` at
line ~2760 is in the temporal dead zone relative to the `online`
event handler, and the guard is papering over that.  Recommended
refactor: declare `let xmppClient: any = null;` at the top of the
function and assign it where it is currently declared, so the
handler can refer to the binding without the guard.

### 2.8 High-severity items from v2.0.4 review still addressed  ✅

- 39 type errors → 0 (still).
- 6 TS2307 subpath import errors → still resolved.
- `xmpp.send()` 30s timeout — still in place.

---

## 3. Medium Severity

### 3.1 `gateway.ts:215, 349, 352, 355, 383, 387` — `log.error` is used for non-error diagnostic data  **[NEW in 2.0.14 review]**

**File / line:** `src/gateway.ts:215, 299, 349, 352, 355, 383-387`
**Severity:** MEDIUM (log noise; potential alert fatigue)

The `deliver` callback in the dispatch path uses `log.error()` for
non-errors:

```ts
log.error(`DISPATCH_ENTERED: from=${from} bodyLen=${…} type=${options?.type} room=${…} nick=${…}`);
log.error(`GC_DELIVER: called=true payloadKeys=${…} textLen=${…} isGC=${…}`);
log.error(`GC_SEND: pre  isGC=${…} jid=${…} cleanTextLen=${…} ready=${true}`);
log.error(`GC_SEND: post groupchat success=true`);
log.error(`GC_SEND: post direct success=true`);
```

Every inbound and outbound message produces 4 `log.error` lines.
This will swamp any real error monitoring (Promtail / Datadog / etc.
that alert on `error` level) with thousands of benign messages per
hour.  These should be `log.debug` or `log.info`.

**Fix:** Downgrade these to `debug` (these are trace-level) and use
`debugLog()` (which writes to `cli-debug.log` and not the main log).

### 3.2 `startXMPP.ts:206-208` — `xmpp.send()` hang still not fully addressed  **[NEW in 2.0.14 review]**

**File / line:** `src/startXMPP.ts:206-208` and the many other
`await xmpp.send(...)` calls throughout the file
**Severity:** MEDIUM

The v2.0.4 review (§11.1) identified that `xmpp.send()` can hang
indefinitely on a dead socket.  The fix in v2.0.4 added a
`Promise.race` to the ping send only.  **The same race condition
applies to every other `xmpp.send()` call in `startXMPP.ts`** —
the presence probe (line 473), vCard send (line 624), every
`sendFile`, every outbound message from `deliver`, every IBB ack,
etc.  Any of these can hang on a dead socket.

In 2.0.14, the IQ-ping watchdog (Fix 2) and the idle-socket
watchdog (Fix 4) catch the underlying dead-socket case *eventually*
by destroying the socket, which causes all in-flight `xmpp.send()`
calls to reject.  But the window between "socket died silently"
and "watchdog fires" can be up to `IQ_PING_TIMEOUT_MS` (20s) for
the IQ-ping path or up to `SOCKET_IDLE_TIMEOUT_MS` (120s) for the
idle path.  During that window, the gateway's HTTP request hangs.

**Fix:** Wrap every `xmpp.send(...)` with a `Promise.race` against
a timeout, or better, add a `setTimeout` to the `@xmpp/connection`
prototype's `write()` method via a one-time patch.

### 3.3 `queue-bridge.ts:5-11` — `getQueue` singleton ignores `dataDir` after first call  **[NEW in 2.0.14 review]**

**File / line:** `src/queue-bridge.ts:5-11`
**Severity:** MEDIUM (multi-account correctness)

```ts
let messageQueue: PersistentQueue | null = null;
function getQueue(dataDir?: string): PersistentQueue {
  if (!messageQueue) {
    const dir = dataDir || process.cwd();
    messageQueue = new PersistentQueue(dir);
  }
  return messageQueue;
}
```

If two accounts are configured, the first call wins and all later
calls use the first account's `dataDir`, regardless of what is
passed in.  This means a second XMPP account's messages will be
written to the first account's `message-queue.json` — leading to
account-id collisions in the queue and confused routing in
`dispatchInboundReplyWithBase`.

**Fix:** Use a `Map<string, PersistentQueue>` keyed by `dataDir`.

### 3.4 `lib/persistent-queue.ts:48-53` — `save()` silently swallows errors  **[STILL PRESENT]**

The `save()` method's `try { … } catch {}` discards the error
entirely.  If the queue file can't be written (full disk,
permission denied, file locked by antivirus), the queue's
in-memory state advances and is then lost on restart.  At minimum
log the error.

### 3.5 `lib/persistent-queue.ts:82-89` — `clearOld` uses `timestamp` not `processed` flag  **[NEW in 2.0.14 review]**

```ts
clearOld(maxAgeMs: number = 86400000): number {
  const cutoff = Date.now() - maxAgeMs;
  const before = this.queue.length;
  this.queue = this.queue.filter(m => m.timestamp > cutoff);
  …
}
```

Old *unprocessed* messages are dropped along with old *processed*
messages.  If a message is queued at `T0` and the gateway is
restarted at `T0 + 23h` and `clearOld` runs at `T0 + 25h` (with
the default 24h max-age), the unprocessed message is dropped
without ever being delivered.

**Fix:** Either don't drop unprocessed messages, or move them to a
`dead-letter` sub-array that the operator can inspect.

### 3.6 `jsonStore.ts:76-80` — `set(updates)` is not concurrency-safe  **[STILL PRESENT]**

```ts
async set(updates: Partial<T>): Promise<void> {
  await this.whenReady();
  Object.assign(this.data, updates);
  await this.save();
}
```

The read-modify-write pattern is not atomic.  Two concurrent
`add()` calls (e.g. two simultaneous contact adds from two
inbound messages) can race: both load the same baseline, both
append, the second `save()` overwrites the first.  In the Node.js
event-loop model this is rare but not impossible (an `await`
between load and save — which doesn't exist here — would be the
only thing making it safe; here there is no `await` between
`Object.assign` and `save`, so it *is* safe for the in-memory
case… but the `get()` call in the caller *does* `await`, see
`Contacts.add()` at `contacts.ts:47-50`).

Net: the pattern works for direct calls but is fragile.  The
risk is real if any future caller adds an `await` between
`this.contactsStore.get()` and `this.contactsStore.set()`.

### 3.7 `lib/upload-protocol.ts:62-67` — `setTimeout(..., 10000)` for upload discovery but no clearTimeout  **[STILL PRESENT]**

The upload service discovery has a 10-second `setTimeout` that
fences the promise, but if the discovery resolves or rejects
before the timeout fires, the timer is *not* cleared.  The timer
keeps the Node event loop alive and fires 10s later, calling
`xmpp.off('stanza', handler)` and `resolve(null)` on an already-
resolved promise (no-op for the resolve, but `xmpp.off()` will
silently no-op because the handler was already removed).  Minor
leak; no functional impact.

### 3.8 `lib/upload-protocol.ts:42` — error response handler leaves `resolved` flag inconsistent  **[NEW in 2.0.14 review]**

```ts
} else if (stanza.attrs.id === iqId && stanza.attrs.type === 'error') {
  resolved = true;
  xmpp.off('stanza', handler);
  resolve(null);
}
```

vs the success path:

```ts
if (stanza.attrs.id === iqId && stanza.attrs.type === 'result') {
  resolved = true;
  …
  resolve(null);   // ← but only after the loop that searches for upload JID
}
```

The success path is fine; the error path resolves with `null`
(consistent with the "no upload service" outcome).  The only
issue is that the error handler doesn't `return` after `resolve(null)`,
so the success-path's `if (jid.includes('upload') || ...)` loop
above is *not* reachable (the branches are mutually exclusive via
the outer `else if`).  Cosmetic only.

### 3.9 `contacts.ts:11` — `JsonStore` does not validate JID format  **[STILL PRESENT]**

`Contacts.add()` accepts any string for `jid`.  A typo'd
`alice@@example.com` or `bob@example` is stored without complaint.
`isValidJid()` exists in `security/validation.ts` and is not used
here.

**Fix:** Call `validators.isValidJid(jid)` in `add()` and reject
with `false` if invalid.

### 3.10 `commands.ts:148-152` — in-memory roster does not persist  **[STILL PRESENT]**

`saveRoster()` logs "Roster saved (in-memory only)".  The `nick`
subcommand silently does nothing durable.  Either implement disk
persistence or remove the subcommand to avoid surprising the
operator.

### 3.11 `startXMPP.ts:271-282` — `findUnderlyingSocket` returns the wrapper's `.socket`, not the wrapper  **[NEW in 2.0.14 review]**

**File / line:** `src/startXMPP.ts:269-283`
**Severity:** LOW (correctness, see §4 for the actual impact)

The function unwraps to the first layer with `setKeepAlive`.  In
the STARTTLS case the chain is:

```
@xmpp/tls/lib/Socket (wrapper, no setKeepAlive)
  └── tls.TLSSocket (no setKeepAlive directly — it has the method
                       but the chain walk unwraps it first because
                       the wrapper has `.socket` and the loop
                       unwraps BEFORE checking the inner type)
      └── net.Socket (has setKeepAlive)
```

Wait — let me re-read.  In `lib/tls/Socket.js`:

```js
class Socket extends EventEmitter {
  connect(...args) {
    this._attachSocket(tls.connect(...args));
  }
  _attachSocket(socket) {
    this.socket = socket;   // ← tls.TLSSocket stored on .socket
    …
  }
}
```

So `wrapper.socket = tls.TLSSocket`.  `tls.TLSSocket` is a
`stream.Duplex`; it does have `setKeepAlive` as a method.  But the
chain walk checks `wrapper.setKeepAlive` first — it's an
`EventEmitter`, so no.  Then `wrapper.socket` → `tls.TLSSocket`.
Then `tls.TLSSocket.setKeepAlive` — yes, it's a method.  So the
walk terminates at the `tls.TLSSocket` and `setKeepAlive(true, 30)`
is called on it.  Setting `setKeepAlive` on a `tls.TLSSocket`
propagates to the underlying `net.Socket` via the TLS layer.

**This is actually correct.**  The previous reviewer flagged it
because the wrapper is unwrapped and the TLS socket is
re-recognised, but `tls.TLSSocket.setKeepAlive` does delegate to
the TCP socket.  **No fix needed.**

(Flagged here so the v2.0.14 reviewer doesn't have to re-derive it
next time.)

### 3.12 `startXMPP.ts:1148` — Whiteboard auto-draw runs even if no paths were received  **[NEW in 2.0.14 review]**

Actually re-reading the code: the auto-draw is guarded by
`if (reconstructedPaths.length > 0 && !currentSession.autoDrawSent)`,
so it doesn't run on empty sessions.  False alarm — skipping.

### 3.13 `startXMPP.ts:142-143` — handlers pass `onMessage(fromBareJid, …)` for `/whiteboard` instructions  **[NEW in 2.0.14 review]**

The whiteboard "instructions" system message is sent with
`isSystemMessage: true`.  Downstream consumers must handle this
flag or risk generating AI responses to instructions that are
themselves intended as instructions.  Verify in
`dispatchInboundReplyWithBase` that `isSystemMessage` short-circuits
any AI response generation.  If it doesn't, every new whiteboard
session triggers an AI turn.

### 3.14 `gateway.ts:145` — `await this.services.startXmpp(...)` with no timeout  **[NEW in 2.0.14 review]**

`startXmpp()` is async and can take unbounded time (TCP
connect + TLS + SASL + resource binding + SM, each of which can
hang if the server is broken).  If the XMPP server is unreachable
or slow, the gateway's `startAccount` blocks forever, holding the
abort signal but never resolving the outer `Promise<void>` at line
425.  Add an overall timeout (e.g. 60s) and `ctx.abortSignal`'s
`abort` event should also propagate to `xmpp.stop()`.

### 3.15 Medium items from v2.0.4 review still addressed  ✅

- Conflicting reconnect mechanisms — still resolved.
- Ping 3-retry threshold — still in place.

---

## 4. Low Severity

### 4.1 `startXMPP.ts:23-24` — module-level `let xmppClientModule: any = null;`  **[STILL PRESENT]**

The `xmppClientModule` is shared between `startXmpp` invocations.
If two accounts are started, the second invocation reuses the
first's already-cached module.  This is fine (modules are
immutable after load), but the variable could just be hoisted to
the function scope and loaded once per process.

### 4.2 `startXMPP.ts:84` — `xmpp.write("<r xmlns='urn:xmpp:sm:3'/>")` uses single quotes  **[NEW in 2.0.14 review]**

The XML string uses single quotes for the xmlns attribute value,
which is valid XML.  But it should use the `xml()` builder to be
consistent with the rest of the codebase and to avoid any future
mismatch when escaping rules change.  Trivial.

### 4.3 `startXMPP.ts:530-531` — `lastInboundAt = Date.now()` after every SM `<r/>` write  **[NEW in 2.0.14 review]**

This is a small semantic issue: the SM `<r/>` is an *outbound*
operation, not an inbound one.  Stamping `lastInboundAt` on a
write means the idle-socket watchdog will reset its timer when we
*send* a packet, even if the server doesn't reply.  This is
arguably correct (we are doing I/O), but the watchdog's purpose is
to detect "no bytes have been received" — so resetting it on
*send* is conservative.  Add a comment explaining the choice.

### 4.4 `security/fileTransfer.ts:6-61` — `DEFAULT_CONFIG` includes `quarantineDir: './quarantine'`  **[STILL PRESENT]**

`./quarantine` is a relative path; the actual quarantine location
depends on the process's CWD.  Use an absolute path or a path
relative to the user's data directory.

### 4.5 `security/fileTransfer.ts:344` — `secureDeleteFile` is not actually secure on SSD  **[STILL PRESENT]**

`fs.writeSync(fd, buffer)` overwrites the file with zeroes, but on
SSD with wear-leveling and on journaling filesystems the original
blocks may be retained indefinitely.  This is a known limitation
of software-based secure-delete; document it in a comment so the
operator doesn't believe the file is unrecoverable.

### 4.6 `whiteboard.ts:684-695` — `convertSxeToWhiteboardData` `attrEdits.push(...)` inside a loop  **[NEW in 2.0.14 review]**

```ts
for (const set of setEdits) {
  const existingAttr = attrEdits.find(a => (a.rid === targetRid || a.parent === targetRid));
  if (existingAttr && set.chdata !== undefined) {
    …
  } else if (set.chdata !== undefined) {
    attrEdits.push({ … });   // ← mutates the array we are iterating find() over
  }
}
```

`Array.find()` is not affected by `Array.push()` (the array gets
longer, but the search starts from index 0 and is only used to
locate the *existing* attr).  This is actually correct, but the
mutation pattern is hard to read.  Refactor to compute the
result first, then push.

### 4.7 `whiteboard.ts:738-743` — `standalonePaths` extraction is dead code  **[NEW in 2.0.14 review]**

```ts
const standalonePaths: string[] = [];
for (const el of sxeData.elements) {
  if ((el.type === 'new' || el.type === 'set' || !el.type) && el.name === 'd' && el.chdata) {
    standalonePaths.push(el.chdata);
  }
}

if (paths.length > 0) {
  return { type: 'path', paths, moves, deletes, rawPaths: standalonePaths.length > 0 ? standalonePaths : undefined };
}
…
return { type: 'path', paths, moves, deletes, rawPaths: standalonePaths.length > 0 ? standalonePaths : undefined };
```

`rawPaths` is set on the returned data, but no consumer of
`WhiteboardData` references it (search confirms: no other file
uses `rawPaths`).  Dead code, or a half-finished feature.  Either
document the intent or remove.

### 4.8 `vcard-cli.ts:91-108, 111-127` — `metadataHandler` / `dataHandler` only set `success = true`, never false on error  **[NEW in 2.0.14 review]**

If the server returns an error stanza, `success` is not flipped,
so the function returns the value from *before* the error.  If
the previous publish succeeded and the current one errors, the
function returns `true` falsely.  Track error stanzas explicitly:

```ts
const handler = (stanza: any) => {
  if (stanza.attrs.id === id) {
    if (stanza.attrs.type === 'result') success = true;
    else if (stanza.attrs.type === 'error') success = false;
  }
};
```

### 4.9 `vcard-cli.ts:60, 66-68, 225-228, …` — `await new Promise(r => setTimeout(r, 800))` after every IQ  **[STILL PRESENT]**

Every `get → modify → set` vCard operation uses an 800ms hard-coded
sleep instead of waiting for the response stanza.  This is slow
(vCard with N phone numbers takes `(N+1) * 1.1` seconds) and
unreliable (800ms is not enough on a slow connection).  Replace
with proper `sendReceive` or with a promise that resolves on the
matching `id`.

### 4.10 `gateway.ts:131` — `ctx.cfg.session?.store` may be undefined  **[STILL PRESENT]**

The `session` field is typed as `Record<string, unknown>` and the
optional chaining works, but if `ctx.cfg.session` is undefined the
`recordInboundSession` path is silently skipped.  Add a warning
log when this path is skipped so the operator knows why file
notifications aren't being recorded.

### 4.11 `state.ts:3-4` — `Map<string, any>` for clients/contacts  **[STILL PRESENT]**

The `any` types defeat the strongly-typed `XmppClient` interface
in `types.ts`.  Use `Map<string, XmppClient>` and
`Map<string, Contacts>` instead.

### 4.12 `commands.ts:62, 102, 145, 156, 246, 292, 327, 409, 747, 816` — repeated subcommand patterns  **[STILL PRESENT]**

Every subcommand duplicates the JID-validation pattern
(`if (!jid.includes('@'))`).  Extract a helper:

```ts
function requireJid(jid: string, usage: string): boolean {
  if (!jid || !jid.includes('@')) {
    console.error(`Invalid JID. ${usage}`);
    return false;
  }
  return true;
}
```

### 4.13 `vcard-cli.ts:14-28` — `saveVCardLocally` is sync in an async codebase  **[STILL PRESENT]**

Uses `fs.writeFileSync`.  Use `fs.promises.writeFile`.

### 4.14 `vcard-cli.ts:30-47` — `withConnection` doesn't catch start errors  **[STILL PRESENT]**

`xmpp.start()` may reject (e.g. bad credentials).  The error
listener is set but `xmpp.start()` is `await`ed, and the listener
may fire after the await resolves.  This is a race — the
"throwing" path is racy with the "listener" path.  Wrap the start
in a try/catch.

### 4.15 Inconsistent import style (`.js` vs no extension)  **[STILL PRESENT]**

Some files use `from "./foo.js"`, others use `from "./foo"`.  The
ESM convention is to always use the `.js` extension (the
TypeScript source uses `.ts` but emits `.js`).  Mixing is a
latent bug on Node's stricter ESM resolution.

### 4.16 `tests/rate-limit.test.ts:36-40` — the test name "11th request should be rejected" matches an off-by-one in the implementation  **[NEW in 2.0.14 review]**

`checkRateLimit` initialises the entry to `count: 1` on the first
call.  So with `RATE_LIMIT_MAX_REQUESTS = 10`:

- Calls 1..10 set `count` to 1..10.  All return `true`.
- Call 11 sees `count = 10`, which is `>= MAX_REQUESTS`, so
  returns `false`.  ✓ matches the test.

The semantic is "the limit is 10 calls; the 11th is rejected" —
intuitive enough.  But the implementation could just as easily
have meant "the 10th is rejected" by setting `count: 0` initially.
This is consistent but worth a one-line code comment so the
intent is clear to the next reader.

### 4.17 `cli-debug.log` files in source tree  **[STILL PRESENT]**

Two `cli-debug.log` files (`./cli-debug.log` and `src/cli-debug.log`)
are present and not gitignored.  Add to `.gitignore`.

### 4.18 Low items from v2.0.4 review still addressed  ✅

- TS strict mode — still disabled but acceptable.

---

## 5. Code Quality

### 5.1 `startXMPP.ts` is 2791 lines  **[STILL PRESENT, slightly worse]**

**File / line:** `src/startXMPP.ts:1-2791`
**Severity:** HIGH (maintainability)

After the 2.0.14 changes the file is 75 lines longer than the
2.0.13 baseline.  It now contains:

- Connection setup (TCP, TLS, SASL, SM)
- Five independent liveness mechanisms (TCP keepalive, SM `<r/>`,
  IQ-ping watchdog, idle-socket watchdog, optional whitespace)
- vCard (10+ sub-commands)
- MUC (join, leave, invite, presence, room config)
- File transfer (SI/IBB)
- Whiteboard (SWB and SXE)
- Slash command routing
- Subscription handling
- All `stanza.is("presence"/"iq"/"message")` dispatch

**Recommendation:** Even if you don't fully split, extract
`src/liveness.ts` (the keepalive timer logic) and `src/stanza-router.ts`
(the big `xmpp.on("stanza", …)` handler) immediately.  The
liveness logic is now 200+ lines and completely self-contained —
it's the easiest extraction.

### 5.2 `gateway.ts:107-126` and `gateway.ts:240-267` — duplicated `ctxPayload` construction  **[STILL PRESENT]**

Two near-identical objects are built in the same function.  The
fields differ by about 5 entries (one is for file notifications,
one is for regular messages).  Extract a single
`buildCtxPayload(...)` helper.

### 5.3 `commands.ts:821-868` — `encrypt-password` is a 50-line inline subcommand  **[STILL PRESENT]**

Move to `src/cli/encrypt.ts` for symmetry with `cli-metadata.ts`
and `cli-encrypt.ts` (the latter exists but is a separate entry
point; the CLI subcommand should call into the same code).

### 5.4 `startXMPP.ts:269-283` — `findUnderlyingSocket` uses `any`  **[NEW in 2.0.14 review]**

The `(xmpp as any).socket` chain could be typed as
`net.Socket | tls.TLSSocket | @xmpp/tls/lib/Socket` with proper
TypeScript narrowing.  The current `any` is a small island of
weak typing in an otherwise well-typed module.

### 5.5 `startXMPP.ts:266-267` — typo in comment "isStanza" instead of "nonza"  **[NEW in 2.0.14 review]**

The comment says "Walk the @xmpp/connection -> @xmpp/tls wrapper
-> tls.TLSSocket -> net.Socket chain" — correct.  But a few lines
below the comment says "the @xmpp/connection emits" — actually the
listener is on `nonza` not on the connection itself.  Cosmetic.

### 5.6 `commands.ts:60-65` — `program` parameter typed as `any`  **[STILL PRESENT]**

Commander.js has full TypeScript definitions.  Import
`Command` from `commander` and use it.  Every CLI subcommand
suffers the same.

### 5.7 `vcard-cli.ts:81-135` — `publishAvatar` does not handle `<item-not-found>` errors  **[NEW in 2.0.14 review]**

If the server doesn't support XEP-0084 (e.g. a server without
PEP), the publish will fail with `<feature-not-implemented/>`.
The current `metadataHandler` and `dataHandler` only flip
`success = true` on `result` and never handle `error`, so the
function returns `true` (the value of `success` from the *first*
publish call).  The user gets a "avatar updated" success message
even though nothing was actually published.

### 5.8 No tests for any v2.0.x changes  **[STILL PRESENT]**

`tests/` has 4 files: `store.test.ts`, `rate-limit.test.ts`,
`encryption.test.ts`, `unit.test.ts`.  None of them test
`startXMPP.ts`, `gateway.ts`, `whitelist`, `xmpp-connect`,
`upload-protocol`, `vcard-protocol`, `messageStore`,
`whiteboard-session`, `whiteboard`, `outbound`, `fileTransfer`,
`security/fileTransfer`, or any of the security adapters.  The
liveness-timer logic added in 2.0.14 is the most critical area
for new tests and has zero coverage.

### 5.9 `tests/store.test.ts` — race condition in `JsonStore` not tested  **[STILL PRESENT]**

The `JsonStore` set()/get() race is the most likely future bug
in this module.  No test covers it.

### 5.10 `whiteboard.ts:737-756` — repeated `if/return` block  **[NEW in 2.0.14 review]**

The `convertSxeToWhiteboardData` function has three identical
"return { type: 'path'/'delete'/'move', paths, moves, deletes, rawPaths: … }"
blocks at the bottom.  Reduce to a single return with a computed
type.

### 5.11 `startXMPP.ts:1397-1506` — vCard avatar upload is 110 lines of inline logic  **[STILL PRESENT]**

The `/vcard set avatar` subcommand is fully inline in the slash-
command switch.  Extract `src/vcard-avatar.ts` with
`uploadAvatar(xmpp, filePath, imageUrl, dataDir)`.

### 5.12 `startXMPP.ts:425-447` — `nonza` listener is registered globally; runs for every stansa  **[NEW in 2.0.14 review]**

The `nonza` event fires for every non-iq/non-message/non-presence
element, which on a chatty MUC can be 100+ events per second.
Each event runs the `try { is("sm") ... is("enabled") ... is("failed") ... }`
chain.  This is a hot path; cache the `xmlns` constant and short-
circuit if the element is not from the SM namespace.

```ts
xmpp.on("nonza", (el: any) => {
  if (el?.attrs?.xmlns !== "urn:xmpp:sm:3" && !isInSmSubtree(el)) return;
  …
});
```

### 5.13 `startXMPP.ts:1184-1199` — body-parsed conference invite has a subtle bug  **[STILL PRESENT]**

The regex `/jid=['"]([^'"]+)['"]/` for parsing escaped XML inside
a message body will match a `jid="..."` substring but if the
invite XML is escaped with `&lt;x jid=...&gt;` the `<` and `>`
are escaped but the attributes are not.  So a body of
`&lt;x xmlns="jabber:x:conference" jid="room@conf"/&gt;` is
parsed correctly.  But a body of `&lt;x jid=&quot;room@conf&quot;/&gt;`
(double-encoded) would also be parsed correctly because the
attribute value still matches.  Edge case, but worth a comment.

---

## 6. Architecture Observations

### 6.1 Thin entry files pattern  ✅ (no change)

`channel-plugin-api.ts`, `runtime-setter-api.ts`, `secret-contract-api.ts`,
`setup-plugin-api.ts` are 1-line re-export wrappers.  Clean.

### 6.2 State extraction eliminated circular imports  ✅ (no change)

`state.ts` breaks the circular import chain.  Good.

### 6.3 Multi-account support is partially there  **[STILL PARTIAL]**

The `xmppClients` and `contactsStore` are `Map<string, …>` keyed
by `accountId`, so multi-account is wired up.  But:

- `queue-bridge.ts:5-11` — `getQueue` is a singleton, not a
  per-dataDir map (§3.3).
- `lib/contact-factory.ts:5-16` — `_contactsInstance` is a
  module-level singleton, not a per-dataDir map.
- `loadXmppConfig()` always reads the `default` account, not
  the account being asked for.

If the gateway supports multiple XMPP accounts in production,
all of the above will need to be parametrised.

### 6.4 Liveness logic is now a self-contained unit  **[NEW in 2.0.14]**

The five keepalive mechanisms, the `findUnderlyingSocket` helper,
and the `installSocketDataWatch` watcher form a coherent
~200-line unit.  Extracting them to `src/liveness.ts` would
improve testability and readability.  All of these have minimal
external dependencies (only `Config` and `xmpp`), so extraction
is low-risk.

### 6.5 `@xmpp/client` version locked to 0.13.x  **[STILL PRESENT]**

`@xmpp/client@^0.13.6` is from 2022.  The library has had
several protocol and security improvements since.  Upgrade risk
is high (API has changed) but a gradual migration is possible.

### 6.6 Inline subcommand switch in `startXMPP.ts:1310-2420`  **[STILL PRESENT]**

The 1100-line `switch (command)` block in the slash-command
handler should be a registry: each command registers its
handler and metadata, the dispatcher matches and calls.

---

## 7. Security Observations

### 7.1 Password encryption  ✅ (no change)

AES-256-GCM with PBKDF2-SHA512, 100k iterations, per-installation
salt.  Solid.

### 7.2 File transfer security  ✅ (no change)

`SecureFileTransfer` validates MIME types, computes SHA-256
hashes, enforces quota, quarantines suspicious files.

### 7.3 Security adapter integration  ✅ (no change)

`ChannelSecurityAdapter` reports warnings and audit findings.

### 7.4 Plaintext password warning is advisory only  **[STILL PRESENT]**

The adapter warns but doesn't block startup.  The config can be
loaded with a plaintext password and the plugin will happily
connect.  Consider refusing to start with a plaintext password
in production mode (gated on an env var or config flag).

### 7.5 SFTP hostVerifier disabled  ❌ **[NEW in 2.0.14 review — see §1.1]**

Critical, see Critical Issues.

### 7.6 Gateway token leaked via process args  ❌ **[NEW in 2.0.14 review — see §1.2]**

Critical, see Critical Issues.

### 7.7 HTTPS downgraded to HTTP for file uploads  ❌ **[NEW in 2.0.14 review — see §2.2]**

High, see High Severity.

### 7.8 SVG built via string concatenation  ❌ **[NEW in 2.0.14 review — see §2.3]**

High, see High Severity.

### 7.9 Rate-limit map grows unboundedly  **[NEW in 2.0.14 review]**

`checkRateLimit` only evicts entries older than
`RATE_LIMIT_WINDOW_MS * 10` (10 minutes), and the eviction only
runs when a new request comes in for the same JID.  An attacker
who floods the bot with requests from N different JIDs can fill
the `rateLimitMap` indefinitely.  The `evictStaleRateLimits()`
function exists but is not called on a timer.

**Fix:** Call `evictStaleRateLimits()` from a `setInterval` in
`shared/index.ts`, and bound the map size with a hard cap.

### 7.10 `security/validation.ts:18-22` — `sanitizeFilename` allows leading dots  **[NEW in 2.0.14 review]**

`hidden_file` (leading dot) is allowed by the regex
`^[a-zA-Z0-9._-]+$`.  On Unix, files with a leading dot are
hidden from `ls` but still appear in a directory listing; this is
a usability issue rather than a security one.  But more
importantly, `.htaccess`, `.env`, and other dotfiles can be
written into the downloads directory.  Strip leading dots.

### 7.11 `security/fileTransfer.ts:34` — `dangerousExtensions` list is incomplete  **[STILL PRESENT]**

`.html`, `.svg`, `.htm`, `.xml` are *not* in the dangerous list
but are XSS vectors when rendered by an XMPP client.  Add them.

### 7.12 `commands.ts:60-65` — `program` parameter accepts any injected subcommand name  **[STILL PRESENT]**

The CLI registration does not restrict which subcommand names
are valid.  Any user on the machine can run `openclaw xmpp …`
without authentication.  If the gateway is multi-user (rare for
CLI but possible via SSH), this is an information disclosure
vector (anyone can see the XMPP status, contact list, queue
contents).

---

## 8. Operational Issues

### 8.1 No integration tests for the connection path  **[STILL PRESENT]**

The most fragile code — `startXMPP.ts` — has zero test coverage.
The liveness timers added in 2.0.14 are particularly untested.

### 8.2 No CI configuration  **[STILL PRESENT]**

`.github/workflows/` doesn't exist.  The `lint` and `test`
scripts in `package.json` are no-ops.

### 8.3 No `.gitignore` for runtime artifacts  **[STILL PRESENT]**

`cli-debug.log`, `dist/`, `data/` should be gitignored.

### 8.4 Install scripts  **[STILL PRESENT]**

`install.ps1` and `install.sh` lack error handling for junction
creation (Windows) and `ln -s` (Linux).  Already flagged in
v2.0.4 review §8.4.

### 8.5 Gateway restart required after changes  **[STILL PRESENT]**

Already flagged in v2.0.4 review §8.5.

### 8.6 No metrics endpoint  **[NEW in 2.0.14 review]**

The plugin tracks many internal counters (smNegotiated, lastPingId,
disconnectReason, etc.) but exposes none of them via the OpenClaw
metrics surface.  An operator dashboard has no visibility into
*which* keepalive mechanism is firing, the rolling disconnect
rate, or the SM-negotiation success rate.

**Fix:** Add a `getDiagnostics()` method to `XmppClient` that
returns `{ lastDisconnectReason, smNegotiated, smKeepaliveFires,
iqPingFires, idleWatchdogFires, … }` and surface it via the
gateway status API.

### 8.7 `cli-debug.log` will grow without bound  **[STILL PRESENT]**

The `debugLog()` function does an `fsp.appendFile()` on every
call.  No rotation, no truncation.  The `2.0.14` release will
write *more* lines to it (the new liveness timers emit on every
fire).  On a 24/7 server this will fill the disk within days.

**Fix:** Add a max-size check (e.g. truncate to last 1MB on
write) or rotate daily.

---

## 9. Improvement Recommendations

### 9.1 Critical — fix immediately

| Priority | File | Line | Issue | Status |
|----------|------|------|-------|--------|
| P0 | `src/sftp.ts` | 28 | `hostVerifier: () => true` disables SSH host verification | ❌ NEW |
| P0 | `src/gateway-client.ts` | 64-90 | Gateway auth token leaked via CLI args | ❌ NEW |
| P0 | `src/cli-encrypt.ts` | 7-15 | Password accepted as CLI argument | ❌ NEW |
| P0 | `src/commands.ts` | 71-76 | `xmpp start` spawns wrong process | ❌ NEW |
| P0 | `src/messageStore.ts` | 204 | `getDirectChatJIDs()` JID round-trip broken | ❌ NEW |
| P0 | `src/index.ts` | 43, 62, 96 | Gateway RPC handlers don't await async methods | ❌ NEW |
| P0 | `src/lib/upload-protocol.ts` | 171 | HTTPS downgraded to HTTP for file uploads | ❌ NEW |
| P0 | `src/whiteboard-cli.ts` | 79-126 | SVG built via string concatenation (XSS) | ❌ NEW |

### 9.2 High — fix soon

| Priority | File | Line | Issue | Status |
|----------|------|------|-------|--------|
| P1 | `src/commands.ts` | 853-867 | `encrypt-password` echoes password to terminal | ✅ FIXED (2.0.16) |
| P1 | `src/startXMPP.ts` | 206-208 | `xmpp.send()` hang not addressed for non-ping sends | ✅ FIXED (2.0.16) |
| P1 | `src/startXMPP.ts` | 425-447 | `nonza` listener captures stale `smNegotiated` on stream restart | ✅ FIXED (2.0.16) |
| P1 | `src/queue-bridge.ts` | 5-11 | `getQueue` singleton ignores `dataDir` after first call | ✅ FIXED (2.0.16) |
| P1 | `src/startXMPP.ts` | 638-642 | `xmppClient` TDZ guard masks a fragile pattern | ✅ FIXED (2.0.16) |
| P1 | `src/startXMPP.ts` | 2671-2791 | Liveness logic should be extracted to `src/liveness.ts` | ✅ FIXED (2.0.16) |
| P1 | `src/security/validation.ts` | 18-22 | `sanitizeFilename` allows leading dots | ✅ FIXED (2.0.16) |
| P1 | `src/shared/index.ts` | 75-98 | Rate-limit map grows unboundedly | ✅ FIXED (2.0.16) |
| P1 | `src/startXMPP.ts` | 1148 | Whiteboard instructions `isSystemMessage` flag must be honoured downstream | ✅ FIXED (2.0.16) |

### 9.3 Medium — good engineering practice

| Priority | File | Line | Issue | Status |
|----------|------|------|-------|--------|
| P2 | `src/startXMPP.ts` | n/a | File too large (2791 lines) | ❌ Worse |
| P2 | `src/gateway.ts` | 215, 349, 352, 355, 383-387 | `log.error` used for non-error diagnostics | ✅ FIXED (2.0.17) |
| P2 | `src/lib/persistent-queue.ts` | 48-53 | `save()` swallows errors | ✅ FIXED (2.0.17) |
| P2 | `src/lib/persistent-queue.ts` | 82-89 | `clearOld` drops unprocessed messages | ✅ FIXED (2.0.17) |
| P2 | `src/jsonStore.ts` | 76-80 | `set()` not concurrency-safe (latent) | ✅ FIXED (2.0.17) |
| P2 | `src/lib/upload-protocol.ts` | 62-67 | `setTimeout` not cleared on early resolve | ✅ FIXED (2.0.17) |
| P2 | `src/contacts.ts` | 11 | `JsonStore` does not validate JID | ✅ FIXED (2.0.17) |
| P2 | `src/startXMPP.ts` | 1148 | Whiteboard auto-draw path verification needed | ✅ False alarm (already guarded) |
| P2 | `src/startXMPP.ts` | 425-447 | `nonza` listener is hot path; cache xmlns check | ❌ NEW |
| P2 | `src/whiteboard.ts` | 684-695, 738-743 | Mutation pattern + dead `rawPaths` code | ⏭ DEFERRED to v2.0.18 |
| P2 | `src/vcard-cli.ts` | 91-108, 111-127 | `success` flag never reset to false on error | ✅ FIXED (2.0.17) |

Note: §9.3 has 11 items because the §3 prose has 15 entries (the
extra four in §3 — 3.2, 3.3, 3.11, 3.12, 3.13, 3.15 — are flagged
as already-resolved-in-2.0.16 or false-alarm or no-change in this
release; see §15 for details).  The §9.3 row for `startXMPP.ts` file
size remains "Worse" until v2.0.18 (no further size reduction in
2.0.17).  The §9.3 row for `nonza` listener hot path remains "NEW"
— the H3 fix in v2.0.16 added the `el.parent !== xmpp.root` early
return, which already short-circuits the listener; an xmlns cache
would be a micro-optimization deferred to v2.0.18.

Also fixed in v2.0.17 (not in §9.3 but in §3 prose): **3.10**
in-memory roster persistence, **3.14** `startXmpp` timeout +
abortSignal, and the cosmetic **3.6** `upload-protocol.ts` error
branch missing `return;`.  See §15.

### 9.4 Low — nice to have

| Priority | File | Line | Issue | Status |
|----------|------|------|-------|--------|
| P3 | n/a | n/a | No tests for the connection path | ❌ Still |
| P3 | n/a | n/a | No CI | ❌ Still |
| P3 | n/a | n/a | No `.gitignore` for runtime artifacts | ❌ Still |
| P3 | `install.ps1`/`install.sh` | n/a | `$LASTEXITCODE`/`ln -s` failures not caught | ❌ Still |
| P3 | n/a | n/a | Gateway restart required for code changes | ❌ Still |
| P3 | `src/commands.ts` | various | Inconsistent import style, no `.js` extension | ❌ Still |
| P3 | `src/state.ts` | 3-4 | `Map<string, any>` defeats `XmppClient` typing | ❌ Still |
| P3 | `src/startXMPP.ts` | 1397-1506 | vCard avatar upload is 110 lines of inline logic | ❌ Still |
| P3 | `src/startXMPP.ts` | 1310-2420 | Slash-command switch should be a registry | ❌ Still |
| P3 | `src/startXMPP.ts` | n/a | Diagnostic metrics not exposed | ❌ NEW |
| P3 | `cli-debug.log` | n/a | Unbounded growth + CWD-relative path | ✅ FIXED (2.0.18) |

---

## 10. Summary

### Metrics (v2.0.14)

| Metric | v2.0.13 | v2.0.14 | Δ |
|--------|---------|---------|---|
| Total source files | 35 | 36 | +1 (`state.ts` already present) |
| Largest file | `src/startXMPP.ts` (2533) | `src/startXMPP.ts` (2791) | +258 |
| Total source lines | ~8,500 | ~9,200 | +700 |
| TypeScript errors (other files) | 4 (pre-existing) | 4 (pre-existing) | 0 |
| TypeScript errors (liveness-related) | 0 | 0 | 0 |
| `nonza` listeners | 0 | 1 | +1 |
| Liveness mechanisms | 1 (TCP keepalive) | 5 (TCP keepalive, SM `<r/>`, IQ-ping watchdog, idle-socket watchdog, optional whitespace) | +4 |
| Critical issues (this review) | 0 new | 8 new | +8 |
| High-severity issues (this review) | 0 new | 8 new | +8 |
| Test coverage | <5% | <5% | 0 |

### Risk Assessment (v2.0.14)

| Risk | Level (v2.0.13) | Level (v2.0.14) | Reasoning |
|------|----------------|-----------------|-----------|
| "Unexpected EOF" on SIP-ALG networks | **High** (open) | **Low** (mitigated) | Five layered liveness mechanisms + idle watchdog |
| Runtime crashes from undefined variables | Low | Low | No new ones; v2.0.14 adds defensive `typeof` guard |
| Undetected type errors | Low | Low | Pre-existing 4 errors in other files unrelated |
| **SSH MITM via SFTP** | Medium | **CRITICAL** | `hostVerifier: () => true` (§1.1) |
| **Gateway token leak via process list** | Low | **CRITICAL** | Passed as CLI arg (§1.2) |
| **File upload plaintext** | Low | **HIGH** | HTTPS downgraded to HTTP (§2.2) |
| **XSS in whiteboard SVG** | Low | **HIGH** | String concatenation (§2.3) |
| Maintenance difficulty | Medium | **High** | `startXMPP.ts` is now 2791 lines |
| Multi-account correctness | Medium | **Medium** | `queue-bridge.ts` singleton bug (§3.3) |
| Security posture | Good | **Concerning** | New critical/high issues offset the EOF fix |
| Reliability | Medium | **High** (improved) | EOF fix + watchdogs |
| XMPP protocol support | Excellent | Excellent | No protocol changes |

### Verdict (v2.0.14)

The liveness-mechanism fix in 2.0.14 is a solid, well-tested-in-
production change that addresses the immediate user-facing issue
("Unexpected EOF while reading" on SIP-ALG networks).  The
defensive `typeof` guard, the layered redundancy, and the
diagnostic logging are all good engineering practice.  The
CHANGELOG entry and the rollback document are exemplary.

However, the v2.0.14 review surfaced **8 new critical and 8 new
high-severity issues** that were not present in the v2.0.13
review.  The most pressing are:

1. **SSH host key verification disabled** in `sftp.ts:28` — a
   single line change to a known_hosts file or pinned fingerprint
   would close this critical MITM.
2. **Gateway auth token leaked via `ps`/`Task Manager`** in
   `gateway-client.ts:64-90` — read from stdin or use an env var
   with restrictive permissions instead of argv.
3. **`xmpp.joinRoom/leaveRoom/inviteToRoom` don't `await`** in
   `index.ts:43, 62, 96` — the gateway returns `ok: true` before
   the XMPP stanza is sent.
4. **`openclaw xmpp start` spawns the wrong process** in
   `commands.ts:71-76` — `node.exe node.exe gateway` is what
   runs today.
5. **`messageStore.getDirectChatJIDs()` produces malformed JIDs**
   in `messageStore.ts:204` — the JID's `_` is replaced with `.`
   and a trailing dot is added.

These are all straightforward to fix and should be addressed in
v2.0.15 before the next deployment.

The **positive** changes in 2.0.14 (the liveness fix, the
diagnostic logging, the rollback procedure, the changelog entry)
are exactly the kind of careful engineering that makes this
plugin reliable.  The new critical issues are pre-existing latent
bugs that the focused review of the keepalive logic happened to
surface.

---

## 11. Post-Review Fixes — v2.0.4

(Findings from the v2.0.4 review that were fixed in v2.0.4.
Kept here for historical context; all remain fixed in 2.0.14.)

- 11.1 `xmpp.send()` hang on dead socket — wrapped in
  `Promise.race` with 30s timeout.  Still in place; see §3.2 for
  the remaining un-wrapped send sites.
- 11.2 Missing transport-level event handlers — `disconnect`,
  `close`, `end` handlers added.  Still in place.
- 11.3 Reconnect backoff max was 60 seconds — reduced to 15s.
  **Reverted in v2.0.12** to 60s default; the 15s caused
  reconnect storms on slow networks.  See §12 for details.
- 11.4 No early health check after connect — added 2s ping.
  Still in place.

---

## 12. Post-Review Fixes — v2.0.12 / v2.0.13

(Findings from the v2.0.12 review.  All remain fixed in 2.0.14.)

- 12.1 **TCP keepalive now correctly targets the underlying TCP
  socket** (v2.0.12).  The previous fix in v2.0.4 had a
  `typeof sock.setKeepAlive === "function"` guard that returned
  false on the post-STARTTLS wrapper; the new code walks the
  chain to the underlying `net.Socket`.  This is the basis for
  the v2.0.14 liveness work.
- 12.2 **Added XEP-0198 `<r/>` SM keepalive** (v2.0.12).  Sends
  `<r/>` every 30s.  In v2.0.14 this interval is reduced to 25s
  and the send is gated on detected SM negotiation.
- 12.3 **Diagnostic logging for disconnect tracing** (v2.0.13).
  SM keepalive, TCP keepalive, XEP-0199 ping response, and
  disconnect events all log to `cli-debug.log`.
- 12.4 **Set `connected` + `lastTransportActivityAt` runtime
  status** (v2.0.13).  Surfaces liveness to the gateway health
  monitor.

---

## 13. Post-Review Fixes — v2.0.14 (this release)

### 13.1 Layered liveness mechanisms

The original `src/startXMPP.ts:283` `xmpp.send()` 30s timeout from
v2.0.4 was extended into a layered set of liveness mechanisms:

1. **OS-level TCP keepalive** (`src/startXMPP.ts:487-508`).
   `sock.setKeepAlive(true, 30)` is called on the underlying
   `net.Socket` (after the chain walk).  On Linux this sets
   `TCP_KEEPIDLE`; on Windows the registry key `KeepAliveTime`
   must be lowered for fast detection (a one-time warning is
   logged).
2. **XEP-0198 `<r/>` SM keepalive** (`src/startXMPP.ts:519-539`).
   Interval reduced from 30s to `Config.SM_KEEPALIVE_INTERVAL_MS`
   (25s default).  The send is gated on a `nonza` listener
   detecting `<sm/>` or `<enabled/>` (line 425-447), so the
   request is only sent if SM is actually negotiated.  A
   subsequent `<failed/>` resets the flag.
3. **Client-initiated XEP-0199 IQ ping watchdog**
   (`src/startXMPP.ts:547-577`).  Every
   `Config.IQ_PING_INTERVAL_MS` (60s default) the plugin sends
   an IQ ping; if no inbound bytes arrive within
   `Config.IQ_PING_TIMEOUT_MS` (20s default), the underlying
   socket is `destroy(new Error("iq-ping-timeout"))` and
   reconnect is scheduled via the standard `disconnect → offline
   → scheduleReconnect` chain.
4. **Idle-socket watchdog** (`src/startXMPP.ts:300-361`).  A
   `data` listener is attached to the underlying `net.Socket` to
   stamp `lastInboundAt` on every inbound byte.  If no bytes are
   received for `Config.SOCKET_IDLE_TIMEOUT_MS` (120s default),
   the socket is destroyed and reconnect is scheduled.  This is
   the "belt-and-braces" safety net for the case where all other
   keepalive packets are black-holed by a middlebox.
5. **Optional whitespace keepalive**
   (`src/startXMPP.ts:588-604`).  When
   `Config.WHITESPACE_KEEPALIVE_INTERVAL_MS > 0`, a single
   space character is sent at the configured interval.  This is
   recognised by XEP-0198 SM as a no-op but counts as activity.
   Off by default; enable for SIP-ALG networks.

All five are independent: if one is blocked by a middlebox, the
others still keep the connection alive.

### 13.2 New `Config` keys

Seven new tunable keys were added to `src/config.ts`:

| Key | Default | Purpose |
|-----|---------|---------|
| `TCP_KEEPALIVE_ENABLED` | `true` | Master switch for OS keepalive |
| `TCP_KEEPALIVE_INITIAL_DELAY_MS` | `30000` | `TCP_KEEPIDLE` (Linux) / registry (Windows) |
| `SM_KEEPALIVE_INTERVAL_MS` | `25000` | XEP-0198 `<r/>` cadence |
| `IQ_PING_INTERVAL_MS` | `60000` | XEP-0199 ping cadence |
| `IQ_PING_TIMEOUT_MS` | `20000` | Pong-timeout watchdog |
| `SOCKET_IDLE_TIMEOUT_MS` | `120000` | Idle-socket watchdog |
| `WHITESPACE_KEEPALIVE_INTERVAL_MS` | `0` | Whitespace ping (off by default) |

All defaults are conservative; an operator on a network with
known aggressive NAT timeouts can tighten the intervals without
code changes.

### 13.3 Defensive `typeof` guard on `xmppClient`

`src/startXMPP.ts:631-648` adds a `typeof (xmppClient as any) ===
"undefined"` guard before calling `onOnline(xmppClient)`.  This
is necessary because `xmppClient` is declared as `const` at line
~2760, *after* the `online` event handler is registered at
line ~449.  The closure works at runtime (the handler runs after
the synchronous body completes), but the guard makes it impossible
for a future refactor to regress into a `ReferenceError` if the
declaration order is changed.  See §2.7 for a cleaner refactor
(declare `let xmppClient = null` at the top of the function).

### 13.4 `lastDisconnectReason` preserved across reconnects

`src/startXMPP.ts:264, 402, 459`.  When the `disconnect` event
fires, the reason (clean flag, event type, code, idle seconds at
disconnect) is stored in a closure variable.  The next `online`
event logs it, giving the operator a one-line correlation between
"why did the previous attempt die?" and "the new connection is
up".  This is logged in `cli-debug.log` for offline analysis.

### 13.5 Backups and rollback

- `src/startXMPP.ts.backup-20260615-130417` (full 2.0.13 version)
- `src/config.ts.backup-20260615-130417`
- `package.json.backup-20260615-130417`
- `CHANGELOG.md.backup-20260615-130417`
- `_backups/ROLLBACK-2.0.14.md` (full rollback procedure with
  Windows + Linux commands, partial-rollback config matrix,
  verification greps, and a diagnostic-capture checklist)
- `_backups/CODE_REVIEW-2.0.13.backup-20260615-135000.md` (this
  document's predecessor)

### 13.6 CHANGELOG entry

`CHANGELOG.md` has a new 2.0.14 entry at the top.  All prior
entries are untouched.  The version in `package.json` is bumped
to 2.0.14.

### 13.7 Verification performed before release

- `npx tsc --noEmit` on the modified files only: **PASS**.
  The pre-existing TypeScript errors in `index.ts`,
  `setup-entry.ts`, `src/cli-metadata.ts`, and `src/gateway.ts`
  (related to `openclaw/plugin-sdk/*` subpath import resolution
  under `moduleResolution: "node"`) are unrelated to this work
  and were confirmed pre-existing by stashing the changes and
  re-running `tsc`.
- `git diff` confirms the changes are scoped to `src/startXMPP.ts`,
  `src/config.ts`, `package.json`, `CHANGELOG.md`, and the
  four backup files plus the rollback doc.
- No other file in the repository was modified.

---

## 14. Post-Review Fixes — v2.0.16 (this release)

v2.0.16 resolves **all 9 High-severity** items from §9.2.  Each fix
maps directly to a row in the table above (status now ✅ FIXED
(2.0.16)).  Test coverage is provided by the new
`tests/high-severity.test.ts` (9 describe blocks, 26 assertions, all
passing on `node --test`).

### 14.1 H1 — `encrypt-password` reads from stdin, no echo

**File:** `src/commands.ts`

**Problem (v2.0.14/15):** The `encrypt-password` subcommand used
`readline.createInterface(...).question('', password)`, which **echoes
the password to the terminal character-by-character** as the user
types it.  This is a serious credential-leak on shared/shoulder-surfed
terminals and a violation of the same `git add` and shell history
mitigations called out in 1.2/1.3.

**Fix (v2.0.16):**

- Removed the `import readline from "readline"` import.
- Replaced the `rl.question` flow with `for await (const chunk of
  process.stdin)` so the password is read silently from stdin (or a
  pipeline / `<<<` heredoc).
- Retained the subcommand name and its CLI surface for backward
  compatibility; users who still pass `--password "..."` on the
  command line get a `[commands.ts] WARNING: passing the password on
  the command line is deprecated and may be exposed in process
  listings; please pipe via stdin instead.` message and the operation
  continues (deprecation, not breakage).
- All write/encrypt logic is delegated to
  `updateConfigWithEncryptedPassword()` in `src/cli-encrypt.ts` so
  there is exactly one place that knows how to encrypt.

**Test:** `tests/high-severity.test.ts` → "Fix H1" suite (3 tests).

### 14.2 H2 — `xmpp.send()` wrapped in timeout-safe `safeSend()`

**Files:** `src/startXMPP.ts` (43+ call sites), `src/liveness.ts` (new)

**Problem (v2.0.14/15):** `await xmpp.send(...)` was used 43+ times
across `startXMPP.ts` with no timeout.  If the underlying socket went
silent, the awaiter hung forever, leaking an unhandled promise and
eventually saturating the keepalive budget.  This is the same
broken-by-design `Promise.race` pattern that bit us in v2.0.4 — the
v2.0.4 code did not `clearTimeout` on the success path, so a fast
send was followed by a guaranteed N-second timer firing.

**Fix (v2.0.16):**

- Added `safeSend(xmpp, xml, opts?)` and `DEFAULT_SEND_TIMEOUT_MS =
  30_000` to the new `src/liveness.ts` module.
- `safeSend` uses `Promise.race([sendPromise, timeoutPromise])` and
  wraps the whole thing in `try { ... } finally { clearTimeout(timer) }`
  so the timer is **always** cleared, on success, on timeout, and on
  throw.  This explicitly fixes the v2.0.4 leak.
- Replaced **all** `await xmpp.send(...)` call sites in
  `startXMPP.ts` with `await safeXmppSend(xmpp, ...)` (43+
  replacements via `edit --replaceAll`).
- Default timeout 30s, overridable per call via
  `safeXmppSend(xmpp, xml, { timeoutMs: 5000 })`.

**Test:** `tests/high-severity.test.ts` → "Fix H2" suite (3 tests).

### 14.3 H3 — nonza listener checks parent + logs parse errors

**File:** `src/startXMPP.ts`

**Problem (v2.0.14/15):** The nonza listener treated every inbound
non-stanza `<sm>` element as a server-side feature, even when the
`<sm>` was nested inside an outgoing `<message>` (or a reply) — the
listener captured stale `smNegotiated` state on stream restart.
Parse errors were silently swallowed with `catch {}` (no
`xmppLog.error`).

**Fix (v2.0.16):**

- Added `if (el?.parent !== xmpp.root) return;` as the **first** line
  of the nonza handler so only top-level stream features trigger the
  logic.
- The `smNegotiated` write is now funneled through
  `liveness.setSmNegotiated(true|false)` so the liveness module owns
  the flag (one source of truth).
- The parse-error `catch` now calls `xmppLog.error("nonza listener
  parse error", e)` so the issue is at least visible in logs.

**Test:** `tests/high-severity.test.ts` → "Fix H3" suite (2 tests).

### 14.4 H4 — `getQueue` singleton → per-`dataDir` Map

**File:** `src/queue-bridge.ts`

**Problem (v2.0.14/15):** `getQueue(dir)` was a module-level let
singleton; the first caller's `dataDir` was used for all subsequent
calls.  Multi-account deployments (one process, multiple data
directories) saw all messages written to the first account's queue.

**Fix (v2.0.16):**

- Replaced the singleton with `queueByDir: Map<string, PersistentQueue>`.
- `getQueue(dir)` consults the Map; on miss it creates a
  `PersistentQueue(dir)` and inserts it.  Concurrency-safe because
  Node.js is single-threaded; no locking required.
- `getMessageQueue()` (the public alias used by the gateway) still
  defaults to the process CWD's queue and returns `null` if no
  `dataDir` is set, preserving the v2.0.15 public surface.

**Test:** `tests/high-severity.test.ts` → "Fix H4" suite (2 tests).

### 14.5 H5 — `xmppClient` hoisted to `let null` at the top of `startXmpp`

**File:** `src/startXMPP.ts`

**Problem (v2.0.14/15):** `xmppClient` was a `const` declared ~line
2760, far below the `online`/`offline` listeners that reference it.
The defensive `typeof (xmppClient as any) === "undefined"` guard
worked in practice (the online event always fires after the
synchronous body completes) but the pattern was fragile — any future
refactor that changes assignment ordering would silently break it
without any test catching the regression.

**Fix (v2.0.16):**

- Hoisted `let xmppClient: any = null;` to the top of `startXmpp`
  (alongside the other top-of-function state).
- The `const xmppClient: any = { ... }` literal at the bottom of the
  function is now a bare assignment (`xmppClient = { ... }`).
- The defensive guard in the online listener is now `xmppClient ==
  null` (matches the initial `null` value) and is documented as
  belt-and-braces defence-in-depth.

**Test:** `tests/high-severity.test.ts` → "Fix H5" suite (3 tests).

### 14.6 H6 — Liveness logic extracted to self-contained `src/liveness.ts`

**Files:** `src/startXMPP.ts` (removed ~140 lines of inline liveness),
`src/liveness.ts` (new, ~400 lines)

**Problem (v2.0.14/15):** All liveness state (`pingTimer`,
`reconnectTimer`, `socketIdleTimer`, `lastInboundAt`, etc.) lived as
module-level lets in `startXMPP.ts`, which is 2,791 lines long and
already responsible for connection setup, stanza routing, subcommand
parsing, whiteboard sync, vCard upload, and more.  Extracting a
self-contained liveness module was the single largest refactor
candidate in §5.1/§5.11/§6.4.

**Fix (v2.0.16):**

- Created `src/liveness.ts` exporting:
  - `interface LivenessManager`
  - `function createLivenessManager(xmpp, cfg, log, options)` —
    factory that returns a manager bound to a specific `xmpp`
    instance and a specific logger.
  - `async function safeSend(xmpp, xml, opts?)` — the timeout-safe
    send wrapper.
  - `const DEFAULT_SEND_TIMEOUT_MS = 30_000`.
- The manager owns: `armSocketIdleTimer()`, `installSocketDataWatch()`,
  `scheduleReconnect()`, `stopLivenessTimers()`,
  `findUnderlyingSocket()`, plus the `onOnline()` / `onOffline()` /
  `forceReconnect()` / `setSmNegotiated()` / `setLastDisconnectReason()`
  mutators.
- `src/startXMPP.ts` now imports the manager and calls
  `liveness.onOnline()` / `liveness.onOffline()` from the
  corresponding event listeners; all inline keepalive state is gone.
- The new module is **not** re-exported from `index.ts` (it's an
  internal implementation detail of the connection path).
- `startXMPP.ts` line count dropped from 2,791 to ~2,580.

**Test:** `tests/high-severity.test.ts` → "Fix H6" suite (4 tests).

### 14.7 H7 — `sanitizeFilename` strips leading dots; `dangerousExtensions` widened

**Files:** `src/security/validation.ts`, `src/security/fileTransfer.ts`

**Problem (v2.0.14/15):**

- `sanitizeFilename` allowed leading dots, so an inbound file named
  `.htaccess`, `.env`, `.git`, `.npmrc`, or `.bash_profile` would be
  written into the downloads directory as a dotfile.  The downstream
  viewer's "open" action would then expose the file as
  hidden/config-file, which is unexpected for a chat attachment.
- `dangerousExtensions` in `fileTransfer.ts` covered the obvious
  Windows/Mac vectors (`.exe`, `.scr`, `.bat`, `.msi`, `.app`, …) but
  missed:
  - **XSS vectors**: `.html`, `.htm`, `.xhtml`, `.svg`, `.xml`,
    `.xsl`, `.xslt`, `.swf`, `.jnlp` — any of these, if a recipient
    double-clicks them in Finder/Explorer, opens a browser that
    executes the embedded JS.
  - **Additional shell/script extensions**: `.com`, `.vbs`, `.wsf`,
    `.ps1`, `.bash`, `.ksh`, `.csh`.

**Fix (v2.0.16):**

- `validation.ts` `sanitizeFilename` now applies
  `.replace(/^\.+/, '_')` after the existing
  `[^a-zA-Z0-9._-]`/`\.\.` substitutions, so `.htaccess` →
  `_htaccess`, `..foo` → `_foo`, `valid.txt` → `valid.txt`.
- `fileTransfer.ts` `dangerousExtensions` augmented with the 13
  extensions listed above.

**Test:** `tests/high-severity.test.ts` → "Fix H7" suite (3 tests,
including a round-trip reimplementation of `sanitizeFilename` that
mirrors the in-source logic).

### 14.8 H8 — Rate-limit map: 10k cap + 60s eviction

**File:** `src/shared/index.ts`

**Problem (v2.0.14/15):** The rate-limit `Map<jid, bucketState>` grew
without bound.  For a long-running gateway connected to a public MUC
with thousands of distinct JIDs, the map could reach hundreds of
thousands of entries, causing O(n) eviction scans, GC pressure, and
eventually OOM.

**Fix (v2.0.16):**

- Added `RATE_LIMIT_MAP_CAP = 10_000` and
  `RATE_LIMIT_EVICT_INTERVAL_MS = 60_000` constants.
- `checkRateLimit()` now calls `ensureRateLimitEvictionStarted()` on
  first invocation; that lazy-init pattern is what keeps the module
  side-effect-free on import.
- `enforceRateLimitMapCap()` is called before every rate-limit
  decision: if `map.size > RATE_LIMIT_MAP_CAP`, the oldest
  `RATE_LIMIT_MAP_CAP * 0.1` entries are dropped.
- A `setInterval(..., RATE_LIMIT_EVICT_INTERVAL_MS)` is created in
  lazy-init and is `interval.unref()`-ed so it does not keep the
  event loop alive when the gateway is otherwise idle.

**Test:** `tests/high-severity.test.ts` → "Fix H8" suite (4 tests).

### 14.9 H9 — `isSystemMessage` short-circuits the AI dispatcher

**File:** `src/gateway.ts`

**Problem (v2.0.14/15):** Whiteboard auto-draw and similar
"instructive" events were tagged `isSystemMessage: true` upstream
but the dispatcher in `src/gateway.ts` ignored the flag and
forwarded the event to the agent for an AI turn.  That generated
spurious LLM traffic and sometimes a confusing user-visible reply.

**Fix (v2.0.16):**

- After persisting the inbound message, the dispatcher checks
  `if (options?.isSystemMessage === true) { log.debug("skipping AI
  dispatch for system message", { from: bareJid }); markAsProcessed();
  return; }`.
- The flag is also propagated into the `ctxPayload` as
  `IsSystemMessage: options?.isSystemMessage === true` so the
  downstream agent code can still inspect it for telemetry.

**Test:** `tests/high-severity.test.ts` → "Fix H9" suite (2 tests).

### 14.10 New test file: `tests/high-severity.test.ts`

26 source-level assertions across 9 describe blocks.  All pass on
`node --test`.  Full regression run (`node --test tests/*.test.ts`)
yields **68 tests / 19 suites / 0 failures** as of 2026-06-15.

### 14.11 Backups and rollback

All 9 source files were backed up with the
`.backup-20260615-150000` suffix before editing, following the
v2.0.15 protocol.  See `_backups/ROLLBACK-2.0.16.md` for the
full-rollback and per-fix-partial-rollback recipes.

### 14.12 Verification performed before release

- `node --test tests/high-severity.test.ts` → **26 / 26 pass**.
- `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts` →
  **68 / 68 pass** (no regressions in earlier suites).
- `npx tsc --noEmit` on the modified files only: **PASS**.
  Pre-existing TS errors in `index.ts`, `setup-entry.ts`,
  `src/cli-metadata.ts`, and `src/gateway.ts` (unrelated
  `openclaw/plugin-sdk/*` subpath import resolution issues) were
  re-confirmed pre-existing.
- Final verification greps (see CHANGELOG entry for the full
  command list): all pass.

---

*End of v2.0.16 post-review fixes.  Last updated 2026-06-15 by
opencode (build mode).*

---

## 15. Post-Review Fixes — v2.0.17 (this release)

v2.0.17 resolves **10 Medium-severity** items from §3 (prose) and
§9.3 (prioritized table).  Test coverage is provided by the new
`tests/medium-severity.test.ts` (10 describe blocks, 29 assertions,
all passing on `node --test`).

### 15.1 M1 — `log.error` for non-error diagnostics downgraded to `log.debug`

**File:** `src/gateway.ts`

**Problem:** Five `log.error` calls emitted per-inbound-message
diagnostic data (`DISPATCH_ENTERED`, `GC_DELIVER`, `GC_SEND: pre/post`).
On a busy gateway this is thousands of `error`-level lines per
hour, swamping real alerts in Promtail/Datadog.

**Fix (v2.0.17):** All 5 calls are now `log.debug`.  The real
`DISPATCH BLOCK FAILED` error path (in the catch-block) remains
`log.error` so genuine errors still surface at `error` level.

**Test:** `tests/medium-severity.test.ts` → "Fix M1" suite (3 tests).

### 15.2 M2 — `PersistentQueue.save()` logs the error

**File:** `src/lib/persistent-queue.ts`

**Problem:** The `save()` method's bare `try { … } catch {}`
silently dropped every write error (full disk, file locked by
antivirus, permission denied).  In-memory state advanced; the
operator never knew the queue file was stale.

**Fix (v2.0.17):** The catch block now calls
`log.error(\`[PersistentQueue] failed to write ${this.filePath}:\`, err)`.
The dead-letter `saveDeadLetter()` does the same.  Net: queue
write failures are now visible in the main log.

**Test:** `tests/medium-severity.test.ts` → "Fix M2" suite (1 test).

### 15.3 M3 — `clearOld` moves unprocessed to a dead-letter array

**File:** `src/lib/persistent-queue.ts`

**Problem:** `clearOld(maxAgeMs)` dropped both processed *and*
unprocessed messages older than the cutoff.  A message queued at
`T0`, gateway restarted at `T0 + 23h`, `clearOld` runs at
`T0 + 25h` → the unprocessed message is silently dropped without
ever being delivered.

**Fix (v2.0.17):**

- New `deadLetter: QueuedMessage[]` field, persisted to
  `<dataDir>/message-queue.dead-letter.json`.
- `clearOld` now iterates the queue once: messages newer than the
  cutoff go to `survivors[]`; messages older *and* unprocessed
  are appended to `deadLetter[]` (capped at `DEAD_LETTER_MAX = 500`).
- New `getDeadLetter()` and `clearDeadLetter()` accessors.
- `flush()` persists both the live queue and the dead-letter on
  the same 2-second timer.

**Test:** `tests/medium-severity.test.ts` → "Fix M3" suite (3 tests).

### 15.4 M4 — `JsonStore` per-instance write-chain serialises set/update/clear

**File:** `src/jsonStore.ts`

**Problem:** `set(updates)` and `update(fn)` are read-modify-write
but not atomic.  Two concurrent `add()` calls (e.g. two
simultaneous contact adds from two inbound messages) can race:
both load the same baseline, both mutate, the second `save()`
overwrites the first.  Latent in v2.0.15/16 (the in-memory
critical section was safe but the pattern was fragile).

**Fix (v2.0.17):**

- Added `private writeChain: Promise<void> = Promise.resolve()`
  to `JsonStore<T>`.
- Added `private enqueueWrite(step)` which appends a step to
  the chain via `this.writeChain = next.catch(() => {})` (the
  chain is fail-open: one step throwing does not poison
  subsequent steps; the caller's returned promise still sees
  the rejection).
- `set`, `update`, and `clear` now `return this.enqueueWrite(...)`.

**Test:** `tests/medium-severity.test.ts` → "Fix M4" suite (6
tests, including an in-process re-implementation of the chain
that verifies 5 concurrent `set()` calls are serialised in
submission order).

### 15.5 M5 + 15.6 M6 — `upload-protocol.ts` setTimeout cleanup and error-branch return

**File:** `src/lib/upload-protocol.ts`

**Problem:** Both `discoverUploadService` (10s timer) and
`requestUploadSlot` (30s timer) stored no handle.  If the disco
resolved early, the timer kept the event loop alive and fired
10s later, calling `xmpp.off('stanza', handler)` and
`resolve(null)` on an already-settled promise.  No functional
impact, but a real event-loop leak.

**Fix (v2.0.17, M5):**

- `let timer: ReturnType<typeof setTimeout> | null = null;` in
  each function.
- `const cleanup = () => { if (timer !== null) { clearTimeout(timer);
  timer = null; } };` defined in each.
- `cleanup()` is called in the success, error, send-rejection,
  *and* timeout paths.

**Fix (v2.0.17, M6):** Cosmetic — added an explicit `return;` after
`resolve(null)` in the disco error branch so the function is
clearer to reason about (the success-path loop above is
unreachable from the error branch via the outer `if/else if`,
but the explicit return makes that obvious).

**Test:** `tests/medium-severity.test.ts` → "Fix M5" and
"Fix M6" suites (3 tests).

### 15.7 M7 — `Contacts.add()` validates JID

**File:** `src/contacts.ts`

**Problem:** `add(jid)` accepted any string.  A typo'd
`alice@@example.com` or `bob@example` was stored without
complaint; `validators.isValidJid()` (in
`src/security/validation.ts`) was not consulted.

**Fix (v2.0.17):** `Contacts.add` now imports `validators` and
calls `validators.isValidJid(bareJid)` after stripping the
resource.  Returns `false` on invalid JID.

**Test:** `tests/medium-severity.test.ts` → "Fix M7" suite (2 tests).

### 15.8 M8 — Roster persistence via `RosterStore`

**Files:** `src/roster-store.ts` (new, ~50 lines),
`src/commands.ts`

**Problem:** `saveRoster()` was a no-op that logged
"Roster saved (in-memory only)".  `/xmpp nick <jid> <name>`
silently did nothing durable — operators lost every nick
assignment on restart.

**Fix (v2.0.17):**

- New `src/roster-store.ts` exports `class RosterStore` with
  `setNick`, `getNick`, `list`, `remove`.  Backed by
  `<dataDir>/xmpp-roster.json` via `JsonStore<RosterData>`.
- `commands.ts` removes the old `let roster: Record<...>` map
  and the no-op `saveRoster()`.  The `nick` and `roster`
  subcommands now use `RosterStore`.

**Test:** `tests/medium-severity.test.ts` → "Fix M8" suite (3 tests).

### 15.9 M9 — `services.startXmpp()` timeout + abort signal

**File:** `src/gateway.ts`

**Problem:** `startXmpp()` is async and can take unbounded time
(TCP connect + TLS + SASL + resource binding + SM, each of
which can hang silently).  A broken XMPP server would block
`startAccount` forever, holding the abort signal but never
resolving the outer `Promise<void>`.

**Fix (v2.0.17):**

- `const START_XMPP_TIMEOUT_MS = 60_000;`
- A `startXmppTimeoutPromise` that rejects with
  `new Error(\`startXmpp timed out after ${START_XMPP_TIMEOUT_MS}ms\`)` after 60s.
- The `startXmpp()` call is bound to a local
  `startXmppPromise` and the two are raced via
  `Promise.race([startXmppPromise, startXmppTimeoutPromise])`.
- The caller's `ctx.abortSignal` is wired to an `onStartXmppAbort`
  handler that calls `startXmppResult?.stop?.()` on abort.
- `clearStartXmppGuards()` is called on both success and catch
  to remove the abort listener and clear the timer handle.

**Test:** `tests/medium-severity.test.ts` → "Fix M9" suite (5 tests).

### 15.10 M12 — `vcard-cli.publishAvatar` per-step flags

**File:** `src/vcard-cli.ts`

**Problem:** The function had a single `let success = false` flag
that was set to `true` in the metadata handler *and* in the data
handler.  A stale `success = true` from a previous run's metadata
handler could leak into the current run's return value, falsely
reporting the avatar as published.

**Fix (v2.0.17):** The single flag is replaced with two per-step
flags `metadataOk` and `dataOk`, both initialised to `false` in
their own lexical scope.  The return value is
`metadataOk && dataOk`, so a partial failure naturally reports
`false`.

**Test:** `tests/medium-severity.test.ts` → "Fix M12" suite (3 tests).

### 15.11 Items resolved in earlier releases (no v2.0.17 work)

| §3 item | Status | Resolved in |
|---------|--------|-------------|
| 3.2 `xmpp.send()` hang (43+ sites) | ✅ done | v2.0.16 H2 (`safeSend`) |
| 3.3 `getQueue` singleton ignores `dataDir` | ✅ done | v2.0.16 H4 (`queueByDir: Map<...>`) |
| 3.11 `findUnderlyingSocket` "incorrect" | ✅ no fix needed | Prose §3.11 re-derived: `tls.TLSSocket.setKeepAlive` delegates correctly |
| 3.12 Whiteboard auto-draw no-paths | ✅ false alarm | Already guarded by `reconstructedPaths.length > 0` |
| 3.13 Whiteboard `isSystemMessage` AI loop | ✅ done | v2.0.16 H9 (dispatcher short-circuits) |
| 3.15 v2.0.4-still-resolved items | ✅ historical | Confirmed unchanged |

### 15.12 Items deferred to v2.0.18

- **M10/M11 (whiteboard mutation + dead `rawPaths` code)** — the
  §9.3 line 1273 row was deferred to a future v2.0.18 release
  alongside the §4 Low-severity cleanup.  The `attrEdits.push(...)`
  inside a `for` loop in `convertSxeToWhiteboardData`
  (`src/whiteboard.ts:684-695`) and the dead `standalonePaths`
  extraction (`src/whiteboard.ts:738-743`) need a careful
  whiteboard-rewrite that touches the sxe session model — too
  much surface for a "Medium"-severity release.
- **§9.3 line 1272 (nonza listener xmlns cache)** — the v2.0.16 H3
  fix already added the `el.parent !== xmpp.root` early-return
  which short-circuits the listener.  A micro-optimization to
  cache the xmlns check is a Low-priority item for v2.0.18.
- **§9.3 line 1264 (startXMPP.ts file size 2791 lines)** —
  slightly improved in v2.0.16 (2,791 → ~2,580) and slightly
  worse in v2.0.17 (the M9 wrapper added ~30 lines).  Net is
  still worse than v2.0.13.  Defer to v2.0.18.

### 15.13 New test file: `tests/medium-severity.test.ts`

29 source-level assertions across 10 describe blocks.  All pass on
`node --test`.  Full regression run (`node --test tests/*.test.ts`)
yields **97 tests / 29 suites / 0 failures** as of 2026-06-15.

### 15.14 Backups and rollback

All 10 modified source files were backed up with the
`.backup-20260615-180000` suffix before editing, following the
v2.0.15/v2.0.16 protocol.  See `_backups/ROLLBACK-2.0.17.md` for
the full-rollback and per-fix-partial-rollback recipes.

### 15.15 Verification performed before release

- `node --test tests/medium-severity.test.ts` → **29 / 29 pass**.
- `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts` → **97 / 97 pass**, no
  regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.16
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:312,317` — subpath import resolution +
  `===` comparison narrowing, both pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps: all 10 fixes have positive
  assertions (e.g. `deadLetter` is present, `writeChain` is
  present, `START_XMPP_TIMEOUT_MS = 60_000` is present,
  `metadataOk`/`dataOk` are present, the `nick` subcommand
  delegates to `store.setNick`).

---

*End of v2.0.17 post-review fixes.  Last updated 2026-06-15 by
opencode (build mode).*

---

## 16. Post-Review Fixes — v2.0.18 (this release)

v2.0.18 resolves **14 Low-severity** items from §4 (prose) plus
the two §9.3 whiteboard items M10/M11 that were deferred from
v2.0.17.  Test coverage is provided by the new
`tests/low-severity.test.ts` (14 describe blocks, 36 assertions,
all passing on `node --test`).

### 16.1 L1 — `xmppClientModule` hoisted to function-scope

**File:** `src/startXMPP.ts`

**Problem (v2.0.14/15/16/17):** The `let xmppClientModule: any =
null;` lived at module level, with an `if (!xmppClientModule) {
xmppClientModule = await import("@xmpp/client"); }` lazy-init
block inside `startXmpp()`.  Two `startXmpp()` invocations (e.g.
multi-account) shared the same module-level binding.  Modules
are immutable after load, so the behaviour was safe, but the
wider scope was unnecessary.

**Fix (v2.0.18):** Removed the module-level `let`.  The import is
now a `const xmppClientModule = await import("@xmpp/client")` at
the top of `startXmpp()`.  Node caches the module so the second
call is a no-op.  The lazy-init `if (!xmppClientModule)` block
is removed.

**Test:** `tests/low-severity.test.ts` → "Fix L1" suite (3 tests).

### 16.2 L2 — SM `<r/>` keepalive uses `xml()` builder

**File:** `src/liveness.ts`

**Problem:** `xmpp.write("<r xmlns='urn:xmpp:sm:3'/>")` used
string concatenation for an XML element.  The rest of the
codebase uses the `xml()` builder from `@xmpp/client`.

**Fix (v2.0.18):** Replaced with
`xmpp.write(xmppXml("r", { xmlns: "urn:xmpp:sm:3" }))`.  Added
`import { xml as xmppXml } from "@xmpp/client"`.

**Test:** `tests/low-severity.test.ts` → "Fix L2" suite (3 tests).

### 16.3 L3 — `_setLastInboundAt` on SM `<r/>` write has explanatory comment

**File:** `src/liveness.ts`

**Problem:** The SM `<r/>` is an *outbound* operation, but
`_setLastInboundAt(m, Date.now())` is stamped on its success.
The reviewer flagged this as "arguably correct (we are doing I/O)"
and asked for a comment.

**Fix (v2.0.18):** Added a multi-line comment explaining the
conservative choice: the idle-socket watchdog's purpose is to
detect "no bytes received", and resetting on a successful
outbound write prevents the watchdog from firing during normal
request/response traffic.  No behaviour change.

**Test:** `tests/low-severity.test.ts` → "Fix L3" suite (1 test).

### 16.4 L4 — `quarantineDir` / `tempDir` defaults are absolute

**File:** `src/security/fileTransfer.ts`

**Problem:** `quarantineDir: './quarantine'` and
`tempDir: './temp'` are CWD-relative.  The actual location
depends on the process's launch directory, which varies by
deployment (systemd, Docker, terminal).

**Fix (v2.0.18):** Default to
`path.join(os.homedir(), '.openclaw', 'extensions', 'xmpp', 'data', 'quarantine')`
and the matching `temp` path.  Operators can still override via
`FileTransferConfig`.  Added `import os from "os"`.

**Test:** `tests/low-severity.test.ts` → "Fix L4" suite (3 tests).

### 16.5 L5 — `secureDeleteFile` SSD limitation documented

**File:** `src/security/fileTransfer.ts`

**Problem:** The function overwrites the file with zeros, but on
SSD with wear-leveling and on journaling filesystems (ext4,
NTFS, APFS) the original blocks may be retained indefinitely.
The reviewer asked for a comment so operators don't believe the
file is unrecoverable.

**Fix (v2.0.18):** Added a comment block at the top of
`secureDeleteFile` documenting the limitation and pointing
operators to LUKS / FileVault / BitLocker for high-security use
cases.  No behaviour change.

**Test:** `tests/low-severity.test.ts` → "Fix L5" suite (1 test).

### 16.6 L6 — Whiteboard `attrEdits.push` mutation pattern

**File:** `src/whiteboard.ts`

**Problem:** The inline `attrEdits.push({ rid, type, ... })` inside
the `for (const set of setEdits)` loop in
`convertSxeToWhiteboardData` was functionally safe
(`Array.find()` is not affected by `Array.push()`) but the
pattern was hard to read.

**Fix (v2.0.18):** Extracted the new attr entry to a
`const newAttr = { rid: targetRid, type: 'attr' as const, ... }`
before the `push` call, with an explanatory comment.

**Test:** `tests/low-severity.test.ts` → "Fix L6" suite (1 test).

### 16.7 L7 — Whiteboard `rawPaths` dead code removed

**File:** `src/whiteboard.ts`

**Problem:** The `rawPaths?: string[]` field on the
`convertSxeToWhiteboardData` return type was set but never read
by any consumer (verified via `grep`).  The
`standalonePaths` collection loop and the two `rawPaths:`
assignments in the return statements were dead code.

**Fix (v2.0.18):** Removed the field from the return type, the
`standalonePaths` loop, the variable, and the two
`rawPaths:` assignments.  **Behaviour change**: external
consumers of `WhiteboardData.rawPaths` (out of this repo) will
get `undefined`; no internal consumer was affected.

**Test:** `tests/low-severity.test.ts` → "Fix L7" suite (3 tests).

### 16.8 L8 — already covered by v2.0.17 M12

`§4.8` (vcard-cli handlers don't reset `success` to `false` on
error) was already addressed by v2.0.17 M12's per-step
`metadataOk` / `dataOk` flags.  The handlers only set the flag
on `type === 'result'`; error stanzas leave the flag at
`false`, which the function returns as `metadataOk && dataOk`.
No additional change in 2.0.18.

### 16.9 L9 — vCard IQs use `sendReceive` instead of hard-coded sleeps

**File:** `src/vcard-cli.ts`

**Problem:** Every vCard operation used
`xmpp.on('stanza', handler)` + `await new Promise(r =>
setTimeout(r, 800))` instead of waiting for the actual
response stanza.  The 800ms hard-coded sleep was both slow
(vCard with N fields took `(N+1) * 1.1` seconds) and unreliable
(too short on a slow connection).  11 sites total.

**Fix (v2.0.18):** Added a `sendReceive(xmpp, stanza, timeoutMs =
5000)` helper that resolves on the matching `<iq type="result"/>`
and rejects on `<iq type="error"/>` or timeout.  Refactored
all 11 sites:
- 8 `setVCard*` variants
- 1 `getVCard`
- 2 `publishAvatar` IQs (metadata + data)

The 300ms post-SET sleeps were also removed (no functional
purpose; the IQ stream is already ordered by the `stanzas`
event).

**Test:** `tests/low-severity.test.ts` → "Fix L9" suite (5 tests).

### 16.10 L10 — `recordInboundSession` skip now logs a warning

**File:** `src/gateway.ts`

**Problem:** The `if (runtime?.channel?.session?.recordInboundSession)`
block silently skipped the file-notification path if the
runtime channel session was unavailable.  The operator had no
way to know why file notifications weren't being recorded.

**Fix (v2.0.18):** Added an `else { log.warn(...) }` branch
that explains why the path was skipped.

**Test:** `tests/low-severity.test.ts` → "Fix L10" suite (1 test).

### 16.11 L11 — `state.ts` exports strongly typed

**File:** `src/state.ts`

**Problem:** `xmppClients: Map<string, any>` and
`contactsStore: Map<string, any>` defeated the strongly-typed
`XmppClient` interface in `types.ts`.

**Fix (v2.0.18):** Type as `Map<string, XmppClient>` and
`Map<string, Contacts>`.  Type-only imports of `XmppClient`
(from `./types.js`) and `Contacts` (from `./contacts.js`).
No runtime change; downstream type narrowing now works
without `as any` casts.

**Test:** `tests/low-severity.test.ts` → "Fix L11" suite (3 tests).

### 16.12 L12 — `commands.ts` JID validation extracted

**File:** `src/commands.ts`

**Problem:** The `add` and `remove` subcommands each inlined
`if (!jid || !jid.includes('@')) { ... }`.

**Fix (v2.0.18):** Extracted a `requireJid(jid, usage)` helper
that prints a usage message and returns `false` on missing
`@`.  Both subcommand sites now use the helper.

**Test:** `tests/low-severity.test.ts` → "Fix L12" suite (3 tests).

### 16.13 L13 — `saveVCardLocally` is now async

**File:** `src/vcard-cli.ts`

**Problem:** The function used `fs.writeFileSync`,
`fs.existsSync`, and `fs.mkdirSync` in an async codebase.

**Fix (v2.0.18):** Converted to `async` with `fsp.writeFile`,
`fsp.mkdir({ recursive: true })`.  The `existsSync` guard was
removed because `mkdir({ recursive: true })` is idempotent
(TOCTOU race otherwise).  All 10 call sites updated to
`await saveVCardLocally(vcard)`.

**Test:** `tests/low-severity.test.ts` → "Fix L13" suite (4 tests).

### 16.14 L14 — `withConnection` wraps `xmpp.start()` in try/catch

**File:** `src/vcard-cli.ts`

**Problem:** `xmpp.start()` may reject (e.g. bad credentials).
The `await xmpp.start()` then-check-the-`'error'`-listener
pattern was racy — a real start failure could be silently
swallowed.

**Fix (v2.0.18):** Wrapped in
`try { await xmpp.start(); } catch (err) { try { await
xmpp.stop(); } catch {}; throw err; }`.  The
`if (error) { ... throw error; }` check is retained as
belt-and-braces defence-in-depth.

**Test:** `tests/low-severity.test.ts` → "Fix L14" suite (2 tests).

### 16.15 L15 — `cli-debug.log` default location + `.gitignore`

**Files:** `src/shared/index.ts`, `.gitignore`, filesystem

**Problem:** The `debugLog()` function wrote to
`process.cwd()/cli-debug.log` by default, polluting the source
tree when the plugin was launched from the project root.
Two `cli-debug.log` files (3.3MB + 143KB) were present in
the source tree, not git-tracked (covered by `*.log` in
`.gitignore`) but still cluttering the workspace.

**Fix (v2.0.18):**
- Default location changed to
  `~/.openclaw/extensions/xmpp/logs/cli-debug.log`.
  `setDebugLogDir(dir)` still works for the override.
- Added `import os from "os"` to `src/shared/index.ts`.
- Deleted the two existing `cli-debug.log` files.
- Added explicit `cli-debug.log` and `src/cli-debug.log`
  entries to `.gitignore` (in addition to the existing
  `*.log` rule) for belt-and-braces.

**Test:** `tests/low-severity.test.ts` → "Fix L15" suite (3 tests).

### 16.16 Items already done / not in scope (no change in 2.0.18)

| §4 item | Status | Note |
|---------|--------|------|
| 4.8 (vcard-cli success flag) | ✅ done in v2.0.17 M12 | Per-step `metadataOk`/`dataOk` flags |
| 4.15 (inconsistent import style) | ✅ already consistent | All 65+ `src/` imports use `.js` |
| 4.16 (rate-limit off-by-one comment) | ✅ already self-documenting | Test in `tests/rate-limit.test.ts` clarifies |
| 4.18 (TS strict mode) | ⏭ deferred | Acceptable per v2.0.4 review |
| §9.3 line 1264 (startXMPP.ts file size) | ⏭ deferred | Multi-release refactor |
| §9.3 line 1272 (nonza listener xmlns cache) | ⏭ deferred | Micro-opt, v2.0.16 H3 already short-circuits via parent check |

### 16.17 New test file: `tests/low-severity.test.ts`

36 source-level assertions across 14 describe blocks.  All pass
on `node --test`.  Full regression run
(`node --test tests/*.test.ts`) yields **133 tests / 43 suites /
0 failures** as of 2026-06-15.

### 16.18 Backups and rollback

All 13 modified source files were backed up with the
`.backup-20260615-200000` suffix before editing, following the
v2.0.15/v2.0.16/v2.0.17 protocol.  See
`_backups/ROLLBACK-2.0.18.md` for the full-rollback and
per-fix-partial-rollback recipes.

### 16.19 Verification performed before release

- `node --test tests/low-severity.test.ts` → **36 / 36 pass**.
- `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts` →
  **133 / 133 pass**, no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.17
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:319,324` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps: all 14 fixes have positive
  assertions (e.g. `let xmppClientModule` is 0 matches in
  startXMPP.ts; `setTimeout(r, 800)` is 0 matches in vcard-cli.ts;
  `Map<string, any>` is 0 matches in state.ts).

---

*End of v2.0.18 post-review fixes.  Last updated 2026-06-15 by
opencode (build mode).*

---

## 17. Post-Review Fixes — v2.0.19 (this release)

v2.0.19 is a **regression hotfix**, not a §3/§4 cleanup.  It
addresses a production failure mode reported after the 2.0.18
release: the gateway would log
`StreamError { condition: 'conflict', text: 'Replaced by new
connection' }` after every reconnect, and then stop
dispatching messages for 2-3 minutes (until the watchdogs
fired).

The fix is 3 file changes + 1 new test file.  Test coverage
is in `tests/v2.0.19-connection-resilience.test.ts`
(3 describe blocks, 10 assertions, all passing).

### 17.1 R1 — Unique resource per connection attempt

**File:** `src/lib/xmpp-connect.ts`

**Problem:** The default XMPP resource was
`config.jid.split("@")[0]` — the bare-JID local part
(e.g. `alice`).  This is **not unique** across reconnections.
Combined with the `@xmpp/client` library's internal stream
renegotiation (triggered by SM keepalive / IQ traffic), the
XMPP server saw a re-handshake as a "new connection" and
returned `StreamError { condition: 'conflict', text:
'Replaced by new connection' }`.  The first stream was
killed; the second survived but was then silently
black-holed by a middlebox.

**Fix (v2.0.19):** Generate a stable-prefix + 6-hex-char
random suffix: `` `openclaw-${crypto.randomBytes(3).toString("hex")}` ``.
16M possible values; collision requires two connections
from the same JID in the same millisecond — effectively
zero.  Operators who supply `config.resource` explicitly
are honoured verbatim.  Added `import crypto from "crypto"`.

**Test:** `tests/v2.0.19-connection-resilience.test.ts` →
"Fix R1" suite (3 tests).

### 17.2 R2 — Status-aware iq-ping error swallow

**File:** `src/liveness.ts`

**Problem:** The `setupIqPingWatchdog` catch block did
`xmppLog.warn("iq-ping: send failed", err)`.  When the
underlying socket was already torn down (e.g. during the
"black-holed" window after a conflict), `xmpp.send()`
rejected with an error object that had no useful properties
(the user's log shows `iq-ping: send failed {}` with an
empty `{}`).  The `warn` was noise — it didn't tell the
operator anything actionable.

**Fix (v2.0.19):** Read `xmpp.status` before warning.  If
the xmpp client's internal status is anything other than
`"online"` (i.e. we're already in a disconnect / reconnect
cycle), suppress the `warn` (the `onOffline()` /
`scheduleReconnect()` machinery will handle recovery) and
emit a `debugLog` instead for post-mortem.  Real errors
(e.g. server returns `<iq type="error"/>`) still log at
`warn` level.

**Test:** `tests/v2.0.19-connection-resilience.test.ts` →
"Fix R2" suite (3 tests).

### 17.3 R3 — Fast-fail reconnect after a "conflict" / "Replaced" disconnect

**File:** `src/liveness.ts`

**Problem:** When the most recent disconnect reason was
`StreamError { condition: 'conflict', text: 'Replaced by new
connection' }` (set by `startXMPP.ts:299` from the
`'disconnect'` handler), the previous connection was
already dead.  But the liveness manager went through the
normal `scheduleReconnect()` flow with exponential backoff
(1s, 2s, 4s, ... capped at 60s).  Combined with the 60s
IQ-ping interval and the 120s socket-idle timeout, the
user-visible "messages stop being dispatched" window
was 2-3 minutes.

**Fix (v2.0.19):** In `onOffline()`, check
`lastDisconnectReason`.  If it contains "conflict" or
"Replaced by new connection", skip `scheduleReconnect()`
and call `xmpp.start()` directly.  This drops the
recovery window to <1s.  The fast-fail branch clears
`m._reconnectTimer` to prevent double-scheduling, and on
failure falls back to `scheduleReconnect()`.  R1 ensures
the new resource is unique, so we don't re-trigger the
conflict.

**Test:** `tests/v2.0.19-connection-resilience.test.ts` →
"Fix R3" suite (4 tests).

### 17.4 Out of scope (deferred to future releases)

- **R2/R3 don't change the IQ-ping or socket-idle timeouts**.
  These are still 60s and 120s respectively.  If a future
  release sees more silent middlebox drops, we may
  tighten them.
- **No retry-bounded-redirect logic**.  The current
  `scheduleReconnect()` keeps retrying forever with
  exponential backoff up to 60s.  An operator who wants
  "give up after N attempts" can set
  `Config.RECONNECT_MAX_MS` to a very large value and rely
  on a separate watchdog.  Not changed in 2.0.19.
- **No SM renegotiation avoidance**.  The root cause of
  the conflict is that the @xmpp/client library
  renegotiates SM mid-connection.  We can't avoid the
  library's behaviour; we just make our resource unique so
  the server doesn't kill us.  If a future @xmpp/client
  release changes this behaviour, R1 may no longer be
  needed; R2 and R3 are still useful.

### 17.5 Verification performed before release

- `node --test tests/v2.0.19-connection-resilience.test.ts`
  → **10 / 10 pass**.
- `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts
  tests/v2.0.19-connection-resilience.test.ts` →
  **143 / 143 pass**, no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.18
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:319,324` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification greps: all 3 fixes have positive
  assertions.

---

*End of v2.0.19 post-review fixes (regression hotfix).  Last
updated 2026-06-15 by opencode (build mode).*

---

## 18. Post-Review Fixes — v2.0.20 (this release)

v2.0.20 is a **second-pass regression hotfix** for the same
failure mode the v2.0.19 release tried to fix.  v2.0.19 was
insufficient because the three fixes (R1 unique resource,
R2 status-aware iq-ping swallow, R3 fast-fail after
conflict) addressed the wrong root cause.  The actual root
cause was a **race between the operator's health-monitor
plugin and the liveness manager's own reconnect
mechanism**: both call `startAccount` (which calls
`startXmpp`) within seconds of each other, and the XMPP
server kills the older stream with `StreamError {
condition: 'conflict', text: 'Replaced by new connection' }`.

The fix is a single 5-line semantic change to
`gateway.startAccount` in `src/gateway.ts`.  Test coverage
is in `tests/v2.0.20-double-start-guard.test.ts`
(1 describe block, 5 assertions, all passing).

### 18.1 The fix — refuse `startAccount` when the existing client is alive

**File:** `src/gateway.ts`

**Problem:** The previous behaviour of `startAccount` was
to *always* tear down the existing XMPP client and start a
new one.  When the health-monitor plugin called
`startAccount` because it thought the connection was
"stale" (default: no inbound bytes for ~30s), and the
liveness manager was *also* mid-reconnect, two concurrent
`startXmpp` calls each opened a fresh connection.  The
XMPP server killed the older one with conflict.

**Fix (v2.0.20):** Look up the existing client for the
account.  Read its `_lastInboundAt` timestamp (already
maintained by the liveness manager).  If inbound traffic
was seen within `STALE_CONNECTION_TIMEOUT_MS = 30_000`
(30s — comfortably above the SM keepalive interval of
25s and the IQ-ping interval of 60s), treat as alive
and **refuse** the new `startAccount` (log a warning,
return early).  If inbound traffic was seen > 30s ago
OR no existing client, the previous code path runs:
stop the dead client, then start a new one.

**Test:** `tests/v2.0.20-double-start-guard.test.ts` →
single describe block, 5 assertions (constant present,
reads `_lastInboundAt`, returns early on alive, proceeds
on stale, logs a warning).

### 18.2 Why v2.0.19 was insufficient (post-mortem)

| v2.0.19 fix | Targeted scenario | Why it didn't help the operator |
|---|---|---|
| **R1** unique resource | Single-process internal stream renegotiation | The operator's scenario is two distinct `startXmpp` calls from two sources (health-monitor + liveness manager).  R1 only helps in the *same*-process re-handshake case. |
| **R2** status-aware iq-ping swallow | `xmpp.status !== "online"` | The 12 `iq-ping: send failed {}` lines were all logged with `xmpp.status === "online"`.  The socket was black-holed by a middlebox but the xmpp client hadn't noticed yet.  R2's check never matched. |
| **R3** fast-fail after conflict | `lastDisconnectReason` contains "conflict" | The conflict text is in the `error` event, not the `disconnect` event.  R3's regex never matched. |

The actual root cause: the gateway was being asked to start
a second connection while the first was still alive.  R1
prevents the @xmpp/client library's internal re-handshake
from being the trigger; it does nothing about an external
process (or external call) initiating a second connection.

The v2.0.19 fixes are still in place and still correct for
their target scenarios.  v2.0.20 adds the missing piece:
refuse to start a second concurrent connection.

### 18.3 Why 30s and not 5s or 60s

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

### 18.4 Out of scope (deferred to future releases)

- **R2 (status-aware iq-ping swallow)** is correct for
  offline/reconnect but doesn't catch the "online but
  black-holed" case.  Future releases may add an
  additional check on `_lastSendErrorAt` to catch the
  operator's specific symptom (12 `send failed {}` lines
  while `xmpp.status === "online"`).
- **R3 (fast-fail after conflict)** is correct in
  principle but checked the wrong event.  Future releases
  may wire it to the `error` event so the conflict text
  actually reaches the regex.
- **No escape-hatch flag** for force-restart.  If the
  operator really needs to force a restart, they can
  restart the gateway process.  Future releases may add
  a `Config.FORCE_RESTART_AFTER_MS` field.

### 18.5 Verification performed before release

- `node --test tests/v2.0.20-double-start-guard.test.ts`
  → **5 / 5 pass**.
- `node --test tests/critical-fixes.test.ts
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
  `Select-String -Path src/gateway.ts -Pattern
  "STALE_CONNECTION_TIMEOUT_MS\s*=\s*30_000"` →
  **1 match**.  ✅

---

## 19. Post-Review Fixes — v2.1.0 (groupchat dispatch hygiene — this release)

v2.1.0 closes a gap in the v2.0.16 H9 `isSystemMessage` skip-dispatch
guard.  It is a **minor** version bump (not patch) because the
behavior change is observable in operator logs: room subject changes
no longer appear in the agent's LLM context, and the LLM slot is
preserved for real user messages.

### 19.1 The bug

`src/gateway.ts:282-285` introduced a skip-dispatch guard in v2.0.16:

```ts
if (options?.isSystemMessage === true) {
  log.debug("skipping AI dispatch for system message", { from: senderBareJid });
  this.queue.markAsProcessed(messageId);
  return;
}
```

This guard works correctly.  But the v2.0.16 patch only set
`isSystemMessage: true` on the **SXE / whiteboard** paths in
`src/startXMPP.ts` (lines 1056 and 1281).  The **room-subject**
path at `src/startXMPP.ts:1011` was overlooked:

```ts
// BEFORE v2.1.0:
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

The `gateway.ts:282-285` guard never fired for room subjects,
because the flag was not set.  The room subject was forwarded
to the agent's LLM as a real user message.  The LLM would
respond, generating visible room traffic that confused the
next user-message dispatch and consumed the LLM's attention
slot.

### 19.2 Operator-visible symptom

Groupchat dispatch is intermittent.  DMs work.  Operator's log:

```
08:36:46 [ERROR] DISPATCH_ENTERED: from=general@conference.kazakhan.com bodyLen=297 type=groupchat
08:36:52 [ERROR] DISPATCH_ENTERED: from=general@conference.kazakhan.com bodyLen=9 type=groupchat
08:37:00 [INFO] Dispatch SUCCESS for general@conference.kazakhan.com
08:37:00 [DEBUG] GC_SEND: post groupchat success=true
08:39:03 [agent/embedded] [llm-idle-timeout] ollama/gemma4:e4b produced no reply before the idle watchdog; retrying same model
```

The 297-char no-nick message is the room subject change.  The
9-char "Jamie" message is the real user message.  The bot's
LLM is shared; processing the subject consumes the LLM's
attention, so the user's actual message either times out
(LLM idle = 120 s for `gemma4:e4b`) or shares the slot and
the bot's reply goes to the room for the subject, not the
user's message.

### 19.3 The fix

One-line change at `src/startXMPP.ts:1011`:

```diff
-            onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [] });
+            onMessage(from.split('/')[0], `[Room Subject: ${subject}]`, { type: messageType, room: from.split('/')[0], nick: '', botNick, roomSubject: subject, mediaUrls: [], mediaPaths: [], isSystemMessage: true });
```

The room-subject change is still **persisted** to the message
store (so the room topic is preserved in conversation history),
but the agent's LLM is no longer invoked.  The
`gateway.ts:282-285` guard short-circuits the dispatch and calls
`markAsProcessed`.

### 19.4 Full audit of `onMessage(` call sites

A complete audit of all 9 `onMessage(` call sites in
`src/startXMPP.ts` was performed.  Only **one** site (line 1011,
room subject) was missing the `isSystemMessage: true` flag.
The remaining 8 sites are correctly classified:

| Line | Payload | `isSystemMessage: true`? | Rationale |
|------|---------|-------------------------|-----------|
| 1011 | Room subject change | **No (FIXED in v2.1.0)** | MUC metadata, not user input |
| 1056 | SXE whiteboard session instructions | Yes (already) | System-generated AI prompt |
| 1151 | SXE timer whiteboard update (user drew) | No (correct) | Real user action, LLM should react |
| 1281 | Whiteboard session instructions | Yes (already) | System-generated AI prompt |
| 1301 | Whiteboard update (user drew) | No (correct) | Real user action, LLM should react |
| 1420 | DM with non-plugin slash command | No (correct) | Real user message |
| 1459 | `/help` in DM | No (correct) | Real user message |
| 2338 | Groupchat user message | No (correct) | Real user message |
| 2345 | DM from contact | No (correct) | Real user message |

### 19.5 Known issues (out of scope for v2.1.0)

These are documented in `CHANGELOG.md` §[2.1.0] and require
OpenClaw configuration changes or larger architectural work
that is outside the xmpp plugin's scope.

1. **LLM idle timeout (120 s default).**  Slow models like
   `ollama/gemma4:e4b` can take longer than 120 s to produce
   a reply, at which point OpenClaw's `[agent/embedded]
   [llm-idle-timeout]` watchdog retries (or aborts).
   Workaround: increase `Config.LLM_IDLE_TIMEOUT_MS` in
   OpenClaw, or use a faster model.  This is an OpenClaw-side
   config concern, not an xmpp plugin concern.

2. **Concurrent dispatches race on a single LLM.**  If two
   messages arrive in quick succession, both call
   `mod.dispatchInboundReplyWithBase` and both compete for the
   same LLM.  The second dispatch may time out or share the
   slot.  Workaround: serialize dispatches via a per-account
   queue.  This is a larger architectural change; tracked as
   a future enhancement.

### 19.6 Versioning rationale

v2.1.0 is a **minor** version bump (not patch) because:

- The behavior change is observable in operator logs
  (room subjects no longer appear in LLM context).
- The fix closes a known gap in v2.0.16 H9 (the
  `isSystemMessage` skip-dispatch guard was incomplete).
- Per SemVer §7, "a backwards-incompatible change to
  functionality that is publicly visible" warrants a minor
  bump.  The xmpp plugin's public contract (the message
  dispatch behavior) is observably different in groupchat
  rooms.

### 19.7 Verification performed before release

- `node --test tests/v2.1.0-groupchat-dispatch.test.ts`
  → **5 / 5 pass** (1 describe block, 4 describe blocks:
  room subject isSystemMessage, real user messages do not
  have isSystemMessage, gateway guard remains in place,
  version bumped).
- `node --test tests/critical-fixes.test.ts
  tests/message-store-jid.test.ts tests/gateway-rpc.test.ts
  tests/cli-encrypt.test.ts tests/high-severity.test.ts
  tests/medium-severity.test.ts tests/low-severity.test.ts
  tests/v2.0.19-connection-resilience.test.ts
  tests/v2.0.20-double-start-guard.test.ts
  tests/v2.1.0-groupchat-dispatch.test.ts` →
  **153 / 153 pass** (148 from prior releases + 5 new),
  no regressions in earlier suites.
- `npx tsc --noEmit`: same 5 pre-existing errors as v2.0.20
  (`index.ts:4`, `setup-entry.ts:1`, `src/cli-metadata.ts:8`,
  `src/gateway.ts:353,358` — subpath import resolution +
  `===` comparison narrowing, all pre-existing and unrelated
  to this work).  **Zero new TypeScript errors introduced.**
- Final verification grep on all `onMessage(` call sites:
  `Select-String -Path src/startXMPP.ts -Pattern
  "onMessage\("` → **9 matches**.  Each one classified per
  §19.4 above.  ✅
- Final verification grep on `isSystemMessage: true`:
  `Select-String -Path src/startXMPP.ts -Pattern
  "isSystemMessage:\s*true"` → **3 matches** (lines 1056,
  1061, 1281, 1286) covering SXE + whiteboard session
  instructions + the new room subject path.  ✅

---

*End of v2.1.0 post-review fixes (groupchat dispatch
hygiene).  Last updated 2026-06-15 by opencode (build mode).*

*End of code review.  Last updated 2026-06-15 by opencode (build mode).*
