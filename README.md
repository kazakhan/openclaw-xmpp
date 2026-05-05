# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw with support for 1:1 chat, multi-user chat (MUC), CLI management, SFTP file transfers, and comprehensive security features including password encryption at rest and secure file transfer validation.
FTP was added so the OpenClaw bot could upload to a server to have it's own webpage. I just wanted to see what they made, FTP was probably not the way to go...
Need an XMPP server? Check out [Prosody](https://prosody.im/).

## Status: ✅ WORKING

Fully functional with shared sessions, memory continuity, SFTP file transfers, password encryption at rest, and enhanced file transfer security.

## Installation

### Prerequisites
- OpenClaw 2026.5+ (tested on 2026.5.3-2026.5.4)
- Node.js >= 22
- npm

### Quick Install (recommended)

#### Linux
```bash
# Clone and run installer
git clone https://github.com/kazakhan/openclaw-xmpp.git ~/.openclaw/extensions/xmpp
chmod +x ~/.openclaw/extensions/xmpp/install.sh
~/.openclaw/extensions/xmpp/install.sh
```

#### Windows (PowerShell)
```powershell
# Clone and run installer
git clone https://github.com/kazakhan/openclaw-xmpp.git "$env:USERPROFILE\.openclaw\extensions\xmpp"
& "$env:USERPROFILE\.openclaw\extensions\xmpp\install.ps1"
```

### Manual Install

#### Step 1: Get the code
```bash
# Linux
mkdir -p ~/.openclaw/extensions/xmpp
git clone https://github.com/kazakhan/openclaw-xmpp.git ~/.openclaw/extensions/xmpp
```
```powershell
# Windows
md "$env:USERPROFILE\.openclaw\extensions\xmpp" -Force
git clone https://github.com/kazakhan/openclaw-xmpp.git "$env:USERPROFILE\.openclaw\extensions\xmpp"
```

#### Step 2: Install dependencies
```bash
cd ~/.openclaw/extensions/xmpp
npm install
```

#### Step 3: Remove old compiled JS
```bash
rm -rf ~/.openclaw/extensions/xmpp/dist
```
The `dist/` directory contains compiled JavaScript that can shadow edited `.ts` source files. Always delete it after pulling updates.

#### Step 4: Compile TypeScript
OpenClaw 2026.5.4+ requires compiled JS for plugin installation:
```bash
cd ~/.openclaw/extensions/xmpp
npx tsc
```
Type errors in the codebase are pre-existing and non-blocking; the compiler will still emit the required JS files.

#### Step 5: Register the plugin
```bash
openclaw plugins install --force ~/.openclaw/extensions/xmpp
```
The `--force` flag bypasses the security scanner (the plugin uses `child_process` for SSH/SFTP support — legitimate functionality).

#### Step 6: Configure your XMPP account
```bash
openclaw config set channels.xmpp.accounts.default.service "xmpp://your-server:5222"
openclaw config set channels.xmpp.accounts.default.domain "your-domain"
openclaw config set channels.xmpp.accounts.default.jid "user@domain"
openclaw config set channels.xmpp.accounts.default.password "your-password"
openclaw config set channels.xmpp.accounts.default.dataDir "~/.openclaw/extensions/xmpp/data"
openclaw config set channels.xmpp.accounts.default.enabled true
```

#### Step 7: Enable groupchat replies
OpenClaw 2026.5+ suppresses channel delivery for groupchat by default. This is required for the plugin to send responses to MUC rooms:
```bash
openclaw config set messages.groupChat.visibleReplies automatic
```

#### Step 8: Start the gateway
```bash
openclaw gateway
```

#### Step 9: Whitelist contacts
```bash
openclaw xmpp add user@domain.com
```

## Configuration

### XMPP Account
Configured under `channels.xmpp.accounts.default` in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "enabled": true,
          "service": "xmpp://your-server:5222",
          "domain": "your-domain",
          "jid": "bot@domain",
          "password": "your-password",
          "dataDir": "/home/user/.openclaw/extensions/xmpp/data",
          "resource": "openclaw",
          "adminJid": "admin@domain",
          "nick": "MyBot",
          "dmPolicy": "open",
          "allowFrom": [],
          "rooms": [],
          "vcard": {
            "fn": "My Bot Name",
            "nickname": "MyBot"
          }
        }
      }
    }
  },
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  }
}
```

### Password Encryption
```bash
openclaw xmpp encrypt-password
```
Encrypts the `password` field in config using AES-256-GCM with PBKDF2-SHA512.

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
### Security Commands
```bash
openclaw xmpp encrypt-password  # Encrypt password in config file (hidden input)
```

### vCard Commands

XEP-0054 vCard support for bot profile management and querying users.

```bash
openclaw xmpp vcard get              # View current vCard
openclaw xmpp vcard set fn <value>   # Set Full Name
openclaw xmpp vcard set nickname <value> # Set Nickname
openclaw xmpp vcard set url <value>  # Set URL
openclaw xmpp vcard set desc <value> # Set Description
openclaw xmpp vcard set avatarUrl <value> # Set Avatar URL
openclaw xmpp vcard get <jid>        # Query vCard from server for any user
```

## In-Chat Slash Commands

Use these commands directly in XMPP chat (direct message or groupchat) to control the bot.

### Available to Everyone
```bash
/whoami                          # Show your info (room/nick in groupchat)
/help                            # Show available commands
/whiteboard draw <prompt>        # Request AI image generation
/whiteboard send <url>           # Share an image URL
```

### Admin Only (Direct Chat)
```bash
/list                            # List all contacts
/add <jid> [name]               # Add a contact
/remove <jid>                    # Remove a contact
/admins                          # List admin users
/join <room> [nick]              # Join a MUC room
/invite <jid> <room>             # Invite a contact to a MUC room
/rooms                           # List joined rooms
/leave <room>                   # Leave a MUC room
/vcard                           # Manage vCard profile
/vcard get                       # Show current vCard
/vcard get <jid>                 # Show any user's vCard
/vcard set fn <name>             # Set Full Name
/vcard set nickname <name>       # Set Nickname
/vcard set url <url>             # Set URL
/vcard set desc <desc>           # Set Description
/vcard set avatarUrl <url>       # Set Avatar URL
```

### Notes
- Admin commands require your JID to be in the `adminJid` config
- Most admin commands only work in direct chat (not groupchat)
- The `/help` command forwards to the AI agent in direct chat
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
`

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
- `visibleReplies`: **Must** be set to `"automatic"` for groupchat replies to work (see Installation Step 7)

