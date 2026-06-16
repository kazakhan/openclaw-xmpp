# Plan: Split `src/startXMPP.ts` (2794 lines) into focused modules

## Goal

Reduce `src/startXMPP.ts` from **2794 lines** to a leaner file by extracting
the two feature areas the user explicitly called out:

1. **Slash-command dispatcher** — parsing and handling `/help`, `/list`,
   `/add`, `/remove`, `/admins`, `/whoami`, `/join`, `/rooms`, `/leave`,
   `/invite`, `/vcard ...`, `/test ...` (and the non-plugin routing
   decision for groupchat vs. direct chat).
2. **vCard server-side helpers** — `queryVCardFromServer()` and
   `updateVCardOnServer()` (XEP-0054 IQ wrappers) plus the `publishAvatar()`
   XEP-0084 helper that the slash-command path relies on.

Stays in `startXMPP.ts` (this is a **minimal** split per the user's choice):
connection setup, the `online`/`offline`/`error`/`nonza`/`stanza`
top-level dispatcher, presence handler, MUC room tracking, IBB/SI
file-transfer stanza handling, SXE whiteboard stanza handling, the
public `xmppClient` object, and `stop()`.

---

## File map (after the refactor)

| New file | Lines (approx) | Origin in `startXMPP.ts` | What it owns |
|---|---|---|---|
| `src/slash-commands.ts` | ~970 | 1451–2406 (the `if (body && body.startsWith('/'))` block, including the giant `switch (command)`) | `SlashCommandContext` interface, `handleSlashCommand(ctx)` entrypoint, `getDefaultNick()` helper, subcommand handlers (`handleHelp`, `handleList`, `handleAdd`, `handleRemove`, `handleAdmins`, `handleWhoami`, `handleJoin`, `handleRooms`, `handleLeave`, `handleInvite`, `handleVcard`, `handleTest`) |
| `src/vcard-server.ts` | ~250 | 152–263 (`queryVCardFromServer`, `updateVCardOnServer`), 2503–2572 (`publishAvatar`), plus the small `vCard SET` IQ handler at 885–931 (which lives inside the `iq` stanza branch) | `VCardServer` class with `query()`, `update()`, `publishAvatar()` methods, plus a tiny `vcard-protocol` `parseVCard` re-export for callers |
| `src/startXMPP.ts` | ~1850 | everything else | connection bootstrap, dispatcher, presence, MUC, IBB/SI, SXE, `xmppClient`, `stop()` |

The `vCard GET`/`SET` stanza handler that lives inside the `iq` branch
(885–931) stays in `startXMPP.ts` for now — it's only ~50 lines and
moving it would require restructuring the entire `iq` stanza switch.
The split is a *minimal* one, per the user's choice.

---

## Detailed extraction plan

### 1. `src/vcard-server.ts` (new file)

**Contents moved verbatim from `startXMPP.ts`:**

- `queryVCardFromServer` — lines 154–201
- `updateVCardOnServer` — lines 203–263
- `publishAvatar` (XEP-0084 PEP publish) — lines 2503–2572

**Wrapper shape (factory function, not a class, to match the surrounding
style):**

```ts
// src/vcard-server.ts
import { xml } from "@xmpp/client";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { parseVCard } from "./lib/vcard-protocol.js";
import { safeSend } from "./lib/xmpp-utils.js";
import { log } from "./lib/logger.js";
import { child } from "./lib/logger.js";

export interface VCardServerDeps {
  xmpp: any;
  bareJid: string;        // cfg.jid.split("/")[0]
  dataDir: string;        // cfg.dataDir
  debugLog: (...args: any[]) => void;
}

export function createVCardServer(deps: VCardServerDeps) {
  const { xmpp, bareJid, debugLog } = deps;
  const xmppLog = child("vcard-server");

  async function queryVCardFromServer(targetJid: string): Promise<any> { /* ... */ }
  async function updateVCardOnServer(updates: any): Promise<boolean> { /* ... */ }
  async function publishAvatar(filePath: string, imageUrl: string): Promise<boolean> { /* ... */ }

  return { queryVCardFromServer, updateVCardOnServer, publishAvatar };
}
```

**Why a closure factory, not a class:** matches the existing style
in `startXMPP.ts` (most helpers are arrow functions closed over
`xmpp`/`xmppLog`/`cfg`). Keeps the diff minimal.

**`xmppLog`:** the moved code calls `xmppLog.debug(...)`/`xmppLog.warn(...)`
using the file-scoped `xmppLog = child("xmpp")` from `startXMPP.ts:31`.
Inside the new module we use `child("vcard-server")` to keep log
namespacing clean; the human-readable strings already include `"vCard"`
prefixes so log readers can still find them.

### 2. `src/slash-commands.ts` (new file)

**Contents moved verbatim from `startXMPP.ts`:**

- The `getDefaultNick` arrow — lines 79–85 (it's only used by the
  slash-command path and the MUC join helpers; we'll pass it as a
  dependency from `startXMPP.ts` rather than duplicating it)
- The slash-command body — lines 1451–2406
  - `sendReply` closure
  - `pluginCommands` set
  - Groupchat / direct-chat routing decision
  - `checkAdminAccess` closure
  - The `switch (command)` block (all 10+ cases)
  - The outer `try { ... } catch` that wraps the whole switch

**Public API:**

```ts
// src/slash-commands.ts
export interface SlashCommandContext {
  xmpp: any;
  xmppLog: any;             // child("xmpp") from startXMPP.ts
  debugLog: (...a: any[]) => void;
  vcard: any;               // VCard instance (for local field setters)
  vcardServer: {            // from src/vcard-server.ts
    queryVCardFromServer: (jid: string) => Promise<any>;
    updateVCardOnServer:   (updates: any) => Promise<boolean>;
    publishAvatar:         (filePath: string, imageUrl: string) => Promise<boolean>;
  };
  contacts: any;            // isAdmin / list / add / exists
  cfg: any;                 // dataDir, jid, domain
  resolveRoomJid: (room: string) => string;
  getDefaultNick: () => Promise<string>;
  onMessage: (from: string, body: string, options?: any) => void;
  joinedRooms: Set<string>;
  roomNicks: Map<string, string>;
  requestUploadSlot: (filename: string, size: number, contentType?: string) => Promise<{putUrl: string, getUrl: string, headers?: Record<string,string>}>;
  uploadFileViaHTTP: (filePath: string, putUrl: string, headers?: Record<string,string>) => Promise<void>;
}

export async function handleSlashCommand(ctx: SlashCommandContext, args: {
  body: string;
  from: string;
  fromBareJid: string;
  messageType: "chat" | "groupchat";
  roomJid: string | null;
  nick: string | null;
  botNick: string | null;
  mediaUrls: string[];
  mediaPaths: string[];
}): Promise<{ handled: boolean; forwardToAgent?: boolean }>;
```

**Return value contract:** replaces the messy `return;` / `return;` /
"forwarded to agent" / "fell through to normal processing" control flow
of the in-file version with an explicit return. The caller in
`startXMPP.ts` decides what to do next:

- `{ handled: true }` → stop, do not forward to agent
- `{ handled: true, forwardToAgent: true }` → handled locally AND
  also forward (the existing `/help` special case)
- `{ handled: false }` → slash command was ignored (non-plugin in
  groupchat, or non-plugin from non-contact) — caller decides

**Re-implementing `getDefaultNick`:** the in-file version closes over
the `vcard` instance declared later in `startXMPP.ts` (line 535). To
avoid a forward-reference we hoist the `VCard` instantiation to
**before** the `xmpp.on("stanza", ...)` registration, and pass
`getDefaultNick` into the slash-command context from the call site.
The body of `getDefaultNick` is preserved verbatim.

### 3. `src/startXMPP.ts` (slimmed)

**What stays:**

- Imports (add the two new modules)
- File-scope `xmppLog = child("xmpp")`, `isRunning` flag,
  `unhandledRejection` handler
- `startXmpp(cfg, contacts, log, onMessage, onOnline, onFileReceived)`
  function body, with these changes:
  1. Instantiate `VCard` (line 535) **before** the stanza handler
     registration
  2. Build `vcardServer = createVCardServer({ xmpp, bareJid: cfg.jid.split("/")[0], dataDir: cfg.dataDir, debugLog })`
  3. In the `stanza` handler's `message` branch, replace the
     1451–2406 block with:
     ```ts
     if (body && body.startsWith('/')) {
       const result = await handleSlashCommand(ctx, {
         body, from, fromBareJid, messageType,
         roomJid: messageType === "groupchat" ? from.split("/")[0] : null,
         nick:    messageType === "groupchat" ? from.split("/")[1] || "" : null,
         botNick: messageType === "groupchat" ? roomNicks.get(from.split("/")[0]) : null,
         mediaUrls, mediaPaths,
       });
       if (result.handled) {
         if (result.forwardToAgent) onMessage(fromBareJid, body, { type: messageType === "groupchat" ? "groupchat" : "chat", mediaUrls, mediaPaths });
         return;
       }
       if (!result.handled && messageType === "chat" && result.forwardToAgent) {
         onMessage(fromBareJid, body, { type: "chat", mediaUrls, mediaPaths });
         return;
       }
       // handled:false means "ignored, do not forward"
       return;
     }
     ```
  4. The `iq` stanza branch (885–931 vCard request handler) stays put
- `xmppClient` definition, `stop()`, shutdown signal wiring

**Approximate resulting size:** ~1850 lines.

---

## Test changes (required by the user's first answer)

The following tests pin line numbers inside `src/startXMPP.ts` and will
break when the slash-command and vCard-server code moves out:

### `tests/v2.1.0-groupchat-dispatch.test.ts`

The relevant assertions look at lines `1011`, `1056`, `1281`, `2338`,
`2345`, `1151`. After the refactor:

| Test | Old line | New location |
|---|---|---|
| `startXMPP.ts:1011 — room subject onMessage call has isSystemMessage: true` | 1011 (room-subject message) | unchanged content, but line shifts up because the slash-command block is removed from before it. **Re-find by content, not line.** Change the test to grep for `\[Room Subject:` plus the `isSystemMessage: true` on the same call, rather than reading a fixed line number. |
| `startXMPP.ts:1056 — SXE whiteboard session instructions still set isSystemMessage: true` | 1056 | same — the SXE block is NOT moving. The line number will change because code is removed above it. Update the numeric anchor or, better, change the test to use a content match (the existing test already does a content scan — just remove the line-number specific error message). |
| `startXMPP.ts:1281 — whiteboard session instructions still set isSystemMessage: true` | 1281 | same. The test already does a content scan; just refresh the comment. |
| `startXMPP.ts:2338 — groupchat user message is NOT marked isSystemMessage` | 2338 | this IS the slash-command block (groupchat forwarding of non-plugin command). It moves to `src/slash-commands.ts`. Change the test to look inside `src/slash-commands.ts`. |
| `startXMPP.ts:2345 — DM user message is NOT marked isSystemMessage` | 2345 | same — moves to `src/slash-commands.ts`. |
| `startXMPP.ts:1151 — SXE timer whiteboard update is a real user action` | 1151 | same — stays in startXMPP.ts; the line number shifts. |

**Strategy:** update the test descriptions to say "in
`src/slash-commands.ts`" for the cases that move, and either refresh
the numeric line anchors for cases that stay or convert them to
content-based scans (the existing tests already use content scans
for some cases — make all of them content-based for resilience).

### `tests/v2.1.4-muc-rejoin-conflict.test.ts`, `high-severity.test.ts`, `v2.1.3-restore-old-design.test.ts`, `low-severity.test.ts`

All assertions of the form
> `startXMPP.ts` uses crypto.randomBytes for the default resource
> `startXMPP.ts` imports safeSend from `./lib/xmpp-utils.js`
> `startXMPP.ts` declares a `pendingJoins` Map
> etc.

are about symbols that **stay in `startXMPP.ts`** (`getDefaultResource`,
`safeXmppSend`, `pendingJoins`, `joinRoom` wrapper, etc.). The
assertions are content-based (regex matches), not line-based, so they
should keep passing as long as the symbols remain in
`startXMPP.ts`. **No changes needed** — but each test will be re-run
to verify.

The one exception is the "zero bare `await xmpp.send(` calls" test
in `high-severity.test.ts:75`. The `xmpp.send` calls we're moving
(`vcardServer.publishAvatar` uses two `safeXmppSend` calls, not bare
`xmpp.send`, so this should still pass — but verify on re-run).

### `tests/medium-severity.test.ts`

The M9 test in `medium-severity.test.ts:330` tests `src/gateway.ts`,
not `startXMPP.ts`. **No changes needed.**

### `tests/critical-fixes.test.ts`, `tests/unit.test.ts`, etc.

Spot-check on the day of implementation to confirm no other test
references the moved line numbers.

---

## Imports / dependency surface

After the refactor:

### `src/slash-commands.ts` imports

```ts
import { xml } from "@xmpp/client";
import fs from "fs";
import path from "path";
import { validators } from "./security/validation.js";
import { checkRateLimit, MAX_FILE_SIZE } from "./shared/index.js";
import { log } from "./lib/logger.js";
```

It no longer needs to import `safeSend` directly because `xmpp` and
`debugLog`/`xmppLog` come through `ctx`; calls use
`await ctx.xmpp.send(...)` via a small wrapper. Actually, simpler:
we'll pass `safeXmppSend` as a member of `ctx` too. (Easier than
re-importing the helper and creating a new alias.)

