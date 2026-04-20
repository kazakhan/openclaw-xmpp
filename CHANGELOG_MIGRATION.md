# XMPP Plugin Migration Changelog

## Version: 2026.4.14-migration
## Date: 2026-04-14
## Reason: Fix SI file transfer bug (Cannot create property 'parent' on string)

### Changes Made

#### 1. src/startXMPP.ts (UPDATED)
- Fixed sendFileWithSITransfer function (lines ~2307-2310)
- Changed from `xmpp.send(to, message)` to proper XML element format
- Now uses: `xml("message", { type, to }, xml("body", {}, message))`

#### 2. Backup File
- `startXMPP_20260414_081935.ts` - Backup before this fix

---

## Version: 2026.4.13-migration
## Date: 2026-04-13
## Reason: Extract base64 images from XHTML-IM messages (PSI+ screen captures)

### Changes Made

#### 1. src/startXMPP.ts (UPDATED)
- Added XHTML-IM base64 image extraction (lines ~948-1010)
- Detects `<html xmlns='http://jabber.org/protocol/xhtml-im'>` element
- Finds `<img>` tags with `data:image/...;base64,...` src attributes
- Extracts base64 data, decodes to binary, saves to `dataDir/downloads/xhtml_im_<timestamp>.<ext>`
- Adds saved file paths to `mediaPaths` array for forwarding to agent

#### 2. Backup File
- `startXMPP_20260413_153315.ts` - Prevents backup before this change

---

## Version: 2026.4.2-migration
## Date: 2026-04-06
## Reason: Update to work with OpenClaw 2026.4.x plugin API changes

### Files Modified/Created

#### Backup Files (in .backups/)
All backups are timestamped with ISO 8601 format: `YYYY-MM-DDTHH-MM-SS`

| Original File | Backup File | Purpose |
|--------------|-------------|---------|
| index.ts | 2026-04-06T11-04-00_index.ts.backup | Main plugin entry point |
| package.json | 2026-04-06T11-04-00_package.json.backup | Package configuration |
| - | openclaw.plugin.json.backup | NEW - Plugin manifest |
| - | setup-entry.ts.backup | NEW - Setup entry point |
| - | src/channel.ts.backup | NEW - Channel plugin definition |

### Changes Made

#### 1. package.json
- Added `openclaw` metadata with compat info
- Added `channel` field to specify channel ID and label
- Added `compat` section for plugin API version
- Added `build` section for SDK version

#### 2. openclaw.plugin.json (NEW)
- Created manifest with channel type
- Defined config schema for XMPP accounts
- Added channel-specific metadata

#### 3. setup-entry.ts (NEW)
- Created lightweight setup entry using `defineSetupPluginEntry`
- Only loads minimal setup code when channel is disabled

#### 4. src/channel.ts (NEW)
- Created channel plugin using `createChatChannelPlugin`
- Defined setup adapter with account resolution
- Configured security (DM policy, allowlist)
- Configured outbound (sendText, sendMedia)
- Configured threading (top-level reply mode)

#### 5. index.ts (UPDATED)
- Migrated to use `defineChannelPluginEntry`
- Split registration into `registerCliMetadata` and `registerFull`
- Uses new channel.ts for plugin definition

### Why Changes Were Needed

The OpenClaw plugin API changed in version 2026.4.x:
1. Plugins must use `defineChannelPluginEntry` instead of old registration
2. Setup entry must be separate (`defineSetupPluginEntry`)
3. Package.json requires new `openclaw` metadata structure
4. Manifest must be in `openclaw.plugin.json` format
5. CLI commands must use `registerCliMetadata` for metadata-only registration

### Rollback Instructions

To rollback to previous version:
1. Restore index.ts from `.backups/2026-04-06T11-04-00_index.ts.backup`
2. Restore package.json from `.backups/2026-04-06T11-04-00_package.json.backup`
3. Delete newly created files (openclaw.plugin.json, setup-entry.ts, src/channel.ts)

### Testing

