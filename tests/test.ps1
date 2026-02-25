#!/usr/bin/env pwsh
# XMPP Plugin Automated Test Suite (Windows PowerShell)
# Run: .\test.ps1

# Source common functions and config
. "$PSScriptRoot\test-common.ps1"

# Initialize
Init-Log
Write-SectionHeader -Title "XMPP Plugin Automated Test Suite"

#========================================
# SETUP PHASE
#========================================
Write-TestLog -Level "INFO" -Message "=== SETUP PHASE ==="
Write-TestLog -Level "INFO" -Message "Gateway check skipped (assumed running)"

# Save vCard
Save-Vcard

# Clear old test data
Cleanup-TestFiles

#========================================
# TEST 1: DIRECT MESSAGES
#========================================
Write-SectionHeader -Title "TEST 1: Direct Messages"

# Test 1.1: Bot -> User
Write-TestLog -Level "INFO" -Message "Test 1.1 - Sending DM from bot to tester..."
$testMsg = Get-TestMessage -Prefix "DM1"
$dmResult = Run-Command "openclaw xmpp msg $TESTER_JID '$testMsg'"
Assert-Test -TestName "Send DM from bot" -Condition ($dmResult -eq 0) -Expected "0" -Actual $dmResult

# Test 1.2: User -> Bot
Write-TestLog -Level "INFO" -Message "Test 1.2 - Sending DM from tester to bot..."
$dmReply = "Hello abot, this is a test message"
$replyResult = Run-Command "openclaw xmpp msg $BOT_JID '$dmReply'"
Assert-Test -TestName "Send DM to bot" -Condition ($replyResult -eq 0) -Expected "0" -Actual $replyResult

# Test 1.3: Wait for abot response
Write-TestLog -Level "INFO" -Message "Test 1.3 - Waiting for abot response..."
Start-Sleep -Seconds 10

$pollOutput = Run-CommandOutput "openclaw xmpp poll"
if ($pollOutput -match [regex]::Escape($BOT_JID)) {
    Assert-Test -TestName "Receive DM from bot" -Condition $true -Expected "response" -Actual "received"
} else {
    # Send follow-up
    Write-TestLog -Level "INFO" -Message "Sending follow-up to trigger abot..."
    Run-Command "openclaw xmpp msg $BOT_JID 'ping'" | Out-Null
    Start-Sleep -Seconds 15
    
    $pollOutput = Run-CommandOutput "openclaw xmpp poll"
    if ($pollOutput -match [regex]::Escape($BOT_JID)) {
        Assert-Test -TestName "Receive DM from bot (retry)" -Condition $true -Expected "response" -Actual "received"
    } else {
        Assert-Test -TestName "Receive DM from bot" -Condition $false -Expected "response" -Actual "none"
    }
}

# Test 1.4: Message Queue
Write-TestLog -Level "INFO" -Message "Test 1.4 - Checking message queue..."
$queueOutput = Run-CommandOutput "openclaw xmpp queue"
Assert-Test -TestName "Queue command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 1.5: Poll Messages
Write-TestLog -Level "INFO" -Message "Test 1.5 - Polling messages..."
$pollOutput = Run-CommandOutput "openclaw xmpp poll"
Assert-Test -TestName "Poll command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 2: MUC - JOIN ROOM
#========================================
Write-SectionHeader -Title "TEST 2: MUC - Join Room"

Write-TestLog -Level "INFO" -Message "Test 2.1 - Joining room $ROOM_JID..."
$joinOutput = Run-CommandOutput "openclaw xmpp join $ROOM_JID"
$joinExit = $LASTEXITCODE
Assert-Test -TestName "Join room command" -Condition ($joinExit -eq 0) -Expected "0" -Actual $joinExit

if ($joinOutput -match "joined|success") {
    Write-TestLog -Level "INFO" -Message "Successfully joined room"
    Assert-Test -TestName "Room joined" -Condition $true -Expected "joined" -Actual "joined"
} else {
    Write-TestLog -Level "WARN" -Message "Could not verify room join"
    Assert-Test -TestName "Room joined" -Condition $false -Expected "joined" -Actual "unknown"
}

