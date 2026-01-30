# ClawdBot XMPP Plugin

A full-featured XMPP channel plugin for ClawdBot that enables XMPP/Jabber integration with support for 1:1 chat, multi-user chat (MUC), file transfer, and whiteboard functionality.

## Features

### 🚀 Core Features
- **XMPP Protocol Support**: Full XMPP client implementation using `@xmpp/client`
- **Multi-User Chat (MUC)**: Join and participate in group chat rooms
- **Direct Messaging**: 1:1 chat with individual users
- **Auto-Reconnection**: Automatic reconnection on network issues
- **Presence Management**: Online/offline status handling

### 📁 File Transfer
- **HTTP Upload (XEP-0363)**: Send files via HTTP Upload protocol
- **SI File Transfer (XEP-0096)**: Receive files via In-Band Bytestreams (IBB)
- **File Download**: Download files from URLs to local storage
- **Auto-Accept**: Automatically accept and save incoming file transfers

### 🎨 Whiteboard Integration
- **Image Generation**: `/whiteboard draw <prompt>` - Request image generation from agents
- **Image Sharing**: `/whiteboard send <url>` - Share images via file transfer
- **Status Check**: `/whiteboard status` - Check whiteboard capabilities

### ⚙️ Administration
- **Slash Commands**: Built-in command system for room management
- **Room Auto-Join**: Automatically join configured rooms on startup
- **Contact Management**: Store and manage XMPP contacts
- **Admin Controls**: Admin JID configuration for privileged commands

## Installation

### Prerequisites
- Node.js (v16 or higher)
- ClawdBot installation
- XMPP server account (Prosody, ejabberd, etc.)

### Installation Steps
1. Clone or copy the plugin to your ClawdBot extensions directory:
   ```bash
   cd ~/.clawdbot/extensions
   git clone <repository-url> clawdbot-xmpp
   ```

2. Install dependencies:
   ```bash
   cd clawdbot-xmpp
   npm install
   ```

3. Configure the plugin in `clawdbot.json` (see Configuration section)

4. Restart ClawdBot

## Configuration

Add the following configuration to your `clawdbot.json`:

```json
{
  "plugins": {
    "entries": {
      "clawdbot-xmpp": {
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
          "rooms": [
            "general@conference.your-server.com",
            "chat@conference.your-server.com"
          ],
          "dataDir": "/path/to/data/directory"
        }
      }
    }
  }
}
```

### Configuration Options
- `service`: XMPP server address (e.g., `xmpp://example.com:5222`)
- `domain`: XMPP domain
- `jid`: Bot's JID (e.g., `bot@example.com`)
- `password`: Bot's password
- `adminJid`: Administrator JID for privileged commands
- `rooms`: Array of MUC rooms to auto-join
- `dataDir`: Directory for storing contacts, downloads, and plugin data

## Usage

### Slash Commands

The plugin supports various slash commands in XMPP chats:

#### Basic Commands
- `/help` - Show all available commands
- `/status` - Show connection status
- `/rooms` - List joined rooms
- `/join <room> [nick]` - Join a MUC room
- `/leave <room>` - Leave a MUC room
- `/invite <room> <jid>` - Invite a user to a room

#### Whiteboard Commands
- `/whiteboard help` - Show whiteboard command help
- `/whiteboard draw <prompt>` - Generate image from text prompt
- `/whiteboard send <image_url>` - Send image via file transfer
- `/whiteboard status` - Check whiteboard availability

#### File Commands
- `/file send <path_or_url>` - Send file via HTTP Upload
- `/file status` - Check file transfer capabilities

#### Administration Commands
- `/contacts list` - List stored contacts
- `/contacts add <jid> <name>` - Add a contact
- `/contacts remove <jid>` - Remove a contact

### CLI Commands

The plugin also registers CLI commands in ClawdBot:

```bash
# Show XMPP status
clawdbot xmpp status

# Send a message
clawdbot xmpp msg user@example.com "Hello world"

# Join a room
clawdbot xmpp join general@conference.example.com

# Show roster
clawdbot xmpp roster

# Poll message queue
clawdbot xmpp poll

# Clear message queue
clawdbot xmpp clear

# Show queue status
clawdbot xmpp queue
```

## Technical Details

### Architecture

The plugin implements a full ClawdBot channel with the following components:

