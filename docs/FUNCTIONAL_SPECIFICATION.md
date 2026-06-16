# XMPP Plugin — Functional Specification

> OpenClaw XMPP Plugin v2.0.2
> Compatible with OpenClaw >= 2026.6.1

---

## 1. Overview

The XMPP plugin provides an XMPP/Jabber channel for OpenClaw, enabling bidirectional messaging between OpenClaw agents and XMPP users. It supports direct messages, group chat (MUC), file transfer, whiteboard collaboration, vCard management, and SFTP file access.

### 1.1 Channel Identity

| Property | Value |
|----------|-------|
| Channel ID | `xmpp` |
| Channel Label | `XMPP` |
| Plugin Name | `@openclaw/xmpp` |
| Capability | `channel: xmpp` |
| Entry Contract | `defineBundledChannelEntry` |

---

## 2. Directory Structure

```
xmpp/
├── index.ts                          # Main entry: defineBundledChannelEntry
├── setup-entry.ts                    # Setup flow entry: defineBundledChannelSetupEntry
├── channel-plugin-api.ts             # Re-exports xmppChannelPlugin
├── secret-contract-api.ts            # Re-exports channelSecrets
├── runtime-setter-api.ts             # Re-exports setXmppRuntime
├── setup-plugin-api.ts               # Re-exports xmppSetupPlugin
├── openclaw.plugin.json              # Plugin manifest
├── package.json                      # npm package config
├── tsconfig.json                     # TypeScript config
├── install.ps1                       # Windows install script
├── install.sh                        # Linux/Mac install script
│
├── src/
│   ├── index.ts                      # (in root via re-exports)
│   ├── state.ts                      # Global mutable state
│   ├── channel-plugin.ts             # Core channel plugin object
│   ├── setup-plugin.ts               # Setup-only plugin object
│   ├── secret-contract.ts            # Secret target registry
│   ├── cli-metadata.ts               # CLI command registration
│   ├── gateway.ts                    # GatewayLifecycle class
│   ├── startXMPP.ts                  # XMPP connection core (2533 lines)
│   ├── outbound.ts                   # Outbound message dispatch
│   ├── queue-bridge.ts              # Singleton message queue wrapper
│   ├── commands.ts                   # CLI subcommands (899 lines)
│   ├── gateway-client.ts             # CLI-to-gateway RPC client
│   ├── contacts.ts                   # Contact whitelist + admin store
│   ├── jsonStore.ts                  # Generic JSON file store
│   ├── messageStore.ts               # Persistent message history
│   ├── vcard.ts                      # Local vCard persistence
│   ├── vcard-cli.ts                  # vCard CLI operations
│   ├── whiteboard.ts                 # Whiteboard protocol handlers
│   ├── whiteboard-cli.ts             # Whiteboard CLI commands
│   ├── whiteboard-session.ts         # Whiteboard session manager
│   ├── fileTransfer.ts               # File transfer handler factory
│   ├── sftp.ts                       # SFTP operations
│   ├── types.ts                      # TypeScript interfaces
│   ├── config.ts                     # Constants and configuration
│   ├── cli-encrypt.ts                # Standalone encrypt-password script
│   │
│   ├── lib/
│   │   ├── logger.ts                 # Logging utilities
│   │   ├── persistent-queue.ts       # JSON-backed FIFO queue
│   │   ├── config-loader.ts          # Config reader
│   │   ├── contact-factory.ts        # Singleton Contacts factory
│   │   ├── upload-protocol.ts        # XEP-0363 HTTP Upload
│   │   ├── vcard-protocol.ts         # vCard XML parse/build
│   │   └── xmpp-connect.ts           # @xmpp/client wrapper
│   │
│   ├── security/
│   │   ├── adapter.ts                # Channel security adapter
│   │   ├── encryption.ts             # AES-256-GCM password encryption
│   │   ├── fileTransfer.ts           # Secure file transfer
│   │   └── validation.ts             # Input validation utilities
│   │
│   └── shared/
│       └── index.ts                  # Shared utilities
│
├── docs/
│   ├── FUNCTIONAL_SPECIFICATION.md   # This document
│   └── CODE_REVIEW.md                # Code review findings
│
├── data/
│   ├── xmpp-contacts.json            # Contact whitelist
│   ├── xmpp-admins.json              # Admin list
│   ├── xmpp-vcard.json               # Bot vCard data
│   ├── messages/direct/              # Per-JID message history
│   └── downloads/                    # Received files
│
├── _backups/                         # Timestamped pre-edit backups
│   ├── 2.0.0_20260607_103340/
│   └── 2.0.1_20260611_154945/
│   └── 2.0.2_20260611_212551/
│
└── CHANGELOG.md                      # Version history
```