### `src/vcard-server.ts` imports

```ts
import { xml } from "@xmpp/client";
import crypto from "crypto";
import fs from "fs/promises";
import { parseVCard } from "./lib/vcard-protocol.js";
import { safeSend } from "./lib/xmpp-utils.js";
import { child } from "./lib/logger.js";
```

### `src/startXMPP.ts` imports (new lines added)

```ts
import { createVCardServer } from "./vcard-server.js";
import { handleSlashCommand, type SlashCommandContext } from "./slash-commands.js";
```

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Source-grep test line anchors break | High (known) | Update tests as part of the same change (user-approved) |
| `xmppLog` debug strings lose their `"vCard"` / `"slash command"` prefixes during the move | Low | Keep the exact log lines; only the logger *name* changes from `"xmpp"` to `"vcard-server"` |
| `getDefaultNick` forward-reference on `vcard` | Medium | Hoist `const vcard = new VCard(cfg.dataDir)` to before `xmpp.on("stanza", ...)` |
| `joinedRooms`/`roomNicks`/`pendingJoins` are mutated by slash-command code (e.g. `/leave` does `joinedRooms.delete(...)`) | Medium | Pass the `Set`/`Map` references into the context — they're live references, not copies, so mutations work |
| `safeXmppSend` / `requestUploadSlot` / `uploadFileViaHTTP` defined later in `startXMPP.ts` are used by slash commands | Medium | Pass them as `ctx` members; the slash-command code is only invoked from inside the `stanza` handler, which runs after the bottom-of-function definitions are in scope |
| The `xmppClient` wrapper methods (`joinRoom`, `leaveRoom`, `sendFile`, etc.) call helpers that the slash command path also needs | Low | Most of these are independent; the only overlap is `resolveRoomJid` (passed via ctx) and `getDefaultNick` (also passed via ctx) |
| Comment cross-references in `src/lib/xmpp-connect.ts:23` say "`getDefaultResource` in `src/startXMPP.ts:60-83`" | Low | The function stays in startXMPP.ts; the line number shifts but the file path comment is still correct. Optionally refresh the line range. |

