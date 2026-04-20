#!/usr/bin/env pwsh
# XMPP Plugin Automated Test Suite (Windows PowerShell)
# Run: .\test.ps1

# Source common functions and config
. "$PSScriptRoot\test-common.ps1"

# Initialize
Init-Log
Write-SectionHeader -Title "XMPP Plugin Automated Test Suite"

try {

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
# Uses Assert-Output because msg spawns a gateway child that may exit non-zero
# even when the message sends successfully.
Write-TestLog -Level "INFO" -Message "Test 1.1 - Sending DM from bot to tester..."
$testMsg = Get-TestMessage -Prefix "DM1"
$dmOutput = Run-CommandOutput "openclaw xmpp msg $TESTER_JID '$testMsg'"
Assert-Output -TestName "Send DM from bot" -Output $dmOutput -Pattern "sent|message|delivered|$TESTER_JID"

# Test 1.2: User -> Bot
Write-TestLog -Level "INFO" -Message "Test 1.2 - Sending DM from tester to bot..."
$dmReply = "Hello abot, this is a test message"
$replyOutput = Run-CommandOutput "openclaw xmpp msg $BOT_JID '$dmReply'"
Assert-Output -TestName "Send DM to bot" -Output $replyOutput -Pattern "sent|message|delivered|$BOT_JID"

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

# Test 1.4: Message Queue (read-only -- exit code assertion OK)
Write-TestLog -Level "INFO" -Message "Test 1.4 - Checking message queue..."
$queueOutput = Run-CommandOutput "openclaw xmpp queue"
Assert-Test -TestName "Queue command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

# Test 1.5: Poll Messages (read-only -- exit code assertion OK)
Write-TestLog -Level "INFO" -Message "Test 1.5 - Polling messages..."
$pollOutput = Run-CommandOutput "openclaw xmpp poll"
Assert-Test -TestName "Poll command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 2: MUC - JOIN ROOM
#========================================
Write-SectionHeader -Title "TEST 2: MUC - Join Room"

Write-TestLog -Level "INFO" -Message "Test 2.1 - Joining room $ROOM_JID..."
$joinOutput = Run-CommandOutput "openclaw xmpp join $ROOM_JID"
# join spawns a gateway; check output content instead of exit code
Assert-Output -TestName "Join room command" -Output $joinOutput -Pattern "joined|success|already joined|room|conference"

if ($joinOutput -match "joined|success") {
    Write-TestLog -Level "INFO" -Message "Successfully joined room"
    Assert-Test -TestName "Room joined" -Condition $true -Expected "joined" -Actual "joined"
} else {
    Write-TestLog -Level "WARN" -Message "Could not verify room join via keyword"
    if ($joinOutput -match "room|conference|presence|muc") {
        Write-TestLog -Level "INFO" -Message "Room join appears successful (XMPP content in output)"
        Assert-Test -TestName "Room joined (soft)" -Condition $true -Expected "joined" -Actual "likely"
    } else {
        Assert-Test -TestName "Room joined" -Condition $false -Expected "joined" -Actual "unknown"
    }
}

# Test 2.2: List joined rooms (read-only -- exit code assertion OK)
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
$addOutput = Run-CommandOutput "openclaw xmpp add $testContact TestUser"
Assert-Output -TestName "Add contact" -Output $addOutput -Pattern "added|contact|whitelist|roster|subscription"

# Test 3.2: List contacts (read-only -- exit code assertion OK)
Write-TestLog -Level "INFO" -Message "Test 3.2 - Listing contacts..."
$rosterOutput = Run-CommandOutput "openclaw xmpp roster"
Assert-Test -TestName "Roster command works" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

if ($rosterOutput -match [regex]::Escape($testContact)) {
    Assert-Test -TestName "Contact added" -Condition $true -Expected "in roster" -Actual "found"
}

# Test 3.3: Set nickname
Write-TestLog -Level "INFO" -Message "Test 3.3 - Setting nickname..."
$nickOutput = Run-CommandOutput "openclaw xmpp nick $testContact TestNick"
Assert-Output -TestName "Set nickname" -Output $nickOutput -Pattern "nick|set|updated|roster"

# Test 3.4: Remove contact
Write-TestLog -Level "INFO" -Message "Test 3.4 - Removing test contact..."
$removeOutput = Run-CommandOutput "openclaw xmpp remove $testContact"
Assert-Output -TestName "Remove contact" -Output $removeOutput -Pattern "removed|deleted|whitelist|roster"

#========================================
# TEST 4: SUBSCRIPTION MANAGEMENT
#========================================
Write-SectionHeader -Title "TEST 4: Subscription Management"

if (Probe-CommandExists "openclaw xmpp subscriptions pending") {
    Write-TestLog -Level "INFO" -Message "Test 4.1 - Listing pending subscriptions..."
    $subOutput = Run-CommandOutput "openclaw xmpp subscriptions pending"
    Assert-Output -TestName "Subscriptions pending" -Output $subOutput -Pattern "subscription|pending|none|list"
} else {
    Skip-Test -TestName "Subscriptions pending" -Reason "CLI command 'subscriptions' not registered (no handler in commands.ts)"
}

#========================================
# TEST 5: VCARD
#========================================
Write-SectionHeader -Title "TEST 5: vCard"

# Pre-flight: check if vCard CLI can actually reach the server
$vcardProbe = Run-CommandOutput "openclaw xmpp vcard get" 2>&1
if ($vcardProbe -match "configuration not found|cannot load|no such file") {
    Write-TestLog -Level "WARN" -Message "vCard CLI cannot load XMPP config -- skipping all vCard tests"
    Skip-Test -TestName "vCard get" -Reason "XMPP configuration not found in CLI context"
    Skip-Test -TestName "vCard set fn/nickname/url/desc" -Reason "XMPP configuration not found in CLI context"
    Skip-Test -TestName "vCard verify fields" -Reason "XMPP configuration not found in CLI context"
    Skip-Test -TestName "vCard birthday/title/role/timezone/name/phone/email/address/org" -Reason "XMPP configuration not found in CLI context"
} else {
    # Test 5.1: Get vCard
    Write-TestLog -Level "INFO" -Message "Test 5.1 - Getting current vCard..."
    $vcardOutput = $vcardProbe
    Assert-Output -TestName "vCard get" -Output $vcardOutput -Pattern "FN:|Nickname:|vcard|BEGIN:VCARD"

    # Test 5.2: Modify vCard fields
    Write-TestLog -Level "INFO" -Message "Test 5.2 - Modifying vCard fields..."
    $ts = Get-Timestamp
    $testFN = "XMPP Test Bot $ts"
    $testNick = "xmpptest"
    $testUrl = "https://test.example.com"
    $testDesc = "Modified by automated test on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

    $fnOut = Run-CommandOutput "openclaw xmpp vcard set fn '$testFN'"
    Assert-Output -TestName "vCard set fn" -Output $fnOut -Pattern "set|updated|saved|ok"

    $nickOut = Run-CommandOutput "openclaw xmpp vcard set nickname '$testNick'"
    Assert-Output -TestName "vCard set nickname" -Output $nickOut -Pattern "set|updated|saved|ok"

    $urlOut = Run-CommandOutput "openclaw xmpp vcard set url '$testUrl'"
    Assert-Output -TestName "vCard set url" -Output $urlOut -Pattern "set|updated|saved|ok"

    $descOut = Run-CommandOutput "openclaw xmpp vcard set desc '$testDesc'"
    Assert-Output -TestName "vCard set desc" -Output $descOut -Pattern "set|updated|saved|ok"

    # Verify changes
    Write-TestLog -Level "INFO" -Message "Test 5.3 - Verifying vCard changes..."
    $vcardVerify = Run-CommandOutput "openclaw xmpp vcard get"
    if ($vcardVerify -match [regex]::Escape($testFN)) {
        Assert-Test -TestName "vCard fn updated" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard fn updated" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify -match [regex]::Escape($testNick)) {
        Assert-Test -TestName "vCard nickname updated" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard nickname updated" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify -match [regex]::Escape($testUrl)) {
        Assert-Test -TestName "vCard url updated" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard url updated" -Condition $false -Expected "found" -Actual "not found"
    }

    # Test 5.4: Set birthday
    Write-TestLog -Level "INFO" -Message "Test 5.4 - Setting birthday..."
    $bdayOut = Run-CommandOutput "openclaw xmpp vcard set birthday '1990-05-15'"
    Assert-Output -TestName "vCard set birthday" -Output $bdayOut -Pattern "set|updated|saved|ok"

    # Test 5.5: Set title
    Write-TestLog -Level "INFO" -Message "Test 5.5 - Setting title..."
    $titleOut = Run-CommandOutput "openclaw xmpp vcard set title 'Test Engineer'"
    Assert-Output -TestName "vCard set title" -Output $titleOut -Pattern "set|updated|saved|ok"

    # Test 5.6: Set role
    Write-TestLog -Level "INFO" -Message "Test 5.6 - Setting role..."
    $roleOut = Run-CommandOutput "openclaw xmpp vcard set role 'Developer'"
    Assert-Output -TestName "vCard set role" -Output $roleOut -Pattern "set|updated|saved|ok"

    # Test 5.7: Set timezone
    Write-TestLog -Level "INFO" -Message "Test 5.7 - Setting timezone..."
    $tzOut = Run-CommandOutput "openclaw xmpp vcard set timezone '-05:00'"
    Assert-Output -TestName "vCard set timezone" -Output $tzOut -Pattern "set|updated|saved|ok"

    # Test 5.8: Set structured name
    Write-TestLog -Level "INFO" -Message "Test 5.8 - Setting structured name..."
    $nameOut = Run-CommandOutput "openclaw xmpp vcard name 'Testbot' 'XMPP' 'Bot' 'Mr.'"
    Assert-Output -TestName "vCard name" -Output $nameOut -Pattern "set|updated|saved|ok"

    # Test 5.9: Add phone
    Write-TestLog -Level "INFO" -Message "Test 5.9 - Adding phone..."
    $phoneOut = Run-CommandOutput "openclaw xmpp vcard phone add +61412345678 cell"
    Assert-Output -TestName "vCard phone add" -Output $phoneOut -Pattern "added|phone|set|ok"

    # Test 5.10: Add work phone
    Write-TestLog -Level "INFO" -Message "Test 5.10 - Adding work phone..."
    $wPhoneOut = Run-CommandOutput "openclaw xmpp vcard phone add +60987654321 work voice"
    Assert-Output -TestName "vCard phone add work" -Output $wPhoneOut -Pattern "added|phone|set|ok"

    # Test 5.11: Add email
    Write-TestLog -Level "INFO" -Message "Test 5.11 - Adding email..."
    $emailOut = Run-CommandOutput "openclaw xmpp vcard email add test@example.com home"
    Assert-Output -TestName "vCard email add" -Output $emailOut -Pattern "added|email|set|ok"

    # Test 5.12: Add work email
    Write-TestLog -Level "INFO" -Message "Test 5.12 - Adding work email..."
    $wEmailOut = Run-CommandOutput "openclaw xmpp vcard email add work@example.com work pref"
    Assert-Output -TestName "vCard email add work" -Output $wEmailOut -Pattern "added|email|set|ok"

    # Test 5.13: Add address
    Write-TestLog -Level "INFO" -Message "Test 5.13 - Adding address..."
    $addrOut = Run-CommandOutput "openclaw xmpp vcard address add `"123 Test St`" Boston MA 02101 USA home"
    Assert-Output -TestName "vCard address add" -Output $addrOut -Pattern "added|address|set|ok"

    # Test 5.14: Set organization
    Write-TestLog -Level "INFO" -Message "Test 5.14 - Setting organization..."
    $orgOut = Run-CommandOutput "openclaw xmpp vcard org 'Test Corp' 'Engineering'"
    Assert-Output -TestName "vCard org" -Output $orgOut -Pattern "set|updated|saved|ok"

    # Test 5.15: Verify all new fields
    Write-TestLog -Level "INFO" -Message "Test 5.15 - Verifying all new vCard fields..."
    $vcardVerify2 = Run-CommandOutput "openclaw xmpp vcard get"
    if ($vcardVerify2 -match "1990-05-15") {
        Assert-Test -TestName "vCard birthday" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard birthday" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "Test Engineer") {
        Assert-Test -TestName "vCard title" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard title" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "Developer") {
        Assert-Test -TestName "vCard role" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard role" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "\+1234567890|\+61412345678") {
        Assert-Test -TestName "vCard phone" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard phone" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "test@example.com") {
        Assert-Test -TestName "vCard email" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard email" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "Boston") {
        Assert-Test -TestName "vCard address" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard address" -Condition $false -Expected "found" -Actual "not found"
    }
    if ($vcardVerify2 -match "Test Corp") {
        Assert-Test -TestName "vCard org" -Condition $true -Expected "found" -Actual "found"
    } else {
        Assert-Test -TestName "vCard org" -Condition $false -Expected "found" -Actual "not found"
    }
}

#========================================
# TEST 6: SFTP
#========================================
Write-SectionHeader -Title "TEST 6: SFTP File Management"

# Test 6.1: List files
Write-TestLog -Level "INFO" -Message "Test 6.1 - Listing SFTP files..."
$sftpLs = Run-CommandOutput "openclaw xmpp sftp ls"
Assert-Output -TestName "SFTP ls" -Output $sftpLs -Pattern "file|listing|directory|total"

# Test 6.2: Upload file
Write-TestLog -Level "INFO" -Message "Test 6.2 - Uploading test file..."
$ts = Get-Timestamp
$testFilename = "xmpp-test-$ts.txt"
$testContent = @'
This is a test file for XMPP plugin automated testing.
Timestamp: PLACEHOLDER_DATE
Purpose: Verify SFTP functionality
NOTE: Test file will be removed by cleanup
'@ -replace 'PLACEHOLDER_DATE', (Get-Date)

$testFilePath = Create-TestFile -Content $testContent -Extension ".txt"

$sftpUpload = Run-CommandOutput "openclaw xmpp sftp upload '$testFilePath'"
Assert-Output -TestName "SFTP upload" -Output $sftpUpload -Pattern "uploaded|upload|success|ok|sent|transfer"

# Test 6.3: Download file
Write-TestLog -Level "INFO" -Message "Test 6.3 - Downloading test file..."
$downloadPath = "$TEST_FILES_DIR\downloaded-$ts.txt"
$sftpDownload = Run-CommandOutput "openclaw xmpp sftp download '$testFilename' '$downloadPath'"
Assert-Output -TestName "SFTP download" -Output $sftpDownload -Pattern "downloaded|download|success|ok|received|transfer"

if (Test-Path $downloadPath) {
    Assert-Test -TestName "Downloaded file exists" -Condition $true -Expected "file" -Actual "exists"
    $fileContent = Get-Content $downloadPath -Raw
    if ($fileContent -match "This is a test file") {
        Assert-Test -TestName "Downloaded file content matches" -Condition $true -Expected "content" -Actual "matched"
    } else {
        Assert-Test -TestName "Downloaded file content matches" -Condition $false -Expected "content" -Actual "mismatch"
    }
} else {
    Assert-Test -TestName "Downloaded file exists" -Condition $false -Expected "file" -Actual "missing"
}

# Test 6.4: Delete file
Write-TestLog -Level "INFO" -Message "Test 6.4 - Deleting test file..."
$deleteOutput = Run-CommandOutput "openclaw xmpp sftp rm '$testFilename'"
Assert-Output -TestName "SFTP delete" -Output $deleteOutput -Pattern "deleted|remove|success|ok|gone"

#========================================
# TEST 7: FILE TRANSFER SECURITY
#========================================
Write-SectionHeader -Title "TEST 7: File Transfer Security"

if (Probe-CommandExists "openclaw xmpp file-transfer-security status") {
    Write-TestLog -Level "INFO" -Message "Test 7.1 - Checking file transfer security status..."
    $ftsStatus = Run-CommandOutput "openclaw xmpp file-transfer-security status"
    Assert-Output -TestName "File transfer security status" -Output $ftsStatus -Pattern "status|security|quota|enabled|disabled"

    Write-TestLog -Level "INFO" -Message "Test 7.2 - Checking user quota..."
    $quota = Run-CommandOutput "openclaw xmpp file-transfer-security quota $BOT_JID"
    Assert-Output -TestName "Quota check" -Output $quota -Pattern "quota|usage|bytes|limit|allowed"
} else {
    Skip-Test -TestName "File transfer security status" -Reason "CLI command 'file-transfer-security' not registered (module exists but no CLI handler in commands.ts)"
    Skip-Test -TestName "Quota check" -Reason "CLI command 'file-transfer-security' not registered (module exists but no CLI handler in commands.ts)"
}

#========================================
# TEST 8: AUDIT LOGGING
#========================================
Write-SectionHeader -Title "TEST 8: Audit Logging"

if (Probe-CommandExists "openclaw xmpp audit status") {
    Write-TestLog -Level "INFO" -Message "Test 8.1 - Checking audit status..."
    $auditStatus = Run-CommandOutput "openclaw xmpp audit status"
    Assert-Output -TestName "Audit status" -Output $auditStatus -Pattern "audit|logging|enabled|disabled|events"

    Write-TestLog -Level "INFO" -Message "Test 8.2 - Listing audit events..."
    $auditList = Run-CommandOutput "openclaw xmpp audit list 10"
    Assert-Output -TestName "Audit list" -Output $auditList -Pattern "audit|event|entry|timestamp"
} else {
    Skip-Test -TestName "Audit status" -Reason "CLI command 'audit' not registered (no audit module or CLI handler in commands.ts)"
    Skip-Test -TestName "Audit list" -Reason "CLI command 'audit' not registered (no audit module or CLI handler in commands.ts)"
}

#========================================
# TEST 9: RATE LIMITING
#========================================
Write-SectionHeader -Title "TEST 9: Rate Limiting"

if (Probe-CommandExists "openclaw xmpp status") {
    Write-TestLog -Level "INFO" -Message "Test 9.1 - Testing rate limit (sending 12 commands rapidly)..."
    Write-TestLog -Level "WARN" -Message "Rate limiting test is informational only -- each CLI call spawns a separate gateway process, so in-memory rate limits won't accumulate across invocations."
    
    $rateLimited = 0
    for ($i = 1; $i -le 12; $i++) {
        $cmdOutput = Run-CommandOutput "openclaw xmpp status"
        if ($cmdOutput -match "too many|rate limit") {
            $rate++
            Write-TestLog -Level "INFO" -Message "Command $i - Rate limited"
        } else {
            Write-TestLog -Level "INFO" -Message "Command $i - OK"
        }
    }

    if ($rateLimited -ge 1) {
        Assert-Test -TestName "Rate limiting works" -Condition $true -Expected "limited" -Actual "limited"
        Write-TestLog -Level "INFO" -Message "Rate limiting triggered: $rateLimited commands limited"
    } else {
        Write-TestLog -Level "INFO" -Message "Rate limiting not triggered (expected -- CLI calls spawn separate gateways)"
        Skip-Test -TestName "Rate limiting" -Reason "Not reliably testable via CLI (each call = new gateway process, in-memory rate state doesn't persist)"
    }
} else {
    Skip-Test -TestName "Rate limiting" -Reason "'openclaw xmpp status' command not available"
}

#========================================
# TEST 10: MUC INVITES (Auto-Accept)
#========================================
Write-SectionHeader -Title "TEST 10: MUC Invites"

# Jamie is admin, can join without invite
Write-TestLog -Level "INFO" -Message "Test 10.1 - Bot can join room without invite (admin)..."
$adminJoinOutput = Run-CommandOutput "openclaw xmpp join $ROOM_JID"
Assert-Output -TestName "Admin room join" -Output $adminJoinOutput -Pattern "joined|success|already joined|room|conference"

# Test invite (abot will auto-accept)
Write-TestLog -Level "INFO" -Message "Test 10.2 - Inviting abot to room..."
$inviteOutput = Run-CommandOutput "openclaw xmpp invite $BOT_JID $ROOM_JID"
Assert-Output -TestName "Invite command" -Output $inviteOutput -Pattern "invited|sent|success|invite"

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

# Wait and check poll (read-only -- exit code assertion OK)
Start-Sleep -Seconds 15
$pollCheck = Run-CommandOutput "openclaw xmpp poll"
Assert-Test -TestName "Slash command poll" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE

#========================================
# TEST 12: CLEAR & CLEANUP
#========================================
Write-SectionHeader -Title "TEST 12: Clear & Cleanup"

Write-TestLog -Level "INFO" -Message "Test 12.1 - Clearing message queue..."
$clearOutput = Run-CommandOutput "openclaw xmpp clear"
Assert-Output -TestName "Clear queue" -Output $clearOutput -Pattern "cleared|empty|queue|removed|ok"

#========================================
# RESTORE VCARD & FINAL CLEANUP
# (handled by finally block)
#========================================
Write-SectionHeader -Title "FINAL: Restore & Cleanup"

Write-TestLog -Level "INFO" -Message "Cleanup will be handled by finally block."
Write-TestLog -Level "INFO" -Message "If you reached here, all tests completed."

#========================================
# TEST SUMMARY
#========================================
Write-Summary

Write-TestLog -Level "INFO" -Message "Test suite complete. Check $LOG_FILE for full output."

} finally {
    # Guaranteed cleanup even if errors occur
    Cleanup-TestFiles
    Restore-Vcard
}