---

## 3. Architecture

### 3.1 Registration Flow

```
openclaw loads package.json
  → discovers "extensions": ["./index.ts"]
    → loads index.ts
      → calls defineBundledChannelEntry({
           id: "xmpp",
           name: "XMPP",
           description: "XMPP/Jabber messaging...",
           importMetaUrl: import.meta.url,
           plugin: { specifier: "./channel-plugin-api.js" },
           secrets: { specifier: "./secret-contract-api.js" },
           runtime: { specifier: "./runtime-setter-api.js" },
           registerCliMetadata: registerXmppCliMetadata,
           registerFull: registerXmppGatewayMethods
         })
```

### 3.2 Layer Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway Core                     │
│  (loads plugin, calls startAccount, dispatches outbound)     │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    index.ts (defineBundledChannelEntry)       │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ xmppChannelPlugin │  │ channelSecrets│  │ setXmppRuntime│ │
│  └────────┬─────────┘  └──────────────┘  └───────┬───────┘ │
│           │                                       │         │
│           ▼                                       ▼         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              GatewayLifecycle (gateway.ts)            │    │
│  │  startAccount(ctx) → creates XMPP connection         │    │
│  │  stopAccount(ctx)  → tears down XMPP connection      │    │
│  └─────────────────────────┬───────────────────────────┘    │
│                            │                                 │
│                            ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              startXMPP.ts (core connection)           │    │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │    │
│  │  │ Stanza       │ │ Ping         │ │ Reconnect    │  │    │
│  │  │ Handlers     │ │ XEP-0199     │ │ Backoff      │  │    │
│  │  └─────────────┘ └──────────────┘ └──────────────┘  │    │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │    │
│  │  │ MUC         │ │ Whiteboard   │ │ File Xfer    │  │    │
│  │  │ XEP-0045    │ │ SWB/SXE      │ │ SI/IBB/HTTP  │  │    │
│  │  └─────────────┘ └──────────────┘ └──────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  outbound.ts (sendText / sendMedia)                   │    │
│  │  Called by OpenClaw when agent produces a reply       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  CLI Layer (commands.ts → gateway-client.ts RPC)      │    │
│  │  openclaw xmpp msg/status/vcard/contacts/sftp/...    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Core Components

### 4.1 `index.ts` — Main Entry Point

**Purpose**: Registers the XMPP channel with OpenClaw via the bundled channel entry contract.

**Key exports**:
- **Default**: `defineBundledChannelEntry({...})`
- **Named**: `xmppClients`, `contactsStore`, `getPluginRuntime`, `setXmppRuntime`, `isPluginRegistered`, `addToQueue`, `getUnprocessedMessages`, `markAsProcessed`, `clearOldMessages`

**Gateway Methods Registered** (`registerXmppGatewayMethods`):
| Method | Description |
|--------|-------------|
| `xmpp.joinRoom` | Join a MUC room |
| `xmpp.leaveRoom` | Leave a MUC room |
| `xmpp.getJoinedRooms` | List joined rooms |
| `xmpp.inviteToRoom` | Invite a user to a room |
| `xmpp.removeContact` | Remove a contact |
| `xmpp.sendMessage` | Send an XMPP message |

### 4.2 `src/state.ts` — Global Mutable State

**Purpose**: Eliminates circular imports by providing a single source of truth for runtime state shared between the channel lifecycle, outbound senders, and CLI handlers.

**Exports**:
| Name | Type | Description |
|------|------|-------------|
| `xmppClients` | `Map<string, XmppClient>` | Account ID → XMPP client |
| `contactsStore` | `Map<string, Contacts>` | Account ID → Contacts instance |
| `getPluginRuntime()` | `() => PluginRuntime \| null` | Get current plugin runtime |
| `setXmppRuntime(r)` | `(PluginRuntime) => void` | Set plugin runtime (called by SDK) |
| `isPluginRegistered()` | `() => boolean` | Check if plugin is registered |
| `markPluginRegistered()` | `() => void` | Mark plugin as registered |