After migration, test:
1. `openclaw xmpp status` - Should show connection status
2. `openclaw message send --channel xmpp --target user@domain.com --message "test"` - Should work
3. Gateway startup should load XMPP channel without errors
4. XMPP messages should be received and dispatched to agents

---

## Update: 2026-04-06 - Groupchat Message Fix

### Problem
The `openclaw xmpp msg general@conference.kazakhan.com "Hello"` command failed to send messages to groupchat (MUC) rooms, even when the bot was already in the room.

### Root Cause
The newly added `xmpp.sendMessage` gateway method only used `client.send()` which is for direct messages. Groupchat messages require `client.sendGroupchat()`.

### Fix Applied

**File: `index.ts`** (lines 1125-1158)

Updated the `xmpp.sendMessage` gateway method to detect groupchat vs direct messages:
- Check if JID contains `@conference.` (groupchat indicator)
- Check if JID contains `/` after the conference domain (private message in groupchat)
- Use `sendGroupchat()` for public groupchat messages
- Use `send()` for direct messages and private messages in groupchat

### Backup
- `2026-04-06T12-30-00_index.ts.backup` - Index before groupchat fix

### Testing
```
openclaw xmpp msg general@conference.kazakhan.com "Hello, world!"
```

---

## Update: 2026-04-06 - Linux Case-Sensitive Fix

### Problem
Plugin fails to load on Linux with error: "Cannot find module './src/startXmpp.js'"

### Root Cause
Filename case mismatch between file on disk and import path:
- File on disk: `src/startXMPP.ts` (uppercase MPP)
- Import in code: `./src/startXmpp.js` (lowercase mpp)

Windows (NTFS) is case-insensitive so this works. Linux (ext4) is case-sensitive so it fails.

### Fix Applied

**Files edited:**
- `index.ts` (line 99): Changed `./src/startXmpp.js` to `./src/startXMPP.js`
- `src/register.ts` (line 3): Changed `./startXmpp.js` to `./startXMPP.js`

### Backup
- `2026-04-06T14-00-00_index.ts.backup` - index.ts before this fix

### Testing
Copy updated files to Linux and verify plugin loads without case-sensitivity errors.

---

## Update: 2026-04-06 - Groupchat Command Support

### Problem
OpenClaw commands (like `/help`, `/status`, `/new`) don't work in groupchat - they only work in direct chat.

### Solution
Enabled OpenClaw commands in groupchat by using `@<botNick> /<command>` mention syntax. Only admins can use these commands.

### Example
```
@uranus /help
@uranus /status
@uranus /new
```

### Implementation

**File: `index.ts`**

1. Added `handleGroupchatCommand()` function (lines 98-165) that processes common commands:
   - /help - Show available commands
   - /whoami - Show user info
   - /context - Show context info
   - /models - List models
   - /status - Show status
   - /new - Start new session
   - /stop - Stop session
   - /reset - Reset conversation
   - /model <id> - Switch model
   - /think <level> - Set think level
   - /verbose on|off - Toggle verbose

2. Added groupchat command detection (lines 641-677):
   - Check if message is type="groupchat" with a room
   - Check if message starts with `@<botNick> `
   - Extract command after the mention prefix
   - Verify sender is admin using `contacts.isAdmin(senderBareJid)`
   - Process command and send response back to room
   - Mark message as processed to skip regular message handling

### Security
- Only users in the admin list can run commands
- Non-admin users get an error message explaining they need admin access

### Backup
- `2026-04-06T15-00-00_index.ts.backup` - index.ts before groupchat command implementation

### Testing
```
@uranus /model claude-3-5-sonnet-20241022
```

---

## Update: 2026-04-06 - Groupchat Command Fix (v3)

### Problem
Previous implementation intercepted groupchat commands and created custom dispatchers, which broke all commands except /help.

### Solution
Strip the `@<nick> ` prefix and let the command flow through naturally - no interception at all.

### Implementation

**File: `index.ts`** (lines 566-577)

Changed from:
- Intercepting the command
- Building custom payload
- Creating custom dispatcher
- Returning early (skipping normal processing)

