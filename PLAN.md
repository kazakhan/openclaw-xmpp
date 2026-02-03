# XMPP Plugin Code Review - Refactoring Plan

## Overview
The XMPP plugin at `C:\Users\kazak\.clawdbot\extensions\xmpp` has significant redundancy and maintainability issues. This plan outlines a phased approach to refactor and clean up the codebase.

---

## Critical Issues

### 1. Dead Code - Roster System

**Problem:** `data/roster.ts` defines async roster functions that are never imported or used anywhere in the codebase.

**Files Involved:**
- `data/roster.ts` (20 lines) - Exports `loadRoster`, `saveRoster`, `getRoster`, `setNick`
- `data/commands.ts` (lines 7-20) - Has duplicate in-memory roster implementation

**Impact:** Wasted file, confusion about roster persistence

**Solution:**
```bash
# Remove dead file
rm data/roster.ts

# In commands.ts, either:
# Option A: Remove in-memory roster functions entirely if unused
# Option B: Rename functions to make purpose clear (e.g., getInMemoryRoster)
```

**Estimated Effort:** 0.5 hours

---

### 2. Duplicate vCard Management (Three Implementations!)

**Problem:** vCard handling is split across three separate implementations:

| Implementation | Location | Purpose |
|---------------|----------|---------|
| `VCard` class | `index.ts:179-285` | Persistent vCard with JSON storage |
| Gateway methods | `index.ts:2626-2688` | `xmpp.vcard.get`/`set` API |
| Slash commands | `index.ts:1381-1474` | `/vcard` command handling |
| Standalone CLI | `data/vcard-cli.ts` | Separate process XMPP connection |

**Impact:** Code duplication, maintenance burden, inconsistent behavior

**Solution:**
1. Keep only `VCard` class from `index.ts` as the single source of truth
2. Remove `data/vcard-cli.ts` entirely
3. Update `commands.ts` CLI commands to call gateway methods instead of spawning new XMPP connections
4. Keep slash commands as-is (they already use `vcard` object)

**Code Changes Required:**
```typescript
// In commands.ts, replace vcard-cli.ts imports with:
api.registerGatewayMethod('xmpp.vcard.get', ...)
api.registerGatewayMethod('xmpp.vcard.set', ...)
```

**Estimated Effort:** 2-3 hours

---

### 3. `startXmpp` Function is 1500+ Lines

**Problem:** The `startXmpp` function (`index.ts:334-1797`) is a monolithic function containing:
- Helper functions (lines 336-397)
- Stanza event handler (lines 506-1577)
- Slash command processor (lines 913-1521)
- File transfer helpers (lines 1586-1712)
- Return object definition (lines 1716-1796)

**Impact:** Impossible to understand, test, or modify in isolation

**Solution - Module Extraction:**

```
src/
├── index.ts           # Main entry, minimal logic
├── stanzaHandler.ts   # XMPP stanza processing
├── slashCommands.ts   # Command parsing & execution
├── fileTransfer.ts    # HTTP upload & SI transfer
├── presenceHandler.ts # Subscription & MUC presence
└── utils.ts           # Shared helpers
```

**Extraction Details:**

#### `stanzaHandler.ts` (~800 lines)
Handles `xmpp.on("stanza", ...)` events:
- Message parsing (groupchat vs direct)
- Presence handling (joins, leaves, subscriptions)
- IQ stanzas (vCard, file transfer, HTTP upload)
- MUC invite processing

#### `slashCommands.ts` (~600 lines)
Processes `/` commands:
- Plugin commands: list, add, remove, admins, whoami, join, rooms, leave, invite, whiteboard, vcard, mapnick, help
- Contact management
- Room management
- Whiteboard integration

#### `fileTransfer.ts` (~150 lines)
HTTP Upload (XEP-0363) and SI File Transfer (XEP-0096):
- `requestUploadSlot()`
- `uploadFileViaHTTP()`
- `sendFileWithHTTPUpload()`
- `sendFileWithSITransfer()`

#### `presenceHandler.ts` (~100 lines)
- Subscription requests (`subscribe`, `subscribed`, `unsubscribe`)
- Presence probes
- MUC status codes

#### `utils.ts` (~100 lines)
```typescript
export function getDefaultResource(cfg: Config): string;
export function getDefaultNick(cfg: Config): string;
export function resolveRoomJid(room: string, domain: string): string;
export async function downloadFile(url: string, tempDir: string): Promise<string>;
export function stripResource(jid: string): string;
export function createDebugLogger(prefix: string): (...args: any[]) => void;
```