### 4.3 `src/channel-plugin.ts` — Channel Plugin Object

**Purpose**: Defines the `xmppChannelPlugin` object that conforms to OpenClaw's `ChannelPlugin` interface. This is the primary contract between the plugin and the gateway.

**Structure**:
```
xmppChannelPlugin = {
  id: "xmpp",
  meta: { label, blurb, docsUrl },
  capabilities: { channels: ["xmpp"], commands: ["xmpp"] },
  config: {
    schema: { ... },             // JSON Schema for validation
    listAccountIds(cfg),         // Returns ["default"]
    resolveAccount(cfg, id),     // Returns specific account config
    defaultAccountId(),          // Returns "default"
    isConfigured(cfg, id)        // Checks jid + password present
  },
  status: {
    buildAccountSnapshot(ctx)    // Returns AccountSnapshot
  },
  security: xmppSecurityAdapter, // Warnings + audit findings
  outbound: {
    sendText(params),            // Delegate to outbound.ts
    sendMedia(params)            // Delegate to outbound.ts
  },
  gateway: new GatewayLifecycle(...) // startAccount + stopAccount
}
```

### 4.4 `src/gateway.ts` — GatewayLifecycle Class

**Purpose**: Manages the full lifecycle of an XMPP account within the OpenClaw gateway.

**Constructor Dependencies**:
| Dependency | Source | Purpose |
|------------|--------|---------|
| `deps.xmppClients` | `state.ts` | Map of active XMPP clients |
| `deps.contactsStore` | `state.ts` | Map of Contacts instances |
| `deps.getPluginRuntime` | `state.ts` | Runtime accessor |
| `services.startXmpp` | `startXMPP.ts` | XMPP connection creator |
| `services.Contacts` | `contacts.ts` | Contacts class |
| `services.MessageStore` | `messageStore.ts` | Message persistence |
| `queue` | `queue-bridge.ts` | Message queue helpers |

**Methods**:

#### `startAccount(ctx: GatewayContext): Promise<void>`
1. Validates account config (jid, password required)
2. Loads contacts from data directory
3. Initializes admin from config (`adminJid`)
4. Stops any existing connection for same account
5. Creates `MessageStore` for persistence
6. Calls `startXmpp()` with:
   - `onMessage` callback: queues message + dispatches to agent via `dispatchInboundReplyWithBase`
   - `onOnline` callback: auto-joins configured rooms
7. Stores client in `xmppClients` map
8. Sets status to running
9. Registers abort handler for graceful shutdown

#### `stopAccount(ctx: GatewayContext): Promise<void>`
1. Retrieves XMPP client from `xmppClients` map
2. Calls `xmpp.stop()` to disconnect
3. Deletes from `xmppClients` map
4. Sets status to stopped

### 4.5 `src/startXMPP.ts` — XMPP Connection Core

**Purpose**: The heart of the plugin. Creates an XMPP client connection via `@xmpp/client`, handles all stanza types, and returns a rich client object.

**Exported function**: `startXmpp(cfg, contacts, log, onMessage, onOnline?, onFileReceived?)`

**Parameters**:
| Param | Type | Description |
|-------|------|-------------|
| `cfg` | `XmppConfig` | Account configuration |
| `contacts` | `Contacts` | Contact/admins store |
| `log` | `PluginLogger` | Logger instance |
| `onMessage` | `callback` | Inbound message handler |
| `onOnline` | `callback` | Called when connection established |
| `onFileReceived` | `callback` | Called when file received |

**Returns**: `xmppClient` object with:
| Method | Description |
|--------|-------------|
| `send(jid, text)` | Send direct message |
| `sendGroupchat(jid, text)` | Send groupchat message |
| `sendStanza(stanza)` | Send raw XML stanza |
| `joinRoom(room, nick)` | Join MUC room |
| `leaveRoom(room, nick)` | Leave MUC room |
| `getJoinedRooms()` | List joined rooms |
| `stop()` | Graceful disconnect |
| `getContacts()` | Get Contacts instance |

