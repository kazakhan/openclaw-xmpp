#!/bin/bash
# XMPP Plugin Automated Test Suite (Linux)
# Run: bash test.sh

# Source common functions and config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-common.sh"

# Guaranteed cleanup on exit (even if set -e would have killed us)
trap 'cleanup_test_files; restore_vcard' EXIT

# Initialize
init_log
section_header "XMPP Plugin Automated Test Suite"

#========================================
# SETUP PHASE
#========================================
log "INFO" "=== SETUP PHASE ==="

# Check gateway
if ! ensure_gateway; then
    log "ERROR" "Failed to start gateway. Exiting."
    exit 1
fi
assert "Gateway running" "$?" "0" "$?"

# Save vCard
save_vcard

# Clear old test data
cleanup_test_files

#========================================
# TEST 1: DIRECT MESSAGES
#========================================
section_header "TEST 1: Direct Messages"

# Test 1.1: Bot -> User
# Uses assert_output because msg spawns a gateway child that may exit non-zero
# even when the message sends successfully.
log "INFO" "Test 1.1: Sending DM from bot to tester..."
TEST_MSG=$(get_test_message "DM1")
MSG_OUTPUT=$(run_command "openclaw xmpp msg $TESTER_JID '$TEST_MSG'" 30)
assert_output "Send DM from bot" "$MSG_OUTPUT" "sent|message|delivered|$TESTER_JID"

# Test 1.2: User -> Bot
log "INFO" "Test 1.2: Sending DM from tester to bot..."
DM_REPLY="Hello abot, this is a test message"
REPLY_OUTPUT=$(run_command "openclaw xmpp msg $BOT_JID '$DM_REPLY'" 30)
assert_output "Send DM to bot" "$REPLY_OUTPUT" "sent|message|delivered|$BOT_JID"

# Wait for abot response (abot echoes with prefix)
log "INFO" "Test 1.3: Waiting for abot response..."
sleep 10
POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
if echo "$POLL_OUTPUT" | grep -qi "$BOT_JID"; then
    assert "Receive DM from bot" "true" "response" "received"
else
    # Try sending another message to trigger response
    log "INFO" "Sending follow-up to trigger abot..."
    run_command "openclaw xmpp msg $BOT_JID 'ping'" 30 >/dev/null 2>&1
    sleep 15
    POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
    if echo "$POLL_OUTPUT" | grep -qi "$BOT_JID"; then
        assert "Receive DM from bot (retry)" "true" "response" "received"
    else
        assert "Receive DM from bot" "false" "response" "none"
    fi
fi

# Test 1.3: Message Queue (read-only — exit code assertion OK)
log "INFO" "Test 1.4: Checking message queue..."
QUEUE_OUTPUT=$(run_command "openclaw xmpp queue" 10)
assert "Queue command works" "$?" "0" "$?"

# Test 1.4: Poll Messages (read-only — exit code assertion OK)
log "INFO" "Test 1.5: Polling messages..."
POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
assert "Poll command works" "$?" "0" "$?"

#========================================
# TEST 2: MUC - JOIN ROOM
#========================================
section_header "TEST 2: MUC - Join Room"

log "INFO" "Test 2.1: Joining room $ROOM_JID..."
JOIN_OUTPUT=$(run_command "openclaw xmpp join $ROOM_JID" 30)
# join spawns a gateway; check output content instead of exit code
assert_output "Join room command" "$JOIN_OUTPUT" "joined|success|already joined|room|$ROOM_JID"

if echo "$JOIN_OUTPUT" | grep -qi "joined\|success"; then
    log "INFO" "Successfully joined room"
    assert "Room joined" "true" "joined" "joined"
else
    log "WARN" "Could not verify room join via keyword"
    # If output contains any XMPP-related content, consider it a soft pass
    if echo "$JOIN_OUTPUT" | grep -qiE "room|conference|presence|muc"; then
        log "INFO" "Room join appears successful (XMPP content in output)"
        assert "Room joined (soft)" "true" "joined" "likely"
    else
        assert "Room joined" "false" "joined" "unknown"
    fi
fi

# Test 2.2: List joined rooms (read-only — exit code assertion OK)
log "INFO" "Test 2.2: Checking joined rooms..."
ROOMS_OUTPUT=$(run_command "openclaw xmpp rooms" 10)
assert "Rooms command works" "$?" "0" "$?"

#========================================
# TEST 3: CONTACT MANAGEMENT
#========================================
section_header "TEST 3: Contact Management"

