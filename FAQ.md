# Frequently Asked Questions

## General

### What XMPP servers are supported?
The plugin should work with any standards-compliant XMPP server including:
- **Prosody** (recommended for development)
- **ejabberd**
- **Openfire**
- **Tigase**
- Any server implementing XMPP RFC 6120/6121/7622

### Does it support OMEMO encryption?
Not currently. The plugin focuses on core XMPP functionality and file transfer. OMEMO support would require additional dependencies and implementation.

### Can I use it with public XMPP servers?
Yes, you can configure it with public servers like:
- `xmpp://xmpp.example.org:5222`
- `xmpp://chat.example.org:5222`

Check the server's terms of service and ensure bot accounts are allowed.

## vCard (User Profile)

### How do I set my vCard (profile info)?
vCard is stored on the **XMPP server**, not by the bot. Use your XMPP client:
- **Conversations**: Settings → Profile → Edit Profile
- **Gajim**: Actions → Personal Information
- **Other clients**: Look for "Profile" or "vCard" in settings

### Can users set vCard through the bot?
No. Users must set their vCard through their XMPP client. The bot only:
- Responds to vCard requests for itself
- Forwards vCard GET requests to the server for other users

### Why do I get "Not Found" when querying vCard?
This means the user hasn't set their vCard on the server. They need to:
1. Open their XMPP client
2. Go to Profile/Account settings
3. Set their display name, nickname, etc.

The bot cannot create or modify user vCards on the server.

### Does the bot have a vCard?
Yes! The bot responds to vCard GET requests with its profile info. Configure it with `/vcard set` commands (admin only).

### Can I see who's online with their vCard?
XMPP doesn't provide a standard way to query all users' vCards at once. You can query individual users' vCards if they're online and your server allows it.

## Shared Sessions & Memory

### What are shared sessions?
Shared sessions allow the bot to maintain memory continuity between direct chat and groupchat. When a user is identified (via occupant-ID or nick mapping), both conversation types use the same session key, enabling the agent to remember context across both.

### How does user identification work?
1. **Occupant-ID (XEP-0327)**: Servers like Prosody provide stable occupant IDs in MUC rooms. The plugin uses these for consistent user identification.
2. **Direct Message Learning**: When a user messages the bot directly, their nick is learned for future groupchat correlation.
3. **Manual Mapping**: Use `/mapnick :nickname user@domain.com` to manually map room nicks to JIDs.

### How do I enable session memory searching?
Add to `~/.clawdbot/clawdbot.json`:
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
This enables the `memory_search` tool to search both memory files and session transcripts.

### Why doesn't the bot remember my groupchat messages?
Common reasons:
1. **User not identified**: The bot doesn't know who "KazaKhan" is. Use `/mapnick :KazaKhan your-jid@domain.com`
2. **Session memory disabled**: Enable `memorySearch.experimental.sessionMemory` in config
3. **New session**: Each conversation starts fresh unless shared session is established

### How does the bot identify users in groupchat?
The bot uses:
1. **Occupant-ID** (XEP-0327) if server provides it
2. **Nick-to-JID mappings** learned from direct messages
3. **Manual mappings** via `/mapnick` command

## Configuration

### Why isn't my bot connecting?
Common connection issues:
1. **Wrong server address**: Ensure the `service` URL is correct
2. **Firewall blocking**: Check if port 5222 is open
3. **TLS issues**: The plugin disables TLS verification (`rejectUnauthorized: false`)
4. **Wrong credentials**: Double-check JID and password
5. **Server doesn't exist**: Verify the XMPP server is running

### How do I find my XMPP server domain?
The domain is usually the part after `@` in your JID:
- JID: `bot@example.com` → domain: `example.com`
- JID: `user@chat.example.org` → domain: `chat.example.org`

### What's the difference between `service` and `domain`?
- `service`: Full XMPP server URL (e.g., `xmpp://example.com:5222`)
- `domain`: XMPP domain for authentication (e.g., `example.com`)

## File Transfer

### Why can't I send files?
File transfer issues:
1. **Server doesn't support HTTP Upload**: Check if your server has `mod_http_upload` (Prosody) or equivalent
2. **File too large**: Server may have size limits
3. **Network issues**: Firewall blocking HTTP PUT requests
4. **Missing dependencies**: Ensure Node.js can make HTTP requests