**Features implemented inline**:
- Stanza routing (presence, IQ, message)
- XEP-0199 Ping keepalive (30s interval, 30s timeout)
- XEP-0115 Entity Capabilities
- XEP-0054 vCard query/update/register
- XEP-0066 Out-of-Band Data URLs
- XEP-0096 SI File Transfer (fallback)
- XEP-0047 In-Band Bytestreams (IBB)
- XEP-0363 HTTP File Upload
- XEP-0084 User Avatar (PEP)
- XEP-0045 MUC (rooms, invites)
- SWB Whiteboard (XEP-0113)
- SXE Whiteboard (XEP-0114)
- XEP-0030 Service Discovery
- Slash commands (/help, /add, /join, /invite, /leave, /nick, /rooms, /msg, /status, /sfdp, /sftp, /queue)
- Exponential backoff reconnection

### 4.6 `src/outbound.ts` — Outbound Message Dispatch

**Purpose**: Handles outgoing messages from OpenClaw agents to XMPP users.

**Key Functions**:

#### `sendText({ to, text, accountId }: SendTextParams)`
1. Finds XMPP client from `xmppClients` map
2. Checks for `[WHITEBOARD_DRAW]` tags in text
3. If whiteboard session active: parses SVG commands and sends SXE/SWB stanzas
4. Removes thinking preamble (lines starting with "Thinking..." or "Thinking .")
5. Routes to `sendGroupchat()` for `@conference.` JIDs
6. Routes to `send()` for direct messages

#### `sendMedia({ to, text, mediaUrl, accountId, deps }: SendMediaParams)`
1. Same flow as `sendText()`
2. Additionally checks `deps.getDirectLink()` to resolve media URLs
3. Attaches media URL to message body

### 4.7 `src/contacts.ts` — Contacts Class

**Purpose**: Manages the XMPP contact whitelist and admin list. Uses `JsonStore` for persistence.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `list()` | List all contacts |
| `exists(jid)` | Check if JID is allowed |
| `add(jid, name?)` | Add contact |
| `remove(jid)` | Remove contact |
| `getName(jid)` | Get display name |
| `getAllJids()` | Get all JIDs for `allowFrom` |
| `isAdmin(jid)` | Check if JID is admin |
| `addAdmin(jid)` | Add admin |
| `removeAdmin(jid)` | Remove admin |
| `listAdmins()` | List all admins |

### 4.8 `src/messageStore.ts` — Message Persistence

**Purpose**: Stores chat history in JSON files, organized by conversation partner and date.

**Storage layout**:
- Direct messages: `data/messages/direct/{bareJid}.json`
- Group messages: `data/messages/group/{roomJid}.json`

**Key Methods**:
| Method | Description |
|--------|-------------|
| `saveMessage(msg)` | Save a message |
| `getDirectMessages(jid)` | Get direct messages |
| `getGroupchatMessages(room)` | Get groupchat messages |
| `getRecentDirectMessages()` | Recent DMs across all contacts |
| `getRecentGroupchatMessages()` | Recent group messages across all rooms |
| `getDirectChatJIDs()` | List all DM partners |
| `getGroupChatRoomJIDs()` | List all group rooms |
| `getStats()` | Message statistics |

### 4.9 `src/commands.ts` — CLI Commands

**Purpose**: Registers the `openclaw xmpp` command tree with all subcommands.

**Registered subcommands**:
| Command | Description |
|---------|-------------|
| `xmpp start` | Start XMPP connection (standalone mode) |
| `xmpp status` | Show connection status |
| `xmpp msg <jid> <text>` | Send a message |
| `xmpp roster` | List contacts |
| `xmpp nick <jid> [name]` | Set/get contact nickname |
| `xmpp join <room>` | Join a MUC room |
| `xmpp rooms` | List joined rooms |
| `xmpp leave <room>` | Leave a MUC room |
| `xmpp poll` | Poll queued messages |
| `xmpp clear` | Clear processed message queue |
| `xmpp add <jid> [name]` | Add contact |
| `xmpp remove <jid>` | Remove contact |
| `xmpp invite <jid> <room>` | Invite user to room |
| `xmpp contacts` | List/reload contacts |
| `xmpp queue` | Show queued messages |
| `xmpp vcard ...` | vCard subcommands |
| `xmpp sftp ...` | SFTP subcommands |
| `xmpp encrypt-password` | Encrypt account password |