1. **Channel Plugin** (`index.ts`): Main plugin entry point
2. **XMPP Client**: Manages XMPP connection and stanza handling
3. **Command System**: Processes slash commands in XMPP messages
4. **File Transfer**: Handles HTTP Upload and SI file transfer
5. **Whiteboard Integration**: Routes image requests to agents

### File Transfer Protocols

#### HTTP Upload (XEP-0363)
- **Outgoing files**: Files are uploaded to an HTTP server and shared via URL
- **Server support**: Requires XMPP server with `mod_http_upload` (Prosody) or equivalent
- **Implementation**: `sendFileWithHTTPUpload()` function in `index.ts`

#### SI File Transfer (XEP-0096) with IBB
- **Incoming files**: Uses In-Band Bytestreams for receiving files
- **Base64 encoding**: File data transferred as base64 chunks
- **Session management**: Tracks active file transfer sessions
- **Implementation**: IBB handlers in stanza processing

### Message Flow

1. **Incoming Messages**:
   - XMPP stanza received
   - Processed for commands (starting with `/`)
   - Non-command messages forwarded to agents via message queue
   - Files downloaded and paths provided to agents

2. **Outgoing Messages**:
   - Agents send messages through ClawdBot channel API
   - Plugin routes to appropriate XMPP recipient
   - Files sent via HTTP Upload with fallback to SI transfer

### Whiteboard Integration

Whiteboard requests are forwarded to ClawdBot agents with special metadata:

```typescript
// When /whiteboard draw is used
onMessage(jid, body, {
  whiteboardPrompt: "sunset over mountains",
  whiteboardRequest: true
});

// When /whiteboard send is used  
onMessage(jid, body, {
  mediaUrls: ["https://example.com/image.png"],
  whiteboardImage: true
});
```

Agents can then process these requests for image generation or manipulation.

## Development

### Project Structure
```
clawdbot-xmpp/
├── index.ts              # Main plugin implementation
├── package.json          # Dependencies
├── clawdbot.plugin.json  # Plugin metadata
├── README.md             # This file
├── data/                 # Data storage
│   ├── commands.ts       # CLI command registration
│   ├── state.ts          # Shared state management
│   └── *.json           # Contact and admin storage
└── node_modules/         # Dependencies
```

### Building and Testing

1. **TypeScript**: The plugin is written in TypeScript and runs natively in ClawdBot
2. **Development**:
   ```bash
   # Install dependencies
   npm install
   
   # Check for TypeScript errors (if tsc is available)
   npx tsc --noEmit index.ts
   ```

3. **Testing**: Currently manual testing with XMPP server
   - Connect to XMPP server
   - Test slash commands
   - Verify file transfer
   - Test whiteboard functionality

### Adding Features

1. **New Slash Commands**:
   Add command handlers in the `processMessage` function in `index.ts`

2. **New File Transfer Methods**:
   Implement additional XEPs (XEP-0065 for SOCKS5, XEP-0234 for Jingle)

3. **Enhanced Whiteboard**:
   Integrate with specific image generation APIs or services

## Troubleshooting

### Common Issues

1. **Connection Failed**:
   - Check server address and port
   - Verify TLS settings (plugin disables TLS verification)
   - Check firewall settings

2. **File Transfer Not Working**:
   - Ensure server supports HTTP Upload (XEP-0363)
   - Check file size limits on server
   - Verify network connectivity for HTTP PUT requests

3. **Whiteboard Commands Not Working**:
   - Check agent integration in ClawdBot
   - Verify message routing works
   - Test with simple `/help` command first

4. **Room Join Failures**:
   - Verify room JID format
   - Check MUC service configuration on server
   - Ensure bot has permission to join room

### Logging

The plugin outputs detailed logs to console:
- Connection status
- Stanza processing
- File transfer progress
- Command execution

Check ClawdBot logs for XMPP-related messages.

## License

This plugin is part of the ClawdBot ecosystem. See the main ClawdBot repository for license information.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement changes with proper TypeScript typing
4. Test with a real XMPP server
5. Submit a pull request

## Acknowledgments

- Built with [`@xmpp/client`](https://github.com/xmppjs/xmpp.js) library
- XMPP protocol standards by the XMPP Standards Foundation
- ClawdBot platform for the plugin architecture

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review the ClawdBot documentation
3. Create an issue in the repository
4. Contact via XMPP (if configured)