To:
- Detect `@<nick> /<command>` format
- Strip the prefix: `@uranus /status` → `/status`
- Let message continue through normal processing
- OpenClaw handles everything naturally

```typescript
// Check for groupchat command: @<botNick> /<command>
// If detected, strip the prefix and let the command flow through naturally
if (options?.type === "groupchat" && options?.room && options?.botNick && body) {
  const botNick = options.botNick;
  const commandPrefix = `@${botNick} `;
  
  if (body.startsWith(commandPrefix)) {
    body = body.substring(commandPrefix.length).trim();
    console.log(`Groupchat command detected, stripped prefix: ${body}`);
    // Let it continue through normal processing - NO interception
  }
}
```

### Backup
- `2026-04-06T16-00-00_index.ts.backup` - index.ts before this fix

### Testing
```
@uranus /help
@uranus /status
@uranus /whoami
@uranus /context
```

---

## Update: 2026-04-06 - Groupchat Command Fix (v2)

### Problem
Initial implementation used a custom command handler which only worked for /help because it was hardcoded. All other commands failed.

### Root Cause
Instead of passing commands through to OpenClaw, I implemented a custom handler that only had /help defined.

### Fix Applied

**File: `index.ts`**

1. Removed custom `handleGroupchatCommand()` function (the one with hardcoded command responses)

2. Updated groupchat command processing (lines 575-659):
   - Now passes command through to OpenClaw via `runtime.channel.reply.dispatchReplyFromConfig()`
   - Creates a custom dispatcher that sends responses as DM to the sender
   - Uses the extracted command as CommandBody so OpenClaw can detect it as a command

### How It Works Now
```
Groupchat: @uranus /status
     ↓
Extract command: /status
     ↓
Pass to OpenClaw via dispatchReplyFromConfig()
     ↓
OpenClaw detects /status as command, processes it
     ↓
Response sent as DM to sender
```

### Backup
- `2026-04-06T15-30-00_index.ts.backup` - index.ts before this fix

### Testing
```
@uranus /help
@uranus /status
@uranus /whoami
@uranus /model claude-3-5-sonnet-20241022
```

---

## Update: 2026-04-07 - Groupchat Nickname to Agent

### Problem
When messages come from groupchat, the agent doesn't know the sender's room nickname - only their JID.

### Solution
Added `Nickname` field to the payload, only included for groupchat messages.

### Implementation

**File: `index.ts`** (line 534)

Added conditional field:
```typescript
Nickname: options?.room ? nick : undefined,
```