### Where are downloaded files saved?
Files are saved to `{dataDir}/downloads/` where `dataDir` is configured in your settings.

### What's the maximum file size?
The plugin doesn't enforce size limits, but your XMPP server might. Common limits:
- Prosody: Configurable in `mod_http_upload`
- ejabberd: Configurable in settings
- Default: Often 10MB-100MB

## Multi-User Chat

### Why can't I join rooms?
Room join failures:
1. **Wrong room format**: Should be `room@conference.example.com`
2. **Room doesn't exist**: The room must be created first
3. **Permission denied**: Room may be members-only
4. **MUC service different**: Some servers use `muc.example.com` instead of `conference.example.com`

### How do I create a room?
The plugin doesn't create rooms automatically. Create rooms using your XMPP client first, then configure the bot to auto-join.

### Can the bot moderate rooms?
Basic moderation is possible through slash commands. Advanced moderation would require additional implementation.

## Whiteboard

### What does `/whiteboard draw` actually do?
It forwards the request to ClawdBot agents with `whiteboardRequest: true` flag. The actual image generation depends on:
1. Agent capabilities
2. Available image generation services
3. ClawdBot configuration

### Can I use it with Stable Diffusion/DALL-E/Midjourney?
Yes, if you have an agent configured to use those services. The plugin just routes the request.

### Why doesn't `/whiteboard send` work with local files?
It only accepts HTTP/HTTPS URLs. For local files, use `/file send` instead.

## Development

### How do I add new slash commands?
1. Add command handler in `processMessage` function in `index.ts`
2. Update `/help` command output
3. Test with XMPP client

### Can I use this as a base for my own XMPP bot?
Yes! The plugin provides a solid foundation for XMPP bot development with ClawdBot.

### How do I debug connection issues?
Enable verbose logging in ClawdBot and check:
- Connection attempts
- Authentication process
- Stanza exchange
- Error messages

## Performance

### How many simultaneous connections does it support?
The plugin is designed for single-account use. Multiple accounts would require additional implementation.

### Does it handle reconnection?
Yes, automatic reconnection is built into the `@xmpp/client` library.

### Memory usage with large file transfers?
Files are buffered in memory during transfer. For very large files, consider implementing streaming to disk.

## Security

### Is it safe to disable TLS verification?
For development, it's acceptable. For production, configure proper TLS certificates on your server.

### Can I restrict who can message the bot?
Yes, through contact management and potential whitelist implementation.

### Are passwords stored securely?
Passwords are stored in `clawdbot.json` configuration. Ensure proper file permissions.

## Integration

### Can it work with other ClawdBot plugins?
Yes, it integrates with the ClawdBot channel system and can work alongside other plugins.

### How do I get messages into my agent?
Messages are routed through ClawdBot's channel system. Ensure your agent is listening to the `xmpp` channel.

### Can I use it with webhooks or APIs?
Not directly, but you could extend the plugin to support webhook integration.

## Shared Sessions FAQ

### How do I check if a user is mapped?
The bot logs nick-to-JID mappings when messages are received. Look for:
```
[SESSION] Learned nick→JID mapping: "jamie" -> jamie@kazakhan.com
[SESSION] Admin mapped ":KazaKhan" -> jamie@kazakhan.com
```

### What if the server doesn't support Occupant-ID?
The plugin falls back to:
1. Nick-to-JID mappings learned from direct messages
2. Manual `/mapnick` commands

Configure your Prosody server with `mod_occupant_id` for automatic occupant identification.

### Does shared session work with different nicks?
Yes, but you need to map each nick:
```
/mapnick :Jamie user@domain.com
/mapnick :KazaKhan user@domain.com
```
Both will use the same session.

### Can I see current session mappings?
Check the debug logs for:
```
[DEBUG] nickToJidMap contents: [ [ ':jamie', 'jamie@kazakhan.com' ], [ ':KazaKhan', 'jamie@kazakhan.com' ] ]
```

### What's the session key format?
- Direct chat: `xmpp:user@domain.com`
- Groupchat (known user): `xmpp:user@domain.com` (shared with direct)
- Groupchat (unknown): `xmpp:room@conference.domain.com:nick` (separate session)