---

## Execution order

1. **Pre-flight:** run `npx tsc --noEmit` to confirm the current
   `startXMPP.ts` compiles cleanly. Record the result.
2. **Create `src/vcard-server.ts`** with the three extracted functions.
   Add `src/vcard-server.ts` to nothing — it's a new file, no callers
   yet. Verify it compiles in isolation by adding a dummy
   `export {}` and running `tsc --noEmit`.
3. **Create `src/slash-commands.ts`** with the extracted slash-command
   block. Same compile check.
4. **Modify `src/startXMPP.ts`:**
   a. Add the two new imports.
   b. Hoist `const vcard = new VCard(cfg.dataDir)` and the
      `cfg.vcard` defaults merge (535–548) to **before** the
      `xmpp.on("stanza", ...)` registration.
   c. Construct `vcardServer = createVCardServer({...})` at the
      same point.
   d. Build the `SlashCommandContext` object right before the
      `stanza` handler registration (it needs to be a stable
      reference inside the closure).
   e. Replace the 1451–2406 block with the `await handleSlashCommand(ctx, ...)`
      call shown above.
   f. Remove the now-orphaned `queryVCardFromServer`,
      `updateVCardOnServer`, `publishAvatar`, and the inline
      `getDefaultNick` definitions.
5. **Run `npx tsc --noEmit`** and fix any type errors.
6. **Update tests:**
   a. `tests/v2.1.0-groupchat-dispatch.test.ts` — change the two
      cases that point at the slash-command block (lines 2338/2345)
      to scan `src/slash-commands.ts`. Refresh the line-number
      comments for the cases that stay in `startXMPP.ts` to their
      new positions, OR convert to content-based scans.
   b. Re-run the full test suite (`./test.sh` per the repo
      convention).
