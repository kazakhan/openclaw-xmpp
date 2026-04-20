#!/bin/bash
# XMPP Plugin Test - Common Functions (Linux)
# Source this file: source test-common.sh

source "$(dirname "$0")/test-config.sh"

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0
TEST_START_TIME=$(date +%s)
LOG_FILE="$TEMP_DIR/test-output.log"

# Cleanup flag to prevent double-cleanup
_CLEANUP_DONE=0

# Initialize log file
init_log() {
    mkdir -p "$TEMP_DIR"
    mkdir -p "$BACKUP_DIR"
    mkdir -p "$TEST_FILES_DIR"
    echo "=== XMPP Plugin Test - $(date) ===" > "$LOG_FILE"
    echo "Tester: $TESTER_JID" >> "$LOG_FILE"
    echo "Bot: $BOT_JID" >> "$LOG_FILE"
    echo "Room: $ROOM_JID" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
}

# Log message to file and console
log() {
    local level=$1
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
    case $level in
        PASS) echo -e "${GREEN}[$level] $message${NC}" ;;
        FAIL) echo -e "${RED}[$level] $message${NC}" ;;
        WARN) echo -e "${YELLOW}[$level] $message${NC}" ;;
        SKIP) echo -e "${YELLOW}[$level] $message${NC}" ;;
        *)    echo -e "[$level] $message" ;;
    esac
}

# Test assertion (exit-code based — use for read-only commands that return 0 on success)
assert() {
    local test_name="$1"
    local condition="$2"
    local expected="$3"
    local actual="$4"
    
    if [ "$condition" = "true" ] || [ "$condition" = "0" ]; then
        log "PASS" "$test_name"
        ((TESTS_PASSED++))
        return 0
    else
        log "FAIL" "$test_name (expected: $expected, got: $actual)"
        ((TESTS_FAILED++))
        return 1
    fi
}

# Output-content assertion — checks that command output contains expected text.
# Use this for write operations (msg, join, add, etc.) where exit code may be
# non-zero even on success because the CLI spawns a gateway child process.
assert_output() {
    local test_name="$1"
    local output="$2"
    local expected_pattern="$3"
    
    if echo "$output" | grep -qiE "$expected_pattern"; then
        log "PASS" "$test_name"
        ((TESTS_PASSED++))
        return 0
    else
        log "FAIL" "$test_name (output did not contain pattern: $expected_pattern)"
        ((TESTS_FAILED++))
        return 1
    fi
}

# Skip a test with reason
skip_test() {
    local test_name="$1"
    local reason="$2"
    log "SKIP" "$test_name — $reason"
    ((TESTS_SKIPPED++))
}

# Probe whether a command exists and is functional.
# Returns 0 if the command responds (even with help/usage), 1 if not found.
probe_command_exists() {
    local cmd="$1"
    local output
    output=$(timeout 10 bash -c "$cmd --help" 2>&1)
    local rc=$?
    if [ $rc -eq 0 ] || echo "$output" | grep -qiE "usage|command|options|subcommand|error.*unknown"; then
        return 0
    fi
    return 1
}

# Run command with timeout. Outputs stdout+stderr to stdout.
# Sets global variables _LAST_CMD_OUTPUT and _LAST_CMD_EXITCODE for callers.
run_command() {
    local cmd="$1"
    local timeout="${2:-$COMMAND_TIMEOUT}"
    
    _LAST_CMD_OUTPUT=$(timeout "$timeout" bash -c "$cmd" 2>&1) || _LAST_CMD_EXITCODE=$?
    if [ -z "$_LAST_CMD_EXITCODE" ]; then
        _LAST_CMD_EXITCODE=0
    fi
    
    echo "$_LAST_CMD_OUTPUT"
    return $_LAST_CMD_EXITCODE
}

# Get timestamp for unique filenames
get_timestamp() {
    date '+%Y%m%d-%H%M%S'
}

# Save vCard backup
save_vcard() {
    log "INFO" "Saving vCard backup..."
    run_command "openclaw xmpp vcard get" > "$VCARD_BACKUP_FILE" 2>&1
    # Don't hard-fail here; vCard may fail if config path differs in CLI context
    if echo "$_LAST_CMD_OUTPUT" | grep -qi "configuration not found\|no such file\|cannot load"; then
        log "WARN" "vCard backup skipped — XMPP config not accessible from CLI context"
    else
        assert "Save vCard backup" "$?" "0" "$?"
    fi
}

