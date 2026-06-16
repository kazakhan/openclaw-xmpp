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

Write-Host "Compiling TypeScript..."
npx tsc 2>&1 | Tee-Object -FilePath "$PluginDir\.tsc.log" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  tsc emitted errors. See .tsc.log" -ForegroundColor Yellow
} else {
    Write-Host "  Build complete"
    Remove-Item -LiteralPath "$PluginDir\.tsc.log" -ErrorAction SilentlyContinue
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

Write-Host ""
Write-Host "============================================"
Write-Host " Install complete!"
Write-Host "============================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Configure your XMPP account (if not already set):"
Write-Host "     openclaw config set channels.xmpp.accounts.default.service 'xmpp://your-server:5222'"
Write-Host "     openclaw config set channels.xmpp.accounts.default.domain 'your-domain'"
Write-Host "     openclaw config set channels.xmpp.accounts.default.jid 'user@domain'"
Write-Host "     openclaw config set channels.xmpp.accounts.default.password 'your-password'"
Write-Host "     openclaw config set channels.xmpp.accounts.default.dataDir '$PluginDir\data'"
Write-Host "     openclaw config set channels.xmpp.accounts.default.enabled true"
Write-Host ""
Write-Host "  2. Encrypt your password (recommended):"
Write-Host "     openclaw xmpp encrypt-password"
Write-Host ""
Write-Host "  3. Restart the gateway:"
Write-Host "     openclaw gateway restart"
Write-Host ""
Write-Host "  4. Whitelist contacts:"
Write-Host "     openclaw xmpp add user@domain.com"
