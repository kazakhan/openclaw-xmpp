#!/bin/bash
# XMPP Plugin Automated Test Suite (Linux)
# Run: bash test.sh

set -e  # Exit on error

# Source common functions and config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-common.sh"

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
log "INFO" "Test 1.1: Sending DM from bot to tester..."
TEST_MSG=$(get_test_message "DM1")
run_command "openclaw xmpp msg $TESTER_JID '$TEST_MSG'" 30
assert "Send DM from bot" "$?" "0" "$?"

# Test 1.2: User -> Bot
log "INFO" "Test 1.2: Sending DM from tester to bot..."
DM_REPLY="Hello abot, this is a test message"
run_command "openclaw xmpp msg $BOT_JID '$DM_REPLY'" 30

# Wait for abot response (abot echoes with prefix)
log "INFO" "Test 1.3: Waiting for abot response..."
sleep 10
POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
if echo "$POLL_OUTPUT" | grep -qi "$BOT_JID"; then
    assert "Receive DM from bot" "true" "response" "received"
else
    # Try sending another message to trigger response
    log "INFO" "Sending follow-up to trigger abot..."
    run_command "openclaw xmpp msg $BOT_JID 'ping'" 30
    sleep 15
    POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
    if echo "$POLL_OUTPUT" | grep -qi "$BOT_JID"; then
        assert "Receive DM from bot (retry)" "true" "response" "received"
    else
        assert "Receive DM from bot" "false" "response" "none"
    fi
fi

# Test 1.3: Message Queue
log "INFO" "Test 1.4: Checking message queue..."
QUEUE_OUTPUT=$(run_command "openclaw xmpp queue" 10)
assert "Queue command works" "$?" "0" "$?"

# Test 1.4: Poll Messages
log "INFO" "Test 1.5: Polling messages..."
POLL_OUTPUT=$(run_command "openclaw xmpp poll" 10)
assert "Poll command works" "$?" "0" "$?"

#========================================
# TEST 2: MUC - JOIN ROOM
#========================================
section_header "TEST 2: MUC - Join Room"

log "INFO" "Test 2.1: Joining room $ROOM_JID..."
JOIN_OUTPUT=$(run_command "openclaw xmpp join $ROOM_JID" 30)
assert "Join room command" "$?" "0" "$?"

if echo "$JOIN_OUTPUT" | grep -qi "joined\|success"; then
    log "INFO" "Successfully joined room"
    assert "Room joined" "true" "joined" "joined"
else
    log "WARN" "Could not verify room join"
    assert "Room joined" "false" "joined" "unknown"
fi

# Test 2.2: List joined rooms
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
run_command "openclaw xmpp add $TEST_CONTACT TestUser" 30
assert "Add contact" "$?" "0" "$?"

# Test 3.2: List contacts
log "INFO" "Test 3.2: Listing contacts..."
ROSTER_OUTPUT=$(run_command "openclaw xmpp roster" 10)
assert "Roster command works" "$?" "0" "$?"
if echo "$ROSTER_OUTPUT" | grep -qi "$TEST_CONTACT"; then
    assert "Contact added" "true" "in roster" "found"
fi

# Test 3.3: Set nickname
log "INFO" "Test 3.3: Setting nickname..."
run_command "openclaw xmpp nick $TEST_CONTACT TestNick" 30
assert "Set nickname" "$?" "0" "$?"

# Test 3.4: Remove contact
log "INFO" "Test 3.4: Removing test contact..."
run_command "openclaw xmpp remove $TEST_CONTACT" 30
assert "Remove contact" "$?" "0" "$?"

#========================================
# TEST 4: SUBSCRIPTION MANAGEMENT
#========================================
section_header "TEST 4: Subscription Management"

log "INFO" "Test 4.1: Listing pending subscriptions..."
SUB_OUTPUT=$(run_command "openclaw xmpp subscriptions pending" 30)
assert "Subscriptions pending" "$?" "0" "$?"

#========================================
# TEST 5: VCARD
#========================================
section_header "TEST 5: vCard"

# Save current vCard is done in setup

# Test 5.1: Get vCard
log "INFO" "Test 5.1: Getting current vCard..."
VCARD_OUTPUT=$(run_command "openclaw xmpp vcard get" 30)
assert "vCard get" "$?" "0" "$?"

# Test 5.2: Modify vCard fields
log "INFO" "Test 5.2: Modifying vCard fields..."
TEST_FN="XMPP Test Bot $(get_timestamp)"
TEST_NICK="xmpptest"
TEST_URL="https://test.example.com"
TEST_DESC="Modified by automated test on $(date)"

run_command "openclaw xmpp vcard set fn '$TEST_FN'" 30
assert "vCard set fn" "$?" "0" "$?"

