# Changelog

All notable changes to the ClawdBot XMPP plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-31

### Added
- Initial release of ClawdBot XMPP plugin
- Full XMPP protocol support using `@xmpp/client`
- Multi-User Chat (MUC) integration with auto-join
- Direct messaging support
- Slash command system for room management
- HTTP Upload file transfer (XEP-0363) for sending files
- SI File Transfer with IBB (XEP-0096) for receiving files
- Whiteboard integration with `/whiteboard` commands:
  - `/whiteboard draw <prompt>` - Image generation requests
  - `/whiteboard send <url>` - Image sharing
  - `/whiteboard status` - Capability check
- Contact management system
- Admin JID configuration
- CLI commands for ClawdBot interface
- Message queue system for inbound messages
- Auto-accept MUC invites
- File download from URLs to local storage
- Presence management and online status

### Technical Features
- TypeScript implementation
- Automatic reconnection on network issues
- TLS support (with verification disabled for development)
- Configurable data directory for contacts and downloads
- Persistent storage for contacts and admin lists
- Runtime channel integration with ClawdBot

### Configuration
- XMPP server connection settings
- Multiple room auto-join configuration
- Admin JID for privileged commands
- Data directory path configuration

## [Unreleased]

### Planned Features
- SOCKS5 Bytestreams support (XEP-0065)
- Jingle file transfer (XEP-0234)
- Enhanced whiteboard with drawing tools
- Image optimization before sending
- File size limits and validation
- Improved error handling and logging
- Unit tests and integration tests
- Documentation improvements