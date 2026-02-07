# Changelog

All notable changes to the OpenClaw XMPP plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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