run_command "openclaw xmpp vcard set nickname '$TEST_NICK'" 30
assert "vCard set nickname" "$?" "0" "$?"

run_command "openclaw xmpp vcard set url '$TEST_URL'" 30
assert "vCard set url" "$?" "0" "$?"

run_command "openclaw xmpp vcard set desc '$TEST_DESC'" 30
assert "vCard set desc" "$?" "0" "$?"

# Verify changes
log "INFO" "Test 5.3: Verifying vCard changes..."
VCARD_VERIFY=$(run_command "openclaw xmpp vcard get" 30)
echo "$VCARD_VERIFY" | grep -qi "$TEST_FN" && assert "vCard fn updated" "true" "found" "found" || assert "vCard fn updated" "false" "found" "not found"
echo "$VCARD_VERIFY" | grep -qi "$TEST_NICK" && assert "vCard nickname updated" "true" "found" "found" || assert "vCard nickname updated" "false" "found" "not found"
echo "$VCARD_VERIFY" | grep -qi "$TEST_URL" && assert "vCard url updated" "true" "found" "found" || assert "vCard url updated" "false" "found" "not found"

# Test 5.4: Set birthday
log "INFO" "Test 5.4: Setting birthday..."
run_command "openclaw xmpp vcard set birthday '1990-05-15'" 30
assert "vCard set birthday" "$?" "0" "$?"

# Test 5.5: Set title
log "INFO" "Test 5.5: Setting title..."
run_command "openclaw xmpp vcard set title 'Test Engineer'" 30
assert "vCard set title" "$?" "0" "$?"

# Test 5.6: Set role
log "INFO" "Test 5.6: Setting role..."
run_command "openclaw xmpp vcard set role 'Developer'" 30
assert "vCard set role" "$?" "0" "$?"

# Test 5.7: Set timezone
log "INFO" "Test 5.7: Setting timezone..."
run_command "openclaw xmpp vcard set timezone '-05:00'" 30
assert "vCard set timezone" "$?" "0" "$?"

# Test 5.8: Set structured name
log "INFO" "Test 5.8: Setting structured name..."
run_command "openclaw xmpp vcard name 'Testbot' 'XMPP' 'Bot' 'Mr.'" 30
assert "vCard name" "$?" "0" "$?"

# Test 5.9: Add phone
log "INFO" "Test 5.9: Adding phone..."
run_command "openclaw xmpp vcard phone add +61412345678 cell" 30
assert "vCard phone add" "$?" "0" "$?"

# Test 5.10: Add work phone
log "INFO" "Test 5.10: Adding work phone..."
run_command "openclaw xmpp vcard phone add +60987654321 work voice" 30
assert "vCard phone add work" "$?" "0" "$?"

# Test 5.11: Add email
log "INFO" "Test 5.11: Adding email..."
run_command "openclaw xmpp vcard email add test@example.com home" 30
assert "vCard email add" "$?" "0" "$?"

# Test 5.12: Add work email
log "INFO" "Test 5.12: Adding work email..."
run_command "openclaw xmpp vcard email add work@example.com work pref" 30
assert "vCard email add work" "$?" "0" "$?"

# Test 5.13: Add address
log "INFO" "Test 5.13: Adding address..."
run_command "openclaw xmpp vcard address add \"123 Test St\" Boston MA 02101 USA home" 30
assert "vCard address add" "$?" "0" "$?"

# Test 5.14: Set organization
log "INFO" "Test 5.14: Setting organization..."
run_command "openclaw xmpp vcard org 'Test Corp' 'Engineering'" 30
assert "vCard org" "$?" "0" "$?"

# Test 5.15: Verify all new fields
log "INFO" "Test 5.15: Verifying all new vCard fields..."
VCARD_VERIFY2=$(run_command "openclaw xmpp vcard get" 30)
echo "$VCARD_VERIFY2" | grep -qi "1990-05-15" && assert "vCard birthday" "true" "found" "found" || assert "vCard birthday" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "Test Engineer" && assert "vCard title" "true" "found" "found" || assert "vCard title" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "Developer" && assert "vCard role" "true" "found" "found" || assert "vCard role" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "+1234567890" && assert "vCard phone" "true" "found" "found" || assert "vCard phone" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "test@example.com" && assert "vCard email" "true" "found" "found" || assert "vCard email" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "Boston" && assert "vCard address" "true" "found" "found" || assert "vCard address" "false" "found" "not found"
echo "$VCARD_VERIFY2" | grep -qi "Test Corp" && assert "vCard org" "true" "found" "found" || assert "vCard org" "false" "found" "not found"

