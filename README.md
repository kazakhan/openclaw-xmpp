# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw with support for 1:1 chat, multi-user chat (MUC), CLI management, SFTP file transfers, and comprehensive security features including password encryption at rest and secure file transfer validation.
FTP was added so the OpenClaw bot could upload to a server to have it's own webpage. I just wanted to see what they made, FTP was probably not the way to go...
Need an XMPP server? Check out [Prosody](https://prosody.im/).

## Status: ✅ WORKING

Fully functional with shared sessions, memory continuity, SFTP file transfers, password encryption at rest, and enhanced file transfer security.

## Installation

### Option 1: Clone Repository
```bash
# Create xmpp folder in extensions directory
mkdir -p ~/.openclaw/extensions/xmpp

# Clone the repository
git clone https://github.com/kazakhan/openclaw-xmpp.git ~/.openclaw/extensions/xmpp

# Install dependencies
cd ~/.openclaw/extensions/xmpp
npm install
```

### Option 2: Download Release
1. Download the latest release from https://github.com/kazakhan/openclaw-xmpp/releases
2. Extract to `~/.openclaw/extensions/`
3. Rename `openclaw-xmpp` to `xmpp`
4. Open terminal in `~/.openclaw/extensions/xmpp` and run:
```bash
npm install
```

## Setup

Configure your XMPP account in ~/.openclaw/openclaw.json
- Format in Configuration section below
- Password can be plaintext or encrypted (ENC:...)
- Run `openclaw xmpp encrypt-password` to encrypt existing password

## Security

### Password Encryption at Rest
Passwords are encrypted using AES-256-GCM with PBKDF2-SHA512 key derivation (100,000 iterations).
```bash
openclaw xmpp encrypt-password
```
This prompts for plaintext password and encrypts it in config with an auto-generated encryptionKey.

### Contact Whitelisting
**IMPORTANT**: The bot only responds to whitelisted contacts. Add contacts using:
```bash
openclaw xmpp add jid@domain.com
```
Or message the bot with `/add jid@domain.com` in chat.

### Rate Limiting
- 10 commands/minute per JID
- Excess commands receive: "Too many commands. Please wait before sending more."

### Input Validation
- JID format validation (RFC 7622)
- Filename sanitization (blocks path traversal)
- URL validation
- Message content sanitization (XSS prevention)

### Debug Log Sanitization
Sensitive data automatically redacted from logs:
- Passwords, API keys, tokens
- JIDs and message content
- Configuration metadata

### Secure File Transfer
- MIME type validation with magic byte detection
- Dangerous extension blocking (.exe, .bat, .php, .js, etc.)
- File quarantine system for suspicious files
- Per-user storage quotas
- SHA-256 integrity verification
- Malware pattern scanning (optional)

## Commands

### Core Commands
```bash
openclaw xmpp status              # Check connection status
openclaw xmpp msg <jid> <msg>     # Send direct message
openclaw xmpp add <jid>           # Whitelist contact (required for bot responses)
openclaw xmpp roster               # View roster
openclaw xmpp nick <jid> <name>  # Set nickname
openclaw xmpp join <room> [nick]  # Join MUC room
openclaw xmpp poll                # Poll message queue
openclaw xmpp clear               # Clear message queue
openclaw xmpp queue               # Show queue status
```

### SFTP Commands
```bash
openclaw xmpp sftp upload <local-path> [remote-name]  # Upload file via SFTP
openclaw xmpp sftp download <remote-name> [local-path] # Download file via SFTP
openclaw xmpp sftp ls                                 # List files
openclaw xmpp sftp rm <remote-name>                   # Delete file
openclaw xmpp sftp help                               # Show help
```

### vCard Commands
```bash
openclaw xmpp vcard get              # View current vCard
openclaw xmpp vcard set fn <value>   # Set Full Name
openclaw xmpp vcard set nickname <value> # Set Nickname
openclaw xmpp vcard set url <value>  # Set URL
openclaw xmpp vcard set desc <value> # Set Description
openclaw xmpp vcard set avatarUrl <value> # Set Avatar URL
openclaw xmpp vcard get <jid>        # Query vCard from server for any user
```

### Security Commands
```bash
openclaw xmpp encrypt-password  # Encrypt password in config file (hidden input)
```

## SFTP File Management

Uses same credentials as XMPP server (encrypted password supported). Files stored in personal folder via SSH/SFTP.

### Configuration
Add to `~/.openclaw/openclaw.json`:
```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "sftpPort": 2211
        }
      }
    }
  }
}
```

### SFTP Details
| Setting | Value |
|---------|-------|
| Host | Same as XMPP domain |
| Port | 2211 (SSH/SFTP) |
| User | JID local part |
| Password | Same as XMPP (encrypted supported) |
| Storage | Personal folder |

## vCard Profile

XEP-0054 vCard support for bot profile management and querying users.

### Get Your vCard
```bash
openclaw xmpp vcard get
```

### Set Your vCard
```bash
openclaw xmpp vcard set fn "My Bot Name"
openclaw xmpp vcard set nickname "bot"
openclaw xmpp vcard set url "https://github.com/anomalyco/openclaw"
openclaw xmpp vcard set desc "AI Assistant"
openclaw xmpp vcard set avatarUrl "https://example.com/avatar.png"
```

### Query Any User's vCard
```bash
openclaw xmpp vcard get user@domain.com
```

## Features

- Full XMPP protocol with TLS
- Multi-User Chat (MUC)
- Shared sessions between direct chat and groupchat
- Session memory continuity (experimental)
- XEP-0327 Occupant-ID support for MUC
- Contact & roster management
- vCard support (get/set/query)
- SFTP file transfers (SSH-based, encrypted)
- Password encryption at rest (AES-256-GCM)
- Comprehensive input validation (JID, filename, URL)
- Secure debug logging (sensitive data redaction)
- Enhanced file transfer security (MIME validation, quarantine, malware scanning)
- Per-user storage quotas
- Rate limiting (10 commands/minute)

## Configuration Notes
- `password`: Use plaintext for initial setup, then run `openclaw xmpp encrypt-password` to encrypt
- `encryptionKey`: Auto-generated when encrypting password
- `sessionMemory`: Enable shared session memory between direct chat and groupchat

## Quick Start

```bash
# Configure account in ~/.openclaw/openclaw.json
openclaw xmpp encrypt-password  # Encrypt your password (recommended)

openclaw xmpp add user@domain.com  # Whitelist contact
openclaw xmpp status               # Test connection
openclaw xmpp sftp upload /path/to/file.pdf
```

## File Layout

```
xmpp/
├── index.ts                    # Main plugin with XMPP client, MUC, messaging
├── package.json                # Dependencies (@xmpp/client, ssh2, basic-ftp)
├── openclaw.plugin.json
├── src/
│   ├── commands.ts           # CLI commands registration
│   ├── sftp.ts               # SFTP client (SSH-based, encrypted password)
│   ├── ftp.ts                # FTP client (legacy)
│   ├── contacts.ts           # Contact management
│   ├── messageStore.ts       # Message persistence
│   ├── vcard.ts              # vCard handling
│   ├── vcard-cli.ts          # vCard CLI commands
│   ├── fileTransfer.ts       # HTTP upload/SI file transfer
│   ├── roster.ts             # Roster management
│   ├── jsonStore.ts          # JSON storage utilities
│   ├── types.ts              # TypeScript types
│   ├── state.ts              # State management
│   ├── logger.ts             # Logging utilities
│   ├── utils.ts              # Utility functions
│   └── security/
│       ├── encryption.ts     # Password encryption (AES-256-GCM)
│       ├── validation.ts     # Input validation (JID, filename, URL)
│       ├── logging.ts        # Secure debug logging with sanitization
│       └── fileTransfer.ts   # Secure file transfer (MIME, quarantine, malware)
├── data/                     # Storage
│   ├── xmpp-contacts.json
│   ├── xmpp-admins.json
│   ├── xmpp-vcard.json
│   └── messages/
│       ├── direct/
│       └── group/
├── quarantine/               # Quarantined files (auto-created)
├── temp/                     # Temporary files (auto-created)
├── README.md
└── CHANGELOG.md
```

## Session Memory (Experimental)

Enable shared session memory between direct chat and groupchat for identified users:

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

This uses consistent session keys (`xmpp:user@domain.com`) across conversation types for memory continuity.

## License

Part of OpenClaw ecosystem. See main repository for license info.