**Estimated Effort:** 6-8 hours

---

### 4. Duplicate Helper Functions

**Problem:** Same or similar helper functions defined in multiple places:

| Function | Locations |
|----------|-----------|
| `getDefaultResource()` | `index.ts:336-340`, `data/vcard-cli.ts:15-17` |
| Room JID resolution | Multiple inline implementations |
| File downloading | `index.ts:348-377`, `index.ts:379-397` |

**Solution:** Centralize all utilities in `src/utils.ts`

**Estimated Effort:** 1 hour

---

### 5. Inconsistent Logging

**Problem:**
- `debugLog()` function exists (`index.ts:6-15`) but only used at module load
- 200+ `console.log()` calls throughout
- Mixed usage of `api.logger` and `console`

**Logging Pattern Current:**
```typescript
// Debug log (file-based)
const debugLog = (msg: string) => { /* writes to cli-debug.log */ };

// Scattered console.log
console.log("XMPP plugin loading...");
console.error("XMPP PLUGIN MODULE LOADED");
debugLog(...);

// Logger from API
log.info("XMPP online as", address.toString());
```

**Solution:**
```typescript
// src/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

export function createLogger(prefix: string, level: LogLevel = 'info'): Logger {
  // Prefix all messages with [xmpp:prefix]
  // Support configurable level
  // Optional file output for debug level
}
```

**Benefits:**
- Consistent message format
- Configurable verbosity
- Easy to disable debug output

**Estimated Effort:** 2 hours

---

## Moderate Issues

### 6. Complex Message Routing (5+ Fallback Paths)

**Problem:** `index.ts:2240-2565` tries many approaches to forward messages to the agent:

```typescript
// Tries in order:
1. runtime.channel.session.recordInboundSession (line 2286)
2. dispatchReplyFromConfig (line 2378)
3. dispatchReplyWithBufferedBlockDispatcher (line 2441)
4. ctx.receiveText / ctx.receiveMessage (line 2503)
5. runtime.dispatchInboundMessage (line 2531)
6. runtime.channel.activity.record (line 2550)
```

**Impact:** Code complexity, unknown which path works, debug output noise

**Solution:**
1. Determine which method is actually used by the framework
2. Remove unused fallback paths
3. Create single `forwardToAgent()` function with clear contract

**Steps:**
1. Add instrumentation to log which path is taken
2. Run plugin and identify working path
3. Remove all other paths
4. Document the working API in code comments

**Estimated Effort:** 3-4 hours (including testing)

---

### 7. Contacts/VCard Class Duplication

**Problem:** Both `Contacts` and `VCard` classes have nearly identical JSON persistence patterns:

```typescript
// Contacts (index.ts:52-177)
class Contacts {
  private contactsFile: string;
  private contactsCache: Array<{ jid: string; name: string }>;
  private loadContacts(): Array<{ jid: string; name: string }> { ... }
  private saveContacts() { ... }
  // ... CRUD methods
}

// VCard (index.ts:179-285)
class VCard {
  private vcardFile: string;
  private vcardData: { ... };
  private loadVCard() { ... }
  private saveVCard() { ... }
  // ... CRUD methods
}
```

**Solution:** Extract base class for JSON file persistence:

```typescript
// src/jsonStore.ts
interface JsonStoreOptions<T> {
  filePath: string;
  defaults?: T;
  onLoad?: (data: T) => T;
  onSave?: (data: T) => T;
}

class JsonStore<T extends object> {
  private filePath: string;
  private data: T;
  private load(): T { ... }
  private save(): void { ... }
  get(): T { ... }
  set(updates: Partial<T>): void { ... }
  update(fn: (data: T) => void): void { ... }
}

// Usage:
class Contacts extends JsonStore<ContactsData> { ... }
class VCard extends JsonStore<VCardData> { ... }
```

**Estimated Effort:** 2 hours

---

### 8. Type Safety Gaps

**Problem:** Extensive `any` usage throughout:

```typescript
// Examples of any:
const xmpp = client({ ... });  // Any
xmpp.on("stanza", (stanza: any) => { ... });
const onMessage = (from: string, body: string, options?: { ... }) => void;
const sendReply = async (replyText: string) => { ... };
// Plus 100+ more
```

**Solution:** Add TypeScript interfaces:

