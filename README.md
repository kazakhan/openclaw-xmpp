# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw that enables XMPP/Jabber integration with support for 1:1 chat, multi-user chat (MUC), CLI management, and FTP file transfers.

## Status: ✅ WORKING

The XMPP plugin is now fully functional with CLI command support, shared sessions, memory continuity, and FTP file transfers!

## Security

The XMPP plugin implements multiple security measures:

### Input Validation
- **Path Traversal Protection**: File downloads and transfers sanitize filenames to prevent directory traversal attacks
- **Rate Limiting**: Command rate limiting per JID (10 commands/minute) to prevent abuse
- **Queue Enforcement**: Message queue limited to 100 messages to prevent memory exhaustion

### Rate Limiting
- Commands are rate limited per sender JID
- Users exceeding the limit receive: "Too many commands. Please wait before sending more."
- Rate limit window: 1 minute

### Path Traversal Protection
- Download filenames are sanitized: illegal characters replaced with `_`
- Paths are normalized and checked for `..` or absolute paths
- IBB file transfers also sanitize filenames on completion

### Contact Whitelisting
**IMPORTANT**: The bot only responds to whitelisted contacts. Add contacts using:
```bash
openclaw xmpp add jid@domain.com
```
Or message the bot directly with `/add jid@domain.com` in chat. Users not in your contact list will be ignored by the bot.

## Shared Sessions & Memory

The XMPP plugin supports **shared session memory** between direct chat and groupchat:

### How It Works
1. **Direct Chat**: Messages create sessions keyed by user's bare JID (e.g., `xmpp:user@domain.com`)
2. **GroupChat**: When user is identified, uses same session key for memory continuity
3. **Memory**: Agent remembers conversation context across both conversation types

### User Identification
- **Occupant-ID (XEP-0327)**: Server provides stable occupant IDs for automatic identification
- **Known Users**: When a user messages directly first, their nick is learned for future groupchat sessions

### Session Memory Configuration
Add to `~/.openclaw/openclaw.json`:
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

## FTP File Management

The XMPP plugin includes FTP file transfer support using the same credentials as your XMPP server.

### FTP Commands
```bash
openclaw xmpp ftp upload <local-path> [remote-name]  # Upload file (overwrites existing)
openclaw xmpp ftp download <remote-name> [local-path] # Download file
openclaw xmpp ftp ls                                  # List files in your folder
openclaw xmpp ftp rm <remote-name>                    # Delete file
openclaw xmpp ftp help                               # Show FTP help
```

### FTP Configuration
Add `ftpPort` to your XMPP account config:
```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "ftpPort": 17323
        }
      }
    }
  }
}
```

### FTP Details
- **Host**: Same as XMPP domain
- **Port**: 17323 (configurable via `ftpPort`)
- **User**: Your XMPP JID (local part only)
- **Password**: Same as XMPP password
- **Storage**: Files are stored in your personal folder (JID-based isolation)

### FTP Examples
```bash
# Upload a file
openclaw xmpp ftp upload C:\Users\kazak\Documents\report.pdf
openclaw xmpp ftp upload C:\Users\kazak\Documents\report.pdf custom-name.pdf

# Download a file
openclaw xmpp ftp download report.pdf
openclaw xmpp ftp download report.pdf C:\Downloads\report.pdf

# List and manage files
openclaw xmpp ftp ls
openclaw xmpp ftp rm old-file.pdf
```

### FTP Server Requirements
- FTP server must be running on the same domain as XMPP
- Passive port range must be open (e.g., 40000-40100 for vsFTPd)
- User must have write permissions in their home directory

## Commands

```
openclaw xmpp --help
openclaw xmpp status
openclaw xmpp msg user@domain.com "Hello"
openclaw xmpp add jid@domain.com
openclaw xmpp roster
openclaw xmpp nick <jid> <name>
openclaw xmpp join <room> [nick]
openclaw xmpp poll
openclaw xmpp clear
openclaw xmpp queue
openclaw xmpp ftp upload <path> [name]
openclaw xmpp ftp download <name> [path]
openclaw xmpp ftp ls
openclaw xmpp ftp rm <name>
```

