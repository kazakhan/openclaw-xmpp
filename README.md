# OpenClaw XMPP Plugin

A full-featured XMPP channel plugin for OpenClaw with support for 1:1 chat, multi-user chat (MUC), CLI management, file transfers, presence/status, and comprehensive security features including password encryption at rest and secure file transfer validation.
Need an XMPP server? Check out [Prosody](https://prosody.im/).

## Status: ✅ WORKING (v2.16.2)

Fully functional with shared sessions, memory continuity, file transfers via SI/SOCKS5/IBB (XEP-0096/XEP-0065/XEP-0047) and HTTP Upload (XEP-0363), vCard + vCard4 profiles, presence/status, SFTP transfers, auto-update, password encryption at rest, and enhanced file transfer security.

**Release highlights:**
- **v2.11.x** — stable sanitized-hostname resource (no random `openclaw-<hex>` on
  reconnect), re-enabled keepalive (TCP `setKeepAlive` + XML whitespace) that
  stops the ~15-minute NAT/firewall dropouts, MUC re-join after reconnect,
  interactive onboarding (`openclaw xmpp setup`) and `openclaw xmpp doctor`.
- **v2.12–2.13** — auto-update (`openclaw xmpp update-check` / `update`), and
  groupchat **mention-only gating** for the agent.
- **v2.14.0–2.14.2** — secure **SFTP** (pinned host key, `xmpp_sftp` tool +
  `openclaw xmpp sftp`); groupchat dispatch skipped for unmentioned messages
  (`messages.groupChat.unmentionedInbound`).
- **v2.14.4–2.14.6** — full vCard field support (all fields settable and
  persisted, avatar), and **vCard4 (XEP-0292)** published over PEP
  (`urn:xmpp:vcard4`) alongside vcard-temp.
- **v2.14.7 / v2.15.1** — the `vcard`/`vcard4` CLI runs on the gateway's
  **existing** connection (no second XMPP session, no `conflict` kicks), and the
  CLI→gateway transport uses OpenClaw's in-process gateway client.
- **v2.15.0–2.15.2** — **presence/status**: built-in/alias shows + custom status
  from the CLI, chat, and the `xmpp_setPresence` agent tool, with an automatic
  **busy** presence while thinking/running tools, persisted across reconnect.
- **v2.15.3** — fixed `openclaw xmpp update` (the rollback snapshot copied the
  plugin into a subdirectory of itself, which `fs.cp` rejects with
  `ERR_FS_CP_EINVAL`).
- **v2.15.4** — strips the illegal `mechanism` attribute `@xmpp/sasl` 0.13.6
  puts on the SASL `<response/>` (RFC 6120 §6.4.2). RFC-correctness; most
  servers tolerate the attribute.
- **v2.15.5** — pinned `sasl-scram-sha-1` to **1.3.0**. 1.4.0 made `response()`
  async, which `@xmpp/sasl` 0.13.x calls synchronously, so SCRAM sent an
  **empty `<response/>`** and Prosody rejected it with `malformed-request`.
  `doctor` now detects the bad version and `--fix` runs `npm install` to
  reconcile it.
- **v2.16.0** — **`ask_user` questions are delivered and answerable in XMPP**
  (the agent's multiple-choice prompts were previously invisible and the run
  blocked). Questions and numbered options are rendered as a message; reply with
  a number, the option text, or type your own answer (multiple questions use
  `1: 2, 2: 1`).
- **v2.16.1** — ask_user render is **immediate** (no gateway RPC in the delivery
  path), the plugin enforces a **900s minimum** `ask_user` timeout
  (`askUserMinTimeoutSeconds`), and a **late answer** is no longer dropped — it
  is noted and dispatched to the agent.
- **v2.16.2** — ask_user answers actually resolve: the gateway call uses the
  in-process client with the `operator.questions` scope (the previous
  `runtime.gateway.request` hung with no request context). Answers are parsed
  per message (`q1. 1`, `1: 1`, `<questionId>: 1`) and accumulated until all
  questions are answered.

`openclaw.plugin.json` declares `contracts.tools` (`xmpp_setPresence`,
`xmpp_sftp`) to satisfy the OpenClaw 2026.8.x plugin contract check.

## Installation

### Prerequisites
- OpenClaw **2026.8.2+** (the capability-consent and `contracts.tools` checks
  were introduced in 2026.8.x; see the "Troubleshooting" note below)
- Node.js >= 16.0.0
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
The `--force` flag bypasses the security scanner (the plugin uses `child_process` for native helpers — legitimate functionality).

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
          },
          "presence": {
            "enabled": true,
            "defaultShow": "available",
            "thinkingShow": "dnd",
            "thinkingStatus": "Thinking…",
            "toolShow": "dnd",
            "toolStatus": "Running {tool}…",
            "minIntervalSeconds": 5,
            "manualTtlSeconds": 0,
            "restoreOnReconnect": true
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

### Presence / status (v2.15.0)

The bot can show built-in availability and a custom status message, and it
automatically shows **busy while it is thinking or running tools**:

- Built-in shows: `available` (online), `chat` (free for chat), `away`,
  `xa` (extended away), `dnd` (busy). Friendly aliases: `online`→available,
  `busy`→dnd, `free`→chat, `idle`→away.
- Precedence: a **manual** status (set by the agent or a human) wins over the
  automatic activity presence until cleared or until `manualTtlSeconds` expires.
- Auto-activity is **on by default** (`presence.enabled: true`) with a 5s
  throttle; set `presence.enabled: false` to disable it per account. Status is
  persisted to `<dataDir>/xmpp-presence.json` and restored on reconnect.

```bash
openclaw xmpp presence                       # show current presence
openclaw xmpp presence busy "Deploying"      # set a manual status
openclaw xmpp presence clear                 # drop the manual status
```

### SFTP (v2.14.0)

SFTP is configured per account under `channels.xmpp.accounts.<id>.sftp`. It
**fails closed** unless `hostKeyFingerprint` is set (pinned host key):

```json
"sftp": {
  "enabled": true,
  "host": "sftp.example.com",
  "port": 2222,
  "user": "bot",
  "password": "…",
  "hostKeyFingerprint": "SHA256:…"
}
```

### Auto-update (v2.12.0)

```json
"autoUpdate": {
  "enabled": true,
  "intervalHours": 24,
  "mode": "ask",         // "ask" | "auto"
  "autoRestart": true
}
```

### Groupchat mention gating (v2.14.2)

In MUC rooms the agent is invoked **only when this bot is @mentioned** — its own
room nick (or its vCard nickname/full name or JID local part). Unmentioned
chatter is still written to the message log, but it is **never sent to the
agent** (no model call, no cost). A message that mentions other nicks does not
wake the bot unless one of the mentions is the bot's own name.

To let the bot answer **all** group messages, opt out:
```bash
openclaw config set messages.groupChat.unmentionedInbound user_request
```

Installers / `openclaw xmpp setup` also set the mention requirement:
```bash
openclaw config set "channels.xmpp.groups.*.requireMention" true
```

- A mention is `@` immediately followed by the bot's own **room nick**, **vCard
  nickname/full name**, or **JID local part** (case-insensitive, word boundary).
  A message may mention several nicks; only a mention of the bot's own name
  counts. Bare names without `@` do not count, and `@othernick` never wakes it.
- Per-room override (e.g. always reply in one room):
  ```bash
  openclaw config set 'channels.xmpp.groups."room@conference.example".requireMention' false
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
openclaw xmpp setup               # Interactive onboarding (prompts, masks/encrypts password)
openclaw xmpp doctor              # Runtime-readiness check (add --fix to repair)
openclaw xmpp status              # Check connection status
openclaw xmpp msg <jid> <msg>     # Send direct message
openclaw xmpp add <jid> [name]    # Whitelist contact (required for bot responses)
openclaw xmpp remove <jid>        # Remove a contact
openclaw xmpp contacts            # List contacts
openclaw xmpp roster              # View roster
openclaw xmpp nick <jid> <name>   # Set nickname
openclaw xmpp join <room> [nick]  # Join MUC room
openclaw xmpp rooms               # List joined rooms
openclaw xmpp leave <room>        # Leave MUC room
openclaw xmpp invite <jid> <room> # Invite a contact to a room
openclaw xmpp poll                # Poll message queue
openclaw xmpp clear               # Clear message queue
openclaw xmpp queue               # Show queue status
openclaw xmpp update-check        # Check GitHub for a newer plugin version
openclaw xmpp update              # Install the latest plugin version
```

### File Transfer
```bash
# Send a file over XMPP (SI/SOCKS5/IBB, XEP-0096/XEP-0065/XEP-0047) with HTTP Upload fallback
openclaw xmpp msg <jid> "/sendfile <path> [desc]"
```

### SFTP Commands (v2.14.0)
Secure SFTP to the configured server with a **pinned host key** (fails closed if
`hostKeyFingerprint` is not configured). This is separate from XMPP file
transfer above.
```bash
openclaw xmpp sftp upload <local-path> [remote-name]   # Upload a file
openclaw xmpp sftp download <remote-name> [local-path] # Download a file
openclaw xmpp sftp ls [remote-dir]                     # List remote files
openclaw xmpp sftp rm <remote-name>                    # Delete a remote file
```

### Security Commands
```bash
openclaw xmpp encrypt-password  # Encrypt password in config file (hidden input)
```

### vCard Commands

XEP-0054 vcard-temp support for bot profile management. Every field below is
settable (v2.14.6) and runs on the gateway's existing connection.

```bash
openclaw xmpp vcard get                       # View current vCard (full output)
openclaw xmpp vcard set fn <value>            # Full Name
openclaw xmpp vcard set nickname <value>      # Nickname
openclaw xmpp vcard set url <value>           # URL
openclaw xmpp vcard set desc <value>          # Description
openclaw xmpp vcard set bday <YYYY-MM-DD>     # Birthday (alias: birthday)
openclaw xmpp vcard set title <value>         # Job Title
openclaw xmpp vcard set role <value>          # Job Role
openclaw xmpp vcard set tz <value>            # Timezone (alias: timezone)
openclaw xmpp vcard set jabberid <jid>        # Jabber ID (alias: jabber)
openclaw xmpp vcard set mailer <value>        # Mailer
openclaw xmpp vcard set note <value>          # Note
openclaw xmpp vcard set uid <value>           # UID
openclaw xmpp vcard set prodid <value>        # PRODID
openclaw xmpp vcard set sortString <value>    # Sort String (aliases: sort-string, sort)
openclaw xmpp vcard set categories <a,b,c>    # Categories
openclaw xmpp vcard set geo <lat> <lon>       # Geolocation
openclaw xmpp vcard set avatar <url-or-path>  # Avatar (URL, or a local file to upload)
openclaw xmpp vcard name <family> <given> [middle] [prefix] [suffix]  # Structured name
openclaw xmpp vcard phone add <number> [type...]    # Add phone (home work voice fax cell video pager msg)
openclaw xmpp vcard phone remove <index>            # Remove phone by index
openclaw xmpp vcard email add <address> [type...]   # Add email (home work internet pref)
openclaw xmpp vcard email remove <index>            # Remove email by index
openclaw xmpp vcard address add <street> <city> <region> <postal> <country> [type...]
openclaw xmpp vcard address remove <index>
openclaw xmpp vcard org <orgname> [orgunit...]      # Organization
```

### vCard4 Commands (v2.14.5)

XEP-0292 vCard4 published to the PEP node `urn:xmpp:vcard4` (kept in sync with
vcard-temp on every change).

```bash
openclaw xmpp vcard4           # Show the published vCard4 (same as: vcard4 get)
openclaw xmpp vcard4 publish   # Republish the local vCard as vCard4
```

### Presence Commands (v2.15.0)

```bash
openclaw xmpp presence                       # Show current presence
openclaw xmpp presence <show> [status...]    # Set a manual status
openclaw xmpp presence clear                 # Clear the manual status
# <show>: available|chat|away|xa|dnd (aliases: online, busy, free, idle)
```

## In-Chat Slash Commands

Use these commands directly in XMPP chat (direct message or groupchat) to control the bot.

### Available to Everyone
```bash
/whoami                          # Show your info (room/nick in groupchat)
/help                            # Show available commands
/presence                        # Show the bot's current presence
/status <text>                   # Set a custom status message (alias for /presence)
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
/leave <room>                    # Leave a MUC room
/sendfile <path> [description]   # Send a file over XMPP (SI/SOCKS5/IBB) with HTTP Upload fallback
/presence <show> [status]        # Set presence (available|chat|away|xa|busy)
/presence clear                  # Clear a manual status
/vcard                           # Manage vCard profile (see /vcard help)
/vcard get                       # Show current vCard
/vcard set fn|nickname|url|desc|bday|title|role|tz|jabberid|mailer|note|uid|prodid|sortString <value>
/vcard set categories <a,b,c>    # Set categories
/vcard set geo <lat> <lon>       # Set geolocation
/vcard name <family> <given> [middle] [prefix] [suffix]
/vcard phone add|remove ...      # Manage phone numbers
/vcard email add|remove ...      # Manage emails
/vcard address add|remove ...    # Manage addresses
/vcard org <orgname> [orgunit...] # Set organization
```

### Notes
- Admin commands require your JID to be in the `adminJid` config
- Most admin commands only work in direct chat (not groupchat)
- The `/help` command forwards to the AI agent in direct chat

## Answering agent questions (ask_user)

When the agent uses OpenClaw's **ask_user** tool it blocks until the question is
answered. The plugin renders the question(s) as a normal XMPP message with
numbered options, and your reply is turned into the answer:

```
Agent needs input:

Deploy
Proceed with the deploy?
  1. Yes
  2. No — abort
  3. Type your own answer

Reply with a number, the option text, or type your own answer.
```

- Reply with a **number** (`2`), the **option text** (`No`), or **any other
  text** — anything that isn't an option is submitted as a **custom answer**.
- **Multiple questions** are numbered; answer them all at once (`1: 2, 2: 1`)
  **or one message at a time** (`q1. 1` then `q2. 1`). Prefixes can be the
  number, `q<n>`, the question id (`timeout_test: 1`), or the header. The bot
  replies "Still need: …" until every question is answered, then submits them.
- **Multi-select** questions accept comma-separated numbers/labels.
- Only the conversation that received the question can answer it. The question
  expires after ~15 minutes (the gateway's own timeout also applies).
- The plugin enforces a **minimum `ask_user` timeout** so the XMPP round-trip
  has time to complete. Default **900s**; override per account:
  ```bash
  openclaw config set channels.xmpp.accounts.default.askUserMinTimeoutSeconds 1800
  ```
- If you answer **after** the tool timed out, the plugin notes it and passes
  your message through to the agent (the answer isn't dropped).

## File Management

Files are transferred over XMPP via SI (XEP-0096) with SOCKS5 bytestreams (XEP-0065) or IBB (XEP-0047) preferred, falling back to HTTP File Upload (XEP-0363) for a URL link. PSI+ clients receive a native file transfer dialog; other clients receive an HTTP download link.

### Transfer Methods

1. **SI → SOCKS5 bytestream** (preferred) — PSI+ selects this when available. Requires a SOCKS5 proxy65 component on the server (e.g., Prosody `proxy65` module) at `proxy.<domain>:5000`.
2. **SI → IBB** (fallback within SI) — if SOCKS5 is unavailable, PSI+ falls back to IBB (in-band bytestreams via IQ stanzas).
3. **HTTP Upload** (last resort) — sends a URL link via chat message if SI/SOCKS5/IBB fails.

### Usage

```bash
# CLI — bare JID auto-resolves to full JID via presence tracking
openclaw xmpp msg user@domain "/sendfile /path/to/file description"

# CLI — explicit full JID (more reliable)
openclaw xmpp msg user@domain/resource "/sendfile /path/to/file description"

# In-chat (agent response) — agent text starting with /sendfile triggers transfer
/sendfile /path/to/file description
```

**Note:** The target must be using a compatible client (PSI+ tested) for native SI transfers. Bare JIDs are auto-resolved to the last-seen full JID (tracked from presence and message stanzas).

## Features

- Full XMPP protocol with TLS
- Multi-User Chat (MUC), with **mention-only gating** for the agent (v2.14.2)
- Shared sessions between direct chat and groupchat
- Session memory continuity (experimental)
- Contact & roster management
- **Presence/status** (built-in + custom) with automatic **busy while thinking/tooling** and persistence across reconnect (v2.15.0)
- **Agent questions (`ask_user`)** rendered in chat and answerable by number, option text, or a typed custom answer (v2.16.0; instant render + 900s timeout floor in v2.16.1; reliable per-message answers in v2.16.2)
- vCard support (all fields get/set) and **vCard4 over PEP** (XEP-0292)
- File transfers via SI/SOCKS5/IBB (XEP-0096/XEP-0065/XEP-0047) with HTTP Upload (XEP-0363) fallback
- In-chat `/sendfile` command (agent response and CLI)
- **Secure SFTP** transfers with pinned host key (`xmpp_sftp` tool + CLI, v2.14.0)
- **Auto-update** (`openclaw xmpp update-check` / `update`)
- CLI vCard/presence operations run on the **gateway's existing connection** (no second XMPP session)
- Bare JID auto-resolve to full JID via presence/message tracking
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
# Interactive onboarding (prompts for server/JID, masks the password and
# encrypts it to ENC:, asks Keep/Override/Cancel if a config already exists)
openclaw xmpp setup

# Or configure manually:
# openclaw config set channels.xmpp.accounts.default.service "xmpp://your-server:5222"
# openclaw config set channels.xmpp.accounts.default.domain "your-domain"
# openclaw config set channels.xmpp.accounts.default.jid "user@domain"
# openclaw config set channels.xmpp.accounts.default.dataDir "~/.openclaw/extensions/xmpp/data"
# openclaw config set channels.xmpp.accounts.default.enabled true
# openclaw config set messages.groupChat.visibleReplies automatic
# openclaw xmpp encrypt-password

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

### OpenClaw 2026.8.x: "plugin verification failed / requires capability consent"
OpenClaw 2026.8+ refuses to start until every enabled plugin's capabilities are
consented. For the XMPP plugin (and any other enabled plugin):
```bash
openclaw plugins enable xmpp --accept-capabilities
# also consent the other enabled plugins you use (e.g. deepseek, zai)
```
Then disable any config entries that are `enabled` but not installed, and the
unused `perplexity` runtime default:
```bash
openclaw config set plugins.entries.comfy.enabled false
openclaw config set plugins.entries.duckduckgo.enabled false
openclaw config set plugins.entries.opencode.enabled false
openclaw config set plugins.entries.perplexity.enabled false
openclaw plugins registry --refresh
systemctl --user restart openclaw-gateway   # Linux; on Windows run openclaw (elevated) then `openclaw gateway restart`
```

### Windows: "schtasks ... access denied" / doctor can't enter maintenance
On Windows the gateway runs as a Scheduled Task and `openclaw` must modify it
via `schtasks`. Run `openclaw` from an **Administrator** PowerShell, or a
non-elevated session gets `ERROR: Access is denied`. Use `openclaw gateway
restart` on Windows instead of `systemctl`.

### "Cannot find package 'tsx'"
OpenClaw only needs `tsx` when it runs the plugin from the TypeScript source
(`index.ts`). The supported path is compiled `dist/`: run `npx tsc` in the
plugin directory, then restart. (Or `openclaw xmpp doctor --fix` to rebuild a
missing `dist/`.)

### "plugin must declare contracts.tools before registering agent tools"
The plugin manifest declares `contracts.tools` (`openclaw.plugin.json`). Update
to v2.11.3 or newer (current: v2.16.2) to clear this OpenClaw 2026.8.x warning.

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
The scanner flags `child_process` usage and environment variable access. These are legitimate and required for the plugin's file transfer features.

### "write after end" crash on reconnect (ERR_STREAM_WRITE_AFTER_END)
This was fixed by checking `xmpp.status` before calling `stop()` in the reconnect logic. Update to the latest version.

### Certificate errors (CERT_HAS_EXPIRED)
Your XMPP server's SSL certificate has expired. Renew it on the server, or use a trusted CA.

### SASL auth fails with `malformed-request` (Prosody), but the password is correct
This is the **`sasl-scram-sha-1` 1.4.0** regression: it made `response()` async
(returns a Promise), but `@xmpp/sasl` 0.13.x calls it synchronously and only
encodes string results — so the SCRAM `<response/>` is sent **empty** and the
server rejects it with `malformed-request`. It only affects SCRAM (multi-step);
PLAIN is client-first and unaffected.

Check and fix:
```bash
openclaw xmpp doctor          # reports the installed sasl-scram-sha-1 version
openclaw xmpp doctor --fix    # runs `npm install` to pin sasl-scram-sha-1@1.3.0
```
The plugin's `package.json` `overrides` pin `sasl-scram-sha-1` to `1.3.0`, so a
fresh `npm install` (or `openclaw xmpp update`, which runs it) resolves the
compatible version. If a machine was installed before the pin, run
`npm install` in the plugin directory once.

## File Layout

```
xmpp/
├── index.ts                    # Plugin entry point (register function)
├── setup-entry.ts              # Setup entry (re-exports from index.ts)
├── package.json                # Dependencies (@xmpp/client)
├── openclaw.plugin.json        # Plugin manifest (channel registration)
├── tsconfig.json               # TypeScript compiler configuration
├── install.sh                  # Linux install script
├── install.ps1                 # Windows install script
├── src/
│   ├── gateway.ts            # Gateway lifecycle (start/stop account, message dispatch)
│   ├── startXMPP.ts          # XMPP client setup, stanza handler, reconnection, presence
│   ├── presence.ts           # PresenceManager (shows/status, auto-activity, persistence)
│   ├── presence-hooks.ts     # Maps OpenClaw agent hooks -> presence activity
│   ├── slash-commands.ts     # In-chat slash command dispatcher (/help, /vcard, /presence, …)
│   ├── vcard-server.ts       # vCard/vCard4 query/update/avatar + PEP publish
│   ├── vcard.ts              # Local vCard storage
│   ├── outbound.ts           # Outbound message sending
│   ├── commands.ts           # CLI commands registration (vcard, vcard4, presence, sftp, …)
│   ├── contacts.ts           # Contact management
│   ├── roster-store.ts       # Roster storage
│   ├── whiteboard.ts         # Whiteboard (SXE/SWB) message parsing
│   ├── whiteboard-session.ts # Whiteboard session manager
│   ├── messageStore.ts       # Message persistence
│   ├── mention.ts            # Groupchat mention detection
│   ├── sftp.ts               # SFTP transfers (pinned host key)
│   ├── updater.ts            # Auto-update (GitHub releases)
│   ├── onboarding.ts         # `openclaw xmpp setup` wizard
│   ├── fileTransfer.ts       # HTTP upload/SI file transfer
│   ├── jsonStore.ts          # JSON storage utilities
│   ├── types.ts              # TypeScript types
│   ├── config.ts             # Plugin configuration constants
│   ├── state.ts              # Runtime state
│   ├── secret-contract.ts    # Secret store integration
│   ├── setup-plugin.ts       # Plugin setup wizard
│   ├── channel-plugin.ts     # Channel plugin descriptor
│   ├── cli-metadata.ts       # CLI metadata builder
│   ├── cli-encrypt.ts        # Password encryption CLI
│   ├── queue-bridge.ts       # Message queue bridge
│   ├── gateway-client.ts     # Gateway RPC client (in-process SDK + spawn fallback)
│   ├── security/
│   │   ├── adapter.ts        # Security adapter for OpenClaw SDK
│   │   ├── encryption.ts     # Password encryption (AES-256-GCM)
│   │   ├── validation.ts     # Input validation (JID, filename, URL)
│   │   └── fileTransfer.ts   # Secure file transfer (MIME, quarantine)
│   ├── lib/
│   │   ├── logger.ts         # Logging utilities
│   │   ├── upload-protocol.ts # HTTP File Upload (XEP-0363)
│   │   ├── vcard-protocol.ts # vCard (XEP-0054) helpers
│   │   ├── vcard4-protocol.ts # vCard4 (XEP-0292) helpers
│   │   ├── vcard-ops.ts      # vCard actions on the live connection
│   │   ├── json-extract.ts   # Robust JSON extraction from CLI output
│   │   ├── questions.ts      # ask_user pending-question store + answer parsing
│   │   ├── ask-user.ts       # ask_user capture/render/resolve (gateway)
│   │   ├── persistent-queue.ts # Persistent message queue
│   │   ├── contact-factory.ts # Contact factory
│   │   ├── config-loader.ts  # Config loader
│   │   ├── xmpp-connect.ts   # XMPP client connection helpers
│   │   └── xmpp-utils.ts     # XMPP stanza utility helpers
│   └── shared/
│       └── index.ts          # Shared types/constants
├── data/                     # Storage (per-install, DO NOT COPY between machines)
│   ├── xmpp-contacts.json
│   ├── xmpp-admins.json
│   ├── xmpp-vcard.json
│   ├── xmpp-presence.json
│   └── messages/
│       ├── direct/
│       └── group/
├── tests/                    # node:test suites
├── dist/                     # Compiled JS (delete after pulling updates)
├── README.md
├── XMPPAUDIT.md
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
