# Changelog

All notable changes to the OpenClaw XMPP plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.4] - 2026-02-07

### Fixed

**MUC Invite Auto-Accept**
- **Issue**: Added pending invite system requiring admin approval for MUC invites, breaking the original simple auto-accept behavior
- **Solution**: Restored original invite handler that auto-accepts any MUC invite
- **Changes**:
  - Removed `PendingInvite` interface and `pendingInvites` Map
  - Restored simple invite handler that joins room immediately on invite
  - Removed `/invites` slash command (no longer needed)
  - Removed CLI commands: `openclaw xmpp invites pending|accept|deny`
- **Behavior**:
  - `/invite <jid> <room>` sends XMPP MUC invite, recipient auto-joins
  - Any MUC invite received is auto-accepted (original behavior)

### Changed

**Invite Command Syntax**
- `/invite <jid> <room>` - Invite a contact to a room (XEP-0246 MUC invite)
- No pending approval required

## [1.5.3] - 2026-02-07

### Security

**4. Enable SFTP (SSH File Transfer)**
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

**12. Audit Logging System**
- **Issue**: No comprehensive audit trail for security events, administrative actions, and file operations
- **Solution**: Created `src/security/audit.ts` with comprehensive audit logging:
  - **Event Types**: 25+ event types covering auth, commands, files, security, admin actions, connections, and data
  - **Log Persistence**: JSON lines format with automatic rotation (10MB per file)
  - **Log Retention**: 30-day retention with cleanup
  - **Sensitive Data Redaction**: Automatic redaction of passwords, tokens, API keys
  - **Buffering**: Event buffer with periodic flush (5 seconds)
- **New Files**:
  - `src/security/audit.ts` - Comprehensive audit logging system
- **Audit Event Types**:
  - Authentication: login_success, login_failure
  - Authorization: permission_granted, permission_denied
  - Commands: command_executed, command_failed
  - File Operations: file_upload, file_download, file_delete
  - Security: suspicious_activity, rate_limit_exceeded, invalid_input, quota_exceeded
  - Admin Actions: subscription_approved/denied, invite_approved/denied, admin_added/removed
  - Connections: xmpp_connected, xmpp_disconnected, room_joined, room_left
  - Data: message_sent, message_received
- **New Class**: `AuditLogger` with methods:
  - `log(event)` - Log an audit event
  - `query(filter)` - Query audit events with filters
  - `export(startDate, endDate)` - Export audit log to JSON
  - `cleanup()` - Remove old audit logs
  - `getStats()` - Get audit logging statistics
- **New Function**: `logAuditEvent(type, userId, action, result, options)` - Convenience wrapper
- **Updated Functions**:
  - `index.ts` - Added audit logging for XMPP connection events
- **New CLI Command**:
  - `openclaw xmpp audit status` - Show audit logging status
  - `openclaw xmpp audit list [limit]` - List recent audit events
  - `openclaw xmpp audit query` - Query audit events
  - `openclaw xmpp audit export [days]` - Export audit log to JSON
  - `openclaw xmpp audit cleanup` - Remove old audit logs
- **Log Format**:
  ```
  {"id":"uuid","timestamp":1234567890,"type":"auth:login_success","userId":"user@example.com","action":"xmpp_online","result":"success","source":"xmpp-plugin"}
  ```

**10. Enhanced File Transfer Security**
- **Issue**: File transfers lacked comprehensive security including content validation, malware scanning, and quota management
- **Solution**: Created `src/security/fileTransfer.ts` with comprehensive file transfer security:
  - **Content-Type Validation**: MIME type detection via file signatures (magic bytes) and extension mapping
  - **File Quarantine**: Suspicious files automatically quarantined to `./quarantine` directory
  - **Malware Scanning**: Basic pattern-based detection for common web shell signatures
  - **Secure Temp Files**: Automatic temp file creation with random names
  - **Per-User Quotas**: 100MB storage limit per user with usage tracking
  - **File Integrity**: SHA-256 hash for all processed files
- **New Files**:
  - `src/security/fileTransfer.ts` - Comprehensive file transfer security
- **New Class**: `SecureFileTransfer` with methods:
  - `calculateHash(filePath)` - SHA-256 file hashing
  - `detectMimeType(filename, buffer?)` - MIME type detection
  - `isAllowedMimeType(mimeType)` - Check allowed types
  - `validateFilename(filename)` - Sanitize and validate filenames
  - `validateFileSize(size, isUpload)` - Size limits with upload/download separation
  - `validateIncomingFile(filePath, metadata)` - Comprehensive file validation
  - `quarantineFile(filePath, reason)` - Move suspicious files to quarantine
  - `scanForMalware(filePath)` - Pattern-based malware detection
  - `secureDeleteFile(filePath)` - Secure file deletion (overwrite with zeros)
  - `getUserUsage(userId)` - Get user's storage quota usage
  - `cleanupOldTempFiles(maxAgeMs)` - Clean up temp files
  - `getStats()` - Get security statistics
