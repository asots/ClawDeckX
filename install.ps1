# ==============================================================================
# ClawDeckX - One-Click Installer for Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/ClawDeckX/ClawDeckX/main/install.ps1 | iex
# ==============================================================================

$ErrorActionPreference = "Stop"

Write-Host @"
  ___                  ___ _               ___         _
 / _ \ _ __  ___ _ _  / __| |__ ___ __ __ |   \ ___ __| |__
| (_) | '_ \/ -_) ' \| (__| / ``_ \ V  V / | |) / -_) _| / /
 \___/| .__/\___|_||_|\___|_\__,_|\_/\_/  |___/\___\__|_\_\
      |_|
"@ -ForegroundColor Cyan

$Repo = "ClawDeckX/ClawDeckX"
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host ":: Fetching latest release..." -ForegroundColor Yellow

try {
    $Release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "User-Agent" = "ClawDeckX-Installer" }
    $Version = $Release.tag_name
} catch {
    Write-Host "Error: Failed to fetch release info. Check your internet connection." -ForegroundColor Red
    exit 1
}

Write-Host ":: ClawDeckX Installer - $Version ::" -ForegroundColor Cyan
Write-Host ""

# Detect architecture
$Arch = if ([System.Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$AssetPattern = "clawdeckx-windows-$Arch.exe"

Write-Host "Detected: Windows/$Arch" -ForegroundColor Green

# Find matching asset
$Asset = $Release.assets | Where-Object { $_.name -like "*windows*$Arch*" } | Select-Object -First 1

if (-not $Asset) {
    Write-Host "Error: No release asset found for Windows/$Arch" -ForegroundColor Red
    Write-Host "Please download manually from: https://github.com/$Repo/releases" -ForegroundColor Yellow
    exit 1
}

$DownloadUrl = $Asset.browser_download_url
$FileName = $Asset.name
Write-Host "Found asset: $FileName" -ForegroundColor Green

# Download to user's local bin directory
$InstallDir = "$env:LOCALAPPDATA\ClawDeckX"
$Dest = "$InstallDir\clawdeckx.exe"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

Write-Host "Downloading to $Dest ..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $DownloadUrl -OutFile $Dest -UseBasicParsing
Write-Host "Download complete!" -ForegroundColor Green

# Add to PATH if not already there
$UserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to PATH" -ForegroundColor Green
    Write-Host "(Restart your terminal for PATH changes to take effect)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  ClawDeckX $Version installed successfully!" -ForegroundColor Green
Write-Host "  Run: clawdeckx.exe" -ForegroundColor Green
Write-Host "  Or find it at: $Dest" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