```typescript
// src/types.ts
interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
  dataDir: string;
  adminJid?: string;
  rooms?: string[];
  vcard?: VCardConfig;
}

interface VCardConfig {
  fn?: string;
  nickname?: string;
  url?: string;
  desc?: string;
  avatarUrl?: string;
}

interface QueuedMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  accountId: string;
  processed: boolean;
}

interface MessageOptions {
  type?: 'chat' | 'groupchat';
  room?: string;
  nick?: string;
  botNick?: string;
  mediaUrls?: string[];
  mediaPaths?: string[];
  whiteboardPrompt?: string;
  whiteboardRequest?: boolean;
  whiteboardImage?: boolean;
}

interface SlashCommandContext {
  command: string;
  args: string[];
  from: string;
  fromBareJid: string;
  messageType: 'chat' | 'groupchat';
  roomJid: string | null;
  nick: string | null;
  sendReply: (text: string) => Promise<void>;
  checkAdminAccess: () => boolean;
}
```

**Estimated Effort:** 3-4 hours

---

## Proposed Refactoring Plan Summary

### Phase 1: Remove Dead Code & Consolidate (4 hours)
| Task | Effort | Priority |
|------|--------|----------|
| Delete `data/roster.ts` | 0.5h | Critical |
| Consolidate roster in `commands.ts` | 0.5h | High |
| Remove `data/vcard-cli.ts`, update CLI | 2h | Critical |
| Update commands to use gateway methods | 1h | High |

### Phase 2: Modularize `startXmpp` (8-10 hours)
| Task | Effort | Priority |
|------|--------|----------|
| Create `src/utils.ts` | 1h | High |
| Create `src/jsonStore.ts` | 2h | Medium |
| Extract `stanzaHandler.ts` | 2h | High |
| Extract `slashCommands.ts` | 2h | High |
| Extract `fileTransfer.ts` | 1h | Medium |
| Extract `presenceHandler.ts` | 1h | Medium |
| Update `index.ts` to use modules | 1h | High |

### Phase 3: Simplify & Type Safety (5-6 hours)
| Task | Effort | Priority |
|------|--------|----------|
| Create `src/logger.ts` | 2h | Medium |
| Add TypeScript interfaces | 2h | Medium |
| Simplify message routing | 3-4h | High |
| Remove unused fallback paths | 1h | High |

### Phase 4: Testing & Polish (3-4 hours)
| Task | Effort | Priority |
|------|--------|----------|
| Run typecheck | 0.5h | High |
| Test all slash commands | 1h | High |
| Test file transfer | 1h | Medium |
| Test MUC functionality | 1h | Medium |
| Update documentation | 0.5h | Low |

---

## Total Estimated Effort: 20-24 hours

---

## Questions for Clarification

1. **Priority**: Should I focus on removing redundancies first (Phase 1), or start with modularization (Phase 2)?

2. **Backward Compatibility**: Are the CLI commands (`clawdbot xmpp vcard`, `clawdbot xmpp roster`) actively used by users? Should I preserve them exactly?

3. **Runtime API**: Which inbound message routing method is actually stable? The code tries many approaches but only one works. I need to determine the correct API before simplifying.

4. **Logging Preference**: Should I implement a configurable debug mode with file output, or just reduce console.log noise?

5. **Testing**: Are there existing tests I should run after changes? The package.json shows no test command configured.

---

## Files to Modify

### Delete
- [ ] `data/roster.ts`
- [ ] `data/vcard-cli.ts`

### Modify
- [ ] `data/commands.ts` - Remove duplicate roster, update vcard commands
- [ ] `index.ts` - Import from new modules, simplify message routing

### Create
- [ ] `src/types.ts` - TypeScript interfaces
- [ ] `src/utils.ts` - Shared helper functions
- [ ] `src/jsonStore.ts` - Base class for JSON persistence
- [ ] `src/logger.ts` - Consistent logging
- [ ] `src/stanzaHandler.ts` - Extracted stanza processing
- [ ] `src/slashCommands.ts` - Extracted slash commands
- [ ] `src/fileTransfer.ts` - Extracted file transfer
- [ ] `src/presenceHandler.ts` - Extracted presence handling

---

## Rollback Plan

If refactoring causes issues:
1. Keep original files with `.bak` extension
2. Use git to revert specific files
3. Run `npm run typecheck` to verify compilation
4. Test CLI commands manually

---

## Success Criteria

- [ ] No dead code (no unused imports, functions, files)
- [ ] `startXmpp` function < 200 lines
- [ ] All helper functions in `utils.ts`
- [ ] All types properly defined
- [ ] Single vCard implementation
- [ ] Single roster implementation
- [ ] Message routing has 1 path (not 6)
- [ ] Consistent logging throughout
- [ ] `npm run typecheck` passes
- [ ] All slash commands work
- [ ] File transfer works
- [ ] MUC room management works
