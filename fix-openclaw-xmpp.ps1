<#
.SYNOPSIS
    Registers the locally-installed xmpp plugin in OpenClaw's SQLite state database,
    fixing the "Package not found on npm: @openclaw/xmpp" error on startup.
.DESCRIPTION
    OpenClaw 2026.7+ migrated plugin install records from installs.json to SQLite.
    If the xmpp plugin's record was lost during migration, OpenClaw tries to fetch
    @openclaw/xmpp from npm (404) and refuses to start. This script injects the
    missing install record so OpenClaw loads the plugin from disk.
.NOTES
    Run while OpenClaw is stopped. Idempotent — safe to re-run.
    Requires Node.js 22.5+ (for built-in node:sqlite module).
    Keep fix-openclaw-xmpp.mjs in the same directory.
#>

$ErrorActionPreference = 'Stop'

# ---- Resolve paths (no hardcoded usernames) ----
$openclawHome = if ($env:OPENCLAW_HOME) { $env:OPENCLAW_HOME } else { Join-Path $env:USERPROFILE '.openclaw' }
$stateDb  = Join-Path (Join-Path $openclawHome 'state') 'openclaw.sqlite'
$xmppDir  = Join-Path (Join-Path $openclawHome 'extensions') 'xmpp'
$manifest = Join-Path $xmppDir 'openclaw.plugin.json'
$pkgJson  = Join-Path $xmppDir 'package.json'

# ---- Validate ----
foreach ($item in @(
    @{ Label = 'State DB';         Path = $stateDb }
    @{ Label = 'xmpp manifest';    Path = $manifest }
    @{ Label = 'xmpp package.json';Path = $pkgJson }
)) {
    if (-not (Test-Path $item.Path)) { Write-Error "Not found: $($item.Label) at $($item.Path)"; exit 1 }
}

Write-Host "OpenClaw home: $openclawHome"
Write-Host "xmpp plugin:   $xmppDir"

# SECURITY (2.18.2): remove in-tree backup/trash dirs.  OpenClaw captures plugin
# source by walking the extension dir; a Windows reserved device entry (e.g.
# `nul`) in an old `_backups/` snapshot fails the whole plugin load.  The \\?\
# prefix lets device names be deleted.
foreach ($backupName in @("_backups", "_trash")) {
    $backupPath = Join-Path $xmppDir $backupName
    if (Test-Path -LiteralPath $backupPath) {
        Write-Host "Removing in-tree $backupName (can break plugin loading)..."
        cmd /c rd /s /q "\\?\$backupPath" 2>$null
    }
}

# ---- Backup ----
$backup = "$stateDb.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $stateDb -Destination $backup
Write-Host "Backup saved:  $backup"

# ---- Read metadata ----
$manifestObj = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
$pkgObj      = Get-Content -Raw -LiteralPath $pkgJson  | ConvertFrom-Json
$pluginId    = $manifestObj.id

# SHA256 of manifest file
$manifestBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $manifest))
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$manifestHash = [System.BitConverter]::ToString($sha256.ComputeHash($manifestBytes)) -replace '-', ''
$sha256.Dispose()

Write-Host "Plugin ID:     $pluginId"
Write-Host "Package:       $($pkgObj.name)@$($pkgObj.version)"

# ---- Find the companion .mjs script ----
$scriptDir = Split-Path -Parent $PSCommandPath
$mjsPath   = Join-Path $scriptDir 'fix-openclaw-xmpp.mjs'

if (-not (Test-Path $mjsPath)) {
    Write-Error "Companion script not found: $mjsPath"
    exit 1
}

# ---- Execute ----
node $mjsPath $xmppDir $stateDb $pluginId $pkgObj.name $pkgObj.version $manifestHash $manifest

if ($LASTEXITCODE -ne 0) { throw "Node.js script exited with code $LASTEXITCODE" }

Write-Host "`nSUCCESS! Run 'openclaw gateway' to test."