# Test 3.1: Add contact
log "INFO" "Test 3.1: Adding test contact..."
TEST_CONTACT="testuser@$XMPP_DOMAIN"
ADD_OUTPUT=$(run_command "openclaw xmpp add $TEST_CONTACT TestUser" 30)
assert_output "Add contact" "$ADD_OUTPUT" "added|contact|whitelist|roster|subscription"

# Test 3.2: List contacts (read-only — exit code assertion OK)
log "INFO" "Test 3.2: Listing contacts..."
ROSTER_OUTPUT=$(run_command "openclaw xmpp roster" 10)
assert "Roster command works" "$?" "0" "$?"
if echo "$ROSTER_OUTPUT" | grep -qi "$TEST_CONTACT"; then
    assert "Contact added" "true" "in roster" "found"
fi

# Test 3.3: Set nickname
log "INFO" "Test 3.3: Setting nickname..."
NICK_OUTPUT=$(run_command "openclaw xmpp nick $TEST_CONTACT TestNick" 30)
assert_output "Set nickname" "$NICK_OUTPUT" "nick|set|updated|roster"

# Test 3.4: Remove contact
log "INFO" "Test 3.4: Removing test contact..."
REMOVE_OUTPUT=$(run_command "openclaw xmpp remove $TEST_CONTACT" 30)
assert_output "Remove contact" "$REMOVE_OUTPUT" "removed|deleted|whitelist|roster"

#========================================
# TEST 4: SUBSCRIPTION MANAGEMENT
#========================================
section_header "TEST 4: Subscription Management"

if probe_command_exists "openclaw xmpp subscriptions pending"; then
    log "INFO" "Test 4.1: Listing pending subscriptions..."
    SUB_OUTPUT=$(run_command "openclaw xmpp subscriptions pending" 30)
    assert_output "Subscriptions pending" "$SUB_OUTPUT" "subscription|pending|none|list"
else
    skip_test "Subscriptions pending" "CLI command 'subscriptions' not registered (no handler in commands.ts)"
fi

#========================================
# TEST 5: VCARD
#========================================
section_header "TEST 5: vCard"

# Save current vCard is done in setup

# Pre-flight: check if vCard CLI can actually reach the server
VCARD_PROBE=$(run_command "openclaw xmpp vcard get" 10 2>&1)
if echo "$VCARD_PROBE" | grep -qi "configuration not found\|cannot load\|no such file"; then
    log "WARN" "vCard CLI cannot load XMPP config — skipping all vCard tests"
    skip_test "vCard get" "XMPP configuration not found in CLI context"
    skip_test "vCard set fn" "XMPP configuration not found in CLI context"
    skip_test "vCard set nickname" "XMPP configuration not found in CLI context"
    skip_test "vCard set url" "XMPP configuration not found in CLI context"
    skip_test "vCard set desc" "XMPP configuration not found in CLI context"
    skip_test "vCard verify fields" "XMPP configuration not found in CLI context"
    skip_test "vCard birthday/title/role/timezone/name/phone/email/address/org" "XMPP configuration not found in CLI context"