### 4.10 `src/queue-bridge.ts` — Message Queue

**Purpose**: Singleton wrapper around `PersistentQueue` for the inbound message queue.

**Functions**:
| Function | Description |
|----------|-------------|
| `addToQueue(message, dataDir?)` | Enqueue inbound message |
| `markAsProcessed(id, dataDir?)` | Mark as processed |
| `getUnprocessedMessages(accountId?, dataDir?)` | Get pending messages |
| `clearOldMessages(maxAgeMs?, dataDir?)` | Remove old messages |
| `getMessageQueue()` | Get the singleton queue instance |

### 4.11 `src/secret-contract.ts` — Secret Registration

**Purpose**: Tells OpenClaw's secret management about the password field.

**Exports**:
```typescript
channelSecrets = {
  secretTargetRegistryEntries: [
    {
      secretPath: "channels.xmpp.accounts.*.password",
      providerId: "user-provided",
      label: "Account password"
    }
  ],
  collectRuntimeConfigAssignments: () => ({})  // no-op
}
```

---

## 5. Data Flows

### 5.1 Inbound Message

```
XMPP Server ──► @xmpp/client (TCP connection)
                     │
                     ▼
            startXMPP.ts — "stanza" event
                     │
                     ├── <presence> → presence handler
                     │   └── XEP-0115 caps, XEP-0084 avatar
                     │
                     ├── <iq> → IQ handler
                     │   ├── vCard query (XEP-0054)
                     │   ├── Disco info (XEP-0030)
                     │   ├── IBB open/data/close (XEP-0047)
                     │   ├── SI request (XEP-0096)
                     │   └── HTTP Upload slot (XEP-0363)
                     │
                     └── <message> → message handler
                         ├── MUC invite → accept/decline
                         ├── Conference invite → accept/decline
                         ├── Whiteboard (SWB/SXE) → process
                         ├── File transfer → download + processInboundFiles
                         ├── Slash command → execute locally / forward to agent
                         └── Normal text message
                               │
                               ▼
                     onMessage callback (in gateway.ts)
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
         addToQueue()            dispatchInboundReplyWithBase()
         (PersistentQueue        (openclaw/plugin-sdk/
          for polling)            inbound-reply-dispatch)
                    │                     │
                    │              resolveAgentRoute()
                    │              finalizeInboundContext()
                    │              deliver() callback
                    │                     │
                    │              xmpp.send() / sendGroupchat()
                    │
              (Used by CLI
               `xmpp poll`)
```

### 5.2 Outbound Message

```
Agent produces response
         │
         ▼
OpenClaw calls xmppChannelPlugin.outbound.sendText()
         │
         ▼
  outbound.ts: sendText({ to, text, accountId })
         │
         ├── Lookup xmppClients.get(accountId)
         ├── Check for [WHITEBOARD_DRAW] tags
         │   ├── If whiteboard session: parse SVG → SXE/SWB stanzas
         │   └── Send drawing stanzas via xmpp.send()
         ├── Strip thinking preamble (Thinking... / Thinking . lines)
         ├── Route by JID:
         │   ├── @conference. → xmpp.sendGroupchat(jid, text)
         │   └── other → xmpp.send(jid, text)
         └── Save outbound message to messageStore
```

### 5.3 Plugin Startup

```
openclaw gateway start
  → Gateway loads all plugins
  → Detects channel: xmpp capability
  → Calls index.ts default export (defineBundledChannelEntry)
  → SDK calls setXmppRuntime(api.runtime)
  → SDK calls xmppChannelPlugin.gateway.startAccount(ctx)
    → Validates config
    → Loads contacts
    → Creates XMPP client (@xmpp/client)
    → Sets up stanza handlers
    → Connects to XMPP server
    → Sends presence (XEP-0115 caps)
    → Registers vCard
    → Auto-joins configured rooms
    → Sets account status to running
```

### 5.4 Plugin Shutdown

```
openclaw gateway stop (or abort signal)
  → SDK calls xmppChannelPlugin.gateway.stopAccount(ctx)
    → Retrieves client from xmppClients map
    → Calls xmpp.stop() (graceful disconnect)
    → Deletes from xmppClients map
    → Sets status to stopped
```

