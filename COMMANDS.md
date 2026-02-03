# XMPP CLI Commands

## Overview
The XMPP plugin provides CLI commands for managing XMPP connections, contacts, and sending messages.

## Commands

### `clawdbot xmpp`
Shows help for all XMPP commands.

```bash
clawdbot xmpp
```

### `clawdbot xmpp status`
Shows the current XMPP connection status.

```bash
clawdbot xmpp status
```

### `clawdbot xmpp msg <jid> <message...>`
Send a direct XMPP message to a JID. Routes through the clawdbot gateway to agents.

```bash
clawdbot xmpp msg user@example.com "Hello, world!"
```

### `clawdbot xmpp roster`
Show the contact roster (in-memory).

```bash
clawdbot xmpp roster
```

### `clawdbot xmpp nick <jid> <name>`
Set a nickname for a JID in the roster (in-memory).

```bash
clawdbot xmpp nick user@example.com "John"
```

### `clawdbot xmpp join <room> [nick]`
Join a MUC (multi-user chat) room.

```bash
clawdbot xmpp join room@conference.example.com mynick
```

### `clawdbot xmpp poll`
Poll and display queued unprocessed messages.

```bash
clawdbot xmpp poll
```

### `clawdbot xmpp clear`
Clear old messages from the queue.

```bash
clawdbot xmpp clear
```

### `clawdbot xmpp queue`
Show message queue statistics.

```bash
clawdbot xmpp queue
```

### `clawdbot xmpp vcard`
Manage vCard profile.

```bash
# Show vCard help
clawdbot xmpp vcard

# View current vCard
clawdbot xmpp vcard get

# Set vCard field
clawdbot xmpp vcard set fn "My Bot Name"
clawdbot xmpp vcard set nickname "bot"
clawdbot xmpp vcard set url "https://github.com/anomalyco/clawdbot"
clawdbot xmpp vcard set desc "AI Assistant"
```

## In-XMPP Commands

When connected via XMPP, you can also use slash commands:

- `/list` - Show contacts (admin only)
- `/add <jid> [name]` - Add contact (admin only)
- `/remove <jid>` - Remove contact (admin only)
- `/admins` - List admins (admin only)
- `/whoami` - Show your JID and admin status
- `/join <room> [nick]` - Join MUC room (admin only)
- `/rooms` - List joined rooms (admin only)
- `/leave <room>` - Leave MUC room (admin only)
- `/invite <contact> <room>` - Invite contact to room (admin only)
- `/help` - Show help

## Notes

- Gateway must be running for full functionality
- Some commands require admin privileges