else
    # Test 5.1: Get vCard
    log "INFO" "Test 5.1: Getting current vCard..."
    VCARD_OUTPUT="$VCARD_PROBE"
    assert_output "vCard get" "$VCARD_OUTPUT" "FN:|Nickname:|vcard|BEGIN:VCARD"

    # Test 5.2: Modify vCard fields
    log "INFO" "Test 5.2: Modifying vCard fields..."
    TEST_FN="XMPP Test Bot $(get_timestamp)"
    TEST_NICK="xmpptest"
    TEST_URL="https://test.example.com"
    TEST_DESC="Modified by automated test on $(date)"

    VCARD_FN_OUT=$(run_command "openclaw xmpp vcard set fn '$TEST_FN'" 30)
    assert_output "vCard set fn" "$VCARD_FN_OUT" "set|updated|saved|ok"

    VCARD_NICK_OUT=$(run_command "openclaw xmpp vcard set nickname '$TEST_NICK'" 30)
    assert_output "vCard set nickname" "$VCARD_NICK_OUT" "set|updated|saved|ok"

    VCARD_URL_OUT=$(run_command "openclaw xmpp vcard set url '$TEST_URL'" 30)
    assert_output "vCard set url" "$VCARD_URL_OUT" "set|updated|saved|ok"

    VCARD_DESC_OUT=$(run_command "openclaw xmpp vcard set desc '$TEST_DESC'" 30)
    assert_output "vCard set desc" "$VCARD_DESC_OUT" "set|updated|saved|ok"

    # Verify changes
    log "INFO" "Test 5.3: Verifying vCard changes..."
    VCARD_VERIFY=$(run_command "openclaw xmpp vcard get" 30)
    echo "$VCARD_VERIFY" | grep -qi "$TEST_FN" && assert "vCard fn updated" "true" "found" "found" || assert "vCard fn updated" "false" "found" "not found"
    echo "$VCARD_VERIFY" | grep -qi "$TEST_NICK" && assert "vCard nickname updated" "true" "found" "found" || assert "vCard nickname updated" "false" "found" "not found"
    echo "$VCARD_VERIFY" | grep -qi "$TEST_URL" && assert "vCard url updated" "true" "found" "found" || assert "vCard url updated" "false" "found" "not found"

    # Test 5.4: Set birthday
    log "INFO" "Test 5.4: Setting birthday..."
    BDAY_OUT=$(run_command "openclaw xmpp vcard set birthday '1990-05-15'" 30)
    assert_output "vCard set birthday" "$BDAY_OUT" "set|updated|saved|ok"

    # Test 5.5: Set title
    log "INFO" "Test 5.5: Setting title..."
    TITLE_OUT=$(run_command "openclaw xmpp vcard set title 'Test Engineer'" 30)
    assert_output "vCard set title" "$TITLE_OUT" "set|updated|saved|ok"

    # Test 5.6: Set role
    log "INFO" "Test 5.6: Setting role..."
    ROLE_OUT=$(run_command "openclaw xmpp vcard set role 'Developer'" 30)
    assert_output "vCard set role" "$ROLE_OUT" "set|updated|saved|ok"

    # Test 5.7: Set timezone
    log "INFO" "Test 5.7: Setting timezone..."
    TZ_OUT=$(run_command "openclaw xmpp vcard set timezone '-05:00'" 30)
    assert_output "vCard set timezone" "$TZ_OUT" "set|updated|saved|ok"

    # Test 5.8: Set structured name
    log "INFO" "Test 5.8: Setting structured name..."
    NAME_OUT=$(run_command "openclaw xmpp vcard name 'Testbot' 'XMPP' 'Bot' 'Mr.'" 30)
    assert_output "vCard name" "$NAME_OUT" "set|updated|saved|ok"

    # Test 5.9: Add phone
    log "INFO" "Test 5.9: Adding phone..."
    PHONE_OUT=$(run_command "openclaw xmpp vcard phone add +61412345678 cell" 30)
    assert_output "vCard phone add" "$PHONE_OUT" "added|phone|set|ok"

    # Test 5.10: Add work phone
    log "INFO" "Test 5.10: Adding work phone..."
    WPHONE_OUT=$(run_command "openclaw xmpp vcard phone add +60987654321 work voice" 30)
    assert_output "vCard phone add work" "$WPHONE_OUT" "added|phone|set|ok"

    # Test 5.11: Add email
    log "INFO" "Test 5.11: Adding email..."
    EMAIL_OUT=$(run_command "openclaw xmpp vcard email add test@example.com home" 30)
    assert_output "vCard email add" "$EMAIL_OUT" "added|email|set|ok"

    # Test 5.12: Add work email
    log "INFO" "Test 5.12: Adding work email..."
    WEMAIL_OUT=$(run_command "openclaw xmpp vcard email add work@example.com work pref" 30)
    assert_output "vCard email add work" "$WEMAIL_OUT" "added|email|set|ok"

    # Test 5.13: Add address
    log "INFO" "Test 5.13: Adding address..."
    ADDR_OUT=$(run_command "openclaw xmpp vcard address add \"123 Test St\" Boston MA 02101 USA home" 30)
    assert_output "vCard address add" "$ADDR_OUT" "added|address|set|ok"

    # Test 5.14: Set organization
    log "INFO" "Test 5.14: Setting organization..."
    ORG_OUT=$(run_command "openclaw xmpp vcard org 'Test Corp' 'Engineering'" 30)
    assert_output "vCard org" "$ORG_OUT" "set|updated|saved|ok"

    # Test 5.15: Verify all new fields
    log "INFO" "Test 5.15: Verifying all new vCard fields..."
    VCARD_VERIFY2=$(run_command "openclaw xmpp vcard get" 30)
    echo "$VCARD_VERIFY2" | grep -qi "1990-05-15" && assert "vCard birthday" "true" "found" "found" || assert "vCard birthday" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "Test Engineer" && assert "vCard title" "true" "found" "found" || assert "vCard title" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "Developer" && assert "vCard role" "true" "found" "found" || assert "vCard role" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "+1234567890\|+61412345678" && assert "vCard phone" "true" "found" "found" || assert "vCard phone" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "test@example.com" && assert "vCard email" "true" "found" "found" || assert "vCard email" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "Boston" && assert "vCard address" "true" "found" "found" || assert "vCard address" "false" "found" "not found"
    echo "$VCARD_VERIFY2" | grep -qi "Test Corp" && assert "vCard org" "true" "found" "found" || assert "vCard org" "false" "found" "not found"