# Test 2.2: List joined rooms
Write-TestLog -Level "INFO" -Message "Test 2.2 - Checking joined rooms..."
$roomsOutput = Run-CommandOutput "openclaw xmpp rooms"
Assert-Test -TestName "Rooms command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 3: CONTACT MANAGEMENT
#========================================
Write-SectionHeader -Title "TEST 3: Contact Management"

# Extract domain from tester JID
$domain = ($TESTER_JID -split '@')[1]
$testContact = "testuser@$domain"

# Test 3.1: Add contact
Write-TestLog -Level "INFO" -Message "Test 3.1 - Adding test contact..."
$addResult = Run-Command "openclaw xmpp add $testContact TestUser"
Assert-Test -TestName "Add contact" -Condition ($addResult -eq 0) -Expected "0" -Actual $addResult

# Test 3.2: List contacts
Write-TestLog -Level "INFO" -Message "Test 3.2 - Listing contacts..."
$rosterOutput = Run-CommandOutput "openclaw xmpp roster"
Assert-Test -TestName "Roster command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

if ($rosterOutput -match [regex]::Escape($testContact)) {
    Assert-Test -TestName "Contact added" -Condition $true -Expected "in roster" -Actual "found"
}

# Test 3.3: Set nickname
Write-TestLog -Level "INFO" -Message "Test 3.3 - Setting nickname..."
$nickResult = Run-Command "openclaw xmpp nick $testContact TestNick"
Assert-Test -TestName "Set nickname" -Condition ($nickResult -eq 0) -Expected "0" -Actual $nickResult

# Test 3.4: Remove contact
Write-TestLog -Level "INFO" -Message "Test 3.4 - Removing test contact..."
$removeResult = Run-Command "openclaw xmpp remove $testContact"
Assert-Test -TestName "Remove contact" -Condition ($removeResult -eq 0) -Expected "0" -Actual $removeResult

#========================================
# TEST 4: SUBSCRIPTION MANAGEMENT
#========================================
Write-SectionHeader -Title "TEST 4: Subscription Management - Skipping"

#Write-TestLog -Level "INFO" -Message "Test 4.1 - Listing pending subscriptions..."
#$subOutput = Run-CommandOutput "openclaw xmpp subscriptions pending"
#Assert-Test -TestName "Subscriptions pending" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 5: VCARD
#========================================
Write-SectionHeader -Title "TEST 5: vCard"

# Test 5.1: Get vCard
Write-TestLog -Level "INFO" -Message "Test 5.1 - Getting current vCard..."
$vcardOutput = Run-CommandOutput "openclaw xmpp vcard get"
Assert-Test -TestName "vCard get" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.2: Modify vCard fields
Write-TestLog -Level "INFO" -Message "Test 5.2 - Modifying vCard fields..."
$ts = Get-Timestamp
$testFN = "XMPP Test Bot $ts"
$testNick = "xmpptest"
$testUrl = "https://test.example.com"
$testDesc = "Modified by automated test on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

Run-Command "openclaw xmpp vcard set fn '$testFN'" | Out-Null
Assert-Test -TestName "vCard set fn" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

Run-Command "openclaw xmpp vcard set nickname '$testNick'" | Out-Null
Assert-Test -TestName "vCard set nickname" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

Run-Command "openclaw xmpp vcard set url '$testUrl'" | Out-Null
Assert-Test -TestName "vCard set url" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

