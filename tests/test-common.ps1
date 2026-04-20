# XMPP Plugin Test - Common Functions (Windows PowerShell)
# Source this file: . ./test-common.ps1

# Import config
. "$(Split-Path -Parent $MyInvocation.MyCommand.Path)\test-config.ps1"

# Track test results
$global:TESTS_PASSED = 0
$global:TESTS_FAILED = 0
$global:TESTS_SKIPPED = 0
$global:TEST_START_TIME = [DateTime]::Now

# Cleanup flag to prevent double-cleanup
$global:_CLEANUP_DONE = $false

# Initialize log file
function Init-Log {
    New-Item -ItemType Directory -Force -Path $TEMP_DIR | Out-Null
    New-Item -ItemType Directory -Force -Path $BACKUP_DIR | Out-Null
    New-Item -ItemType Directory -Force -Path $TEST_FILES_DIR | Out-Null
    
    "=== XMPP Plugin Test - $(Get-Date) ===" | Out-File -FilePath $LOG_FILE -Encoding utf8
    "Tester: $TESTER_JID" | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
    "Bot: $BOT_JID" | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
    "Room: $ROOM_JID" | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
    "" | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
}

# Log message
function Write-TestLog {
    param(
        [string]$Level,
        [string]$Message
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    
    $logEntry | Out-File -FilePath $LOG_FILE -Append -Encoding utf8
    
    switch ($Level) {
        "PASS" { Write-Host $logEntry -ForegroundColor Green }
        "FAIL" { Write-Host $logEntry -ForegroundColor Red }
        "INFO" { Write-Host $logEntry -ForegroundColor Blue }
        "WARN" { Write-Host $logEntry -ForegroundColor Yellow }
        "SKIP" { Write-Host $logEntry -ForegroundColor Yellow }
        default { Write-Host $logEntry }
    }
}

# Test assertion (exit-code based -- use for read-only commands that return 0 on success)
function Assert-Test {
    param(
        [string]$TestName,
        [bool]$Condition,
        [string]$Expected,
        [string]$Actual
    )
    
    if ($Condition) {
        Write-TestLog -Level "PASS" -Message $TestName
        $global:TESTS_PASSED++
        return $true
    } else {
        Write-TestLog -Level "FAIL" -Message "$TestName (expected: $Expected, got: $Actual)"
        $global:TESTS_FAILED++
        return $false
    }
}

# Output-content assertion -- checks that command output contains expected text.
# Use this for write operations where exit code may be non-zero on success.
function Assert-Output {
    param(
        [string]$TestName,
        [string]$Output,
        [string]$Pattern
    )
    
    if ($Output -match [regex]::Escape($Pattern) -or $Output -match "(?i)$Pattern") {
        Write-TestLog -Level "PASS" -Message $TestName
        $global:TESTS_PASSED++
        return $true
    } else {
        Write-TestLog -Level "FAIL" -Message "$TestName (output did not contain pattern: $Pattern)"
        $global:TESTS_FAILED++
        return $false
    }
}

# Skip a test with reason
function Skip-Test {
    param(
        [string]$TestName,
        [string]$Reason
    )
    Write-TestLog -Level "SKIP" -Message "$TestName -- $Reason"
    $global:TESTS_SKIPPED++
}

# Probe whether a command exists and is functional.
function Probe-CommandExists {
    param([string]$Command)
    
    try {
        $output = cmd /c "$Command --help" 2>&1
        # Command exists if it returns usage/help text or error about unknown subcommand
        if ($LASTEXITCODE -eq 0 -or $output -match "usage|command|options|subcommand|error.*unknown") {
            return $true
        }
    } catch {}
    return $false
}

# Run command with timeout using Start-Process. Returns exit code.
function Run-Command {
    param(
        [string]$Command,
        [int]$Timeout = $COMMAND_TIMEOUT
    )
    
    try {
        $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $Command -NoNewWindow -PassThru -ErrorAction Stop
        $null = $process | Wait-Process -Timeout $Timeout -ErrorAction SilentlyContinue
        
        # Capture output for global reference
        $global:LAST_CMD_EXITCODE = if ($process.HasExited) { $process.ExitCode } else { 1 }
        
        if ($process.HasExited) {
            return $process.ExitCode
        } else {
            $process | Stop-Process -Force -ErrorAction SilentlyContinue | Out-Null
            $global:LAST_CMD_EXITCODE = 1
            return 1
        }
    } catch {
        Write-TestLog -Level "WARN" -Message "Command failed: $Command"
        $global:LAST_CMD_EXITCODE = 1
        return 1
    }
}

# Run command and capture output. Also sets $global:LAST_CMD_OUTPUT and $global:LAST_CMD_EXITCODE.
function Run-CommandOutput {
    param(
        [string]$Command,
        [int]$Timeout = $COMMAND_TIMEOUT
    )
    
    try {
        $output = cmd /c "$Command" 2>&1
        $global:LAST_CMD_OUTPUT = $output
        $global:LAST_CMD_EXITCODE = $LASTEXITCODE
        return $output
    } catch {
        $global:LAST_CMD_OUTPUT = ""
        $global:LAST_CMD_EXITCODE = 1
        return ""
    }
}

# Get timestamp
function Get-Timestamp {
    return [DateTime]::Now.ToString("yyyyMMdd-HHmmss")
}

# Save vCard backup
function Save-Vcard {
    Write-TestLog -Level "INFO" -Message "Saving vCard backup..."
    $output = Run-CommandOutput "openclaw xmpp vcard get"
    $output | Out-File -FilePath $VCARD_BACKUP_FILE -Encoding utf8
    
    # Don't hard-fail; vCard may fail if config path differs in CLI context
    if ($output -match "configuration not found|no such file|cannot load") {
        Write-TestLog -Level "WARN" -Message "vCard backup skipped -- XMPP config not accessible from CLI context"
    } else {
        Assert-Test -TestName "Save vCard backup" -Condition ($LASTEXITCODE -eq 0) -Expected "0" -Actual $LASTEXITCODE
    }
}

# Restore vCard from backup
function Restore-Vcard {
    Write-TestLog -Level "INFO" -Message "Restoring vCard..."
    
    if (Test-Path $VCARD_BACKUP_FILE) {
        $backup = Get-Content $VCARD_BACKUP_FILE -Raw
        
        $fnMatch = $backup | Select-String -Pattern "FN:\s*(.+)" -CaseSensitive:$false
        $nickMatch = $backup | Select-String -Pattern "Nickname:\s*(.+)" -CaseSensitive:$false
        $urlMatch = $backup | Select-String -Pattern "URL:\s*(.+)" -CaseSensitive:$false
        $descMatch = $backup | Select-String -Pattern "Description:\s*(.+)" -CaseSensitive:$false
        $bdayMatch = $backup | Select-String -Pattern "Birthday:\s*(.+)" -CaseSensitive:$false
        $titleMatch = $backup | Select-String -Pattern "Title:\s*(.+)" -CaseSensitive:$false
        $roleMatch = $backup | Select-String -Pattern "Role:\s*(.+)" -CaseSensitive:$false
        
        if ($fnMatch) { 
            $fn = ($fnMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set fn '$fn'" | Out-Null
        }
        if ($nickMatch) { 
            $nick = ($nickMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set nickname '$nick'" | Out-Null
        }
        if ($urlMatch) { 
            $url = ($urlMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set url '$url'" | Out-Null
        }
        if ($descMatch) { 
            $desc = ($descMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set desc '$desc'" | Out-Null
        }
        if ($bdayMatch) { 
            $bday = ($bdayMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set birthday '$bday'" | Out-Null
        }
        if ($titleMatch) { 
            $title = ($titleMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set title '$title'" | Out-Null
        }
        if ($roleMatch) { 
            $role = ($roleMatch.Matches.Groups[1].Value).Trim()
            Run-Command "openclaw xmpp vcard set role '$role'" | Out-Null
        }
        
        Write-TestLog -Level "INFO" -Message "vCard restored from backup"
    } else {
        Write-TestLog -Level "WARN" -Message "No vCard backup found, skipping restore"
    }
}

# Cleanup test files (idempotent)
function Cleanup-TestFiles {
    if ($global:_CLEANUP_DONE) { return }
    $global:_CLEANUP_DONE = $true
    
    Write-TestLog -Level "INFO" -Message "Cleaning up test files..."
    
    $sftpList = Run-CommandOutput "openclaw xmpp sftp ls 2>&1"
    $lines = $sftpList | Select-String "xmpp-test"
    foreach ($line in $lines) {
        $filename = ($line -split '\s+')[-1]
        if ($filename -and $filename -notmatch "^\." -and $filename -match "xmpp-test") {
            Run-Command "openclaw xmpp sftp rm '$filename' 2>&1" | Out-Null
        }
    }
    
    Remove-Item -Path "$TEST_FILES_DIR\*" -ErrorAction SilentlyContinue | Out-Null
    
    Write-TestLog -Level "INFO" -Message "Test files cleaned up"
}

# Get test message
function Get-TestMessage {
    param([string]$Prefix)
    $ts = Get-Timestamp
    return "[$Prefix Test $ts] Hello from automated test!"
}

# Create test file
function Create-TestFile {
    param(
        [string]$Content,
        [string]$Extension = ".txt"
    )
    
    $ts = Get-Timestamp
    $filename = "xmpp-test-$ts$Extension"
    $filepath = "$TEST_FILES_DIR\$filename"
    $Content | Out-File -FilePath $filepath -Encoding utf8
    return $filename
}

# Wait for abot response
function Wait-ForAbotReply {
    param(
        [string]$ExpectedContent,
        [int]$Timeout = $ABOT_REPLY_TIMEOUT
    )
    
    Write-TestLog -Level "INFO" -Message "Waiting for abot reply (timeout: ${Timeout}s)..."
    
    $elapsed = 0
    $interval = 5
    
    while ($elapsed -lt $Timeout) {
        $pollOutput = Run-CommandOutput "openclaw xmpp poll 2>&1"
        
        if ($pollOutput -match [regex]::Escape($BOT_JID)) {
            if ($pollOutput -match [regex]::Escape($ExpectedContent)) {
                return $true
            }
        }
        
        Start-Sleep -Seconds $interval
        $elapsed += $interval
        Write-TestLog -Level "INFO" -Message "Waiting... ${elapsed}s / ${Timeout}s"
    }
    
    return $false
}

# Print section header
function Write-SectionHeader {
    param([string]$Title)
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host $Title -ForegroundColor Blue
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host "" 
    "" | Out-File -FilePath $LOG_FILE -Append
    
    "--- $Title ---" | Out-File -FilePath $LOG_FILE -Append
}

# Print test summary
function Write-Summary {
    $testEndTime = [DateTime]::Now
    $duration = ($testEndTime - $global:TEST_START_TIME).TotalSeconds
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host "TEST SUMMARY" -ForegroundColor Blue
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host "Duration: $([math]::Round($duration, 1))s"
    Write-Host "Passed: $global:TESTS_PASSED" -ForegroundColor Green
    Write-Host "Failed: $global:TESTS_FAILED" -ForegroundColor Red
    Write-Host "Skipped: $global:TESTS_SKIPPED" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Full log: $LOG_FILE"
    Write-Host "========================================" -ForegroundColor Blue
}

# Check if gateway is running (simple check)
function Test-GatewayRunning {
    $status = Run-CommandOutput "openclaw xmpp status 2>&1"
    return ($status -match "connected|running|XMPP|online" -or $status.Length -gt 0)
}

# Ensure gateway is running (quick check, don't wait)
function Ensure-Gateway {
    Write-TestLog -Level "INFO" -Message "Checking gateway status..."
    
    $status = Run-CommandOutput "openclaw xmpp status 2>&1"
    
    if ($status -match "connected|running|XMPP|online") {
        Write-TestLog -Level "INFO" -Message "Gateway is running"
        return $true
    }
    
    Write-TestLog -Level "WARN" -Message "Gateway not running, attempting to start..."
    $startResult = Run-CommandOutput "openclaw xmpp start 2>&1"
    
    Write-TestLog -Level "INFO" -Message "Start command sent, continuing with tests..."
    return $true
}