- **Blocked Extensions**: .exe, .bat, .cmd, .sh, .php, .js, .py, .pif, .msi, .dll, .scr, .jar
- **Allowed MIME Types**: Images (JPEG, PNG, GIF, WebP), PDF, Text, JSON, ZIP, Audio, Video
- **New CLI Command**:
  - `openclaw xmpp file-transfer-security status` - Show security status
  - `openclaw xmpp file-transfer-security quota [jid]` - Show quota usage
  - `openclaw xmpp file-transfer-security quarantine` - List quarantined files
  - `openclaw xmpp file-transfer-security cleanup` - Clean up temp files
- **Updated Functions**:
  - `index.ts` - Added `SecureFileTransfer` initialization
  - File downloads now validated with MIME type, size, and quota checks
- **Configurable Limits**:
  - Max file size: 10MB
  - User quota: 100MB
  - Concurrent downloads: 3

**9. Password Encryption at Rest**
- **Issue**: Passwords stored in `openclaw.json` configuration files in plaintext, exposing credentials if config files are compromised
- **Solution**: Created `src/security/encryption.ts` with AES-256-GCM encryption for password storage:
  - **Algorithm**: AES-256-GCM with authenticated encryption
  - **Key Derivation**: PBKDF2-SHA512 with 100,000 iterations
  - **Format**: Encrypted passwords prefixed with `ENC:` (e.g., `ENC:a1b2c3...`)
  - **Config-Based Key**: Encryption key stored in `openclaw.json` config file
- **New Files**:
  - `src/security/encryption.ts` - Password encryption utilities
- **New Class**: `PasswordEncryption` with methods:
  - `encrypt(plaintext)` - Encrypt password, returns `ENC:hexdata`
  - `decrypt(encryptedData)` - Decrypt password
- **New Functions**:
  - `generateEncryptionKey()` - Generate random 32-byte base64 key
  - `getOrCreateEncryptionKey(config)` - Get existing key or generate new one
  - `encryptPasswordWithKey(password, key)` - Encrypt with specific key
  - `decryptPasswordWithKey(encryptedPassword, key)` - Decrypt with specific key
  - `decryptPasswordFromConfig(config)` - Decrypt using config's encryptionKey
  - `encryptPasswordInConfig(config, password)` - Encrypt and update config
  - `updateConfigWithEncryptedPassword(configPath, password)` - Update config file
- **New CLI Command**:
  - `openclaw xmpp encrypt-password` - Encrypts password in config file
    - Prompts for plaintext password (hidden input)
    - Generates encryptionKey if not present
    - Updates config with encrypted password + encryptionKey
- **Updated Functions**:
  - XMPP client initialization now uses `decryptPasswordFromConfig()`
- **Config Changes**:
  - New field: `encryptionKey` in XMPP account config
  - Password format: `ENC:<encrypted-data>` (encrypted) or plaintext
- **Backward Compatibility**:
  - Plaintext passwords still work
  - Encrypted passwords automatically detected and decrypted
  - Encryption key auto-generated if not present

**8. Improve Rate Limiting**
- **Issue**: `index.ts:109-126` used simple fixed-window rate limiting that could be bypassed by varying JID resources, with no persistent blocking for repeat offenders
- **Solution**: Created `src/security/rateLimiter.ts` with `AdvancedRateLimiter` class implementing:
  - **Sliding Window Algorithm**: More accurate rate limiting using request timestamps instead of fixed windows
  - **IP-Based Limiting**: Separate rate limits per IP address (additional restriction layer)
  - **Graduated Response**: Warns, then throttles, then blocks repeat offenders
  - **Temporary Blocking**: Blocks users after 3 violations for 5 minutes
  - **Remaining Requests**: Returns `remaining` count so users know their limit
  - **Retry-After**: Provides `retryAfter` seconds when blocked
- **New Configuration**:
  - `windowMs: 60000` - 1 minute sliding window
  - `maxRequests: 10` - Max requests per window
  - `blockDurationMs: 300000` - 5 minute block
  - `maxViolationsBeforeBlock: 3` - Violations before blocking
- **New Class**: `AdvancedRateLimiter` with methods:
  - `check(identifier, ip?)` - Check rate limit, returns `{ allowed, reason, remaining, retryAfter }`
  - `unblock(identifier)` - Manually unblock a user
  - `getStats(identifier)` - Get rate limit statistics
  - `getBlockedIdentifiers()` - List all blocked JIDs
  - `reset(identifier?)` - Reset limits for specific or all users
- **Updated Functions**:
  - `checkRateLimit()` now returns remaining count and uses AdvancedRateLimiter
  - Uses `secureLog.warn()` for rate limit warnings
- **Backward Compatibility**: `rateLimiter` exported for CLI access

