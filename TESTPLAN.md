# XMPP Plugin Test Plan

## Prerequisites
- XMPP server running (kazakhan.com)
- ClawdBot gateway running
- Test accounts: bot@, abot@, clawdbothome@, jamie@
- Test room: general@conference.kazakhan.com

---

## 1. Direct Messages

### 1.1 Send Direct Message (Bot -> User)
**Command:**
```
clawdbot xmpp msg jamie@kazakhan.com "Hello Jamie, this is a test"
```

**Expected:**
- Message delivered to Jamie's XMPP client
- Confirmation: `Message sent to jamie@kazakhan.com`

### 1.2 Receive Direct Message (User -> Bot)
**Action:**
- Send message from jamie@kazakhan.com to bot@kazakhan.com

**Expected:**
- Message queued in message store
- Visible via: `clawdbot xmpp poll`
- Logs show: `Message added to queue`

### 1.3 Message with Agent Response
**Action:**
1. Send message to bot: "Hello, who are you?"
2. Start gateway if not running

**Expected:**
- Agent responds via gateway
- Response routed back to user

---

## 2. Group Messages (MUC)

### 2.1 Join Room
**Command:**
```
clawdbot xmpp join general@conference.kazakhan.com
```
**Or via slash command:**
```
/join general@conference.kazakhan.com
```

**Expected:**
- Bot joins room with default nick (clawdbot or configured)
- Confirmation in chat: `Joined room: general@conference.kazakhan.com as clawdbot`
- Bot visible in room roster

### 2.2 Receive Group Message
**Action:**
- User sends message in room

**Expected:**
- Message delivered to bot
- Message queued with room JID
- `from` field includes room/nick format

### 2.3 Send Group Message
**Command:**
- Via groupchat from bot

**Expected:**
- Message visible to all room occupants
- Correct message format (type="groupchat")

### 2.4 Leave Room
**Command:**
```
clawdbot xmpp leave general@conference.kazakhan.com
```
**Or via slash command:**
```
/leave general@conference.kazakhan.com
```

**Expected:**
- Bot leaves room
- Confirmation: `Left room: general@conference.kazakhan.com`

---

## 3. CLI Commands

### 3.1 Status Command
**Command:**
```
clawdbot xmpp status
```

**Expected:**
- Shows XMPP connection status
- If connected: `Connected (no status available)` or actual status
- If not connected: `XMPP client not connected. Gateway must be running.`

### 3.2 Start Command
**Command:**
```
clawdbot xmpp start
```

**Expected:**
- Gateway starts in background
- Confirmation: `Gateway starting in background`
- Wait 3 seconds, try status

### 3.3 Roster Command
**Command:**
```
clawdbot xmpp roster
```

**Expected:**
- Lists roster entries
- Format: `jid: nickname`

### 3.4 Nick Command
**Command:**
```
clawdbot xmpp nick jamie@kazakhan.com Jamie
```

**Expected:**
- Nickname saved for JID
- Confirmation: `Nickname set for jamie@kazakhan.com: Jamie`

### 3.5 Poll Command
**Command:**
```
clawdbot xmpp poll
```

**Expected:**
- Shows unprocessed messages
- Format: `[accountId] from: body`
- `No unprocessed messages in queue` if empty

### 3.6 Queue Command
**Command:**
```
clawdbot xmpp queue
```

**Expected:**
- Shows queue stats: `X total, Y unprocessed`
- Lists up to 5 recent messages with status

### 3.7 Clear Command
**Command:**
```
clawdbot xmpp clear
```

**Expected:**
- Clears old messages from queue
- Confirmation: `Cleared N old messages`

### 3.8 vCard Commands
**Command:**
```
clawdbot xmpp vcard help
clawdbot xmpp vcard get
clawdbot xmpp vcard set fn "My Bot Name"
clawdbot xmpp vcard set nickname bot
```

**Expected:**
- Help shows available options
- Get shows current vCard fields
- Set updates field and confirms

---

## 4. Slash Commands (In-Chat)

### 4.1 /help
**Action:** Send `/help` to bot