## Quick Start

```bash
# Configure account
openclaw config set channels.xmpp.accounts.default.service "xmpp://your-server:5222"
openclaw config set channels.xmpp.accounts.default.domain "your-domain"
openclaw config set channels.xmpp.accounts.default.jid "user@domain"
openclaw config set channels.xmpp.accounts.default.password "your-password"
openclaw config set channels.xmpp.accounts.default.dataDir "~/.openclaw/extensions/xmpp/data"
openclaw config set channels.xmpp.accounts.default.enabled true
openclaw config set messages.groupChat.visibleReplies automatic

# Encrypt your password (recommended)
openclaw xmpp encrypt-password

# Whitelist contacts
openclaw xmpp add user@domain.com

# Start gateway
openclaw gateway
```

## Troubleshooting

### Plugin not found / unknown channel id
```bash
openclaw plugins install --force ~/.openclaw/extensions/xmpp
```

### "requires compiled runtime output for TypeScript entry"
Run `npx tsc` in the plugin directory to compile TypeScript, then re-install. Delete `dist/` first if updating from a previous version.

### No groupchat replies (agent responds in webchat but not in room)
```bash
openclaw config set messages.groupChat.visibleReplies automatic
```
OpenClaw 2026.5+ defaults to `message_tool_only` for group/channel messages, which suppresses the channel `deliver` callback. Setting `visibleReplies = "automatic"` restores channel delivery.

### Changes to .ts files have no effect
Delete the `dist/` directory — compiled JS files there take precedence over `.ts` sources when OpenClaw loads the plugin.

### Plugin install blocked by security scanner
```bash
openclaw plugins install --force ~/.openclaw/extensions/xmpp
```
The scanner flags `child_process` usage (SSH/SFTP) and environment variable access. These are legitimate and required for the plugin's file transfer features.

### "write after end" crash on reconnect (ERR_STREAM_WRITE_AFTER_END)
This was fixed by checking `xmpp.status` before calling `stop()` in the reconnect logic. Update to the latest version.

### Certificate errors (CERT_HAS_EXPIRED)
Your XMPP server's SSL certificate has expired. Renew it on the server, or use a trusted CA.

## File Layout

```
xmpp/
├── index.ts                    # Plugin entry point (register function)
├── setup-entry.ts              # Setup entry (re-exports from index.ts)
├── package.json                # Dependencies (@xmpp/client, ssh2)
├── openclaw.plugin.json        # Plugin manifest (channel registration)
├── tsconfig.json               # TypeScript compiler configuration
├── install.sh                  # Linux install script
├── install.ps1                 # Windows install script
├── src/
│   ├── gateway.ts            # Gateway lifecycle (start/stop account, message dispatch)
│   ├── startXMPP.ts          # XMPP client setup, stanza handler, reconnection
│   ├── outbound.ts           # Outbound message sending
│   ├── commands.ts           # CLI commands registration
│   ├── contacts.ts           # Contact management
│   ├── whiteboard.ts         # Whiteboard (SXE/SWB) message parsing
│   ├── whiteboard-session.ts # Whiteboard session manager
│   ├── messageStore.ts       # Message persistence
│   ├── vcard.ts              # vCard handling
│   ├── vcard-cli.ts          # vCard CLI commands
│   ├── fileTransfer.ts       # HTTP upload/SI file transfer
│   ├── jsonStore.ts          # JSON storage utilities
│   ├── types.ts              # TypeScript types
│   ├── config.ts             # Plugin configuration constants
│   ├── gateway-client.ts     # Gateway RPC client
│   ├── sftp.ts               # SFTP client (SSH-based)
│   └── security/
│       ├── adapter.ts        # Security adapter for OpenClaw SDK
│       ├── encryption.ts     # Password encryption (AES-256-GCM)
│       ├── validation.ts     # Input validation (JID, filename, URL)
│       ├── fileTransfer.ts   # Secure file transfer (MIME, quarantine)
│   └── lib/
│       ├── logger.ts         # Logging utilities
│       ├── upload-protocol.ts # HTTP File Upload (XEP-0363)
│       ├── vcard-protocol.ts # vCard protocol helpers
│       ├── persistent-queue.ts # Persistent message queue
│       ├── contact-factory.ts # Contact factory
│       └── config-loader.ts  # Config loader
├── data/                     # Storage (per-install, DO NOT COPY between machines)
│   ├── xmpp-contacts.json
│   ├── xmpp-admins.json
│   ├── xmpp-vcard.json
│   └── messages/
│       ├── direct/
│       └── group/
├── dist/                     # Compiled JS (delete after pulling updates)
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
