# SXE Whiteboard Functional Specification

## Overview

The SXE Whiteboard implementation uses the SXE protocol (`http://jabber.org/protocol/sxe`) for PSI+ compatibility. It supports session-based whiteboard collaboration with SVG-based drawing operations.

## Architecture

### Files Involved
1. **`src/whiteboard-cli.ts`** - CLI commands for sending whiteboard messages
2. **`src/commands.ts`** - Command-line argument parsing for CLI
3. **`src/startXMPP.ts`** - Incoming SXE message handling

---

## Protocol: SXE Session Lifecycle

### 1. Session Establishment

```
Bot --------------------> Client: <invitation/> (with session ID)
Client -----------------> Bot:    <accept-invitation/>
Bot --------------------> Client: <document-begin/> (session established)
```

### 2. Drawing Operations (Within Session)

```
Bot <--------------------> Client: <new/>, <set/>, <remove/> elements
```

### 3. Session End

```
Bot <--------------------> Client: <left-session/> or session timeout
```

---

## XML Structure Reference

### SXE Element Wrapper
```xml
<sxe xmlns="http://jabber.org/protocol/sxe" session="sxe1234567890">
  <!-- child elements here -->
</sxe>
```

### Negotiation Phase Elements
| Element | Purpose |
|---------|---------|
| `<negotiation><invitation/></negotiation>` | Initial invitation |
| `<negotiation><accept-invitation/></negotiation>` | Accept invitation |
| `<negotiation><document-begin/></negotiation>` | Session established |
| `<negotiation><left-session/></negotiation>` | Session ended |

### Drawing Elements
| Element | Purpose |
|---------|---------|
| `<new id="path1"><svg>...</svg></new>` | Add new path |
| `<set id="path1"><svg>...</svg></set>` | Modify existing path |
| `<remove id="path1"/>` | Delete path |

---

## CLI Commands (`src/whiteboard-cli.ts`)

### `sendWhiteboardInvitation(to, isGroupChat)`
- Creates new session with unique ID (`sxe{timestamp}{random}`)
- Sends `<invitation/>` with SVG feature
- **No body** - only SXE element (prevents chat message appearance)

### `sendWhiteboardMessage(to, pathData, options)`
- Options: `stroke`, `strokeWidth`, `id`, `sessionId`, `isGroupChat`
- Sends `<new>` element with SVG path content
- Includes body for debugging

### `sendWhiteboardMove(to, id, dx, dy, sessionId)`
- Sends `<set>` element with transform translate

### `sendWhiteboardDelete(to, id, sessionId)`
- Sends `<remove>` element

### `sendWhiteboardClear(to, sessionId)`
- Sends `<document-begin/>` + `<document-end/>` pair

---

## Incoming Message Handling (`src/startXMPP.ts`)

### Processing Flow
1. Check for `<sxe xmlns="http://jabber.org/protocol/sxe">` element
2. Extract `session` attribute
3. Use `findChild()` helper (manual iteration) to find child elements
4. Handle based on child element type
5. Return early to prevent SXE appearing as chat message

### `findChild(parent, name)` Helper
- Manual iteration through `parent.children`
- Matches by `child.name` or `child.tagName`
- **Critical**: `@xmpp/client` getChild() doesn't work with namespaced elements

### Handling Cases
| Condition | Action |
|-----------|--------|
| `<negotiation><invitation/></negotiation>` | Auto-accept, send `<accept-invitation/>` + `<document-begin/>` |
| `<negotiation><accept-invitation/></negotiation>` | Send `<document-begin/>` |
| `<negotiation><document-begin/></negotiation>` | Log session established |
| `<negotiation><left-session/></negotiation>` | Log session ended |
| `<new>`, `<set>`, `<remove>` | Log whiteboard data (TODO: actual processing) |

---

## Known Limitations

1. **Client-initiated invitations fail**: PSI+ shows "contact does not support whiteboarding" - caps caching issue when client initiates
2. **No whiteboard rendering**: Bot receives `<new>`/`<set>`/`<remove>` but doesn't process SVG content
3. **Session state not tracked**: Bot doesn't maintain session state - each message is independent

---

## Future Development Areas

1. **Process incoming drawing data**: Parse `<new>`, `<set>`, `<remove>` SVG content
2. **Session management**: Track active sessions, handle cleanup
3. **Caps improvement**: Fix client-initiated invitation support
4. **CLI drawing commands**: Allow sending drawings via CLI
5. **Group chat support**: Handle MUC whiteboard sessions