**Expected:**
- Lists available commands:
  - `list` - List agents
  - `add` - Add agent
  - `remove` - Remove agent
  - `admins` - List admins
  - `whoami` - Show your JID
  - `join` - Join room
  - `rooms` - List joined rooms
  - `leave` - Leave room
  - `invite` - Invite to room
  - `whiteboard` - Whiteboard commands
  - `vcard` - vCard management
  - `help` - Show this help

### 4.2 /whoami
**Action:** Send `/whoami` to bot

**Expected:**
- Shows your bare JID: `You are: jamie@kazakhan.com`

### 4.3 /admins
**Action:** Send `/admins` to bot

**Expected:**
- Lists admin JIDs

### 4.4 /join
**Action:** Send `/join room@conference.domain.com` to bot

**Expected:**
- Bot joins specified room
- Confirmation: `Joined room: room@conference.domain.com as nick`

### 4.5 /leave
**Action:** Send `/leave` in room

**Expected:**
- Bot leaves current room
- Confirmation: `Left room: room@conference.domain.com`

### 4.6 /rooms
**Action:** Send `/rooms` to bot

**Expected:**
- Lists currently joined rooms

### 4.7 /vcard
**Action:** Send `/vcard help`

**Expected:**
- Shows vCard subcommands:
  - `get` - View vCard
  - `set <field> <value>` - Update field (fn, nickname, url, desc, avatarUrl)

### 4.8 /invite
**Action:** Send `/invite user@domain.com`

**Expected:**
- Bot invites user to current room

---

## 5. Rate Limiting

### 5.1 Command Rate Limit
**Action:**
- Send more than 10 commands in 1 minute from same JID

**Expected:**
- After 10th command: `❌ Too many commands. Please wait before sending more.`
- Commands rejected until window resets (1 minute)

---

## 6. Security Tests

### 6.1 Path Traversal (Download)
**Action:**
- Try to trigger file download with path traversal in filename

**Expected:**
- Filename sanitized
- `../` replaced with safe characters
- Files saved to correct directory

### 6.2 Path Traversal (IBB Transfer)
**Action:**
- Receive file via IBB with malicious filename

**Expected:**
- Filename sanitized on save
- No files written outside intended directory

---

## 7. Message Queue Tests

### 7.1 Queue Max Size
**Action:**
- Add more than 100 messages to queue

**Expected:**
- Queue caps at 100 messages
- Oldest messages removed when exceeding limit

### 7.2 Queue Persistence
**Action:**
1. Add messages to queue
2. Restart gateway
3. Check queue

**Expected:**
- Messages still in queue (if persistent storage working)

---

## Test Results Summary

| Test | Status | Notes |
|------|--------|-------|
| Direct send | ☐ | |
| Direct receive | ☐ | |
| Group join | ☐ | |
| Group receive | ☐ | |
| Group send | ☐ | |
| Group leave | ☐ | |
| CLI status | ☐ | |
| CLI start | ☐ | |
| CLI roster | ☐ | |
| CLI nick | ☐ | |
| CLI poll | ☐ | |
| CLI queue | ☐ | |
| CLI clear | ☐ | |
| CLI vcard | ☐ | |
| Slash /help | ☐ | |
| Slash /whoami | ☐ | |
| Slash /admins | ☐ | |
| Slash /join | ☐ | |
| Slash /leave | ☐ | |
| Slash /rooms | ☐ | |
| Slash /vcard | ☐ | |
| Slash /invite | ☐ | |
| Rate limiting | ☐ | |
| Path traversal | ☐ | |
| Queue max size | ☐ | |

---

## Quick Test Script

```bash
# Start gateway
clawdbot xmpp start
sleep 3

# Check status
clawdbot xmpp status

# Test commands
clawdbot xmpp roster
clawdbot xmpp queue
clawdbot xmpp poll

# Send test message
clawdbot xmpp msg jamie@kazakhan.com "Test message $(date)"

# Check queue after receiving
clawdbot xmpp poll

# vCard test
clawdbot xmpp vcard get
```