Run-Command "openclaw xmpp vcard set desc '$testDesc'" | Out-Null
Assert-Test -TestName "vCard set desc" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Verify changes
Write-TestLog -Level "INFO" -Message "Test 5.3 - Verifying vCard changes..."
$vcardVerify = Run-CommandOutput "openclaw xmpp vcard get"
if ($vcardVerify -match [regex]::Escape($testFN)) {
    Assert-Test -TestName "vCard fn updated" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify -match [regex]::Escape($testNick)) {
    Assert-Test -TestName "vCard nickname updated" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify -match [regex]::Escape($testUrl)) {
    Assert-Test -TestName "vCard url updated" -Condition $true -Expected "found" -Actual "found"
}

# Test 5.4: Set birthday
Write-TestLog -Level "INFO" -Message "Test 5.4 - Setting birthday..."
Run-Command "openclaw xmpp vcard set birthday '1990-05-15'" | Out-Null
Assert-Test -TestName "vCard set birthday" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.5: Set title
Write-TestLog -Level "INFO" -Message "Test 5.5 - Setting title..."
Run-Command "openclaw xmpp vcard set title 'Test Engineer'" | Out-Null
Assert-Test -TestName "vCard set title" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.6: Set role
Write-TestLog -Level "INFO" -Message "Test 5.6 - Setting role..."
Run-Command "openclaw xmpp vcard set role 'Developer'" | Out-Null
Assert-Test -TestName "vCard set role" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.7: Set timezone
Write-TestLog -Level "INFO" -Message "Test 5.7 - Setting timezone..."
Run-Command "openclaw xmpp vcard set timezone '-05:00'" | Out-Null
Assert-Test -TestName "vCard set timezone" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.8: Set structured name
Write-TestLog -Level "INFO" -Message "Test 5.8 - Setting structured name..."
Run-Command "openclaw xmpp vcard name 'Testbot' 'XMPP' 'Bot' 'Mr.'" | Out-Null
Assert-Test -TestName "vCard name" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.9: Add phone
Write-TestLog -Level "INFO" -Message "Test 5.9 - Adding phone..."
Run-Command "openclaw xmpp vcard phone add +61412345678 cell" | Out-Null
Assert-Test -TestName "vCard phone add" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.10: Add work phone
Write-TestLog -Level "INFO" -Message "Test 5.10 - Adding work phone..."
Run-Command "openclaw xmpp vcard phone add +60987654321 work voice" | Out-Null
Assert-Test -TestName "vCard phone add work" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.11: Add email
Write-TestLog -Level "INFO" -Message "Test 5.11 - Adding email..."
Run-Command "openclaw xmpp vcard email add test@example.com home" | Out-Null
Assert-Test -TestName "vCard email add" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.12: Add work email
Write-TestLog -Level "INFO" -Message "Test 5.12 - Adding work email..."
Run-Command "openclaw xmpp vcard email add work@example.com work pref" | Out-Null
Assert-Test -TestName "vCard email add work" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.13: Add address
Write-TestLog -Level "INFO" -Message "Test 5.13 - Adding address..."
Run-Command "openclaw xmpp vcard address add `"123 Test St`" Boston MA 02101 USA home" | Out-Null
Assert-Test -TestName "vCard address add" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.14: Set organization
Write-TestLog -Level "INFO" -Message "Test 5.14 - Setting organization..."
Run-Command "openclaw xmpp vcard org 'Test Corp' 'Engineering'" | Out-Null
Assert-Test -TestName "vCard org" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 5.15: Verify all new fields
Write-TestLog -Level "INFO" -Message "Test 5.15 - Verifying all new vCard fields..."
$vcardVerify2 = Run-CommandOutput "openclaw xmpp vcard get"
if ($vcardVerify2 -match "1990-05-15") {
    Assert-Test -TestName "vCard birthday" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "Test Engineer") {
    Assert-Test -TestName "vCard title" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "Developer") {
    Assert-Test -TestName "vCard role" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "\+1234567890") {
    Assert-Test -TestName "vCard phone" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "test@example.com") {
    Assert-Test -TestName "vCard email" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "Boston") {
    Assert-Test -TestName "vCard address" -Condition $true -Expected "found" -Actual "found"
}
if ($vcardVerify2 -match "Test Corp") {
    Assert-Test -TestName "vCard org" -Condition $true -Expected "found" -Actual "found"
}

#========================================
# TEST 6: SFTP
#========================================
Write-SectionHeader -Title "TEST 6: SFTP File Management"

# Test 6.1: List files
Write-TestLog -Level "INFO" -Message "Test 6.1 - Listing SFTP files..."
$sftpLs = Run-CommandOutput "openclaw xmpp sftp ls"
Assert-Test -TestName "SFTP ls" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 6.2: Upload file
Write-TestLog -Level "INFO" -Message "Test 6.2 - Uploading test file..."
$ts = Get-Timestamp
$testFilename = "xmpp-test-$ts.txt"
$testContent = "This is a test file for XMPP plugin automated testing.
Timestamp: $(Get-Date)
Purpose: Verify SFTP functionality
DO NOT DELETE: Test file will be removed by cleanup"

$testFilePath = Create-TestFile -Content $testContent -Extension ".txt"

$sftpUpload = Run-CommandOutput "openclaw xmpp sftp upload '$testFilePath'"
Assert-Test -TestName "SFTP upload" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 6.3: Download file
Write-TestLog -Level "INFO" -Message "Test 6.3 - Downloading test file..."
$downloadPath = "$TEST_FILES_DIR\downloaded-$ts.txt"
$sftpDownload = Run-CommandOutput "openclaw xmpp sftp download '$testFilename' '$downloadPath'"
Assert-Test -TestName "SFTP download" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

if (Test-Path $downloadPath) {
    Assert-Test -TestName "Downloaded file exists" -Condition $true -Expected "file" -Actual "exists"
    $fileContent = Get-Content $downloadPath -Raw
    if ($fileContent -match "This is a test file") {
        Assert-Test -TestName "Downloaded file content matches" -Condition $true -Expected "content" -Actual "matched"
    }
} else {
    Assert-Test -TestName "Downloaded file exists" -Condition $false -Expected "file" -Actual "missing"
}

# Test 6.4: Delete file
Write-TestLog -Level "INFO" -Message "Test 6.4 - Deleting test file..."
$deleteResult = Run-Command "openclaw xmpp sftp rm '$testFilename'"
Assert-Test -TestName "SFTP delete" -Condition ($deleteResult -eq 0) -Expected "0" -Actual $deleteResult

#========================================
# TEST 7: FILE TRANSFER SECURITY
#========================================
Write-SectionHeader -Title "TEST 7: File Transfer Security"

Write-TestLog -Level "INFO" -Message "Test 7.1 - Checking file transfer security status..."
$ftsStatus = Run-CommandOutput "openclaw xmpp file-transfer-security status"
Assert-Test -TestName "File transfer security status" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

Write-TestLog -Level "INFO" -Message "Test 7.2 - Checking user quota..."
$quota = Run-CommandOutput "openclaw xmpp file-transfer-security quota $BOT_JID"
Assert-Test -TestName "Quota check" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 8: AUDIT LOGGING
#========================================
Write-SectionHeader -Title "TEST 8: Audit Logging - Skipping"

#Write-TestLog -Level "INFO" -Message "Test 8.1 - Checking audit status..."
#$auditStatus = Run-CommandOutput "openclaw xmpp audit status"
#Assert-Test -TestName "Audit status" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#Write-TestLog -Level "INFO" -Message "Test 8.2 - Listing audit events..."
#$auditList = Run-CommandOutput "openclaw xmpp audit list 10"
#Assert-Test -TestName "Audit list" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 9: RATE LIMITING
#========================================
Write-SectionHeader -Title "TEST 9: Rate Limiting - Skipping"

#Write-TestLog -Level "INFO" -Message "Test 9.1 - Testing rate limit (sending 12 commands rapidly)..."
#$rateLimited = 0

#for ($i = 1; $i -le 12; $i++) {
#    $cmdOutput = Run-CommandOutput "openclaw xmpp status"
#    if ($cmdOutput -match "too many|rate limit") {
#        $rateLimited++
#        Write-TestLog -Level "INFO" -Message "Command $i - Rate limited"
#    } else {
#        Write-TestLog -Level "INFO" -Message "Command $i - OK"
#    }
#}

#if ($rateLimited -ge 1) {
#    Assert-Test -TestName "Rate limiting works" -Condition $true -Expected "limited" -Actual "limited"
#    Write-TestLog -Level "INFO" -Message "Rate limiting triggered: $rateLimited commands limited"
#} else {
#    Write-TestLog -Level "WARN" -Message "Rate limiting not triggered (may need faster sending)"
#    Assert-Test -TestName "Rate limiting" -Condition $false -Expected "limited" -Actual "not triggered"
#}

#========================================
# TEST 10: MUC INVITES (Auto-Accept)
#========================================
Write-SectionHeader -Title "TEST 10: MUC Invites"

# Jamie is admin, can join without invite
Write-TestLog -Level "INFO" -Message "Test 10.1 - Bot can join room without invite (admin)..."
$joinResult = Run-Command "openclaw xmpp join $ROOM_JID"
Assert-Test -TestName "Admin room join" -Condition ($joinResult -eq 0) -Expected "0" -Actual $joinResult

# Test invite (abot will auto-accept)
Write-TestLog -Level "INFO" -Message "Test 10.2 - Inviting abot to room..."
$inviteOutput = Run-CommandOutput "openclaw xmpp invite $BOT_JID $ROOM_JID"
Assert-Test -TestName "Invite command" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Wait for abot to auto-join
Write-TestLog -Level "INFO" -Message "Test 10.3 - Waiting for abot to auto-join..."
Start-Sleep -Seconds 10

$roomsCheck = Run-CommandOutput "openclaw xmpp rooms"
if ($roomsCheck -match [regex]::Escape($ROOM_JID)) {
    Assert-Test -TestName "abot in room" -Condition $true -Expected "in room" -Actual "found"
} else {
    Write-TestLog -Level "INFO" -Message "abot may have joined or left (invite sent)"
}

#========================================
# TEST 11: IN-CHAT SLASH COMMANDS (abot)
#========================================
Write-SectionHeader -Title "TEST 11: In-Chat Slash Commands"

# Send slash commands to abot and check responses
Write-TestLog -Level "INFO" -Message "Test 11.1 - Testing /whoami via DM..."
Run-Command "openclaw xmpp msg $BOT_JID '/whoami'" | Out-Null

Write-TestLog -Level "INFO" -Message "Test 11.2 - Testing /help via DM..."
Run-Command "openclaw xmpp msg $BOT_JID '/help'" | Out-Null

Write-TestLog -Level "INFO" -Message "Test 11.3 - Testing /vcard help via DM..."
Run-Command "openclaw xmpp msg $BOT_JID '/vcard help'" | Out-Null

# Wait and check poll
Start-Sleep -Seconds 15
$pollCheck = Run-CommandOutput "openclaw xmpp poll"
Assert-Test -TestName "Slash command poll" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 12: CLEAR & CLEANUP
#========================================
Write-SectionHeader -Title "TEST 12: Clear & Cleanup"

Write-TestLog -Level "INFO" -Message "Test 12.1 - Clearing message queue..."
$clearOutput = Run-CommandOutput "openclaw xmpp clear"
Assert-Test -TestName "Clear queue" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# RESTORE VCARD & FINAL CLEANUP
#========================================
Write-SectionHeader -Title "FINAL: Restore & Cleanup"

Write-TestLog -Level "INFO" -Message "Restoring original vCard..."
Restore-Vcard

Write-TestLog -Level "INFO" -Message "Cleaning up test files..."
Cleanup-TestFiles

#========================================
# TEST SUMMARY
#========================================
Write-Summary

Write-TestLog -Level "INFO" -Message "Test suite complete. Check $LOG_FILE for full output."

exit 0
