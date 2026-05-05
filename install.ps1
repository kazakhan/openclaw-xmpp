param(
    [string]$PluginDir = "$env:USERPROFILE\.openclaw\extensions\xmpp"
)

Write-Host "============================================"
Write-Host " XMPP Plugin Installer for OpenClaw 2026.5+"
Write-Host "============================================"
Write-Host ""

# Create directory if needed
if (-not (Test-Path $PluginDir)) {
    New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
}

Set-Location $PluginDir

# Clone if package.json doesn't exist
if (-not (Test-Path "$PluginDir\package.json")) {
    Write-Host "Cloning repository..."
    git clone https://github.com/kazakhan/openclaw-xmpp.git "$PluginDir"
}

# Install npm dependencies
Write-Host "Installing npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed" -ForegroundColor Red
    exit 1
}

# Remove old compiled JS (shadows .ts sources)
Write-Host "Removing old compiled JS..."
if (Test-Path "$PluginDir\dist") {
    Remove-Item -Recurse -Force "$PluginDir\dist"
}

# Compile TypeScript (required by OpenClaw 2026.5.4+)
Write-Host "Compiling TypeScript..."
npx tsc --noEmitOnError false 2>&1 | Out-Null
Write-Host "  (tsc warnings are expected)"

# Register plugin with OpenClaw
Write-Host "Registering plugin with OpenClaw..."
openclaw plugins install --force "$PluginDir" 2>&1 | Out-Null

# Enable groupchat reply delivery
Write-Host "Enabling groupchat reply delivery..."
openclaw config set messages.groupChat.visibleReplies automatic 2>&1 | Out-Null

Write-Host ""
Write-Host "============================================"
Write-Host " Install complete!"
Write-Host "============================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Configure your XMPP account:"
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
Write-Host "  3. Start the gateway:"
Write-Host "     openclaw gateway"
Write-Host ""
Write-Host "  4. Whitelist contacts:"
Write-Host "     openclaw xmpp add user@domain.com"
