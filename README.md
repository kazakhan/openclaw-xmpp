# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw with support for 1:1 chat, multi-user chat (MUC), CLI management, and FTP file transfers.
FTP was added so the OpenClaw bot could upload to server to have it's own webpage. I just wanted to see what they made, FTP was probably not the way to go...
Need an XMPP server? Check out [Prosody](https://prosody.im/).

## Status: ✅ WORKING

Fully functional with shared sessions, memory continuity, and FTP file transfers.

## Security

### Contact Whitelisting
**IMPORTANT**: The bot only responds to whitelisted contacts. Add contacts using:
```bash
openclaw xmpp add jid@domain.com
```
Or message the bot with `/add jid@domain.com` in chat.

### Rate Limiting
- 10 commands/minute per JID
- Excess commands receive: "Too many commands. Please wait before sending more."

### Path Traversal Protection
- Filenames sanitized: illegal chars replaced with `_`
- Paths normalized and checked for `..` or absolute paths

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

### FTP Commands
```bash
openclaw xmpp ftp upload <local-path> [remote-name]  # Upload file
openclaw xmpp ftp download <remote-name> [local-path] # Download file
openclaw xmpp ftp ls                                # List files
openclaw xmpp ftp rm <remote-name>                  # Delete file
openclaw xmpp ftp help                              # Show help
```

## FTP File Management

Uses same credentials as XMPP server. Files stored in personal folder.

### Configuration
Add to `~/.openclaw/openclaw.json`:
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
| Setting | Value |
|---------|-------|
| Host | Same as XMPP domain |
| Port | 17323 (configurable) |
| User | JID local part |
| Password | Same as XMPP |
| Storage | Personal folder |

## Features
- Full XMPP protocol with TLS
- Multi-User Chat (MUC)
- Shared sessions between direct chat and groupchat
- Contact & roster management
- vCard support
- FTP file transfers

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
          "dataDir": "/path/to/data",
          "ftpPort": 17323
        }
      }
    }
  }
}
```

## Quick Start
```bash
# Configure account in ~/.openclaw/openclaw.json
openclaw xmpp add user@domain.com  # Whitelist contact
openclaw xmpp status               # Test connection
openclaw xmpp ftp upload /path/to/file.pdf
```

## Files
```
xmpp/
├── index.ts            # Main plugin
├── package.json        # Dependencies
├── openclaw.plugin.json
├── src/
│   ├── commands.ts    # CLI commands
│   ├── ftp.ts         # FTP client
│   ├── contacts.ts    # Contact management
│   ├── messageStore.ts
│   ├── vcard.ts       # vCard handling
│   └── fileTransfer.ts
├── data/              # Storage
│   ├── xmpp-contacts.json
│   ├── xmpp-admins.json
│   ├── xmpp-vcard.json
│   └── messages/
├── README.md
└── CHANGELOG.md
```

## License

Part of OpenClaw ecosystem. See main repository for license info.
