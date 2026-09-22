param(
    [string]$PluginDir = "$env:USERPROFILE\.openclaw\extensions\xmpp"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================"
Write-Host " XMPP Plugin Installer for OpenClaw 2026.6+"
Write-Host "============================================"
Write-Host ""

if (-not (Test-Path $PluginDir)) {
    New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
}

Set-Location $PluginDir

# SECURITY (2.18.2): remove in-tree backup/trash dirs BEFORE install.  OpenClaw
# captures plugin source by walking the extension dir; a Windows reserved device
# entry (e.g. `nul`) in an old `_backups/` snapshot fails the whole plugin load.
# Use the \\?\ prefix so device names can be deleted.  This runs outside the
# plugin load, so it repairs a plugin that currently fails to load.
foreach ($backupName in @("_backups", "_trash")) {
    $backupPath = Join-Path $PluginDir $backupName
    if (Test-Path -LiteralPath $backupPath) {
        Write-Host "Removing in-tree $backupName (can break plugin loading)..."
        cmd /c rd /s /q "\\?\$backupPath" 2>$null
    }
}

if (-not (Test-Path "$PluginDir\package.json")) {
    Write-Host "Cloning repository..."
    git clone https://github.com/kazakhan/openclaw-xmpp.git "$PluginDir"
    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed (exit $LASTEXITCODE)"
    }
}

Write-Host "Installing npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed (exit $LASTEXITCODE)"
}

Write-Host "Linking global OpenClaw SDK..."
$globalOpenclaw = "$env:APPDATA\npm\node_modules\openclaw"
if (Test-Path $globalOpenclaw) {
    $localLink = Join-Path $PluginDir "node_modules\openclaw"
    $linkItem = Get-Item $localLink -ErrorAction SilentlyContinue
    $needsLink = $true
    if ($linkItem -and ($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        $needsLink = $false
        Write-Host "  Junction already exists"
    }
    if ($needsLink) {
        if (Test-Path $localLink) {
            Remove-Item -Recurse -Force $localLink
        }
        $null = New-Item -ItemType Junction -Path $localLink -Target $globalOpenclaw
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create junction at $localLink -> $globalOpenclaw (exit $LASTEXITCODE)"
        }
        Write-Host "  Junction created"
    }
} else {
    Write-Host "  WARNING: Global OpenClaw not found. Run: npm install -g openclaw" -ForegroundColor Yellow
}

Write-Host "Removing old compiled JS..."
$distPath = Join-Path $PluginDir "dist"
if (Test-Path $distPath) {
    Remove-Item -Recurse -Force $distPath
}

Write-Host "Building (tsc + esbuild bundle)..."
& node scripts\build.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Build reported errors. See output above." -ForegroundColor Yellow
} else {
    Write-Host "  Build complete"
}

Write-Host "Registering plugin with OpenClaw..."
& openclaw plugins install --link --force $PluginDir
if ($LASTEXITCODE -ne 0) {
    throw "openclaw plugins install failed (exit $LASTEXITCODE). See output above."
}

Write-Host "Enabling XMPP entry..."
& openclaw config set plugins.entries.xmpp.enabled true
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: failed to set plugins.entries.xmpp.enabled (exit $LASTEXITCODE)" -ForegroundColor Yellow
}

Write-Host "Enabling groupchat reply delivery..."
& openclaw config set messages.groupChat.visibleReplies automatic
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: failed to set messages.groupChat.visibleReplies (exit $LASTEXITCODE)" -ForegroundColor Yellow
}

# SECURITY (2.18.1): the plugin needs the conversation hooks
# (before_agent_run/agent_end) for presence auto-activity.
Write-Host "Enabling conversation hooks..."
& openclaw config set plugins.entries.xmpp.hooks.allowConversationAccess true
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: failed to set plugins.entries.xmpp.hooks.allowConversationAccess (exit $LASTEXITCODE)" -ForegroundColor Yellow
}

# SECURITY (2.18.4): group replies must be OPTIONAL (the agent decides).
Write-Host "Making group replies optional..."
& openclaw config set surfaces.xmpp.silentReply.group allow
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: failed to set surfaces.xmpp.silentReply.group (exit $LASTEXITCODE)" -ForegroundColor Yellow
}
& openclaw config set surfaces.xmpp.silentReply.internal allow
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: failed to set surfaces.xmpp.silentReply.internal (exit $LASTEXITCODE)" -ForegroundColor Yellow
}

# SECURITY (2.18.0): no mention-only toggles.  The plugin dispatches every room
# message through OpenClaw's channel inbound runner; the agent decides whether
# to reply.

Write-Host ""
Write-Host "============================================"
Write-Host " Running interactive onboarding..."
Write-Host "============================================"
Write-Host ""
Write-Host "You will be asked for your server, JID, and password."
Write-Host "The password is encrypted and stored as an ENC: secret."
Write-Host ""
$configPath = Join-Path "$env:USERPROFILE" ".openclaw\openclaw.json"
& openclaw xmpp setup --config $configPath
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  WARNING: interactive onboarding did not complete." -ForegroundColor Yellow
    Write-Host "  You can run it later with: openclaw xmpp setup" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================"
Write-Host " Install complete!"
Write-Host "============================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart the gateway:"
Write-Host "     openclaw gateway restart"
Write-Host ""
Write-Host "  2. Whitelist contacts:"
Write-Host "     openclaw xmpp add user@domain.com"
Write-Host ""