- For groupchat messages: `Nickname: "john"` (sender's room nickname)
- For direct messages: `Nickname: undefined` (not included)

---

## Update: 2026-04-07 - Prepend Nickname to Groupchat Messages

### Problem
When messages come from groupchat, the agent doesn't know the sender's room nickname - only their JID.

### Solution
Prepend `<From: Nickname>` to the message body so the agent sees it directly.

### Implementation

**File: `index.ts`** (lines 565, 580-583)

Removed the separate `Nickname` field (reverted), added prepending to body:

```typescript
const senderNick = from.split('/')[1];

// Prepend sender's nickname to message body for groupchat messages
if (options?.room && senderNick) {
  body = `<From: ${senderNick}>\n${body}`;
}
```

**Example:**
- Original: `Hello everyone`
- Modified: `<From: john>\nHello everyone`

### Files
- `.backups/2026-04-07T19-55-00_index.ts.backup` - index.ts before this final change
- `.backups/2026-04-07T19-45-00_index.ts.backup` - earlier backup

### Backup
- `2026-04-07T19-45-00_index.ts.backup` - index.ts before this change

### REVERTED - This approach was wrong

Reverted in favor of prepending nickname to message body (see below).

---

## Update: 2026-04-07 - File Transfer Fixes

### Problem
1. PSI+ unable to negotiate file transfer - bot didn't advertise file transfer capability
2. Incoming files not forwarded to agent
3. TypeError: from.split is not a function - fromJid was an object instead of string

### Fixes Applied

#### 1. Added File Transfer Disco Features
**File: `src/startXMPP.ts`** (lines 743-748)
Added to disco#info response:
```javascript
xml("feature", { var: "http://jabber.org/protocol/si/profile/file-transfer" }),
xml("feature", { var: "http://jabber.org/protocol/bytestreams" }),
xml("feature", { var: "http://jabber.org/protocol/ibb" })
```

#### 2. Added onFileReceived Callback
**File: `src/startXMPP.ts`**
- Updated startXmpp() signature to accept onFileReceived callback
- Notifies when files received via IBB

#### 3. Forward Files to Agent
**File: `index.ts`**
- Added handleIncomingFile function that:
  - Creates message: `[File received] filename\nSaved to: /path`
  - Includes file path in MediaPath
  - Forwards to agent via recordInboundSession

#### 4. Fixed TypeError - Defensive Coding
**Files: `src/startXMPP.ts` and `index.ts`**

In startXMPP.ts when storing IBB session (line 548-550):
```javascript
const fromJid = typeof from === 'string' ? from : String(from);
ibbSessions.set(sid, {
  from: fromJid,
  ...
});
```

In index.ts handleIncomingFile (line 474-475):
```javascript
const fromJidStr = typeof fromJid === 'string' ? fromJid : String(fromJid);
const senderBareJid = fromJidStr.split('/')[0];
```

#### 5. Fixed startXmpp Call Structure
**File: `index.ts`** (lines 530-540)
Fixed incorrect callback structure that was breaking message handling.

### Backups
- `.backups/2026-04-07T13-00-00_index.ts.backup` - index.ts before fixes
- `.backups/2026-04-07T20-00-00_startXMPP.ts.backup` - startXMPP.ts before fixes

### Testing
1. Try sending file from PSI+ to bot - should now negotiate
2. Check bot's dataDir/downloads/ folder
3. Agent should receive file notification

---

## Update: 2026-04-13 - Save Files Locally After Upload

### Problem
When sending images/files from the agent to XMPP users:
1. File uploaded to XMPP server via HTTP Upload
2. Recipient gets HTTP URL
3. File NOT saved locally - agent can't access local copy

### Solution
Save a local copy of the file after uploading, regardless of transfer method.

### Implementation

**File: `src/startXMPP.ts`**

1. **HTTP Upload** (lines 2261-2268) - Already added, now also fixed fallback path:
   - Save file to `dataDir/downloads/` after upload
   
2. **SI Transfer fallback** (lines 2294-2308) - NEW:
   - Save file to `dataDir/downloads/` before sending
   - Ensures file is saved regardless of which method succeeds

3. **Fixed default path** (line 2262):
   - Changed from `cfg.dataDir || '.'` to `cfg.dataDir || path.join(process.cwd(), 'data')`
   - Consistent with other parts of the plugin

### Code Added to SI fallback:
```javascript
const downloadsDir = path.join(cfg.dataDir || path.join(process.cwd(), 'data'), 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}
const localPath = path.join(downloadsDir, filename);
try {
  await fs.promises.copyFile(filePath, localPath);
  debugLog(`File saved locally to: ${localPath}`);
} catch (copyErr) {
  console.error(`Failed to save local copy:`, copyErr);
}
```

### Backup
- `.backups/2026-04-13T14-30-00_startXMPP.ts.backup`

### Testing
Send image from agent to XMPP user, check dataDir/downloads/ for local copy

---

## Update: 2026-04-13 - Debug Logging Fix

### Problem
Files not being saved locally. No logs showing success or failure.

### Root Cause
`debugLog` function in `src/shared/index.ts` only writes to a file if `debugLogDir` is set. Since it's never set, all debug messages are silently swallowed.

### Solution
Replace `debugLog` with `console.log` in file save code so messages are visible.

### Files Modified

**File: `src/startXMPP.ts`**

1. Line ~2268: Changed `debugLog` → `console.log` in HTTP Upload save
2. Line ~2302: Changed `debugLog` → `console.log` in SI Transfer save

### Backup
- `.backups/2026-04-13T14-45-00_startXMPP.ts.backup`

### Testing
Send image - should now see "File saved locally to: ..." in gateway logs