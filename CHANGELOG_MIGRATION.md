# XMPP Plugin Migration Changelog

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