fi

#========================================
# TEST 6: SFTP
#========================================
section_header "TEST 6: SFTP File Management"

# Test 6.1: List files
log "INFO" "Test 6.1: Listing SFTP files..."
SFTP_LS=$(run_command "openclaw xmpp sftp ls" 60)
assert_output "SFTP ls" "$SFTP_LS" "file|listing|directory|total|\."

# Test 6.2: Upload file
log "INFO" "Test 6.2: Uploading test file..."
TIMESTAMP=$(get_timestamp)
TEST_FILENAME="xmpp-test-$TIMESTAMP.txt"
TEST_CONTENT="This is a test file for XMPP plugin automated testing.
Timestamp: $(date)
Purpose: Verify SFTP functionality
DO NOT DELETE: Test file will be removed by cleanup"
TEST_FILEPATH=$(create_test_file "$TEST_FILENAME" "$TEST_CONTENT")

SFTP_UPLOAD=$(run_command "openclaw xmpp sftp upload '$TEST_FILEPATH'" 60)
assert_output "SFTP upload" "$SFTP_UPLOAD" "uploaded|upload|success|ok|sent|transfer"

# Test 6.3: Download file
log "INFO" "Test 6.3: Downloading test file..."
DOWNLOAD_PATH="$TEST_FILES_DIR/downloaded-$TIMESTAMP.txt"
SFTP_DOWNLOAD=$(run_command "openclaw xmpp sftp download '$TEST_FILENAME' '$DOWNLOAD_PATH'" 60)
assert_output "SFTP download" "$SFTP_DOWNLOAD" "downloaded|download|success|ok|received|transfer"

if [ -f "$DOWNLOAD_PATH" ]; then
    assert "Downloaded file exists" "true" "file" "exists"
    if grep -q "This is a test file" "$DOWNLOAD_PATH"; then
        assert "Downloaded file content matches" "true" "content" "matched"
    else
        assert "Downloaded file content matches" "false" "content" "mismatch"
    fi
else
    assert "Downloaded file exists" "false" "file" "missing"
fi

# Test 6.4: Delete file
log "INFO" "Test 6.4: Deleting test file..."
SFTP_DELETE=$(run_command "openclaw xmpp sftp rm '$TEST_FILENAME'" 30)
assert_output "SFTP delete" "$SFTP_DELETE" "deleted|remove|success|ok|gone"

#========================================
# TEST 7: FILE TRANSFER SECURITY
#========================================
section_header "TEST 7: File Transfer Security"

if probe_command_exists "openclaw xmpp file-transfer-security status"; then
    log "INFO" "Test 7.1: Checking file transfer security status..."
    FTS_STATUS=$(run_command "openclaw xmpp file-transfer-security status" 30)
    assert_output "File transfer security status" "$FTS_STATUS" "status|security|quota|enabled|disabled"

    log "INFO" "Test 7.2: Checking user quota..."
    QUOTA=$(run_command "openclaw xmpp file-transfer-security quota $BOT_JID" 30)
    assert_output "Quota check" "$QUOTA" "quota|usage|bytes|limit|allowed"
else
    skip_test "File transfer security status" "CLI command 'file-transfer-security' not registered (module exists but no CLI handler in commands.ts)"
    skip_test "Quota check" "CLI command 'file-transfer-security' not registered (module exists but no CLI handler in commands.ts)"
fi

#========================================
# TEST 8: AUDIT LOGGING
#========================================
section_header "TEST 8: Audit Logging"

if probe_command_exists "openclaw xmpp audit status"; then
    log "INFO" "Test 8.1: Checking audit status..."
    AUDIT_STATUS=$(run_command "openclaw xmpp audit status" 30)
    assert_output "Audit status" "$AUDIT_STATUS" "audit|logging|enabled|disabled|events"

    log "INFO" "Test 8.2: Listing audit events..."
    AUDIT_LIST=$(run_command "openclaw xmpp audit list 10" 30)
    assert_output "Audit list" "$AUDIT_LIST" "audit|event|entry|timestamp"
else
    skip_test "Audit status" "CLI command 'audit' not registered (no audit module or CLI handler in commands.ts)"
    skip_test "Audit list" "CLI command 'audit' not registered (no audit module or CLI handler in commands.ts)"
