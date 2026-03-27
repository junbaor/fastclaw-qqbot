# FastClaw QQ Bot Plugin Installer (Windows)
# Usage:
#   首次安装: .\install.ps1 -Token "appId:clientSecret"
#   升级:     .\install.ps1

param(
    [string]$Token = $env:QQBOT_TOKEN,
    [string]$AppId,
    [string]$Secret
)

$ErrorActionPreference = "Stop"

$PLUGIN_ID = "qqbot"
$FASTCLAW_HOME = Join-Path $env:USERPROFILE ".fastclaw"
$PLUGIN_DIR = Join-Path $FASTCLAW_HOME "plugins\$PLUGIN_ID"
$GITHUB_REPO = "junbaor/fastclaw-qqbot"

if ($Token) {
    $parts = $Token -split ":", 2
    $AppId = $parts[0]
    $Secret = $parts[1]
}

# Determine install vs upgrade
$Upgrade = $false
if (-not $AppId -or -not $Secret) {
    if (Test-Path (Join-Path $PLUGIN_DIR "qqbot.exe")) {
        $Upgrade = $true
        Write-Host "==> Upgrading FastClaw QQ Bot Plugin..."
    } else {
        Write-Host "Error: -Token appId:clientSecret is required for first install"
        exit 1
    }
} else {
    Write-Host "==> Installing FastClaw QQ Bot Plugin..."
}

$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
} else {
    Write-Host "Error: 32-bit Windows is not supported"; exit 1
}

Write-Host "==> Platform: windows/$arch"
New-Item -ItemType Directory -Force -Path $PLUGIN_DIR | Out-Null

$downloadBase = "https://github.com/$GITHUB_REPO/releases/latest/download"
$binaryName = "qqbot-windows-$arch.exe"

Write-Host "==> Downloading binary..."
Invoke-WebRequest -Uri "$downloadBase/$binaryName" -OutFile (Join-Path $PLUGIN_DIR "qqbot.exe") -UseBasicParsing

Write-Host "==> Downloading plugin.json..."
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$GITHUB_REPO/master/plugin.json" -OutFile (Join-Path $PLUGIN_DIR "plugin.json") -UseBasicParsing

$pluginJsonPath = Join-Path $PLUGIN_DIR "plugin.json"
$pluginJson = Get-Content $pluginJsonPath -Raw | ConvertFrom-Json
$pluginJson.command = ".\qqbot.exe"
$pluginJson | ConvertTo-Json -Depth 10 | Set-Content $pluginJsonPath -Encoding UTF8

if ($Upgrade) {
    Write-Host ""
    Write-Host "==> Upgrade complete!"
    Write-Host "    Restart fastclaw to activate:  fastclaw daemon restart"
    exit 0
}

Write-Host "==> Configuring fastclaw..."
& (Join-Path $PLUGIN_DIR "qqbot.exe") --setup --appid $AppId --secret $Secret

Write-Host ""
Write-Host "==> Done!"
Write-Host "    Plugin dir: $PLUGIN_DIR"
Write-Host "    AppID:      $AppId"
Write-Host ""
Write-Host "    Restart fastclaw to activate:  fastclaw daemon restart"
Write-Host "    View logs:  Get-Content ~\.fastclaw\logs\qqbot.log -Wait"
Write-Host ""
Write-Host "    IMPORTANT: Make sure your bot has NO webhook callback URL configured"
Write-Host "    on QQ Open Platform, otherwise WebSocket events won't be received."