7. **Manual smoke test** (operator-side, not in this PR):
   - `/help` in a DM
   - `/list` as admin
   - `/vcard get` and `/vcard set nickname foo`
   - `/vcard set avatar <url>` (XEP-0084 + vCard BINVAL update)
   - `/join roomname` + `/rooms`
   - `/leave roomname`
   - Restart the gateway and confirm `startXMPP.ts` still calls
     `crypto.randomBytes(3).toString("hex")` for the default
     resource (per `v2.1.4-muc-rejoin-conflict.test.ts`).
8. **Update `docs/CODE_REVIEW.md` / `CHANGELOG.md`** with a note
   that slash-commands and vCard-server helpers are now in
   `src/slash-commands.ts` and `src/vcard-server.ts` respectively
   (the existing `CHANGELOG.md` is 198KB — append, don't rewrite).

---

## Definition of done

- [ ] `src/startXMPP.ts` ≤ 1900 lines
- [ ] `src/slash-commands.ts` exists and contains the slash-command
      block verbatim (modulo the `ctx` parameterization)
- [ ] `src/vcard-server.ts` exists and contains `queryVCardFromServer`,
      `updateVCardOnServer`, `publishAvatar`
- [ ] `npx tsc --noEmit` exits 0
- [ ] All tests in `tests/*.test.ts` pass
- [ ] No behavioural change visible to operators (same log strings,
      same slash-command responses, same MUC join race semantics)
- [ ] `CHANGELOG.md` has an entry for the refactor