Or use the standard OpenClaw message command:
```bash
openclaw message send --channel xmpp --target user@domain.com --message "Hello"
```

## Features

### 🚀 Core XMPP Protocol
- **Full XMPP Client**: Complete XMPP protocol implementation using `@xmpp/client`
- **Multi-User Chat (MUC)**: Join and participate in group chat rooms
- **Direct Messaging**: 1:1 chat with individual users
- **Presence Management**: Online/offline status handling
- **Auto-Reconnection**: Automatic reconnection on network issues
- **TLS Support**: Secure connections
- **Occupant-ID (XEP-0327)**: Stable user identification in MUC rooms

### 👥 Shared Sessions & Memory
- **Session Continuity**: Same session used for direct chat and groupchat when user identified
- **Automatic Learning**: Users who message directly have their nicks learned for groupchat

### 👥 Contact & Roster Management
- **Contact Storage**: In-memory roster with nickname support
- **Admin Management**: Privileged commands for configured admin JIDs
- **Roster CLI**: View and manage roster via command-line

### ⚙️ Room & Conference Management
- **Room Auto-Join**: Automatically join configured rooms on startup
- **MUC Invite Handling**: Auto-accept room invitations

### 📁 FTP File Management
- **Upload**: Upload files to personal FTP folder using XMPP credentials
- **Download**: Download files from personal FTP folder
- **List**: List files in your FTP folder
- **Delete**: Remove files from FTP folder
- **Same Credentials**: Uses same JID/password as XMPP server

### 🔧 CLI Integration
All commands work through the OpenClaw CLI:
```bash
openclaw xmpp status              # Check connection status
openclaw xmpp msg <jid> <msg>    # Send direct messages
openclaw xmpp add <jid>          # Whitelist a contact (required for bot responses)
openclaw xmpp roster             # View current roster
openclaw xmpp nick <jid> <name>  # Set roster nickname
openclaw xmpp join <room> [nick] # Join MUC rooms
openclaw xmpp poll               # Poll message queue
openclaw xmpp clear              # Clear message queue
openclaw xmpp queue              # Show queue status
openclaw xmpp ftp upload <path>  # Upload file to FTP
openclaw xmpp ftp download <name> # Download file from FTP
openclaw xmpp ftp ls             # List FTP files
openclaw xmpp ftp rm <name>      # Delete FTP file
```

### 🔄 Message Queue System
- **Inbound Queue**: Temporary storage for inbound messages
- **Queue Management**: Poll, clear, and monitor via CLI
- **Age-Based Cleanup**: Automatic cleanup of old messages

## Installation

### Prerequisites
- Node.js (v16 or higher)
- OpenClaw installation (2026.1.24-3 or later with CLI fixes)
- XMPP server account (Prosody, ejabberd, etc.)

### Installation
1. Plugin is located at `~/.openclaw/extensions/xmpp/`
2. Ensure OpenClaw is configured with XMPP channel enabled
3. Gateway must be running for message sending to work

## Configuration

### Basic Configuration
Add to `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "xmpp": {
        "enabled": true
      }
    }
  },
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

### Configuration with FTP Support
```json
{
  "plugins": {
    "entries": {
      "xmpp": {
        "enabled": true
      }
    }
  },
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
          "dataDir": "/path/to/data",
          "ftpPort": 17323
        }
      }
    }
  }
}
```

### Configuration Options
| Option | Description | Required |
|--------|-------------|----------|
| `service` | XMPP server URL with protocol and port | Yes |
| `domain` | XMPP server domain | Yes |
| `jid` | Bot's XMPP JID | Yes |
| `password` | XMPP account password | Yes |
| `adminJid` | Admin JID for privileged commands | No |
| `rooms` | Array of MUC rooms to auto-join | No |
| `dataDir` | Plugin data directory | No |
| `ftpPort` | FTP server port (default: 17323) | No |

## Quick Start

```bash
# Check XMPP status
openclaw xmpp status

