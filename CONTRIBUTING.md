# Contributing to OpenClaw XMPP Plugin

Thank you for your interest in contributing to the OpenClaw XMPP plugin! This document provides guidelines and instructions for contributing.

## Development Setup

1. **Fork and clone** the repository
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Set up testing environment**:
   - You'll need an XMPP server for testing
   - Configure the plugin in your OpenClaw `openclaw.json`
   - Use a test account on the XMPP server

## Code Style

- **TypeScript**: Use strict TypeScript with proper typing
- **Naming**: Use descriptive names for variables and functions
- **Comments**: Add comments for complex logic
- **Formatting**: Follow existing code style in the project

## Pull Request Process

1. **Create a branch** for your feature or bug fix
2. **Make your changes** with appropriate tests
3. **Update documentation** (README, CHANGELOG, XMPPAUDIT if XEPs change)
4. **Ensure TypeScript compiles** without errors
5. **Test with a real XMPP server**
6. **Submit pull request** with clear description

## Release Checklist (maintainers)

Run this for **every** release. The README has gone stale in the past; steps 3
and 4 are mandatory.

1. Back up every file you edit to `_backups/<version>_<timestamp>/`.
2. Update `CHANGELOG.md` (new entry at the top) and bump the `package.json`
   version. Never edit previous CHANGELOG entries.
3. **Verify `README.md` is current**: Status/version, feature highlights, the
   CLI + slash command lists, config examples, and File Layout must match the
   code. `node --test tests/readme.test.ts` fails if README is stale.
4. **Verify `XMPPAUDIT.md`** if XMPP/XEP support changed.
5. Build and test:
   ```bash
   npx tsc
   node --test tests/*.test.ts
   ```
   Only the documented pre-existing failures are acceptable (see `AGENTS.md`).
6. Commit (`type(version): summary`), push, and create a GitHub release using
   the `GITHUB_KAZA_TOKEN` in `~/.bashrc` (never store or print the token).

## Testing Guidelines

- Test with at least one XMPP server (Prosody recommended)
- Test both 1:1 chat and MUC functionality
- Verify file transfer works in both directions
- Test reconnection after network interruption
- Ensure backward compatibility with existing configuration

## Feature Requests

When suggesting new features:

1. Check if the feature already exists or is planned
2. Explain the use case and benefits
3. Consider XMPP protocol standards (XEPs)
4. Discuss implementation approach

## Bug Reports

When reporting bugs:

1. Use the issue template
2. Include XMPP server type and version
3. Provide configuration (sanitized)
4. Include error logs and stack traces
5. Describe steps to reproduce

## Documentation

- Update README.md for user-facing changes
- Update CHANGELOG.md for all changes
- Add inline code comments for complex features
- Consider adding example configurations

## XMPP Protocol Standards

This plugin implements several XMPP Extension Protocols (XEPs):

- **XMPP Core**: RFC 6120, RFC 6121, RFC 7622
- **XEP-0045**: Multi-User Chat
- **XEP-0096/XEP-0065/XEP-0047**: SI / SOCKS5 / In-Band file transfer
- **XEP-0363**: HTTP File Upload
- **XEP-0054**: vcard-temp
- **XEP-0084**: User Avatar
- **XEP-0292**: vCard4 over XMPP (PEP)

See `XMPPAUDIT.md` for the full status table, supported/partial/detected
breakdowns, and a prioritized list of candidate XEPs.

When adding new features, prefer using established XEPs where possible.

## Questions?

Feel free to open an issue for questions about:
- Implementation approach
- XMPP protocol details
- Configuration options
- Integration with OpenClaw