#========================================
# TEST 6: SFTP
#========================================
section_header "TEST 6: SFTP File Management"

# Test 6.1: List files
log "INFO" "Test 6.1: Listing SFTP files..."
SFTP_LS=$(run_command "openclaw xmpp sftp ls" 60)
assert "SFTP ls" "$?" "0" "$?"

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
assert "SFTP upload" "$?" "0" "$?"

# Test 6.3: Download file
log "INFO" "Test 6.3: Downloading test file..."
DOWNLOAD_PATH="$TEST_FILES_DIR/downloaded-$TIMESTAMP.txt"
SFTP_DOWNLOAD=$(run_command "openclaw xmpp sftp download '$TEST_FILENAME' '$DOWNLOAD_PATH'" 60)
assert "SFTP download" "$?" "0" "$?"

if [ -f "$DOWNLOAD_PATH" ]; then
    assert "Downloaded file exists" "true" "file" "exists"
    if grep -q "$TEST_CONTENT" "$DOWNLOAD_PATH"; then
        assert "Downloaded file content matches" "true" "content" "matched"
    fi
else
    assert "Downloaded file exists" "false" "file" "missing"
fi

# Test 6.4: Delete file
log "INFO" "Test 6.4: Deleting test file..."
run_command "openclaw xmpp sftp rm '$TEST_FILENAME'" 30
assert "SFTP delete" "$?" "0" "$?"

#========================================
# TEST 7: FILE TRANSFER SECURITY
#========================================
section_header "TEST 7: File Transfer Security"

log "INFO" "Test 7.1: Checking file transfer security status..."
FTS_STATUS=$(run_command "openclaw xmpp file-transfer-security status" 30)
assert "File transfer security status" "$?" "0" "$?"

log "INFO" "Test 7.2: Checking user quota..."
QUOTA=$(run_command "openclaw xmpp file-transfer-security quota $BOT_JID" 30)
assert "Quota check" "$?" "0" "$?"

#========================================
# TEST 8: AUDIT LOGGING
#========================================
section_header "TEST 8: Audit Logging"

log "INFO" "Test 8.1: Checking audit status..."
AUDIT_STATUS=$(run_command "openclaw xmpp audit status" 30)
assert "Audit status" "$?" "0" "$?"

log "INFO" "Test 8.2: Listing audit events..."
AUDIT_LIST=$(run_command "openclaw xmpp audit list 10" 30)
assert "Audit list" "$?" "0" "$?"

#========================================
# TEST 9: RATE LIMITING
#========================================
section_header "TEST 9: Rate Limiting"

log "INFO" "Test 9.1: Testing rate limit (sending 12 commands rapidly)..."
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
    log "WARN" "Rate limiting not triggered (may need faster sending)"
    assert "Rate limiting" "false" "limited" "not triggered"
fi

#========================================
# TEST 10: MUC INVITES (Auto-Accept)
#========================================
section_header "TEST 10: MUC Invites"

# Jamie is admin, can join without invite
log "INFO" "Test 10.1: Bot can join room without invite (admin)..."
run_command "openclaw xmpp join $ROOM_JID" 30
assert "Admin room join" "$?" "0" "$?"

# Test invite (abot will auto-accept)
log "INFO" "Test 10.2: Inviting abot to room..."
INVITE_OUTPUT=$(run_command "openclaw xmpp invite $BOT_JID $ROOM_JID" 30)
assert "Invite command" "$?" "0" "$?"

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
run_command "openclaw xmpp msg $BOT_JID '/whoami'" 30

log "INFO" "Test 11.2: Testing /help via DM..."
run_command "openclaw xmpp msg $BOT_JID '/help'" 30

log "INFO" "Test 11.3: Testing /vcard help via DM..."
run_command "openclaw xmpp msg $BOT_JID '/vcard help'" 30

# Wait and check poll
sleep 15
POLL_CHECK=$(run_command "openclaw xmpp poll" 10)
assert "Slash command poll" "$?" "0" "$?"

#========================================
# TEST 12: CLEAR & CLEANUP
#========================================
section_header "TEST 12: Clear & Cleanup"

log "INFO" "Test 12.1: Clearing message queue..."
CLEAR_OUTPUT=$(run_command "openclaw xmpp clear" 30)
assert "Clear queue" "$?" "0" "$?"

#========================================
# RESTORE VCARD & FINAL CLEANUP
#========================================
section_header "FINAL: Restore & Cleanup"

log "INFO" "Restoring original vCard..."
restore_vcard

log "INFO" "Cleaning up test files..."
cleanup_test_files

#========================================
# TEST SUMMARY
#========================================
print_summary

log "INFO" "Test suite complete. Check $LOG_FILE for full output."

exit 0