# Send a message
openclaw xmpp msg user@domain.com "Hello from OpenClaw!"

# Add a contact (required for bot to respond)
openclaw xmpp add user@domain.com

# Join a MUC room
openclaw xmpp join room@conference.domain.com

# FTP file transfers
openclaw xmpp ftp upload C:\Users\kazak\Documents\report.pdf
openclaw xmpp ftp download report.pdf
openclaw xmpp ftp ls

# Or use the standard message command
openclaw message send --channel xmpp --target user@domain.com --message "Hello"
```

## First Steps

1. **Configure** your XMPP account in `~/.openclaw/openclaw.json`
2. **Add contacts** using `openclaw xmpp add jid@domain.com` - the bot only responds to whitelisted users
3. **Start the gateway** if not already running: `openclaw gateway`
4. **Test** with `openclaw xmpp status`

## Architecture

The plugin consists of:

### Core Components
- `index.ts` - Main plugin with XMPP client, message handling, and CLI registration
- `src/commands.ts` - CLI command definitions for all xmpp subcommands
- `src/ftp.ts` - FTP client module for file upload/download operations

### Support Modules
- `src/contacts.ts` - Contact and admin management
- `src/messageStore.ts` - Message persistence and archiving
- `src/vcard.ts` - vCard profile handling
- `src/fileTransfer.ts` - HTTP and IBB file transfer support
- `src/types.ts` - TypeScript type definitions
- `src/utils.ts` - Common utility functions

## Troubleshooting

### "unknown command 'xmpp'"
- Ensure OpenClaw CLI fixes are applied (see `openclaw-cli-fix.zip`)
- Run `openclaw plugins list` to verify plugin loads

### "No XMPP client available"
- Gateway must be running: `openclaw gateway`
- Messages route through gateway when client not available locally

### Messages not sending
- Verify gateway is running: `openclaw gateway status`
- Check target JID format: `user@domain.com`

## Files & File Layout

```
xmpp/
├── index.ts              # Main plugin with XMPP client, message handling, CLI registration
├── package.json          # Dependencies (includes basic-ftp for file transfers)
├── openclaw.plugin.json  # Plugin metadata
├── src/
│   ├── commands.ts       # CLI command definitions (xmpp, msg, join, roster, ftp, etc.)
│   ├── ftp.ts            # FTP client module for file transfers
│   ├── contacts.ts       # Contact management
│   ├── messageStore.ts   # Message persistence
│   ├── vcard.ts          # vCard handling
│   ├── vcard-cli.ts     # vCard CLI helpers
│   ├── types.ts          # TypeScript interfaces
│   ├── utils.ts          # Utility functions
│   ├── roster.ts         # Roster management
│   ├── jsonStore.ts      # JSON storage abstraction
│   ├── logger.ts         # Logging utilities
│   └── fileTransfer.ts   # HTTP/IBB file transfer handlers
├── data/
│   ├── xmpp-contacts.json    # Contact storage
│   ├── xmpp-admins.json      # Admin list
│   ├── xmpp-vcard.json       # vCard data
│   └── messages/             # Archived messages
├── README.md             # This file
├── CHANGELOG.md          # Change history
└── FAQ.md                # Common questions
```
xmpp/
├── index.ts              # Main plugin
├── package.json          # Dependencies
├── openclaw.plugin.json  # Plugin metadata
├── data/
│   └── commands.ts       # CLI commands
├── README.md             # This file
├── CHANGELOG.md          # Change history
├── FAQ.md                # Common questions
└── ROADMAP.md            # Planned features
```

## License

Part of OpenClaw ecosystem. See main repository for license info.