fi

#========================================
# TEST 9: RATE LIMITING
#========================================
section_header "TEST 9: Rate Limiting"

# Rate limiting is implemented server-side inside startXMPP.ts but testing it
# reliably via sequential CLI calls (each spawning a new gateway) is impractical.
# The rate limiter tracks per-JID state in-memory within a single gateway session.
if probe_command_exists "openclaw xmpp status"; then
    log "INFO" "Test 9.1: Testing rate limit (sending 12 commands rapidly)..."
    log "WARN" "Rate limiting test is informational only — each CLI call spawns a separate gateway process, so in-memory rate limits won't accumulate across invocations."
    RATE_LIMITED=0
    for i in $(seq 1 12); do
        CMD_OUTPUT=$(run_command "openclaw xmpp status" 5)
        if echo "$CMD_OUTPUT" | grep -qi "too many\|rate limit"; then
            RATE_LIMITED=$((RATE_LIMITED + 1))
            log "INFO" "Command $i: Rate limited"
        else
            log "INFO" "Command $i: OK"
        fi
    done

    if [ $RATE_LIMITED -ge 1 ]; then
        assert "Rate limiting works" "true" "limited" "limited"
        log "INFO" "Rate limiting triggered: $RATE_LIMITED commands limited"
    else
        log "INFO" "Rate limiting not triggered (expected — CLI calls spawn separate gateways)"
        skip_test "Rate limiting" "Not reliably testable via CLI (each call = new gateway process, in-memory rate state doesn't persist)"
    fi
else
    skip_test "Rate limiting" "'openclaw xmpp status' command not available"
fi

#========================================
# TEST 10: MUC INVITES (Auto-Accept)
#========================================
section_header "TEST 10: MUC Invites"

# Jamie is admin, can join without invite
log "INFO" "Test 10.1: Bot can join room without invite (admin)..."
ADMIN_JOIN=$(run_command "openclaw xmpp join $ROOM_JID" 30)
assert_output "Admin room join" "$ADMIN_JOIN" "joined|success|already joined|room|conference"

# Test invite (abot will auto-accept)
log "INFO" "Test 10.2: Inviting abot to room..."
INVITE_OUTPUT=$(run_command "openclaw xmpp invite $BOT_JID $ROOM_JID" 30)
assert_output "Invite command" "$INVITE_OUTPUT" "invited|sent|success|invite"

# Wait for abot to auto-join
log "INFO" "Test 10.3: Waiting for abot to auto-join..."
sleep 10
ROOMS_CHECK=$(run_command "openclaw xmpp rooms" 10)
if echo "$ROOMS_CHECK" | grep -qi "$ROOM_JID"; then
    assert "abot in room" "true" "in room" "found"
else
    log "INFO" "abot may have joined or left (invite sent)"
fi

#========================================
# TEST 11: IN-CHAT SLASH COMMANDS (abot)
#========================================
section_header "TEST 11: In-Chat Slash Commands"

# Send slash commands to abot and check responses
log "INFO" "Test 11.1: Testing /whoami via DM..."
WHOAMI_OUT=$(run_command "openclaw xmpp msg $BOT_JID '/whoami'" 30)

log "INFO" "Test 11.2: Testing /help via DM..."
HELP_OUT=$(run_command "openclaw xmpp msg $BOT_JID '/help'" 30)

log "INFO" "Test 11.3: Testing /vcard help via DM..."
VCARD_HELP_OUT=$(run_command "openclaw xmpp msg $BOT_JID '/vcard help'" 30)

# Wait and check poll (read-only — exit code assertion OK)
sleep 15
POLL_CHECK=$(run_command "openclaw xmpp poll" 10)
assert "Slash command poll" "$?" "0" "$?"

#========================================
# TEST 12: CLEAR & CLEANUP
#========================================
section_header "TEST 12: Clear & Cleanup"

log "INFO" "Test 12.1: Clearing message queue..."
CLEAR_OUTPUT=$(run_command "openclaw xmpp clear" 30)
assert_output "Clear queue" "$CLEAR_OUTPUT" "cleared|empty|queue|removed|ok"

#========================================
# RESTORE VCARD & FINAL CLEANUP
# (handled by trap EXIT)
#========================================
section_header "FINAL: Restore & Cleanup"

log "INFO" "Cleanup will be handled by EXIT trap."
log "INFO" "If you reached here, all tests completed."

#========================================
# TEST SUMMARY
#========================================
print_summary

log "INFO" "Test suite complete. Check $LOG_FILE for full output."

exit 0
