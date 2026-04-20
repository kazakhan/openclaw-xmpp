# XMPP Extension for OpenClaw -- Deep Code Review

**Reviewed:** 2026-04-14
**Extension Version:** 1.3.1
**Files Reviewed:** 30+ source files (~8,500+ lines of TypeScript)
**Reference SDK:** OpenClaw Plugin SDK (2026.3.24-beta.2 / 2026.4.12)

---

## Executive Summary

The XMPP extension is a **feature-rich but architecturally problematic** channel plugin. It implements an impressive set of XMPP protocols (MUC, vCard/XEP-0054, File Transfer via IBB/SI/XEP-0096, HTTP Upload/XEP-0363, Whiteboard/XEP-0113, SFTP, FTP, password encryption) but suffers from **severe code duplication**, **lack of SDK convention compliance**, **excessive debug logging in production paths**, and **multiple security concerns**. The plugin appears to have been developed through extensive trial-and-error against the OpenClaw runtime API, leaving behind a trail of workaround code and abandoned approaches.

**Overall Grade: C+** -- Works in practice but needs significant refactoring for maintainability and security.

---

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [Architecture & SDK Compliance](#2-architecture--sdk-compliance)
3. [Code Quality & Duplication](#3-code-quality--duplication)
4. [Security Review](#4-security-review)
5. [Performance & Reliability](#5-performance--reliability)
6. [File-by-File Analysis](#6-file-by-file-analysis)
7. [Recommendations (Prioritized)](#7-recommendations-prioritized)

---

## 1. Critical Issues

### 1.1 God File: `index.ts` (1,270 lines)

`index.ts` is a monolithic file containing:
- Plugin registration logic
- API inspection/debugging (~75 lines of debug-only code in the hot path)
- Channel plugin definition (config, status, outbound adapters)
- **Entire `startAccount` gateway handler** (~600 lines) including:
  - Message queue management
  - Context payload building
  - **Two complete dispatch strategies** (Method 1: `dispatchReplyFromConfig`, Method 2: `dispatchReplyWithBufferedBlockDispatcher`)
  - Fallback dispatch via `ctx.*` methods
  - Fallback via `runtime.dispatchInboundMessage`
  - Activity recording as last resort
  - Inline `immediateSendText()` dispatcher definition
- Gateway RPC method registrations (joinRoom, leaveRoom, getJoinedRooms, inviteToRoom, removeContact, sendMessage)
- CLI command registration

**Impact:** Extremely difficult to test, review, or modify. Every change risks breaking unrelated functionality.

### 1.2 Duplicate File: `register.ts` (950 lines -- nearly identical to index.ts)

`src/register.ts` duplicates ~80% of `index.ts` with subtle differences:
- Different dispatch strategy: uses `runtime.channel.text()` / `runtime.channel.message()` instead of `dispatchReplyFromConfig`
- Returns `{ running, stop }` object from `startAccount` instead of using `ctx.abortSignal`
- Has its own `sendReply()` closure with a **bug** (`replyTo` variable shadowing at line 613)
- Exports its own `xmppClients`, `contactsStore`, `messageQueue`, `addToQueue`, etc.

**Impact:** Maintenance nightmare. Which file is actually used? Both are imported/exported.

### 1.3 No SDK Convention Compliance

OpenClaw's SDK expects plugins to use:

| Expected Pattern | XMPP Plugin Reality |
|---|---|
| `defineBundledChannelEntry()` | Manual object construction |
| `createChatChannelPlugin()` | Hand-rolled plugin object |
| Lazy loading via `createLazyRuntimeModule` | Eager imports or inline `require()` |
| Zod-based config schemas via `buildChannelConfigSchema()` | Raw JSON Schema only |
| `ChannelSecurityAdapter` with DM policy | **Not implemented** |
| `ChannelStatusAdapter` via `createAsyncComputedAccountStatusAdapter` | Manual `buildAccountSnapshot` |
| Proper TypeScript types | `any` used extensively |

**Impact:** The plugin may break on SDK updates, misses security infrastructure, and cannot benefit from SDK-provided helpers.

### 1.4 Excessive Debug Logging in Production Paths

Throughout the codebase, especially in `index.ts:startAccount`:

```
// Examples from the message handler (lines 673-1041):
console.log("Attempting to forward via runtime.channel methods");
console.log(`Fallback for ${options?.type} message from ${from}`);
console.log("Trying simple recordInboundSession as fallback");
console.log("storePath resolved to:", storePath);
console.log("=== STARTING DISPATCH ===");
console.log("Time:", new Date().toISOString());
console.log("🎯 METHOD 1: dispatchReplyFromConfig (fast path)");
console.log("🚀 IMMEDIATE sendText CALLED! Time:", new Date().toISOString());
// ... dozens more per message
```

**Every inbound message generates 40-80 console.log statements.** In groupchats with high traffic, this is a **performance disaster** and potentially leaks sensitive data (message contents, JIDs, timestamps).

### 1.5 "Shotgun" Dispatch Strategy

The message dispatch code tries **6 different methods** in sequence to deliver each inbound message:

1. `runtime.channel.reply.dispatchReplyFromConfig()` (Method 1)
2. `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher()` (Method 2)
3. `ctx.receiveText()` / `ctx.receiveMessage()` / `ctx.inbound()` / `ctx.dispatch()` (loop)
4. `runtime.dispatchInboundMessage()`
5. `runtime.channel.activity.record()` (last resort, doesn't even count as success)

This indicates the developer did not know which API to use and tried everything. This pattern exists in **both** `index.ts` and `register.ts` with different method orderings.

---

## 2. Architecture & SDK Compliance

### 2.1 Registration Flow Issues

**Current approach (both files):**
```typescript
export function register(api: any) {
  // 75 lines of API inspection debugging
  // Manual plugin object construction
  api.registerChannel({ plugin: xmppChannelPlugin });
}
```

**Expected SDK approach (from telegram/zalouser reference implementations):**
```typescript
export default defineBundledChannelEntry({
  id: "xmpp",
  name: "XMPP",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin.js", exportName: "xmppPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-api.js", exportName: "setXmppRuntime" },
});
```

### 2.2 Missing Security Adapter

Every production-grade channel plugin in OpenClaw implements `ChannelSecurityAdapter`:

```typescript
// What's expected (from zalouser/telegram):
security: {
  dm: {
    channelKey: "xmpp",
    resolvePolicy: (account) => account.config.dmPolicy,
    resolveAllowFrom: (account) => account.config.allowFrom,
    normalizeEntry: (raw) => raw.replace(/^(xmpp|jabber):/i, ""),
  },
  collectWarnings: collectXmppSecurityWarnings,
  collectAuditFindings: collectXmppSecurityAuditFindings,
}
```

**The XMPP plugin has NO security adapter.** This means:
- No DM policy enforcement (anyone can message the bot)
- No allowlist checking through SDK infrastructure
- No security audit findings
- No trusted sender verification for privileged actions

### 2.3 Config Schema Issues

The plugin defines config schema in **three places**:
1. `openclaw.plugin.json` (JSON Schema format)
2. `index.ts` configSchema property (inline object)
3. `register.ts` configSchema property (inline object, slightly different)

None use the SDK's `buildChannelConfigSchema()` or `buildCatchallMultiAccountChannelSchema()`. There's no Zod-based runtime validation.

### 2.4 Missing Features vs. SDK Expectations

| Feature | SDK Provides | XMPP Plugin |
|---------|-------------|-------------|
| Debounce inbound messages | `createInboundDebouncer` | Not implemented |
| Mention detection | `buildMentionRegexes` | Not implemented |
| Threading support | `ChannelThreadingAdapter` | Explicitly disabled |
| Reaction support | `ChannelMessageActionAdapter` | Explicitly disabled |
| Poll support | `sendPoll` | Explicitly disabled |
| Streaming adapter | `ChannelStreamingAdapter` | Not implemented |
| Health probe | `probeAccount` | Not implemented |
| Setup wizard | `ChannelSetupWizard` | Not implemented |
| Secret contract | `ChannelSecretsAdapter` | Not implemented |

---

## 3. Code Quality & Duplication

### 3.1 Duplication Inventory

| Code Block | Duplicated In | Approx Lines Each |
|-----------|--------------|-------------------|
| Plugin registration + API inspection | `index.ts`, `register.ts` | ~180 |
| `sendText()` implementation | `index.ts:282-332`, `register.ts:263-305` | ~50 |
| `sendMedia()` implementation | `index.ts:333-409`, `register.ts:306-371` | ~65 |
| `startAccount()` handler | `index.ts:412-1083`, `register.ts:374-790` | ~600+ |
| Gateway RPC methods (5 methods) | `index.ts:1112-1237`, `register.ts:829-922` | ~120 |
| vCard XML parsing | `startXMPP.ts:68-176`, `vcard-cli.ts:134-331` | ~140 |
| vCard XML building | `startXMPP.ts:254-266`, `vcard-cli.ts:333-511` | ~180 |
| XMPP connection setup | `startXMPP.ts:50-56`, `vcard-cli.ts:517-522`, `whiteboard-cli.ts:58-63`, `sftp.ts:58-63`, `ftp.ts:57-62` | ~10 x5 |
| Config loading with decryption | `sftp.ts:19-46`, `ftp.ts:20-48`, `vcard-cli.ts:88-116`, `whiteboard-cli.ts:19-52` | ~30 x4 |
| Upload slot request | `startXMPP.ts:2101-2141`, `fileTransfer.ts:18-61`, `vcard-cli.ts:571-648` | ~40-80 x3 |
| HTTP file upload | `startXMPP.ts`, `fileTransfer.ts:63-94`, `vcard-cli.ts:650-669` | ~20-30 x3 |
| Sanitization patterns | `shared/index.ts:6-11`, `security/logging.ts:1-8`, `register.ts:85-95` | ~10 x3 |
| Debug logger creation | `shared/index.ts:32-44`, `logger.ts:36-66`, `utils.ts:53-64`, `register.ts:71-80` | ~15 x4 |
| Rate limiting | `shared/index.ts:46-76` (only correct impl) | -- |
| Roster management | `roster.ts`, `commands.ts:8-21` (in-memory, incompatible) | ~20 x2 |
| Contact fallback instantiation | `commands.ts:258-295`, `commands.ts:322-343`, `commands.ts:398-423` | ~35 x3 |

**Estimated total duplicated code: ~2,500+ lines (roughly 30% of the codebase)**

### 3.2 Type Safety

The codebase uses `any` extensively:

```typescript
// Count of 'any' usage by file:
// index.ts:        ~45 occurrences
// register.ts:      ~35 occurrences
// startXMPP.ts:     ~25 occurrences
// commands.ts:      ~20 occurrences
// types.ts:         ~3 occurrences (interface definitions)
// Total:            ~128+ explicit 'any' types
```

Key untyped areas:
- `pluginRuntime: any = null` (module-level global)
- `xmppClients: new Map<string, any>()` (no XmppClient interface enforcement)
- All XMPP stanza handling (`stanza: any`)
- All API objects (`api: any`, `ctx: any`)
- Gateway context (`ctx.cfg`, `ctx.account`, etc.)

### 3.3 Deprecated API Usage

```typescript
// index.ts:55 - uses deprecated String.substr()
id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
// register.ts:29 - same issue
```

`String.substr()` is deprecated and should be replaced with `substring()`.

### 3.4 Dead Code / Unused Files

| File | Status |
|------|--------|
| `state.ts` | Exports a `state` object that is never imported anywhere |
| `roster.ts` | Uses `fs-extra` (different from other files), manages in-memory roster that's separate from `contacts.ts` |
| `utils.ts` | Contains utility functions that duplicate `shared/index.ts` (e.g., `downloadFile`, `processInboundFiles`) |
| `logger.ts` | Creates loggers that are never used (code uses `debugLog` from shared and `secureLog` from security/logging) |
| `cli-debug.log` | Checkpoint file committed to repo (should be gitignored) |
| `nul` | Windows NUL device file in root directory |
| `index.ts.old`, `index.ts.orig.ts` | Backup files committed to repo |

---

## 4. Security Review

### 4.1 CRITICAL: Auto-Accept All MUC Invites

**Location:** `src/startXMPP.ts:791-807`, `src/startXMPP.ts:831-850`

```typescript
// Auto-accept invite by joining the room
const presence = xml("presence", { to: `${room}/${getDefaultNick()}` },
  xml("x", { xmlns: "http://jabber.org/protocol/muc" }, ...)
);
await xmpp.send(presence);
```

**Any XMPP user can send a MUC invite and the bot will automatically join.** This allows:
- Room flooding (bot joins spam rooms)
- Information leakage (bot presence reveals it's active)
- Resource exhaustion (unlimited room joins)
- Reputation damage (bot appears in inappropriate rooms)

**Fix required:** Admin approval or allowlist for auto-accept.

### 4.2 HIGH: Plaintext FTP Authentication

**Location:** `src/ftp.ts:57-63`

```typescript
await client.access({
  host: config.domain,
  port: ftpPort,
  user: username,
  password: config.password,
  secure: false  // <-- PLAINTEXT
});
```

FTP sends credentials in plaintext over the network. Same concern applies to SFTP (though SFTP protocol itself is encrypted, the implementation does not verify host keys).

### 4.3 MEDIUM: Weak Default Encryption Salt

**Location:** `src/security/encryption.ts:9`

```typescript
const DEFAULT_SALT = 'xmpp-plugin-salt-v1';
```

If no salt file can be created on disk, the code falls back to a **hardcoded static salt**. This means all installations using the fallback have the same key derivation salt, significantly reducing encryption strength. An attacker who knows the default salt can precompute rainbow tables.

### 4.4 MEDIUM: Password Logging Risk

Despite sanitization efforts, multiple locations can leak passwords:

1. **Encryption error messages**: `throw new Error('Failed to decrypt XMPP password')` followed by stack traces that may include config objects
2. **Debug logs in startXMPP**: `debugLog(`XMPP config: jid=${cfg?.jid}, domain=${cfg?.domain}`)` -- if config ever included password (it shouldn't currently, but fragile pattern)
3. **Console.log in vCard operations**: Full stanza XML is logged including potentially sensitive data
4. **Gateway RPC errors**: Error responses may include stack traces with captured closures

### 4.5 MEDIUM: No Input Validation on Some Paths

- **JID validation** uses email regex (`validators.isValidJid`) which is insufficient for full XMPP JID compliance (doesn't handle internationalized domain names, IPv6 addresses like `user@[::1]`, or resource parts properly)
- **Groupchat command arguments** are not validated beyond basic existence checks -- argument injection possible through crafted slash commands
- **SFTP/FTP paths** don't validate for path traversal on the remote side
- **vCard field values** are written to the server without length limits (could overflow server-side field limits)

### 4.6 LOW: IBB File Transfer Memory Accumulation

**Location:** `src/startXMPP.ts:360`

```typescript
const ibbSessions = new Map<string, { sid, from, filename, size, data: Buffer, received, createdAt }>();
```

Each active IBB session holds the **entire file in memory** as a Buffer. With `MAX_FILE_SIZE = 10MB` and concurrent sessions, this could cause significant memory pressure. An attacker could open multiple simultaneous IBB sessions to exhaust memory. The cleanup interval (1 minute) helps but doesn't prevent burst attacks.

### 4.7 INFO: Missing Security Headers in HTTP Upload

**Location:** `src/fileTransfer.ts:70-73`, `src/vcard-cli.ts:660-663`

```typescript
const fetchHeaders: Record<string, string> = {
  'Content-Type': 'application/octet-stream',
  'Content-Length': fileSize.toString(),
};
// No Origin header, no CSRF protection considerations
```

When uploading files to external HTTP servers, no origin or referer restrictions are set.

---

## 5. Performance & Reliability

### 5.1 Synchronous File I/O in Hot Paths

Multiple locations use synchronous file operations that block the Node.js event loop:

```typescript
// VCard class (src/vcard.ts:21):
private loadVCard(): VCardData {
  if (!fs.existsSync(this.vcardFile)) { ... }
  return JSON.parse(fs.readFileSync(this.vcardFile, "utf8")); // SYNC - blocks event loop
}

// JsonStore (src/jsonStore.ts:41):
private load(): T {
  return JSON.parse(fs.readFileSync(this.filePath, "utf8")); // SYNC
}

// MessageStore (src/messageStore.ts:94):
return JSON.parse(fs.readFileSync(filePath, 'utf8')); // SYNC

// Debug logging (src/shared/index.ts:40):
fs.appendFileSync(logFile, line); // SYNC on EVERY debug log call
```

**Every debug log call does synchronous file append.** With 40-80 log lines per inbound message, this blocks the event loop repeatedly during message processing. Under high message volume, this creates significant latency.

### 5.2 No Connection Pooling / Reconnection Logic

The XMPP client (`src/startXMPP.ts`) handles:
- ✅ Initial connection
- ✅ Error events (logged)
- ✅ Offline events (sets flag)
- ❌ **Automatic reconnection with exponential backoff**
- ❌ **Connection health checks / keepalive pings** (XMPP has no built-in ping; should implement XEP-0199 or whitespace keepalive)
- ❌ **Graceful shutdown on SIGTERM/SIGINT** (process signal handlers not registered)

If the connection drops due to network issues, server restart, or idle timeout, the bot stays offline until manually restarted or the gateway is restarted.

### 5.3 Message Queue Concerns

```typescript
// index.ts:41-42
const messageQueue: QueuedMessage[] = [];
const messageQueueMaxSize = Config.MESSAGE_QUEUE_MAX_SIZE; // 100
```

Issues:
- **In-memory only** -- all queued messages lost on restart/crash/gateway redeploy
- **No persistence** to disk or database for recovery
- **No consumer loop** -- relies entirely on external polling via CLI (`openclaw xmpp poll`)
- **Size truncation** uses `messageQueue.length = messageQueueMaxSize` which truncates the array in place (drops newest messages -- LIFO behavior may be unintended; FIFO would be more appropriate for a queue)
- **No deduplication** -- same message could be queued twice if dispatched through multiple paths

### 5.4 Unbounded Growth Risks

| Data Structure | Location | Growth Pattern | Cleanup? |
|---------------|----------|----------------|----------|
| `rateLimitMap` | `src/shared/index.ts:54` | Per-JID rate limit entries accumulate forever | **Never cleaned** -- grows monotonically |
| `ibbSessions` | `src/startXMPP.ts:360` | Active file transfer sessions | Cleaned every 60s (acceptable) |
| `joinedRooms` / `roomNicks` | `src/startXMPP.ts:377-378` | Room tracking on join | Only removed on leave/kick/eventual unavailability |
| `messageQueue` | `src/index.ts:41` | Undelivered messages | 24h cleanup but only when explicitly called |
| Console output buffer | All files | Debug log text fills process stdout buffer | None (OS-dependent) |

### 5.5 Race Conditions

1. **`pluginRegistered` flag** (`index.ts:20-21`) -- No mutex protection if `register()` were called concurrently (unlikely but possible during hot-reload)
2. **JsonStore read-modify-write** (`src/jsonStore.ts:60-70`) -- `get()` returns a shallow clone, then `set()` does Object.assign + save. Two concurrent writers could lose updates.
3. **MessageStore file operations** (`src/messageStore.ts:120-170`) -- Load-modify-save cycle without file locking. Concurrent message processing could corrupt the JSON file.
4. **IBB session map** (`src/startXMPP.ts:360`) -- Multiple stanzas for the same session could be processed concurrently by the async handler

---

## 6. File-by-File Analysis

### `index.ts` (1,270 lines) -- PRIMARY ENTRY POINT
- **Grade: D+**
- Main plugin entry point with god-file anti-pattern
- Contains entire gateway lifecycle inline when it should delegate to modules
- Excessive debug logging (remove ~60% of console.log calls)
- The dispatch strategy shows uncertainty about correct API usage (tries 6 methods sequentially)
- Mixes concerns: registration, configuration, status, outbound messaging, gateway lifecycle, RPC, CLI
- **Recommendation:** Split into proper module structure following SDK patterns. Keep as thin entry point only.

### `src/register.ts` (950 lines) -- DUPLICATE OF INDEX.TS
- **Grade: F**
- Near-exact copy of index.ts with different dispatch approach
- Has a variable shadowing bug in `sendReply` closure (line 613: `_replyTo` parameter shadows outer `replyTo` variable from enclosing scope)
- Returns different structure from startAccount (object vs Promise<void>)
- Exports its own copies of all module-level state (xmppClients, contactsStore, messageQueue, etc.)
- **Recommendation:** Delete entirely. Consolidate all logic into index.ts using proper module decomposition.

### `src/startXMPP.ts` (2,000+ lines) -- XMPP PROTOCOL ENGINE
- **Grade: B-**
- Comprehensive XMPP protocol implementation covering:
  - MUC (Multi-User Chat) with auto-join, room config, subject tracking
  - vCard (XEP-0054) with full CRUD operations, server query/update
  - SI File Transfer (XEP-0096) with IBB (XEP-0023) fallback
  - HTTP Upload (XEP-0363) with service discovery
  - Service Discovery (XEP-0030) with feature advertisement
  - Whiteboard (XEP-0113 / legacy SWB) parsing and forwarding
  - Presence/Subscription handling with auto-approve for whitelisted contacts
  - OOB data (XEP-0066) for file attachments
  - Room configuration form auto-submission
  - jabber:x:conference invite handling (both XML and body-parsed)
  - Slash command processing (~400 lines inline)
- Too many responsibilities -- should be split into protocol-specific handler modules
- Debug logging throughout stanza handlers (logs raw XML for every message received)
- Slash command switch statement spans ~350 lines (lines 1109-1970)
- **Recommendation:** Extract protocol handlers into separate files. Move slash commands to own module. Remove production debug logging.

### `src/config.ts` (23 lines) -- CONFIGURATION CONSTANTS
- **Grade: A**
- Simple configuration constants with clear naming
- Well-typed with exported type alias
- No issues found
- **Recommendation:** None needed. Good as-is.

### `src/types.ts` (209 lines) -- TYPE DEFINITIONS
- **Grade: B+**
- Comprehensive type definitions covering all data structures
- Some types duplicated between here and inline definitions in other files (e.g., `QueuedMessage` defined both here AND inline in index.ts AND register.ts)
- `WhiteboardData` type defined in both types.ts and whiteboard.ts
- **Recommendation:** Make this the single source of truth. Import from here everywhere. Remove inline duplicates.

### `src/contacts.ts` (116 lines) -- CONTACT MANAGEMENT
- **Grade: B**
- Simple contact/admin whitelist management using JsonStore persistence
- Bare JID normalization on every operation (good)
- Missing: deduplication validation (add same contact twice), JID format validation on add, case normalization for JIDs
- **Recommendation:** Add input validation. Consider normalizing JIDs to lowercase consistently.

### `src/vcard.ts` (378 lines) -- VCARD DATA MODEL
- **Grade: B**
- Complete vCard data model (XEP-0054) with getter/setter for all fields
- Every setter immediately persists to disk (performance concern for batch operations like importing a full vCard)
- No validation on field values (e.g., email format check, phone number format, URL validity, birthday date format)
- Photo handling supports both EXTVAL (URL) and BINLINE (base64) -- good
- **Recommendation:** Batch writes for multi-field updates. Add field validation. Consider async save.

### `src/messageStore.ts` (246 lines) -- MESSAGE PERSISTENCE
- **Grade: C+**
- File-based message persistence organized by date (groupchat) or contact (direct)
- Uses synchronous I/O throughout (load + modify + save cycle)
- **Bug in `getDirectChatJIDs()` (line 196-203):** Replaces `_` with `.` to reverse the sanitization, but since `_` is also the sanitization replacement character, JIDs containing original underscores cannot be correctly round-tripped. Example: `user_name@domain.com` -> stored as `user.name@domain.com` -> listed as `user.name@domain.com` (correct) BUT `user-name@domain.com` -> stored as `user-name@domain.com` (unchanged) -> listed as `user-name@domain.com` (correct). Actually the real bug is: `user.name@host.com` -> sanitized to `user_name@host_com` (dots also replaced!) -> reversal produces `user.name.host.com` (WRONG).
- No indexing or search capability
- Message rotation uses shift() (drops oldest) which is correct for FIFO
- **Recommendation:** Fix the sanitize/round-trip bug. Use async I/O. Add file locking for concurrency safety.

### `src/commands.ts` (927 lines) -- CLI COMMAND HANDLER
- **Grade: C**
- Very long file with many sub-commands (msg, status, roster, nick, join, rooms, leave, poll, clear, add, remove, invite, contacts, queue, vcard, sftp, encrypt-password)
- Repeated Contacts instantiation pattern (same ~30-line block duplicated 3 times at lines 258-295, 322-343, 398-423)
- Mixed concerns: CLI commands, gateway RPC routing, roster management, contact management, SFTP operations, encryption
- Imports `@xmpp/client` directly at module level (heavy dependency for what should be a lightweight CLI module)
- Gateway RPC spawning via child_process is platform-aware (handles Windows cmd.exe) -- good
- **Recommendation:** Extract contact fallback into utility function. Lazy-load heavy imports. Split into sub-modules by concern.

### `src/gateway-client.ts` (154 lines) -- GATEWAY RPC CLIENT
- **Grade: B-**
- Spawns child processes for gateway communication (openclaw gateway call ...)
- Platform-specific handling (Windows cmd.exe vs Unix direct exec)
- Fragile JSON extraction from stdout using regex (looks for last `{...}` block)
- No timeout on child process execution (could hang indefinitely)
- Falls back to `resolve(null)` on any error (silently swallows failures)
- **Recommendation:** Add timeout. Use structured output format (e.g., `--json` flag). Better error propagation.

### `src/fileTransfer.ts` (144 lines) -- FILE TRANSFER HELPERS
- **Grade: B**
- Clean abstraction over XEP-0363 HTTP Upload protocol
- Handles upload slot request, HTTP PUT, and OOB message composition
- Duplicated in startXMPP.ts and vcard-cli.ts (each with slight variations)
- Proper error propagation throughout
- **Recommendation:** Make this the single source of truth. Import from here in startXMPP and vcard-cli.

### `src/jsonStore.ts` (81 lines) -- GENERIC JSON STORE
- **Grade: A-**
- Clean generic JSON store with load/save hooks and defaults
- Good defensive coding (catches parse errors, returns defaults)
- Shallow clone on get() prevents external mutation of internal state
- set() uses Object.assign for merges (reasonable for simple objects)
- **Recommendation:** Consider async version. Add file locking for concurrent access safety.

### `src/security/validation.ts` (61 lines) -- INPUT VALIDATION
- **Grade: B+**
- Good collection of input validation functions
- JID validation uses email regex (acceptable for basic cases, not fully RFC-compliant for XMPP)
- Filename sanitization is thorough (removes path separators, limits length)
- Path traversal check uses `path.resolve()` comparison (correct approach)
- URL validation allows http/https only (good)
- **Recommendation:** Strengthen JID validation to handle edge cases (IPv6, internationalized domains).

### `src/security/encryption.ts` (241 lines) -- PASSWORD ENCRYPTION
- **Grade: B-**
- AES-256-GCM with PBKDF2-SHA512 (strong algorithm choices)
- 100,000 iterations (current best practice as of 2024-2026)
- Random IV per encryption (correct)
- Auth tag verification on decryption (prevents tampering)
- **Static default salt is the main weakness** (see Security section 4.3)
- Key generation creates new key if none exists (correct behavior, but surprising)
- Encryption format: `IV_HEX + AUTHTAG_HEX + CIPHERTEXT_HEX` prefixed with `ENC:` (clear, parseable)
- **Recommendation:** Remove DEFAULT_SALT fallback. Require salt file or fail loudly. Document key management.

### `src/security/logging.ts` (53 lines) -- SECURE LOGGING UTILITIES
- **Grade: B+**
- Good sensitive data redaction patterns (passwords, credentials, API keys, auth tokens)
- Both string-level and object-level sanitization
- Redacts keys containing "password", "credential", "secret", "key" (case-insensitive)
- Duplicates sanitization regex patterns from shared/index.ts
- **Recommendation:** Consolidate into single sanitization module. Import from one place.

### `src/shared/index.ts` (170 lines) -- SHARED UTILITIES
- **Grade: B**
- Centralizes: debug logging with sanitization, rate limiting, file download with validation, inbound file processing
- Rate limiting is per-JID with sliding window (correct approach)
- Download includes URL validation, filename sanitization, path traversal protection, size limits
- **Rate limit map never gets cleaned up** (unbounded growth)
- Debug logging appends synchronously to file (performance concern)
- **Recommendation:** Add TTL eviction for rate limit map. Make debug logging async or batched.

### `src/whiteboard.ts` (351 lines) -- WHITEBOARD PROTOCOL (XEP-0113)
- **Grade: B**
- Clean SVG whiteboard protocol implementation (legacy jabber:x:swb namespace)
- Well-separated: parsing, building, sending, CLI command handling
- Supports paths, moves, and deletes with proper typing
- Standalone protocol handler (well-factored, minimal dependencies)
- **Recommendation:** None significant. Good module structure.

### `src/whiteboard-cli.ts` (317 lines) -- WHITEBOARD CLI COMMANDS
- **Grade: B-**
- SXE-based (XEP-0114) whiteboard CLI commands with SVG path support
- Has its own XMPP connection setup (duplicates pattern from 4 other files)
- Good SVG path parsing with coordinate tracking
- Session ID generation is reasonable
- **Recommendation:** Share connection setup utility. Otherwise fine.

### `src/vcard-cli.ts` (1,147 lines) -- VCARD CLI OPERATIONS
- **Grade: C**
- Very large file for CLI vCard operations (get, set, name, phone, email, address, org, avatar)
- **Duplicates ALL vCard parsing from startXMPP.ts** (~140 lines of parseVCard equivalent)
- **Duplicates ALL vCard building** (~180 lines of buildVCardStanza equivalent)
- **Duplicates upload slot request** (~80 lines)
- **Duplicates HTTP file upload** (~20 lines)
- **Duplicates XMPP connection setup** (~15 lines)
- Each operation creates a NEW XMPP connection, performs action, then disconnects (expensive for batch operations)
- Avatar upload flow is well-implemented (XEP-0084 PEP publish + vCard update)
- **Recommendation:** This is the worst offender for duplication. Refactor to import from startXMPP.ts (extract shared protocol functions) and fileTransfer.ts. Should reduce to ~300 lines.

### `src/sftp.ts` (220 lines) -- SFTP CLIENT
- **Grade: C**
- SSH2-based SFTP file operations (upload, download, list, delete)
- Loads XMPP config (including decrypted password) for authentication
- **No host key verification** (vulnerable to man-in-the-middle attacks)
- Connection-per-operation (no connection pooling -- expensive handshake each time)
- Uses XMPP JID localpart as SFTP username (convenient coupling)
- **Recommendation:** Add host key verification. Implement connection pooling or reuse. Consider async/await patterns consistently.

### `src/ftp.ts` (180 lines) -- FTP CLIENT
- **Grade: C+**
- Basic FTP client wrapper using basic-ftp library
- Same credential loading pattern as SFTP
- **`secure: false` sends credentials in plaintext** -- major security issue for production use
- Connection-per-operation (no pooling)
- **Recommendation:** Either enforce FTPS (explicit TLS) or remove FTP support entirely. Plaintext FTP has no place in modern infrastructure.

### `src/state.ts` (7 lines) -- UNUSED STATE MODULE
- **Grade: F**
- Exports a `state` object with `api`, `xmpp`, and `agents` fields
- **Never imported or used by any other file in the project**
- Appears to be an early experiment with centralized state that was abandoned
- **Recommendation:** DELETE. Dead code.

### `src/roster.ts` (19 lines) -- INCOMPATIBLE ROSTER MODULE
- **Grade: D**
- Uses `fs-extra` package (the ONLY file in the entire project that uses it)
- Manages in-memory roster (nicknames only) separate from contacts.ts
- Commands.ts has its OWN duplicate copy of this (lines 8-21)
- Three incompatible roster/contact tracking systems exist: roster.ts (in-memory, fs-extra), commands.ts (in-memory, plain fs), contacts.ts (persistent, JsonStore)
- **Recommendation:** DELETE. Consolidate all roster functionality into contacts.ts.

### `src/utils.ts` (102 lines) -- DEPRECATED UTILITY FUNCTIONS
- **Grade: D**
- Functions here are superseded by shared/index.ts:
  - `getDefaultResource()` → exists in utils.ts AND startXMPP.ts (duplicated 3 times total)
  - `getDefaultNick()` → exists in utils.ts AND startXMPP.ts
  - `resolveRoomJid()` → exists in utils.ts AND startXMPP.ts
  - `stripResource()` → only here, but trivial one-liner
  - `downloadFile()` → superseded by shared/index.ts version (which adds validation)
  - `processInboundFiles()` → superseded by shared/index.ts version
  - `isGroupChatJid()` → only here, trivial
  - `parseMessageBody()` → only here, trivial
  - `parseMediaUrls()` → only here, trivial
  - `createDebugLogger()` → superseded by logger.ts AND shared/index.ts
- **Nothing imports from this file** (confirmed dead code)
- **Recommendation:** DELETE. All useful functions exist in better form elsewhere.

### `src/logger.ts` (79 lines) -- UNUSED LOGGER MODULE
- **Grade: D**
- Creates Logger instances with level filtering (debug/info/warn/error)
- Writes to cli-debug.log file
- **Nothing imports from this file** -- code uses `debugLog` from shared/index.ts and `secureLog` from security/logging.ts
- Duplicates logging functionality from two other modules
- **Recommendation:** DELETE. Unused dead code.

### `src/cli-encrypt.ts` (20 lines) -- ENCRYPTION CLI TOOL
- **Grade: C**
- Standalone script for encrypting passwords in config files
- Argument parsing is fragile (positional args without proper flag handling)
- Calls `updateConfigWithEncryptedPassword` which reads/writes config directly
- Useful utility but minimal error handling
- **Recommendation:** Keep but improve argument parsing. Add --help flag. Add confirmation prompt before overwriting.

---

## 7. Recommendations (Prioritized)

### PRIORITY 1: Security (Do First)

These items address real vulnerabilities that could lead to data breaches, unauthorized access, or service abuse.

#### 1.1 Implement ChannelSecurityAdapter

Create `src/security/adapter.ts`:

```typescript
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk"; // or build manual adapter

export const xmppSecurityAdapter = {
  dm: {
    channelKey: "xmpp",
    resolvePolicy: (account) => account.config.dmPolicy ?? "allowlist",
    resolveAllowFrom: (account) => account.config.allowFrom ?? [],
    normalizeEntry: (raw: string) =>
      raw.replace(/^(xmpp|jabber):/i, "").trim(),
  },
  collectWarnings(ctx) {
    const warnings = [];
    // Check for plaintext passwords
    if (ctx.account?.config?.password && !ctx.account.config.password.startsWith("ENC:")) {
      warnings.push({
        checkId: "channels.xmpp.plaintext_password",
        severity: "warn" as const,
        title: "XMPP account stores plaintext password",
        detail: "Password should be encrypted via: openclaw xmpp encrypt-password",
        remediation: "Run: openclaw xmpp encrypt-password",
      });
    }
    return warnings;
  },
  collectAuditFindings(ctx) {
    const findings = [];
    // Audit findings here
    return findings;
  },
};
```

Then wire it into the plugin definition in the channel plugin object.

#### 1.2 Gate Auto-Accept MUC Invites

In `src/startXMPP.ts`, replace the auto-accept logic (lines 791-807 and 831-850):

```typescript
// BEFORE (current -- auto-accepts all):
await xmpp.send(presence);
joinedRooms.add(room);

// AFTER (admin-only or configured allowlist):
const inviterBareJid = inviter.split('/')[0];
if (contacts.isAdmin(inviterBareJid) || config.autoJoinRooms?.includes(room)) {
  await xmpp.send(presence);
  joinedRooms.add(room);
  console.log(`✅ Accepted invite from admin/allowed user: ${inviter}`);
} else {
  console.log(`🚫 Rejected MUC invite from non-admin: ${inviter}`);
  // Optionally send decline message
}
```

Also add `autoJoinRooms` to the config schema.

#### 1.3 Remove Hardcoded Default Salt

In `src/security/encryption.ts`:

```typescript
// BEFORE:
const DEFAULT_SALT = 'xmpp-plugin-salt-v1';
function getInstallationSalt(dataDir?: string): string {
  // ...
  return DEFAULT_SALT;  // <-- WEAK FALLBACK
}

// AFTER:
function getInstallationSalt(dataDir?: string): string {
  if (!dataDir) {
    throw new Error(
      "dataDir is required for encryption. " +
      "Ensure xmpp.accounts.<id>.dataDir is configured."
    );
  }
  // ... existing logic ...
  // NO fallback to static salt
  throw new Error(
    `Failed to create/install salt at ${saltFilePath}. ` +
    `Check directory permissions.`
  );
}
```

This forces proper initialization and fails loudly rather than silently degrading security.

#### 1.4 Secure or Remove FTP

Option A -- Remove FTP (recommended):
- Delete `src/ftp.ts`
- Remove FTP CLI commands from `src/commands.ts`
- Users can use SFTP instead

Option B -- Enforce FTPS:
```typescript
// In src/ftp.ts, change:
secure: false
// To:
secure: true,  // Explicit FTPS
secureOptions: { rejectUnauthorized: false },  // Or true for production
```

#### 1.5 Add SFTP Host Key Verification

In `src/sftp.ts`, add known hosts file support:

```typescript
import { readFileSync } from "fs";
import { NodeSSH } from "ssh2"; // or similar

const getKnownHostsPath = () =>
  path.join(process.env.HOME || "", ".ssh", "known_hosts");

// In connectSftp():
const conn = new Client();
// Add host key verification using ssh2's built-in support
// or hash checking against known_hosts file
```

#### 1.6 Add Input Size Limits to Slash Commands

In `src/startXMPP.ts` slash command handler, add bounds checking:

```typescript
// At the start of the message handler, after extracting body:
if (body && body.length > Config.MAX_MESSAGE_BODY_SIZE) {  // e.g., 64KB
  console.log(`[SECURITY] Message too large: ${body.length} bytes`);
  return;  // Drop silently or send error
}
```

Add `MAX_MESSAGE_BODY_SIZE: 65536` to `src/config.ts`.

### PRIORITY 2: Architecture (Do Second)

These changes establish a maintainable foundation for future development.

#### 2.1 Delete Dead Files

Remove these files in one commit:

```bash
rm src/state.ts          # Unused, never imported
rm src/roster.ts         # Incompatible duplicate, superseded by contacts.ts
rm src/utils.ts           # Dead code, all functions exist in shared/
rm src/logger.ts         # Dead code, nothing imports it
rm cli-debug.log         # Runtime artifact, shouldn't be in repo
rm nul                  # Windows artifact, shouldn't be in repo
rm index.ts.old          # Backup file
rm index.ts.orig.ts      # Backup file
```

Update `.gitignore` to include:
```
*.log
cli-debug.log
nul
data/
node_modules/
*.old
*.orig
*.bak
```

#### 2.2 Adopt SDK Entry Point Pattern

Restructure `index.ts` to use `defineBundledChannelEntry()`:

**New `index.ts` (~50 lines):**
```typescript
import { defineBundledChannelEntry } from "openclaw/plugin-sdk";
import { xmppPlugin } from "./src/channel-plugin.js";
import { setXmppRuntime } from "./src/runtime-api.js";

export default defineBundledChannelEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP/Jabber messaging channel plugin with file transfer and whiteboard support",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./src/channel-plugin.js", exportName: "xmppPlugin" },
  secrets: { specifier: "./src/secret-contract.js", exportName: "channelSecrets" },
  runtime: { specifier: "./src/runtime-api.js", exportName: "setXmppRuntime" },
});
```

**New `src/channel-plugin.ts` (~200 lines):**
```typescript
import { createChatChannelPlugin } from "openclaw/plugin-sdk";
import { startXmpp } from "./startXMPP.js";
import { buildXmppConfigSchema } from "./config-schema.js";
// ... imports ...

export const xmppPlugin = createChatChannelPlugin({
  base: {
    id: "xmpp",
    meta: { /* ... */ },
    capabilities: { /* ... */ },
    configSchema: buildXmppConfigSchema(),
    config: { /* account CRUD */ },
    security: xmppSecurityAdapter,  // from priority 1.1
    // ...
  },
  security: xmppSecurityAdapter,
  pairing: { /* ... */ },
  outbound: {
    deliveryMode: "gateway",
    sendText: xmppSendText,       // extracted from index.ts
    sendMedia: xmppSendMedia,      // extracted from index.ts
    // ...
  },
  gateway: {
    startAccount: xmppStartAccount,  // extracted from index.ts
    stopAccount: xmppStopAccount,    // extracted from index.ts
  },
});
```

#### 2.3 Eliminate Duplication -- Module Map

Create these shared modules and update all consumers:

```
src/
  protocol/
    vcard-parse.ts        # Shared by startXMPP.ts, vcard-cli.ts
    vcard-build.ts        # Shared by startXMPP.ts, vcard-cli.ts
    xmpp-connect.ts       # Shared by startXMPP.ts, vcard-cli.ts, whiteboard-cli.ts, sftp.ts, ftp.ts
    file-upload.ts        # Shared by startXMPP.ts, fileTransfer.ts, vcard-cli.ts
  config/
    config-loader.ts      # Shared by sftp.ts, ftp.ts, vcard-cli.ts, whiteboard-cli.ts
  security/
    sanitization.ts      # Single source for all redaction/sanitization patterns
  lib/
    contact-fallback.ts  # Shared Contacts instantiation for commands.ts (3 uses -> 1)
```

**Expected reduction:** ~2,500 lines of duplicated code eliminated.

#### 2.4 Replace `any` Types

Minimum set of interfaces to extract (add to `src/types.ts` or separate files):

```typescript
// src/types/runtime.ts
interface PluginRuntime {
  channel: {
    session: { recordInboundSession(...): Promise<void>; resolveStorePath(...): string; [key: string]: any };
    reply: { dispatchReplyFromConfig(...): Promise<any>; dispatchReplyWithBufferedBlockDispatcher(...): Promise<any>; [key: string]: any };
    text?: (session: string, params: any) => Promise<any>;
    message?: (session: string, params: any) => Promise<any>;
    activity: { record(...): void }; [key: string]: any;
    [key: string]: any;
  };
  dispatchInboundMessage?(params: any): Promise<void>;
  [key: string]: any;
}

// src/types/xmpp-client.ts
interface XmppClientInstance {
  send(to: string, body: string): Promise<void>;
  sendGroupchat(to: string, body: string): Promise<void>;
  sendFile(to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void>;
  joinRoom(roomJid: string, nick?: string): Promise<void>;
  leaveRoom(roomJid: string, nick?: string): Promise<void>;
  getJoinedRooms(): string[];
  stop(): Promise<void>;
  roomNicks: Map<string, string>;
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
  start(): Promise<void>;
  send(stanza: any): Promise<any>;
}

// src/types/gateway.ts
interface GatewayContext {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  setStatus(next: Partial<AccountSnapshot>): void;
  getStatus(): AccountSnapshot;
  channelRuntime?: ChannelRuntimeSurface;
}
```

Target: Reduce `any` usage from ~128 to < 20 (only truly dynamic external APIs).

### PRIORITY 3: Code Quality (Do Third)

These improvements make the codebase sustainable for day-to-day development.

#### 3.1 Production Logging Overhaul

**Step 1:** Create `src/lib/logger.ts`:

```typescript
import { secureLog } from "../security/logging.js";

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
let currentLevel = LOG_LEVELS[process.env.XMPP_LOG_LEVEL ?? "info"] ?? LOG_LEVELS.info;

export function setLevel(level: string) {
  currentLevel = LOG_LEVELS[level] ?? currentLevel;
}

export const log = {
  debug: (...args: any[]) => { if (currentLevel >= LOG_LEVELS.debug) secureLog.debug(...args); },
  info:  (...args: any[]) => { if (currentLevel >= LOG_LEVELS.info) secureLog.info(...args); },
  warn:  (...args: any[]) => { if (currentLevel >= LOG_LEVELS.warn) secureLog.warn(...args); },
  error: (...args: any[]) => { secureLog.error(...args); },
};

// For gateway context (uses ctx.log when available)
export function ctxLog(ctx: any) {
  return ctx?.log ?? log;
}
```

**Step 2:** Replace console.log patterns:

```typescript
// BEFORE (remove all of these):
console.log("XMPP sendText called with:", { to, text, accountId });
console.log(`Attempting to send message to ${cleanTo}: ...`);
console.log("✅ Groupchat message sent successfully");
console.log("=== STARTING DISPATCH ===");

// AFTER:
log.debug("sendText", { to, accountId, textLength: text?.length });
log.info("messageSent", { to, type: isGroupChat ? "groupchat" : "chat" });
```

**Target:** Reduce from ~200 console.log statements to < 20 (only at module boundaries and error paths).

#### 3.2 Async Migration for File I/O

Replace synchronous operations in hot paths:

```typescript
// VCard.ts -- BEFORE:
private loadVCard(): VCardData {
  return JSON.parse(fs.readFileSync(this.vcardFile, "utf8"));
}
private saveVCard() {
  fs.writeFileSync(this.vcardFile, JSON.stringify(this.vcardData, null, 2));
}

// VCard.ts -- AFTER:
private async loadVCard(): Promise<VCardData> {
  try {
    const content = await fs.promises.readFile(this.vcardFile, "utf8");
    return JSON.parse(content);
  } catch { return { version: "3.0" }; }
}
private async saveVCard(): Promise<void> {
  await fs.promises.writeFile(
    this.vcardFile,
    JSON.stringify({ ...this.vcardData, rev: new Date().toISOString() }, null, 2)
  );
}
```

Apply same pattern to `jsonStore.ts` and `messageStore.ts`.

#### 3.3 Fix Deprecated APIs

```typescript
// index.ts:55 and register.ts:29
// BEFORE:
`${Math.random().toString(36).substr(2, 9)}`
// AFTER:
`${Math.random().toString(36).substring(2, 11)}`
```

There are 2 occurrences to fix.

#### 3.4 Add Reconnection Logic

In `src/startXMPP.ts`, after the `xmpp.on("offline", ...)` handler:

```typescript
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, RECONNECT_BACKOFF_FACTOR } from "./config.js";

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

xmpp.on("offline", () => {
  debugLog("XMPP went offline, scheduling reconnect...");
  isRunning = false;
  scheduleReconnect();
});

xmpp.on("online", () => {
  debugLog("XMPP online, clearing reconnect timer");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
});

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempts),
    RECONNECT_MAX_MS
  );

  debugLog(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);
  reconnectTimer = setTimeout(async () => {
    reconnectAttempts++;
    try {
      await xmpp.start(); // @xmpp/client handles reconnection internally
    } catch (err) {
      debugLog(`Reconnect failed: ${err}`);
      scheduleReconnect();
    }
  }, delay);
}
```

Add to config.ts:
```typescript
RECONNECT_BASE_MS: 1000,
RECONNECT_MAX_MS: 60000,       // Max 1 minute between attempts
RECONNECT_BACKOFF_FACTOR: 2,   // Double each time
```

#### 3.5 Implement Tests

**Phase 1 -- Unit tests for pure logic:**

```typescript
// tests/validation.test.ts
import { validators } from "../src/security/validation.js";
import { describe, it, expect } from "vitest";

describe("validators", () => {
  describe("isValidJid", () => {
    it("accepts valid JIDs", () => {
      expect(validators.isValidJid("user@example.com")).toBe(true);
      expect(validators.isValidJid("user@conference.example.com")).toBe(true);
    });
    it("rejects invalid JIDs", () => {
      expect(validators.isValidJid("")).toBe(false);
      expect(validators.isValidJid("not-a-jid")).toBe(false);
      expect(validators.isValidJid("@example.com")).toBe(false);
    });
  });

  describe("sanitizeFilename", () => {
    it("removes dangerous characters", () => {
      expect(validators.sanitizeFilename("file../../../etc/passwd")).not.toContain("..");
    });
    it("limits length", () => {
      expect(validators.sanitizeFilename("a".repeat(300)).length).toBeLessThanOrEqual(255);
    });
  });

  describe("isSafePath", () => {
    it("blocks path traversal", () => {
      expect(validators.isSafePath("../secret.txt", "/tmp")).toBe(false);
      expect(validators.isSafePath("file.txt", "/tmp")).toBe(true);
    });
  });
});
```

**Phase 2 -- Integration tests for XMPP protocol:**

Use a mock XMPP server (or the `xmpp.js` test tools) to verify:
- Connection establishment
- Message send/receive
- MUC join/leave
- vCard query/response
- File transfer (IBB)

Update `package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "vitest": "^1.0.0",
    "@types/node": "^25.2.0"
  }
}
```

### PRIORITY 4: Robustness (Do Fourth)

These improvements prevent production incidents.

#### 4.1 Persist Undelivered Message Queue

```typescript
// src/message-queue.ts
import fs from "fs/promises";
import path from "path";

const QUEUE_FILE = "message-queue.json";

export class PersistentMessageQueue {
  private queue: QueuedMessage[] = [];
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, QUEUE_FILE);
    this.load();
  }

  private async load() {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      this.queue = JSON.parse(data);
    } catch { /* empty queue */ }
  }

  private async save() {
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.queue, null, 2),
      "utf-8"
    );
  }

  async push(msg: Omit<QueuedMessage, "id" | "timestamp" | "processed">) {
    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      processed: false,
      ...msg,
    };
    this.queue.push(entry);
    await this.trim();
    await this.save();
    return entry.id;
  }

  private async trim() {
    const MAX = Config.MESSAGE_QUEUE_MAX_SIZE;
    if (this.queue.length > MAX) {
      this.queue = this.queue.slice(-MAX); // Keep newest MAX
    }
    // Also remove messages older than 24h
    const cutoff = Date.now() - Config.MESSAGE_CLEANUP_MAX_AGE_MS;
    this.queue = this.queue.filter(m => m.timestamp > cutoff);
  }
  // ... rest of queue operations
}
```

#### 4.2 Rate Limit Map Cleanup

In `src/shared/index.ts`, add periodic cleanup:

```typescript
// Add to the existing module:
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [jid, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 10) {
      // Evict entries inactive for 10x the window duration
      rateLimitMap.delete(jid);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

// Export cleanup function for testing
export function clearRateLimitMapForTesting() {
  rateLimitMap.clear();
}
```

#### 4.3 Graceful Shutdown

In `src/startXMPP.ts`, add signal handlers:

```typescript
// After xmpp.start() in startXmpp():
const shutdownHandlers = ["SIGTERM", "SIGINT", "SIGUSR2"] as const;

for (const signal of shutdownHandlers) {
  process.on(signal, async () => {
    log.info(`Received ${signal}, initiating graceful shutdown...`);
    isRunning = false;

    // Stop accepting new messages (already handled by isRunning flag)

    // Wait briefly for in-flight operations
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await xmpp.stop();
      log.info("XMPP client stopped cleanly");
    } catch (err) {
      log.error("Error stopping XMPP client:", err);
    }

    // Clear intervals
    if (ibbCleanupInterval) clearInterval(ibbCleanupInterval);

    process.exit(0);
  });
}
```

#### 4.4 Add Timeouts to All Network Operations

Audit all `xmpp.send()` calls that wait for responses. Ensure they have timeouts:

```typescript
// Pattern for safe stanza exchange:
async function safeStanzaExchange<T>(
  iqId: string,
  timeoutMs: number = 10000
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      xmpp.off("stanza", handler);
      resolve(null); // Timeout
    }, timeoutMs);

    const handler = (stanza: any) => {
      if (stanza.attrs.id === iqId) {
        clearTimeout(timer);
        xmpp.off("stanza", handler);
        resolve(stanza);
      }
    };

    xmpp.on("stanza", handler);
  });
}
```

Apply this pattern to:
- `queryVCardFromServer()` (currently uses setTimeout(1000) -- no guarantee)
- `updateVCardOnServer()` (setTimeout loop of 100ms x 50)
- `discoverUploadService()` (has 10s timeout -- OK)
- `requestUploadSlot()` (needs timeout)
- All vcard-cli.ts operations (use 800ms fixed waits -- fragile)

### PRIORITY 5: Nice to Have (Do Later)

These are improvements that would be nice but aren't blocking issues.

#### 5.1 Mention Detection

Using SDK's mention utilities:

```typescript
// In the message handler, before dispatching:
import { matchesMentionPatterns, buildMentionRegexes } from "openclaw/plugin-sdk";

const botJid = config.jid; // Full JID
const mentionRegexes = buildMentionRegexes(botJid);

if (options?.type === "groupchat") {
  const wasMentioned = matchesMentionRegexes(body, mentionRegexes);
  ctxPayload.WasMentioned = wasMentioned;
  // Only dispatch groupchat messages that mention the bot
  // (unless DM policy says otherwise)
}
```

#### 5.2 Health Probe Endpoint

```typescript
// In channel-plugin.ts or status adapter:
const probeAccount = async ({ account, timeoutMs = 5000 }) => {
  const client = xmppClients.get(account.accountId);
  if (!client) return { ok: false, error: "Not connected" };

  // Send an IQ ping (XEP-0199) or just check socket state
  const startTime = Date.now();
  try {
    // Simple check: can we access the client?
    const rooms = client.getJoinedRooms?.() || [];
    return {
      ok: true,
      latency: Date.now() - startTime,
      details: { connected: true, roomsJoined: rooms.length },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
};
```

#### 5.3 Setup Wizard for First Configuration

```typescript
// In a new src/setup.ts:
export const xmppSetupWizard = {
  async promptForConfig(existingConfig) {
    const questions = [
      {
        key: "service",
        question: "XMPP Server URL (e.g., xmpp://example.com:5222)?",
        defaultValue: existingConfig?.service,
      },
      {
        key: "jid",
        question: "Bot JID (e.g., bot@example.com)?",
        required: true,
      },
      {
        key: "password",
        question: "Password (will be encrypted)?",
        required: true,
        hidden: true,
      },
      {
        key: "adminJid",
        question: "Admin JID (your own JID for admin commands)?",
      },
    ];
    // Interactive or config-driven setup
  },
};
```

#### 5.4 Streaming/Typing Indicators

```typescript
// When starting to compose a reply:
async function sendTypingIndicator(to: string, isGroupChat: boolean) {
  const chatType = isGroupChat ? "groupchat" : "chat";
  const presence = xml("presence", { to, type: chatType },
    xml("show", { xmlns: "http://jabber.org/protocol/chatstates" }, "composing")
  );
  await xmpp.send(presence);
}

// Call this before dispatching replies, clear after send
```

---

## Metrics Summary

| Metric | Current Value | Target Value |
|--------|--------------|-------------|
| Total source files | 28 | ~18 (after dedup/deletion) |
| Total lines of code | ~8,500 | ~4,000 (after dedup) |
| `any` type usage | ~128+ | < 20 |
| Files with >300 lines | 5 | 1 (startXMPP.ts is acceptable at ~800 if split properly) |
| Duplicated code blocks | 18 major | 0 |
| console.log statements | ~200+ | < 20 |
| Test coverage | 0% | > 60% |
| SDK conventions followed | ~20% | > 80% |
| CRITICAL security issues | 2 | 0 |
| HIGH security issues | 1 | 0 |
| MEDIUM security issues | 3 | 0 |
| Dead files to delete | 8 | 0 (deleted) |
| Files needing async migration | 4 | 0 |

---

## Positive Notes

Despite the criticisms above, the extension has genuine strengths worth acknowledging:

1. **Protocol completeness** -- Implements more XEPs than most XMPP bots (MUC, vCard, IBB/SI, HTTP Upload, Whiteboard, disco#info, OOB data, presence subscription management, room configuration)

2. **Password encryption** -- AES-256-GCM with PBKDF2-SHA512 at 100k iterations is cryptographically sound (once the static salt issue is fixed)

3. **Input sanitization** -- Filename sanitization, path traversal prevention, URL validation, and message content cleaning are thorough and applied consistently at file receive boundaries

4. **Rate limiting** -- Built-in per-JID command rate limiting with sliding window (needs memory cleanup but the design is correct)

5. **File size limits** -- Enforced at multiple levels (IBB accept, download, upload) with configurable 10MB default

6. **Contact whitelist model** -- Non-contacts cannot trigger bot responses in direct messages (good security default)

7. **Admin role separation** -- Sensitive commands (add/remove contact, manage rooms, vcard editing) require admin privileges in direct chat

8. **Comprehensive CLI** -- Rich command-line interface covering all operations (messaging, contacts, rooms, vcard, file transfer, encryption)

9. **Multi-account architecture** -- Design supports multiple XMPP accounts simultaneously (though single-account tested in practice)

10. **Message persistence** -- All messages logged to JSON files with date organization and rotation

11. **Auto-join configured rooms** -- Bot automatically joins rooms listed in config on startup

12. **Graceful error handling in protocol handlers** -- Most stanza handlers have try/catch with appropriate error responses sent back to the XMPP network

---

## Implementation Roadmap

### Phase 1: Security Sprint (2-3 days)
- [*] Delete `register.ts`
- [*] Implement `ChannelSecurityAdapter` (priority 1.1)
- [*] Gate MUC auto-accept (priority 1.2)
- [*] Remove hardcoded salt (priority 1.3)
- [*] Remove or fix FTP (priority 1.4)
- [*] Add input size limits (priority 1.6)

### Phase 2: Architecture Sprint (3-5 days)
- [ ] Delete 8 dead files (priority 2.1)
- [ ] Create module map with shared utilities (priority 2.3)
- [ ] Restructure `index.ts` to SDK pattern (priority 2.2)
- [ ] Extract `channel-plugin.ts`, `gateway.ts`, `outbound.ts`, `dispatch.ts` (priority 2.2)
- [ ] Define proper TypeScript interfaces (priority 2.4)

### Phase 3: Quality Sprint (2-3 days)
- [ ] Production logging overhaul (priority 3.1)
- [ ] Async migration for VCard/JsonStore/MessageStore (priority 3.2)
- [ ] Fix deprecated `substr()` calls (priority 3.3)
- [ ] Add reconnection logic (priority 3.4)
- [ ] Write unit tests for validation, sanitization, encryption (priority 3.5)

### Phase 4: Robustness Sprint (2 days)
- [ ] Persist message queue (priority 4.1)
- [ ] Rate limit map cleanup (priority 4.2)
- [ ] Graceful shutdown (priority 4.3)
- [ ] Network operation timeouts (priority 4.4)

### Phase 5: Polish Sprint (ongoing)
- [ ] Mention detection (priority 5.1)
- [ ] Health probe (priority 5.2)
- [ ] Setup wizard (priority 5.3)
- [ ] Typing indicators (priority 5.4)
- [ ] Documentation (README.md update, API docs)

---

*End of review. This document should serve as the actionable plan for all improvement work.*
