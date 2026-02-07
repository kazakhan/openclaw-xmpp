# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw with support for 1:1 chat, multi-user chat (MUC), CLI management, and SFTP file transfers.
SFTP was added so the OpenClaw bot could upload files to a server using SSH. Uses the same credentials as your XMPP account.
Need an XMPP server? Check out [Prosody](https://prosody.im/).

## Status: ✅ WORKING

Fully functional with shared sessions, memory continuity, rate limiting, audit logging, and secure SFTP file transfers.

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

1. Configure your XMPP account in `~/.openclaw/openclaw.json`
2. See Configuration section below for format
3. Run `openclaw xmpp status` to test connection

## Security

### Contact Whitelisting
**IMPORTANT**: The bot only responds to whitelisted contacts. Add contacts using:
```bash
openclaw xmpp add jid@domain.com
```
Or message the bot with `/add jid@domain.com` in chat.

### Subscription Approval
New subscription requests require admin approval. Use:
```bash
openclaw xmpp subscriptions pending   # List pending requests
openclaw xmpp subscriptions approve <jid>  # Approve
openclaw xmpp subscriptions deny <jid>     # Deny
```

### Rate Limiting
- 10 commands/minute per JID
- Excess commands receive: "Too many commands. Please wait before sending more."
- Temporary block after repeated violations

### Password Encryption
Passwords are encrypted at rest using AES-256-GCM. Encrypt your password:
```bash
openclaw xmpp encrypt-password
```

### Path Traversal Protection
- Filenames sanitized: illegal chars replaced with `_`
- Paths normalized and checked for `..` or absolute paths

## Commands

### Connection & Status
```bash
openclaw xmpp status              # Check connection status
openclaw xmpp start               # Start gateway in background
```

### Messaging
```bash
openclaw xmpp msg <jid> <msg>    # Send direct message
```

### Contact Management
```bash
openclaw xmpp add <jid>           # Whitelist contact (required for bot responses)
openclaw xmpp roster              # View roster
openclaw xmpp nick <jid> <name>   # Set nickname
```

### Room Management
```bash
openclaw xmpp join <room> [nick]  # Join MUC room
openclaw xmpp invite <jid> <room>  # Invite a contact to a MUC room
```

### MUC Invites
The bot auto-accepts all MUC invites. When you invite someone:
```bash
/invite clawdbothome@kazakhan.com general
```
The invited contact receives the invite and automatically joins the room.

### Message Queue
```bash
openclaw xmpp poll                # Poll message queue
openclaw xmpp clear              # Clear message queue
openclaw xmpp queue              # Show queue status
```

### Subscription Management
```bash
openclaw xmpp subscriptions pending   # List pending requests
openclaw xmpp subscriptions approve <jid>  # Approve
openclaw xmpp subscriptions deny <jid>     # Deny
openclaw xmpp subscriptions help          # Show help
```

### SFTP File Management
```bash
openclaw xmpp sftp upload <local-path> [remote-name]  # Upload file
openclaw xmpp sftp download <remote-name> [local-path] # Download file
openclaw xmpp sftp ls                                # List files
openclaw xmpp sftp rm <remote-name>                  # Delete file
openclaw xmpp sftp help                              # Show help
```

### Security Commands
```bash
openclaw xmpp encrypt-password    # Encrypt password in config
openclaw xmpp file-transfer-security status   # Show file transfer security status
openclaw xmpp audit status        # Show audit logging status
openclaw xmpp audit list [limit] # List recent audit events
```

### vCard Commands
```bash
openclaw xmpp vcard get           # View current vCard
openclaw xmpp vcard set fn <name> # Set Full Name
openclaw xmpp vcard set nickname <name>  # Set Nickname
openclaw xmpp vcard set url <url>  # Set URL
openclaw xmpp vcard set desc <desc>  # Set Description
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

Uses SSH/SFTP with your XMPP account credentials. Files stored in your home directory.

### SFTP Details
| Setting | Value |
|---------|-------|
| Host | kazakhan.com |
| Port | 2211 (SSH) |
| User | JID local part |
| Password | Same as XMPP (encrypted at rest) |
| Storage | Home directory |

### Legacy FTP (Deprecated)
The old FTP implementation is preserved for backward compatibility:
```bash
openclaw xmpp ftp upload <local-path> [remote-name]
openclaw xmpp ftp download <remote-name> [local-path]
openclaw xmpp ftp ls
openclaw xmpp ftp rm <remote-name>
```
Note: FTP transmits data unencrypted. Use SFTP instead.

## Features

- Full XMPP protocol with TLS certificate verification
- Multi-User Chat (MUC)
- Shared sessions between direct chat and groupchat
- Contact & roster management
- vCard support
- SFTP file transfers via SSH
- Comprehensive input validation
- Rate limiting with graduated blocking
- Audit logging for security events
- Admin approval workflows for subscriptions and invites
- Password encryption at rest

## Configuration

```json
{
  "channels": {
    "xmpp": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "service": "xmpp://your-server.com:5222",
          "domain": "your-server.com",
          "jid": "bot@your-server.com",
          "password": "your-password",
          "adminJid": "admin@your-server.com",
          "rooms": ["general@conference.your-server.com"],
          "dataDir": "/path/to/data"
        }
      }
    }
  }
}
```

### Optional: Password Encryption
After configuring your account, encrypt the password:
```bash
openclaw xmpp encrypt-password
```
This adds `encryptionKey` to your config and stores the password encrypted.

## Quick Start

```bash
# Configure account in ~/.openclaw/openclaw.json
openclaw xmpp add user@domain.com  # Whitelist contact
openclaw xmpp status               # Test connection
openclaw xmpp sftp upload /path/to/file.pdf  # Upload via SFTP
```

## Files

```
xmpp/
├── index.ts              # Main plugin
├── package.json          # Dependencies
├── openclaw.plugin.json
├── src/
│   ├── commands.ts      # CLI commands
│   ├── sftp.ts          # SFTP client (NEW)
│   ├── ftp.ts           # Legacy FTP client
│   ├── contacts.ts      # Contact management
│   ├── messageStore.ts
│   ├── vcard.ts         # vCard handling
│   ├── fileTransfer.ts   # Secure file transfer
│   └── security/        # Security modules
│       ├── audit.ts      # Audit logging
│       ├── encryption.ts # Password encryption
│       ├── fileTransfer.ts
│       ├── logging.ts    # Secure logging
│       ├── rateLimiter.ts
│       └── validation.ts # Input validation
├── data/                # Storage
│   ├── xmpp-contacts.json
│   ├── xmpp-admins.json
│   ├── xmpp-vcard.json
│   └── messages/
├── logs/                # Audit logs
│   └── audit-*.log
├── temp/                # Temporary files
├── quarantine/          # Suspicious files
├── README.md
└── CHANGELOG.md
```

## License

Part of OpenClaw ecosystem. See main repository for license info.