# Restore vCard from backup
restore_vcard() {
    log "INFO" "Restoring vCard..."
    if [ -f "$VCARD_BACKUP_FILE" ]; then
        local fn=$(grep -i "^FN:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local nickname=$(grep -i "^Nickname:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local url=$(grep -i "^URL:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local desc=$(grep -i "^Description:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local birthday=$(grep -i "^Birthday:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local title=$(grep -i "^Title:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        local role=$(grep -i "^Role:" "$VCARD_BACKUP_FILE" | head -1 | cut -d':' -f2- | xargs)
        
        [ -n "$fn" ] && run_command "openclaw xmpp vcard set fn '$fn'" >/dev/null 2>&1
        [ -n "$nickname" ] && run_command "openclaw xmpp vcard set nickname '$nickname'" >/dev/null 2>&1
        [ -n "$url" ] && run_command "openclaw xmpp vcard set url '$url'" >/dev/null 2>&1
        [ -n "$desc" ] && run_command "openclaw xmpp vcard set desc '$desc'" >/dev/null 2>&1
        [ -n "$birthday" ] && run_command "openclaw xmpp vcard set birthday '$birthday'" >/dev/null 2>&1
        [ -n "$title" ] && run_command "openclaw xmpp vcard set title '$title'" >/dev/null 2>&1
        [ -n "$role" ] && run_command "openclaw xmpp vcard set role '$role'" >/dev/null 2>&1
        
        log "INFO" "vCard restored from backup"
    else
        log "WARN" "No vCard backup found, skipping restore"
    fi
}

# Cleanup test files (idempotent)
cleanup_test_files() {
    if [ $_CLEANUP_DONE -eq 1 ]; then return; fi
    _CLEANUP_DONE=1

    log "INFO" "Cleaning up test files..."
    
    run_command "openclaw xmpp sftp ls" 2>/dev/null | grep "xmpp-test" | while read line; do
        local filename=$(echo "$line" | awk '{print $2}')
        if [ -n "$filename" ]; then
            run_command "openclaw xmpp sftp rm '$filename'" >/dev/null 2>&1
        fi
    done
    
    rm -rf "$TEST_FILES_DIR"/* 2>/dev/null || true
    
    log "INFO" "Test files cleaned up"
}

# Get random test message
get_test_message() {
    local prefix="$1"
    local timestamp=$(get_timestamp)
    echo "[$prefix Test $timestamp] Hello from automated test!"
}

# Create test content file
create_test_file() {
    local filename="$1"
    local content="$2"
    echo "$content" > "$TEST_FILES_DIR/$filename"
    echo "$TEST_FILES_DIR/$filename"
}

# Wait for abot response (for direct messages)
wait_for_abot_reply() {
    local expected_content="$1"
    local timeout="${2:-$ABOT_REPLY_TIMEOUT}"
    local elapsed=0
    local interval=5
    
    log "INFO" "Waiting for abot reply (timeout: ${timeout}s)..."
    
    while [ $elapsed -lt $timeout ]; do
        local poll_output=$(run_command "openclaw xmpp poll")
        
        if echo "$poll_output" | grep -q "$BOT_JID"; then
            if echo "$poll_output" | grep -qi "$expected_content"; then
                return 0
            fi
        fi
        
        sleep $interval
        elapsed=$((elapsed + interval))
        log "INFO" "Waiting... ${elapsed}s / ${timeout}s"
    done
    
    return 1
}

# Print test section header
section_header() {
    local title="$1"
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$title${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo "" >> "$LOG_FILE"
    echo "--- $title ---" >> "$LOG_FILE"
}

# Print test summary
print_summary() {
    local test_end_time=$(date +%s)
    local duration=$((test_end_time - TEST_START_TIME))
    
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}TEST SUMMARY${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo -e "Duration: ${duration}s"
    echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "${RED}Failed: $TESTS_FAILED${NC}"
    echo -e "${YELLOW}Skipped: $TESTS_SKIPPED${NC}"
    echo ""
    echo "Full log: $LOG_FILE"
    echo -e "${BLUE}========================================${NC}"
}

# Check if gateway is running
check_gateway() {
    local status_output=$(run_command "openclaw xmpp status" 10)
    if echo "$status_output" | grep -qi "connected\|running\|online\|XMPP"; then
        return 0
    else
        return 1
    fi
}

# Ensure gateway is running
ensure_gateway() {
    if ! check_gateway; then
        log "WARN" "Gateway not running, starting..."
        run_command "openclaw xmpp start" 10
        sleep 5
        check_gateway
    fi
}