**7. Sanitize Debug Logs**
- **Issue**: `index.ts` used raw `debugLog()` function that logged sensitive data including JIDs, message content, and potentially credentials to `cli-debug.log`
- **Solution**: Created `src/security/logging.ts` with `secureLog` module that automatically sanitizes sensitive data:
  - **Automatic Redaction**: `secureLog.debug()`, `info()`, `warn()`, `error()` automatically redact:
    - Passwords, API keys, tokens, credentials, secrets
    - Control characters
  - **Sensitive Pattern Detection**: Regex patterns for:
    - `password`, `credentials`, `apiKey`, `token`, `auth`, `secret`
    - `pwd`, `passwd`, `pass`, `key`, `privateKey`, `accessToken`
  - **JID/IP Redaction**: Optional redaction of JIDs and IP addresses
  - **Security/Audit Logging**: Separate `security()` and `audit()` methods for security events
- **New Files**:
  - `src/security/logging.ts` - Secure logging utilities
- **Updated Functions**:
  - All `debugLog()` calls replaced with `secureLog.debug()` for automatic sanitization
- **Protected Data**:
  - Passwords and credentials in logs
  - API keys and tokens
  - Sensitive configuration values

**6. Comprehensive Input Validation**
- **Issue**: Multiple input points lacked validation, allowing potential JID injection, path traversal, and XSS attacks
- **Solution**: Created `src/security/validation.ts` with comprehensive validators applied to all input points:
  - **JID Validation** (`validators.isValidJid()`): RFC 7622 compliant format checking with length limits
  - **JID Sanitization** (`validators.sanitizeJid()`): Lowercase normalization and format validation
  - **Filename Sanitization** (`validators.sanitizeFilename()`): Safe character filtering, length limits, path stripping
  - **Path Validation** (`validators.isSafePath()`): Path traversal prevention with base directory enforcement
  - **XMPP Message Sanitization** (`validators.sanitizeForXmpp()`): Control character removal
  - **Message Body Sanitization** (`validators.sanitizeMessageBody()`): Length limits and control character removal
  - **URL Validation** (`validators.isValidUrl()`): Protocol and hostname validation, blocks localhost/private IPs
  - **Room Name Sanitization** (`validators.sanitizeRoomName()`): Server part validation and name normalization
  - **Nickname Sanitization** (`validators.sanitizeNickname()`): Length limits and control character removal
  - **File Size Validation** (`validators.isValidFileSize()`): Reusable size validation with configurable limits
  - **HTML Sanitization** (`validators.sanitizeForHtml()`): XSS prevention for display purposes
- **New Files**:
  - `src/security/validation.ts` - Comprehensive validation utilities
- **Applied Validators**:
  - `downloadFile()` - URL validation, filename sanitization, path validation
  - MUC invite handler - JID validation for inviter, room name sanitization
  - `fileTransfer.ts` - Filename validation, file size validation
- **Blocked Attack Vectors**:
  - Path traversal via filenames
  - JID injection attacks
  - XSS via message content
  - Private/localhost URL access
  - Control character injection
  
## [1.5.2] - 2026-02-07

### Security

**1. Enable TLS Certificate Verification**
- **Issue**: `index.ts:452` had `tls: { rejectUnauthorized: false }` which disabled certificate verification, making connections vulnerable to MITM attacks
- **Solution**: Removed the insecure TLS configuration. XMPP client now properly validates server certificates by default
- **Risk**: If connecting to servers with self-signed certificates, add the server's certificate to the system's trust store

**2. Remove Auto-Subscription Approval**
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

**3. Add File Size Limits to File Transfers**
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

**4. Admin Approval for MUC Room Invites**
- **Issue**: `index.ts:1195-1220` automatically joined ANY MUC room when invited, allowing anyone to add the bot to malicious rooms
- **Solution**: Modified invite handler to require admin approval:
  - Existing contacts are still auto-approved (backward compatible)
  - New invites are queued in `pendingInvites` Map
  - Admins receive XMPP notifications of pending invites
  - Added CLI commands: `openclaw xmpp invites pending|accept|deny`
- **New Files/Modules**:
  - `PendingInvite` interface for tracking pending invites
  - `acceptRoomInvite()` helper function to join approved rooms
  - `denyRoomInvite()` helper function to decline invites
- **Behavior Change**: The bot no longer auto-joins rooms; invites from non-contacts require admin approval


### Added
- **Subscription Management Commands**: New CLI commands to manage pending subscription requests
  - `openclaw xmpp subscriptions` - Show help
  - `openclaw xmpp subscriptions pending` - List pending requests
  - `openclaw xmpp subscriptions approve <jid>` - Approve request
  - `openclaw xmpp subscriptions deny <jid>` - Deny request
- **Room Invite Management Commands**: New CLI commands to manage pending room invites
  - `openclaw xmpp invites` - Show help
  - `openclaw xmpp invites pending` - List pending invites
  - `openclaw xmpp invites accept <room>` - Accept invite and join room
  - `openclaw xmpp invites deny <room>` - Decline invite

## [1.5.1] - 2026-02-06

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

## [Unreleased]

### Security
- **TLS Certificate Verification**: Removed insecure `rejectUnauthorized: false` TLS option, enforcing proper certificate validation

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