---

## 6. Configuration Reference

### 6.1 `openclaw.plugin.json` — Plugin Manifest

Key sections:

| Section | Purpose |
|---------|---------|
| `id` | `@openclaw/xmpp` |
| `name` | `OpenClaw XMPP Plugin` |
| `activation.onStartup` | `true` — start with gateway |
| `activation.onCommands` | `["xmpp"]` — activate when CLI used |
| `commandAliases` | `[{ name: "xmpp" }]` |
| `channelConfigs.xmpp` | Channel capability declaration |
| `configSchema.properties.xmpp` | Full JSON Schema for account config |
| `channelEnvVars.xmpp` | Environment variable mappings |

### 6.2 Account Configuration (`openclaw.json`)

Path: `channels.xmpp.accounts.<id>`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | No | Enable/disable account (default: true) |
| `service` | string | **Yes** | XMPP server URI (e.g. `xmpp://server:5222`) |
| `domain` | string | **Yes** | XMPP domain |
| `jid` | string | **Yes** | Full JID (`user@domain`) |
| `password` | string | **Yes** | Plaintext or `ENC:` encrypted |
| `dataDir` | string | **Yes** | Data directory path |
| `resource` | string | No | Resource identifier |
| `adminJid` | string | No | Admin JID (added to admin list on start) |
| `nick` | string | No | Bot nickname |
| `dmPolicy` | `"open"`\|`"allowlist"` | No | DM policy (default: `"open"`) |
| `allowFrom` | string[] | No | Allowed JIDs for DM (used with `allowlist` policy) |
| `rooms` | string[] | No | Rooms to auto-join |
| `autoJoinRooms` | string[] | No | Alias for `rooms` |
| `sftpPort` | number | No | SFTP server port (default: 2211) |
| `vcard.fn` | string | No | vCard full name |
| `vcard.nickname` | string | No | vCard nickname |
| `vcard.url` | string | No | vCard URL |
| `vcard.desc` | string | No | vCard description |
| `vcard.avatarUrl` | string | No | vCard avatar URL |
| `encryptionKey` | string | Auto | Encryption key (auto-generated) |
| `encryptionSalt` | string | Auto | Encryption salt (auto-generated) |

### 6.3 Config Constants (`src/config.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `Config.MAX_MESSAGE_BODY_SIZE` | 100 KB | Max stanza body size |
| `Config.MAX_FILE_SIZE` | 50 MB | Max file transfer size |
| `Config.RATE_LIMIT_WINDOW_MS` | 1000 | Rate limit window |
| `Config.RATE_LIMIT_MAX_MSGS` | 5 | Max messages per window |
| `Config.RECONNECT_BASE_MS` | 1000 | Base reconnect delay |
| `Config.RECONNECT_MAX_MS` | 60000 | Max reconnect delay |
| `Config.RECONNECT_BACKOFF_FACTOR` | 2 | Exponential backoff factor |
| `Config.IBB_CLEANUP_INTERVAL_MS` | 60000 | IBB cleanup interval |
| `Config.CONTACTS_FILE` | `xmpp-contacts.json` | Contacts filename |
| `Config.ADMINS_FILE` | `xmpp-admins.json` | Admins filename |
| `CapsInfo` | XEP-0115 | Entity capabilities info |

---

## 7. Security

### 7.1 Password Encryption (`src/security/encryption.ts`)

- Algorithm: AES-256-GCM
- Key derivation: PBKDF2 with random salt
- Storage: `"ENC:..."` prefixed ciphertext in config
- CLI: `openclaw xmpp encrypt-password` interactive command

### 7.2 Access Control

- DM policy: `"open"` (anyone) or `"allowlist"` (whitelist only)
- Admin users: can execute administrative slash commands
- Contact whitelist: managed via `Contacts` class

### 7.3 Input Validation (`src/security/validation.ts`)

- JID validation (regex pattern)
- Filename sanitization (path traversal prevention)
- URL validation
- HTML sanitization

### 7.4 File Transfer Security (`src/security/fileTransfer.ts`)

- MIME type validation and whitelist
- File extension verification
- Quarantine directory for suspicious files
- SHA-256 hashing
- Virus scan pattern matching
- User quotas and rate limits
- Secure file deletion

