# XMPP Plugin Test Suite

Automated test scripts for validating all XMPP plugin functionality.

## Requirements

- PowerShell 7+ (Windows) or Bash (Linux)
- OpenClaw gateway installed and configured
- XMPP accounts: `jamie@kazakhan.com` and `abot@kazakhan.com`
- Room: `general@conference.kazakhan.com`

## Quick Start

### Windows (PowerShell)
```powershell
cd tests
.\test.ps1
```

### Linux (Bash)
```bash
cd tests
bash test.sh
```

## Test Files

| File | Purpose |
|------|---------|
| `test.ps1` | Windows PowerShell test script |
| `test.sh` | Linux Bash test script |
| `test-config.ps1` | Windows configuration |
| `test-config.sh` | Linux configuration |
| `test-common.ps1` | Windows shared functions |
| `test-common.sh` | Linux shared functions |

## What Gets Tested

1. **Direct Messages** - Bot ↔ User messaging
2. **MUC** - Join room, send/receive messages
3. **Contact Management** - Add/remove contacts, nicknames
4. **Subscriptions** - Pending subscription management
5. **vCard** - Get/set vCard fields (backed up and restored!)
6. **SFTP removal verification** - asserts the `xmpp sftp` subcommand is gone (removed in 2.0.15 for security)
7. **Audit Logging** - Status and event listing
8. **Rate Limiting** - Commands blocked after limit
9. **MUC Invites** - Auto-accept behavior
10. **Slash Commands** - In-chat command handling

## Safety Features

- **vCard Backup**: Original vCard saved to `backups/vcard-original.json` and restored after tests
- **Test Files**: All test files use unique timestamps (e.g., `xmpp-test-20260207-120000.txt`)
- **Cleanup**: All test files removed after completion
- **No Overwrites**: Never modifies `index.html` or other existing files

## Output

- **Console**: Real-time test progress with colors
- **Log File**: Full output saved to `/tmp/xmpp-test/test-output.log` (Linux) or `$env:TEMP\xmpp-test\test-output.log` (Windows)

## Test Results

```
========================================
TEST SUMMARY
========================================
Duration: 127.5s
Passed: 42
Failed: 2
Skipped: 0

Failed Tests:
- Rate limiting (not triggered)
- Audit export (file not created)

[Cleanup] vCard restored
[Cleanup] Test files removed
========================================
```

## Troubleshooting

### Gateway Not Running
Tests will automatically attempt to start the gateway. If it fails:
```bash
# Manual start
openclaw xmpp start

# Check status
openclaw xmpp status
```

### Permission Denied (Linux)
```bash
chmod +x test.sh
```

### PowerShell Execution Policy (Windows)
```powershell
# If you get execution policy error:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Manual Verification

Some tests require manual verification:
- Reading abot's responses in poll queue
- Verifying room presence
- Checking file content

The script will prompt or continue on timeout.

## Adding New Tests

To add a new test:

1. Add test function to `test-common.ps1` or `test-common.sh`
2. Add test section to `test.ps1` or `test.sh`
3. Use `Assert-Test` helper for pass/fail

Example:
```bash
# In test.sh
section_header "TEST X: New Feature"
Write-TestLog -Level "INFO" -Message "Test X.1: Testing new feature..."
run_command "openclaw xmpp new-feature" 30
Assert-Test "New feature" "$?" "0" "$?"
```

## Notes

- Tests run in sequence (1-12)
- Some tests wait up to 2 minutes for abot responses
- Rate limiting test sends 12 rapid commands
- All file operations use temporary directory
- vCard is always restored to original state
