# Changelog

All notable changes to the OpenClaw XMPP plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.5] - 2026-02-07

### Security
- **Sanitize Debug Logs**: Created `src/security/logging.ts` with `secureLog` utility that automatically redacts sensitive data (passwords, credentials, API keys) from logs. Added sanitization to `debugLog()` function in `index.ts` to prevent sensitive information exposure.

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

## [Unreleased]

### Security
- **TLS Certificate Verification**: Removed insecure NODE_TLS_REJECT_UNAUTHORIZED workaround now that XMPP server has proper certificate

### Added
- **Shared Session Memory**: Direct chat and groupchat messages now share the same session when users are identified, enabling persistent memory across conversation types
- **XEP-0327 Occupant-ID Support**: Automatic user identification in MUC rooms using stable occupant IDs for consistent session tracking
- **Session Memory Configuration**: Support for `memorySearch.experimental.sessionMemory` in agent config to enable session transcript searching
- **Query Any User's vCard**: `/vcard get <jid>` command to retrieve vCard information for any XMPP user from the server

### Changed
- **Debug Logging Reduced**: Removed verbose console.log output throughout the plugin; debug information now writes to `cli-debug.log` file instead
- **Cleaner Console Output**: Only essential operational messages (connections, presence, vCard, room events) are logged to console
- **vCard Commands Now Query Server**: `/vcard get` and `/vcard set` now query/update the XMPP server instead of using local storage
- **Session Key Format**: Sessions now use `xmpp:user@domain.com` for both direct and groupchat when user is identified
- **Chat Type**: All XMPP conversations use "direct" chatType to prevent separate session buckets
- **Reply Routing**: Groupchat replies correctly route to room JID instead of user JID
- **Context Payload**: From field consistently uses user's bare JID for session continuity

### Fixed
- Groupchat replies now sent to correct room JID instead of user's personal JID
- Session sharing between direct chat and groupchat for identified users
- Agent context properly uses shared session key for memory continuity

### Configuration
Add to `~/.openclaw/openclaw.json` for session memory:
```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "experimental": {
          "sessionMemory": true
        }
      }
    }
  }
}
```

### Planned Features
- SOCKS5 Bytestreams support (XEP-0065)
- Jingle file transfer (XEP-0234)
- Enhanced whiteboard with drawing tools
- Image optimization before sending
- File size limits and validation
- Improved error handling and logging
- Unit tests and integration tests
- Documentation improvements

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