### 7.5 Security Adapter (`src/security/adapter.ts`)

Reports to OpenClaw's security dashboard:
- Warning: plaintext password in config
- Audit finding: plaintext password
- Audit finding: open DM policy (when applicable)

---

## 8. XMPP Extensions Supported

| XEP | Description | Support |
|-----|-------------|---------|
| XEP-0030 | Service Discovery | IQ disco#info responses |
| XEP-0045 | Multi-User Chat | Room join/leave/invite |
| XEP-0047 | In-Band Bytestreams | File transfer |
| XEP-0054 | vCard | Query, update, register |
| XEP-0066 | Out-of-Band Data | File URLs in messages |
| XEP-0084 | User Avatar | PEP avatar publishing |
| XEP-0096 | SI File Transfer | File transfer |
| XEP-0115 | Entity Capabilities | Presence caps |
| XEP-0113 | SWB Whiteboard | Simple whiteboard protocol |
| XEP-0114 | SXE Whiteboard | SXE whiteboard protocol |
| XEP-0199 | XMPP Ping | Keepalive (30s interval) |
| XEP-0363 | HTTP File Upload | File upload |

---

## 9. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@xmpp/client` | ^0.13.6 | XMPP client library |
| `ssh2` | ^1.17.0 | SFTP server connectivity |
| `typescript` | ^5.9.3 (dev) | TypeScript compiler |
| `@types/node` | ^25.2.0 (dev) | Node.js type definitions |

---

## 10. Build & Install

### Build
```bash
npx tsc
# Emits JS to dist/ directory
# Pre-existing TS errors are non-blocking (noEmitOnError: false)
```

### Install (Windows)
```powershell
.\install.ps1
# Steps: git clone → npm install → link SDK → tsc → openclaw plugins install --link --force
```

### Install (Linux/Mac)
```bash
./install.sh
# Steps: git clone → npm install → link SDK → tsc → openclaw plugins install --link --force
```

### Manual Registration
```bash
openclaw plugins install --link --force /path/to/extensions/xmpp
openclaw gateway restart
```

---

## 11. Important Implementation Details

### 11.1 Ping Keepalive (v2.0.1 fix)

- `PING_INTERVAL_MS = 30 * 1000` (30 seconds)
- `PING_TIMEOUT_MS = 30 * 1000` (30 second response timeout)
- Sends XEP-0199 IQ ping stanza
- On failure: stops ping timer → triggers reconnect

### 11.2 Reconnection Strategy

- Exponential backoff: 1s → 2s → 4s → 8s → ... → 60s max
- Both `@xmpp/client` built-in reconnect (5s delay) and custom fallback
- Reconnection state reset on successful `online` event

### 11.3 Whiteboard Protocol

- Parses `[WHITEBOARD_DRAW]...[/WHITEBOARD_DRAW]` tags in agent responses
- Supports SXE (structured XML editing) and SWB (simple whiteboard) protocols
- Session management with cleanup timers
- Path reconstruction from SXE state

### 11.4 IBB Cleanup

- Periodic cleanup of stale IBB sessions (60s interval)
- Failed IBB sessions cleaned on `stanza` errors

### 11.5 Graceful Shutdown

- `SIGTERM` and `SIGINT` handlers call `xmpp.stop()`
- Gateway abort signal triggers connection teardown
- Status set to `running: false` on stop

### 11.6 TypeScript Configuration Note

- `moduleResolution: "node"` causes TS2307 for subpath exports (`openclaw/plugin-sdk/channel-entry-contract`)
- `noEmitOnError: false` — JS still emitted despite type errors
- Pre-existing type errors in `src/gateway.ts`, `src/startXMPP.ts`, `src/outbound.ts`, `src/whiteboard.ts`, `src/vcard-cli.ts`, `src/lib/vcard-protocol.ts`, `src/security/adapter.ts` (none blocking)

### 11.7 Logging

- Main log: OpenClaw gateway log (`openclaw-YYYY-MM-DD.log`)
- Plugin debug log: `debugLog()` writes to `cli-debug.log` in plugin directory
- Child loggers: `const xmppLog = child("xmpp")` for prefixed output
- Log level controlled by `XMPP_LOG_LEVEL` env var
