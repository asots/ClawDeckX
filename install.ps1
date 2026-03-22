#Requires -Version 5.1
<#
.SYNOPSIS
    ClawDeckX - One-Click Launcher for Windows
.DESCRIPTION
    Install, update, uninstall, and manage ClawDeckX on Windows.
    Equivalent functionality to install.sh for Linux/macOS.
.NOTES
    Run in PowerShell: irm https://raw.githubusercontent.com/ClawDeckX/ClawDeckX/main/install.ps1 | iex
    Or: .\install.ps1
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ==============================================================================
# ClawDeckX - One-Click Launcher (Windows)
# ==============================================================================

# Constants
$BINARY_NAME = "clawdeckx.exe"
$TASK_NAME = "ClawDeckX"
$DEFAULT_PORT = 18788

# Script-level variables
$script:INSTALLED_LOCATION = ""
$script:CURRENT_VERSION = ""
$script:CONFIG_DIR = ""
$script:DATA_DIR = ""
$script:INSTALLED_BINARY = ""
$script:TASK_INSTALLED = $false
$script:SERVICE_RUNNING = $false
$script:PORT = $DEFAULT_PORT

# -- Color helpers -------------------------------------------------------------
function Write-C {
    param([string]$Text, [string]$Color = "White")
    Write-Host $Text -ForegroundColor $Color
}

function Write-Banner {
    Write-Host ""
    Write-Host "  ___ _             ___          _  __  __" -ForegroundColor Blue
    Write-Host " / __| |__ ___ __ _|   \ ___ __| |/ / \ \/ /" -ForegroundColor Blue
    Write-Host "| (__| / _` \ V  V / |) / -_) _| ' <   >  <" -ForegroundColor Blue
    Write-Host " \___|_\__,_|\_/\_/|___/\___|__|_|\_\/_/\_\" -ForegroundColor Blue
    Write-Host ""
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Yellow
    Write-Host "  $Title" -ForegroundColor Yellow
    Write-Host "=======================================================" -ForegroundColor Yellow
    Write-Host ""
}

function Read-YesNo {
    param(
        [string]$Prompt,
        [bool]$DefaultYes = $true
    )
    if ($DefaultYes) {
        $suffix = "[Y/n]"
    } else {
        $suffix = "[y/N]"
    }
    $reply = Read-Host "$Prompt $suffix"
    if ([string]::IsNullOrWhiteSpace($reply)) {
        return $DefaultYes
    }
    return ($reply -match '^[Yy]')
}

function Read-Choice {
    param(
        [string]$Prompt,
        [int]$Min = 1,
        [int]$Max = 4
    )
    $reply = Read-Host "$Prompt"
    if ($reply -match '^\d+$') {
        $val = [int]$reply
        if ($val -ge $Min -and $val -le $Max) { return $val }
    }
    return $Max
}

# -- Check if running as Administrator ----------------------------------------
function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# -- Check if ClawDeckX is installed ------------------------------------------
function Test-Installed {
    $localBinary = Join-Path $PWD $BINARY_NAME
    if (Test-Path $localBinary) {
        $script:INSTALLED_LOCATION = $localBinary
        try {
            $raw = & $localBinary --version 2>$null
            if ($raw -match '(\d+\.\d+\.\d+)') {
                $script:CURRENT_VERSION = $Matches[1]
            } else {
                $script:CURRENT_VERSION = "$raw"
            }
        } catch {
            $script:CURRENT_VERSION = "unknown"
        }
        $dir = Split-Path $localBinary -Parent
        $script:CONFIG_DIR = Join-Path $dir "data"
        $script:DATA_DIR = Join-Path $dir "data"
        return $true
    }
    return $false
}

# -- Scheduled Task management -------------------------------------------------
# NOTE: ClawDeckX is a regular console app, not a native Windows service.
# We use Scheduled Tasks which work with any EXE and don't require admin.

function Test-AutoStartInstalled {
    $script:TASK_INSTALLED = $false
    try {
        $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        if ($task) {
            $script:TASK_INSTALLED = $true
            return $true
        }
    } catch {
        $null = $_
    }
    return $false
}

function Install-AutoStart {
    Write-Section "Install Auto-Start Service / 安装自动启动服务"

    $binaryPath = $script:INSTALLED_BINARY
    if (-not $binaryPath) { $binaryPath = $script:INSTALLED_LOCATION }

    Write-C "Installing Scheduled Task for auto-start on user logon..." Cyan
    Write-C "正在安装计划任务，用户登录时自动启动..." Cyan
    Write-C "Note: ClawDeckX will start automatically when you log in" Yellow
    Write-C "说明：ClawDeckX 将在您登录时自动运行" Yellow
    Write-Host ""
    Install-ScheduledTask $binaryPath
}

function Install-ScheduledTask {
    param([string]$BinaryPath)

    $workDir = Split-Path $BinaryPath -Parent
    $action = New-ScheduledTaskAction -Execute $BinaryPath -WorkingDirectory $workDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

    try {
        Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Description "ClawDeckX - AI Gateway Management Service" -Force | Out-Null
        Write-C "✓ Scheduled Task created / 计划任务已创建" Green
        Write-C "✓ Task will start automatically on user logon / 任务将在用户登录时自动启动" Green
        Write-C "⚠ Task is NOT started yet / 任务尚未启动" Yellow
    } catch {
        Write-C "✗ Could not create Scheduled Task / 无法创建计划任务: $_" Red
    }
}

function Stop-ClawDeckXService {
    Write-Section "Stop ClawDeckX / 停止 ClawDeckX"
    Stop-ClawDeckXProcess
    Write-Host ""
    Write-C "You can now start ClawDeckX manually with: / 现在可以手动启动 ClawDeckX：" Cyan
    Write-C "  .\$BINARY_NAME" Green
}

function Stop-ClawDeckXProcess {
    $procs = Get-Process -Name "clawdeckx" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-C "Killing clawdeckx process... / 正在终止 clawdeckx 进程..." Blue
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    # Also kill any process holding the configured port (e.g. stale node.exe from dev)
    Stop-PortProcess $script:PORT
}

function Stop-PortProcess {
    param([int]$Port)
    try {
        $line = netstat -ano | Select-String ":$Port\s" | Select-Object -First 1
        if ($line) {
            $parts = $line.ToString().Trim() -split '\s+'
            $pid = [int]$parts[-1]
            if ($pid -gt 0) {
                $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-C "Killing process on port ${Port}: $($proc.ProcessName) (PID $pid) / 正在终止占用端口 ${Port} 的进程: $($proc.ProcessName) (PID $pid)" Yellow
                    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Seconds 1
                }
            }
        }
    } catch {
        $null = $_
    }
}

function Start-ClawDeckXService {
    Write-C "Starting ClawDeckX... / 正在启动 ClawDeckX..." Cyan

    $binaryPath = $script:INSTALLED_LOCATION
    if (-not $binaryPath) { $binaryPath = $script:INSTALLED_BINARY }

    # Kill any stale process or port holder to avoid conflict
    if (Test-ProcessRunning) {
        Write-C "Stopping existing instance... / 正在停止已有实例..." Yellow
        Stop-ClawDeckXProcess
        Start-Sleep -Seconds 1
    } else {
        # Process name not found, but port might be held by another process
        Stop-PortProcess $script:PORT
    }

    Write-C "Launching process... / 正在启动进程..." Blue
    try {
        $workDir = Split-Path $binaryPath -Parent
        $errFile = Join-Path $workDir ".clawdeckx-start-err.log"
        $proc = Start-Process -FilePath $binaryPath -WorkingDirectory $workDir -WindowStyle Hidden -RedirectStandardError $errFile -PassThru
        Start-Sleep -Seconds 3
        if (-not $proc.HasExited -and (Test-ProcessRunning)) {
            Write-C "✓ ClawDeckX started successfully / ClawDeckX 启动成功" Green
            Remove-Item $errFile -Force -ErrorAction SilentlyContinue
            return $true
        } else {
            Write-C "⚠ Failed to start ClawDeckX / 启动 ClawDeckX 失败" Yellow
            if (Test-Path $errFile) {
                $errMsg = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
                if ($errMsg) {
                    Write-C "  Error output / 错误输出:" Red
                    Write-C "  $errMsg" Red
                }
                Remove-Item $errFile -Force -ErrorAction SilentlyContinue
            }
            Write-C "  Try running manually to see full output: / 尝试手动运行查看完整输出:" Yellow
            Write-C "  .\$BINARY_NAME" Green
            return $false
        }
    } catch {
        Write-C "⚠ Failed to start ClawDeckX / 启动 ClawDeckX 失败: $_" Yellow
        return $false
    }
}

function Test-ProcessRunning {
    $procs = Get-Process -Name "clawdeckx" -ErrorAction SilentlyContinue
    return ($null -ne $procs)
}

function Stop-AllClawDeckX {
    Write-C "Stopping ClawDeckX... / 正在停止 ClawDeckX..." Cyan
    Stop-ClawDeckXProcess
    Write-C "✓ ClawDeckX stopped / ClawDeckX 已停止" Green
}

# -- Update --------------------------------------------------------------------
function Update-ClawDeckX {
    param([string]$LatestVersion, [string]$Repo)

    Write-Section "Update ClawDeckX / 更新 ClawDeckX"

    Write-C "Current version / 当前版本： $($script:CURRENT_VERSION)" Cyan
    Write-C "Latest version  / 最新版本： $LatestVersion" Cyan
    Write-Host ""

    $arch = Get-Architecture

    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    $assetPattern = "clawdeckx-windows-${arch}.exe"
    $downloadUrl = Get-DownloadUrl $apiUrl $assetPattern

    if (-not $downloadUrl) {
        Write-C "Error: Could not find download URL for windows/$arch" Red
        Write-C "错误：无法找到 windows/$arch 的下载链接" Red
        return
    }

    if ($script:CURRENT_VERSION -eq $LatestVersion) {
        Write-C "✓ Already up to date! / 已经是最新版本！" Green
        Write-Host ""
        if (-not (Read-YesNo "Force re-download? / 强制重新下载?" $false)) {
            return
        }
    } else {
        if (-not (Read-YesNo "Proceed with update? / 确认更新?" $true)) {
            return
        }
    }

    Write-Host ""
    if (Test-ProcessRunning) {
        Write-C "⚠ ClawDeckX is currently running / ClawDeckX 正在运行" Yellow
        Write-C "The program needs to be stopped before updating. / 更新前需要停止程序。" Yellow
        Write-Host ""
        if (-not (Read-YesNo "Stop ClawDeckX now and continue? / 立即停止并继续更新?" $true)) {
            Write-C "Update cancelled. / 更新已取消" Yellow
            return
        }
        Stop-AllClawDeckX
        Start-Sleep -Seconds 2
    }

    Write-Host ""
    Write-C "Downloading update... / 正在下载更新..." Blue

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        Invoke-WebRequest -Uri $downloadUrl -OutFile $script:INSTALLED_LOCATION -UseBasicParsing
        Write-C "✓ Download complete! / 下载完成" Green
    } catch {
        Write-C "✗ Download failed / 下载失败: $_" Red
        return
    }

    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-C "✅ Update complete! / 更新完成！" Green
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host ""

    if (Read-YesNo "Start ClawDeckX now? / 立即启动 ClawDeckX?" $true) {
        $started = Start-ClawDeckXService
        if ($started -and (Test-ProcessRunning)) {
            Write-Host ""
            Write-C "You can access ClawDeckX at: / 可以访问 ClawDeckX：" Cyan
            Write-C "  http://localhost:$($script:PORT)" Green
            Write-Host ""
            if (Test-AutoStartInstalled) { Show-ServiceCommands }
        }
    } else {
        Write-Host ""
        Write-C "You can start it later with: / 稍后可以使用以下命令启动：" Yellow
        Write-C "  .\$BINARY_NAME" Green
        if (Test-AutoStartInstalled) { Show-ServiceCommands }
    }
}

# -- Uninstall -----------------------------------------------------------------
function Uninstall-ClawDeckX {
    Write-Section "Uninstall ClawDeckX / 卸载 ClawDeckX"

    if (-not $script:INSTALLED_LOCATION) {
        Write-C "ClawDeckX is not installed / ClawDeckX 未安装" Red
        return
    }

    Write-C "Found installation / 发现安装： $($script:INSTALLED_LOCATION)" Cyan
    Write-C "Current version / 当前版本：    $($script:CURRENT_VERSION)" Cyan
    Write-Host ""

    Write-C "Choose uninstall mode: / 选择卸载模式：" Yellow
    Write-Host "  1) Quick uninstall (remove everything) / 快速卸载（删除所有）"
    Write-Host "  2) Custom uninstall (select what to remove) / 自定义卸载（选择删除内容）"
    Write-Host ""
    $mode = Read-Choice "Enter your choice / 输入选择 [1-2]:" 1 2

    if ($mode -eq 1) {
        Write-Host ""
        Write-C "Quick uninstall will remove: / 快速卸载将删除：" Cyan
        Write-Host "  - $($script:INSTALLED_LOCATION) (二进制文件)"

        $removeService = $false
        if (Test-AutoStartInstalled) {
            Write-Host "  - ClawDeckX (计划任务)"
            Write-C "    Note: Task will be removed automatically / 说明：任务将自动删除" Yellow
            $removeService = $true
        }

        if (Test-Path $script:CONFIG_DIR) {
            Write-Host "  - $($script:CONFIG_DIR) (配置目录)"
        }
        if ($script:DATA_DIR -ne $script:CONFIG_DIR -and (Test-Path $script:DATA_DIR)) {
            Write-Host "  - $($script:DATA_DIR) (数据目录)"
        }

        Write-Host ""
        if (Read-YesNo "Confirm quick uninstall? / 确认快速卸载?" $false) {
            Invoke-Uninstall -RemoveService $true -RemoveConfig $true -RemoveData $true
        } else {
            Write-C "Uninstall cancelled / 卸载已取消" Yellow
        }
    } else {
        Write-Host ""
        Write-C "Custom uninstall / 自定义卸载" Cyan
        Write-Host ""

        $removeService = $false
        if (Test-AutoStartInstalled) {
            Write-C "Scheduled Task detected / 检测到计划任务: ClawDeckX" Yellow
            Write-C "  Task will be removed during uninstall / 卸载时将删除任务" Cyan
            Write-Host ""
            $removeService = Read-YesNo "Also remove Scheduled Task? / 同时删除计划任务?" $true
        } else {
            Write-C "No auto-start task found / 未发现自动启动任务" Cyan
        }

        $removeConfig = $false
        if (Test-Path $script:CONFIG_DIR) {
            $removeConfig = Read-YesNo "Also remove config directory? / 同时删除配置目录 ($($script:CONFIG_DIR))?" $false
        } else {
            Write-C "No config directory found / 未发现配置目录" Cyan
        }

        $removeData = $false
        if ($script:DATA_DIR -ne $script:CONFIG_DIR -and (Test-Path $script:DATA_DIR)) {
            $removeData = Read-YesNo "Also remove data directory? / 同时删除数据目录 ($($script:DATA_DIR))?" $false
        }

        Write-Host ""
        Write-C "Summary: / 摘要：" Yellow
        Write-Host "  - Binary / 二进制文件: " -NoNewline; Write-C "will be removed / 将被删除" Red
        if ($removeService) {
            Write-Host "  - Scheduled Task / 计划任务: " -NoNewline; Write-C "will be removed / 将被删除" Red
        }
        if ($removeConfig) {
            Write-Host "  - Config / 配置: " -NoNewline; Write-C "will be removed / 将被删除" Red
        }
        if ($removeData) {
            Write-Host "  - Data / 数据: " -NoNewline; Write-C "will be removed / 将被删除" Red
        }

        Write-Host ""
        if (Read-YesNo "Confirm custom uninstall? / 确认自定义卸载?" $false) {
            Invoke-Uninstall -RemoveService $removeService -RemoveConfig $removeConfig -RemoveData $removeData
        } else {
            Write-C "Uninstall cancelled / 卸载已取消" Yellow
        }
    }
}

function Invoke-Uninstall {
    param(
        [bool]$RemoveService,
        [bool]$RemoveConfig,
        [bool]$RemoveData
    )

    if ($RemoveService -and (Test-AutoStartInstalled)) {
        Write-C "Removing Scheduled Task... / 正在删除计划任务..." Blue
        try { Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false } catch { $null = $_ }
        Write-C "✓ Removed Scheduled Task / 计划任务已删除" Green
    }

    Stop-ClawDeckXProcess

    if (Test-Path $script:INSTALLED_LOCATION) {
        Remove-Item -Path $script:INSTALLED_LOCATION -Force
        Write-C "✓ Removed binary / 二进制文件已删除" Green
    }

    if ($RemoveConfig -and $script:CONFIG_DIR -and (Test-Path $script:CONFIG_DIR)) {
        Remove-Item -Path $script:CONFIG_DIR -Recurse -Force
        Write-C "✓ Removed config directory / 配置目录已删除" Green
    }

    if ($RemoveData -and $script:DATA_DIR -and ($script:DATA_DIR -ne $script:CONFIG_DIR) -and (Test-Path $script:DATA_DIR)) {
        Remove-Item -Path $script:DATA_DIR -Recurse -Force
        Write-C "✓ Removed data directory / 数据目录已删除" Green
    }

    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-C "✅ Uninstall complete! / 卸载完成！" Green
    Write-Host "=======================================================" -ForegroundColor Green
}

# -- Helpers -------------------------------------------------------------------
function Get-ConfigPort {
    # Priority: OCD_PORT env > data/ClawDeckX.json server.port > DEFAULT_PORT
    if ($env:OCD_PORT) {
        try {
            $p = [int]$env:OCD_PORT
            if ($p -gt 0 -and $p -le 65535) { return $p }
        } catch { $null = $_ }
    }

    # Try to read from config file
    $configFile = $null
    if ($script:INSTALLED_LOCATION) {
        $configFile = Join-Path (Split-Path $script:INSTALLED_LOCATION -Parent) "data\ClawDeckX.json"
    } elseif ($script:INSTALLED_BINARY) {
        $configFile = Join-Path (Split-Path $script:INSTALLED_BINARY -Parent) "data\ClawDeckX.json"
    } else {
        $configFile = Join-Path $PWD "data\ClawDeckX.json"
    }

    if ($configFile -and (Test-Path $configFile)) {
        try {
            $json = Get-Content $configFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
            if ($json.server -and $json.server.port) {
                $p = [int]$json.server.port
                if ($p -gt 0 -and $p -le 65535) { return $p }
            }
        } catch { $null = $_ }
    }

    return $DEFAULT_PORT
}

function Get-Architecture {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64"   { return "amd64" }
        "x86"     { return "amd64" }
        "ARM64"   { return "arm64" }
        default {
            Write-C "Error: Unsupported architecture / 错误：不支持的架构: $($env:PROCESSOR_ARCHITECTURE)" Red
            exit 1
        }
    }
}

function Get-DownloadUrl {
    param([string]$ApiUrl, [string]$AssetPattern)
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing
        foreach ($asset in $release.assets) {
            if ($asset.name -like "*$AssetPattern*") {
                return $asset.browser_download_url
            }
        }
    } catch {
        Write-C "Warning: Could not fetch release info / 警告：无法获取发布信息: $_" Yellow
    }
    return $null
}

function Get-LatestVersion {
    param([string]$Repo)
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
        $tag = $release.tag_name
        if ($tag) {
            return $tag -replace '^v', ''
        }
    } catch {
        Write-C "Warning: Could not fetch latest version / 警告：无法获取最新版本" Yellow
    }
    return "latest"
}

function Show-ServiceCommands {
    Write-Host ""
    Write-C "Management commands / 管理命令：" Yellow
    Write-C "  .\$BINARY_NAME                                      - Start manually / 手动启动" Green
    Write-C "  Get-Process clawdeckx                               - Check if running / 检查运行状态" Green
    Write-C "  Stop-Process -Name clawdeckx -Force                 - Stop / 停止" Green
    Write-C "  Get-ScheduledTask -TaskName ClawDeckX               - Check auto-start / 检查自动启动" Green
    Write-C "  Unregister-ScheduledTask -TaskName ClawDeckX        - Remove auto-start / 删除自动启动" Green
}

# ==============================================================================
# Docker Mode Functions
# ==============================================================================

$DOCKER_COMPOSE_URL = "https://raw.githubusercontent.com/ClawDeckX/ClawDeckX/main/docker-compose.yml"
$DOCKER_COMPOSE_URL_CN = "https://ghfast.top/https://raw.githubusercontent.com/ClawDeckX/ClawDeckX/main/docker-compose.yml"
$DOCKER_IMAGE = "knowhunters/clawdeckx:latest"
$DOCKER_COMPOSE_FILE = "docker-compose.yml"
$script:NEED_MIRROR = $false
$script:DOCKER_MIRROR = ""

function Invoke-DownloadWithFallback {
    param([string]$Url, [string]$CnUrl, [string]$OutFile)
    if ($script:NEED_MIRROR -and $CnUrl) {
        Write-C "Using China proxy... / 使用中国代理..." Cyan
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
            Invoke-WebRequest -Uri $CnUrl -OutFile $OutFile -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            return
        } catch {
            Write-C "China proxy failed, trying direct... / 中国代理失败，尝试直连..." Yellow
        }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 60
}

# Docker registry mirrors for China mainland
$DOCKER_MIRRORS = @(
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
)

function Test-NetworkDirect {
    # Returns $true if direct access works, $false if mirror is needed
    try {
        $null = Invoke-WebRequest -Uri "https://registry-1.docker.io/v2/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return $true
    } catch { $null = $_ }
    try {
        $null = Invoke-WebRequest -Uri "https://www.google.com" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return $true
    } catch { $null = $_ }
    return $false
}

function Set-DockerMirror {
    # On Windows, Docker Desktop uses a settings JSON file or daemon.json
    $daemonJson = "$env:ProgramData\docker\config\daemon.json"
    $daemonDir = Split-Path $daemonJson -Parent

    Write-C "Configuring Docker registry mirrors for faster pulls..." Cyan
    Write-C "正在配置 Docker 镜像加速器以加快拉取速度..." Cyan

    $mirrorsArray = $DOCKER_MIRRORS | ForEach-Object { $_ }

    if (-not (Test-Path $daemonDir)) {
        New-Item -ItemType Directory -Path $daemonDir -Force | Out-Null
    }

    if (Test-Path $daemonJson) {
        $existing = Get-Content $daemonJson -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($existing -and $existing."registry-mirrors") {
            Write-C "Docker mirrors already configured in $daemonJson" Yellow
            Write-C "$daemonJson 中已配置镜像加速器" Yellow
            return
        }
    }

    try {
        $config = @{}
        if (Test-Path $daemonJson) {
            $config = Get-Content $daemonJson -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
            if (-not $config) { $config = @{} }
            # Convert PSObject to hashtable
            $ht = @{}
            $config.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
            $config = $ht
        }
        $config["registry-mirrors"] = $mirrorsArray
        $config | ConvertTo-Json -Depth 5 | Set-Content -Path $daemonJson -Encoding UTF8
        Write-C "✓ Docker registry mirrors configured / Docker 镜像加速器已配置" Green
        foreach ($m in $DOCKER_MIRRORS) {
            Write-C "  $m" Cyan
        }
        Write-C "⚠ Please restart Docker Desktop for mirrors to take effect." Yellow
        Write-C "  请重启 Docker Desktop 以使镜像加速器生效。" Yellow
    } catch {
        Write-C "⚠ Could not configure Docker mirrors automatically: $_" Yellow
        Write-C "  无法自动配置镜像加速器。请手动在 Docker Desktop Settings > Docker Engine 中添加：" Yellow
        Write-C "  `"registry-mirrors`": [`"$($DOCKER_MIRRORS[0])`"]" Cyan
    }
}

function Set-ImageMirror {
    param([string]$ComposeFile)
    if (-not $script:NEED_MIRROR -or -not $script:DOCKER_MIRROR) { return }
    $mirrorHost = $script:DOCKER_MIRROR -replace 'https?://', ''
    $originalImage = "knowhunters/clawdeckx"
    $mirroredImage = "$mirrorHost/$originalImage"
    $content = Get-Content $ComposeFile -Raw
    if ($content -match [regex]::Escape($mirroredImage)) { return }
    $content = $content -replace [regex]::Escape("image: $originalImage"), "image: $mirroredImage"
    Set-Content -Path $ComposeFile -Value $content -NoNewline
    Write-C "✓ Using mirror for image pull / 使用镜像加速拉取： $mirroredImage" Green
}

function Test-DockerInstalled {
    try {
        $null = & docker info 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-DockerCompose {
    try {
        $null = & docker compose version 2>$null
        if ($LASTEXITCODE -eq 0) {
            $script:COMPOSE_CMD = "docker compose"
            return $true
        }
    } catch { $null = $_ }
    try {
        $null = & docker-compose version 2>$null
        if ($LASTEXITCODE -eq 0) {
            $script:COMPOSE_CMD = "docker-compose"
            return $true
        }
    } catch { $null = $_ }
    return $false
}

function Test-DockerDeployed {
    if ((Test-Path $DOCKER_COMPOSE_FILE) -and (Test-DockerInstalled) -and (Test-DockerCompose)) {
        $content = Get-Content $DOCKER_COMPOSE_FILE -Raw -ErrorAction SilentlyContinue
        if ($content -match "knowhunters/clawdeckx") { return $true }
    }
    return $false
}

function Get-DockerVersion {
    try {
        $ver = & docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' clawdeckx 2>$null
        if ($ver -and $ver -ne "<no value>") { return $ver }
    } catch { $null = $_ }
    return "unknown"
}

function Test-DockerRunning {
    try {
        $out = & docker ps --filter "name=clawdeckx" --filter "status=running" --format '{{.Names}}' 2>$null
        return ($out -match "clawdeckx")
    } catch { return $false }
}

function Get-ComposePort {
    if (Test-Path $DOCKER_COMPOSE_FILE) {
        $content = Get-Content $DOCKER_COMPOSE_FILE -Raw -ErrorAction SilentlyContinue
        if ($content -match '"(\d+):18788"') {
            return [int]$Matches[1]
        }
    }
    return $DEFAULT_PORT
}

function Invoke-ComposeCmd {
    param([string[]]$Args)
    if ($script:COMPOSE_CMD -eq "docker compose") {
        & docker compose @Args
    } else {
        & docker-compose @Args
    }
}

function Install-Docker {
    Write-Section "Install Docker / 安装 Docker"

    Write-C "Docker Desktop is not installed or not running." Yellow
    Write-C "Docker Desktop 未安装或未运行。" Yellow
    Write-Host ""
    Write-C "Please install Docker Desktop for Windows from:" Cyan
    Write-C "请从以下地址安装 Docker Desktop：" Cyan
    Write-C "  https://www.docker.com/products/docker-desktop/" Green
    Write-Host ""
    Write-C "After installation, start Docker Desktop and re-run this script." Yellow
    Write-C "安装完成后，启动 Docker Desktop 并重新运行此脚本。" Yellow
    Write-Host ""

    $openBrowser = Read-YesNo "Open download page now? / 现在打开下载页面？" $true
    if ($openBrowser) {
        Start-Process "https://www.docker.com/products/docker-desktop/"
    }
    return $false
}

function Install-DockerClawDeckX {
    Write-Section "Install ClawDeckX (Docker) / 安装 ClawDeckX (Docker)"

    # Step 0: Detect network early (needed for Docker Desktop guidance + image pull mirror)
    Write-C "Checking network connectivity... / 正在检测网络连通性..." Cyan
    if (-not (Test-NetworkDirect)) {
        $script:NEED_MIRROR = $true
        $script:DOCKER_MIRROR = $DOCKER_MIRRORS[0]
        Write-C "⚠ Docker Hub appears unreachable (likely China mainland network)" Yellow
        Write-C "  Docker Hub 似乎不可访问（可能为中国大陆网络）" Yellow
    } else {
        Write-C "✓ Direct network access OK / 网络直连正常" Green
    }
    Write-Host ""

    # Step 1: Ensure Docker is installed
    if (-not (Test-DockerInstalled)) {
        $null = Install-Docker
        return
    }

    # Step 2: Ensure docker compose is available
    if (-not (Test-DockerCompose)) {
        Write-C "✗ docker compose not found / 未找到 docker compose" Red
        Write-C "Please update Docker Desktop to a recent version." Yellow
        return
    }

    Write-C "✓ Docker is ready / Docker 已就绪" Green
    Write-C "✓ Compose: $($script:COMPOSE_CMD)" Green
    Write-Host ""

    # Step 2.5: Configure Docker daemon mirrors if needed (requires Docker to be installed)
    if ($script:NEED_MIRROR) {
        Set-DockerMirror
        Write-Host ""
    }

    # Step 3: Download docker-compose.yml
    if (Test-Path $DOCKER_COMPOSE_FILE) {
        Write-C "docker-compose.yml already exists in current directory." Yellow
        Write-C "当前目录已存在 docker-compose.yml" Yellow
        if (-not (Read-YesNo "Overwrite? / 覆盖？" $false)) {
            Write-C "Using existing docker-compose.yml / 使用现有 docker-compose.yml" Cyan
        } else {
            Write-C "Downloading docker-compose.yml... / 正在下载 docker-compose.yml..." Cyan
            Invoke-DownloadWithFallback $DOCKER_COMPOSE_URL $DOCKER_COMPOSE_URL_CN $DOCKER_COMPOSE_FILE
            Write-C "✓ Downloaded / 已下载" Green
        }
    } else {
        Write-C "Downloading docker-compose.yml... / 正在下载 docker-compose.yml..." Cyan
        Invoke-DownloadWithFallback $DOCKER_COMPOSE_URL $DOCKER_COMPOSE_URL_CN $DOCKER_COMPOSE_FILE
        Write-C "✓ Downloaded / 已下载" Green
    }

    # Step 4: Optional port configuration
    Write-Host ""
    Write-C "Default port / 默认端口: $DEFAULT_PORT" Cyan
    if (Read-YesNo "Use a different port? / 使用其他端口？" $false) {
        $customPort = Read-Host "Enter port / 输入端口"
        try {
            $p = [int]$customPort
            if ($p -gt 0 -and $p -le 65535) {
                $content = Get-Content $DOCKER_COMPOSE_FILE -Raw
                $content = $content -replace "`"${DEFAULT_PORT}:${DEFAULT_PORT}`"", "`"${p}:${DEFAULT_PORT}`""
                Set-Content -Path $DOCKER_COMPOSE_FILE -Value $content -NoNewline
                $script:PORT = $p
                Write-C "✓ Port set to $p / 端口已设置为 $p" Green
            } else {
                Write-C "Invalid port, using default $DEFAULT_PORT / 端口无效，使用默认 $DEFAULT_PORT" Yellow
            }
        } catch {
            Write-C "Invalid port, using default $DEFAULT_PORT / 端口无效，使用默认 $DEFAULT_PORT" Yellow
        }
    }

    # Step 5: Apply image mirror if needed, then pull and start
    Set-ImageMirror $DOCKER_COMPOSE_FILE

    Write-Host ""
    Write-C "Pulling Docker image... / 正在拉取 Docker 镜像..." Blue
    Invoke-ComposeCmd @("pull")

    Write-Host ""
    Write-C "Starting ClawDeckX container... / 正在启动 ClawDeckX 容器..." Blue
    Invoke-ComposeCmd @("up", "-d")

    # Step 6: Wait for health check
    Write-Host ""
    Write-C "Waiting for ClawDeckX to become ready... / 等待 ClawDeckX 就绪..." Cyan
    $maxWait = 60
    $waited = 0
    while ($waited -lt $maxWait) {
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:$($script:PORT)/api/v1/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            break
        } catch { $null = $_ }
        Start-Sleep -Seconds 2
        $waited += 2
        Write-Host "." -NoNewline
    }
    Write-Host ""

    if ($waited -ge $maxWait) {
        Write-C "⚠ ClawDeckX is still starting. Check with: docker compose ps" Yellow
    } else {
        Write-C "✓ ClawDeckX is ready! / ClawDeckX 已就绪！" Green
    }

    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-C "✅ Docker installation complete! / Docker 安装完成！" Green
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host ""
    Write-C "Access ClawDeckX at / 访问 ClawDeckX：" Cyan
    Write-C "  http://localhost:$($script:PORT)" Green
    Write-Host ""
    Write-C "🔐 First-time login / 首次登录：" Yellow
    Write-Host "  View initial admin credentials in container logs:"
    Write-Host "  查看容器日志中的初始管理员账户信息："
    Write-C "  $COMPOSE_CMD logs | Select-String 'Password'" Green
    Write-Host ""
    Show-DockerCommands
}

function Update-DockerClawDeckX {
    Write-Section "Update ClawDeckX (Docker) / 更新 ClawDeckX (Docker)"

    $currentVer = Get-DockerVersion
    Write-C "Current image version / 当前镜像版本： $currentVer" Cyan
    Write-C "Will pull / 将拉取： $DOCKER_IMAGE" Cyan
    Write-Host ""

    if (-not (Read-YesNo "Proceed with update? / 确认更新？" $true)) {
        Write-C "Update cancelled / 更新已取消" Yellow
        return
    }

    # Detect network and configure mirrors if needed
    Write-Host ""
    Write-C "Checking network connectivity... / 正在检测网络连通性..." Cyan
    if (-not (Test-NetworkDirect)) {
        $script:NEED_MIRROR = $true
        $script:DOCKER_MIRROR = $DOCKER_MIRRORS[0]
        Write-C "⚠ Docker Hub appears unreachable — using mirrors" Yellow
        Write-C "  Docker Hub 不可访问 — 使用镜像加速器" Yellow
        Set-DockerMirror
        Set-ImageMirror $DOCKER_COMPOSE_FILE
    } else {
        Write-C "✓ Direct network access OK / 网络直连正常" Green
    }

    Write-Host ""
    Write-C "Pulling latest image... / 正在拉取最新镜像..." Blue
    Invoke-ComposeCmd @("pull")

    Write-Host ""
    Write-C "Recreating container with new image... / 正在用新镜像重建容器..." Blue
    Invoke-ComposeCmd @("up", "-d")

    # Wait for health check
    Write-Host ""
    Write-C "Waiting for ClawDeckX to become ready... / 等待 ClawDeckX 就绪..." Cyan
    $maxWait = 60
    $waited = 0
    while ($waited -lt $maxWait) {
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:$($script:PORT)/api/v1/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            break
        } catch { $null = $_ }
        Start-Sleep -Seconds 2
        $waited += 2
        Write-Host "." -NoNewline
    }
    Write-Host ""

    $newVer = Get-DockerVersion

    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-C "✅ Docker update complete! / Docker 更新完成！" Green
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host ""
    Write-C "Previous version / 旧版本： $currentVer" Cyan
    Write-C "Current version  / 新版本： $newVer" Cyan
    Write-C "Access at / 访问： http://localhost:$($script:PORT)" Cyan
}

function Uninstall-DockerClawDeckX {
    Write-Section "Uninstall ClawDeckX (Docker) / 卸载 ClawDeckX (Docker)"

    Write-C "This will: / 将执行：" Cyan
    Write-Host "  - Stop and remove the ClawDeckX container / 停止并删除 ClawDeckX 容器"
    Write-Host ""

    $removeVolumes = Read-YesNo "Also remove data volumes? / 同时删除数据卷？" $false
    $removeImage = Read-YesNo "Also remove Docker image? / 同时删除 Docker 镜像？" $false
    $removeCompose = Read-YesNo "Also remove docker-compose.yml? / 同时删除 docker-compose.yml？" $false

    Write-Host ""
    if (-not (Read-YesNo "Confirm uninstall? / 确认卸载？" $false)) {
        Write-C "Uninstall cancelled / 卸载已取消" Yellow
        return
    }

    Write-Host ""
    Write-C "Stopping and removing container... / 正在停止并删除容器..." Blue
    if ($removeVolumes) {
        Invoke-ComposeCmd @("down", "-v")
        Write-C "✓ Container and volumes removed / 容器和数据卷已删除" Green
    } else {
        Invoke-ComposeCmd @("down")
        Write-C "✓ Container removed (volumes preserved) / 容器已删除（数据卷已保留）" Green
    }

    if ($removeImage) {
        Write-C "Removing Docker image... / 正在删除 Docker 镜像..." Blue
        # Remove both original and any mirrored image names
        & docker rmi $DOCKER_IMAGE 2>$null
        foreach ($m in $DOCKER_MIRRORS) {
            $mhost = $m -replace 'https?://', ''
            & docker rmi "${mhost}/knowhunters/clawdeckx:latest" 2>$null
        }
        Write-C "✓ Image removed / 镜像已删除" Green
    }

    if ($removeCompose) {
        Remove-Item -Path $DOCKER_COMPOSE_FILE -Force -ErrorAction SilentlyContinue
        Write-C "✓ docker-compose.yml removed / docker-compose.yml 已删除" Green
    }

    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-C "✅ Docker uninstall complete! / Docker 卸载完成！" Green
    Write-Host "=======================================================" -ForegroundColor Green
}

function Show-DockerCommands {
    Write-C "Docker management commands / Docker 管理命令：" Yellow
    Write-C "  docker compose ps              - Status / 状态" Green
    Write-C "  docker compose logs --tail 50  - Logs / 日志" Green
    Write-C "  docker compose restart         - Restart / 重启" Green
    Write-C "  docker compose stop            - Stop / 停止" Green
    Write-C "  docker compose down            - Remove container / 删除容器" Green
}

function Show-DockerManagementMenu {
    if (-not (Test-DockerCompose)) {
        Write-C "docker compose not available" Red
        return
    }

    $dockerVer = Get-DockerVersion
    $isRunning = Test-DockerRunning
    $script:PORT = Get-ComposePort

    Write-C "✓ ClawDeckX Docker deployment detected / 检测到 ClawDeckX Docker 部署" Green
    Write-C "Image version / 镜像版本： $dockerVer" Cyan
    Write-C "Port / 端口：            $($script:PORT)" Cyan
    if ($isRunning) {
        Write-C "Status / 状态：          Running / 运行中" Green
    } else {
        Write-C "Status / 状态：          Stopped / 已停止" Yellow
    }
    Write-Host ""

    Write-C "What would you like to do? / 您想做什么？" Yellow
    Write-Host "  1) Update / 更新"
    if ($isRunning) {
        Write-Host "  2) Stop / 停止"
    } else {
        Write-Host "  2) Start / 启动"
    }
    Write-Host "  3) Restart / 重启"
    Write-Host "  4) Logs / 查看日志"
    Write-Host "  5) Status / 查看状态"
    Write-Host "  6) Uninstall / 卸载"
    Write-Host "  7) Exit / 退出"
    Write-Host ""

    $choice = Read-Choice "Enter your choice / 输入选择 [1-7]:" 1 7

    switch ($choice) {
        1 { Update-DockerClawDeckX }
        2 {
            if ($isRunning) {
                Write-Host ""
                Write-C "Stopping ClawDeckX container... / 正在停止 ClawDeckX 容器..." Blue
                Invoke-ComposeCmd @("stop")
                Write-C "✓ Stopped / 已停止" Green
            } else {
                Write-Host ""
                Write-C "Starting ClawDeckX container... / 正在启动 ClawDeckX 容器..." Blue
                Invoke-ComposeCmd @("up", "-d")
                Start-Sleep -Seconds 2
                Write-C "✓ Started / 已启动" Green
                Write-C "Access at / 访问： http://localhost:$($script:PORT)" Cyan
            }
        }
        3 {
            Write-Host ""
            Write-C "Restarting ClawDeckX container... / 正在重启 ClawDeckX 容器..." Blue
            Invoke-ComposeCmd @("restart")
            Write-C "✓ Restarted / 已重启" Green
        }
        4 {
            Write-Host ""
            Write-C "Recent logs / 最近日志：" Cyan
            Write-Host "────────────────────────────────────────"
            Invoke-ComposeCmd @("logs", "--tail", "50")
            Write-Host "────────────────────────────────────────"
        }
        5 {
            Write-Host ""
            Invoke-ComposeCmd @("ps")
            Write-Host ""
            if (Test-DockerRunning) {
                Write-C "✓ ClawDeckX is running / ClawDeckX 运行中" Green
                Write-C "Access at / 访问： http://localhost:$($script:PORT)" Cyan
            } else {
                Write-C "ClawDeckX is not running / ClawDeckX 未运行" Yellow
            }
        }
        6 { Uninstall-DockerClawDeckX }
        default { Write-C "Exiting / 退出" Yellow }
    }
}

# ==============================================================================
# MAIN
# ==============================================================================

Write-Banner

$REPO = "ClawDeckX/ClawDeckX"
$LATEST_VERSION = Get-LatestVersion $REPO

Write-C ":: ClawDeckX Launcher - $LATEST_VERSION ::" Cyan
Write-Host ""

# -- Priority check: Docker deployment exists? ---------------------------------
if (Test-DockerDeployed) {
    Show-DockerManagementMenu
    return
}

# -- Already installed? --------------------------------------------------------
if (Test-Installed) {
    # Resolve port from config file
    $script:PORT = Get-ConfigPort

    Write-C "✓ ClawDeckX is already installed / ClawDeckX 已安装" Green
    Write-C "Location / 位置：        $($script:INSTALLED_LOCATION)" Cyan
    Write-C "Current version / 当前版本： $($script:CURRENT_VERSION)" Cyan
    Write-C "Latest version / 最新版本：  $LATEST_VERSION" Cyan
    Write-C "Port / 端口：            $($script:PORT)" Cyan

    $script:SERVICE_RUNNING = $false
    if (Test-AutoStartInstalled) {
        Write-C "Auto-start / 自动启动：      Installed / 已安装 (计划任务)" Cyan
    }
    if (Test-ProcessRunning) {
        $script:SERVICE_RUNNING = $true
        Write-C "Status / 状态：          Running / 运行中" Green
    } else {
        Write-C "Status / 状态：          Stopped / 已停止" Yellow
    }

    Write-Host ""

    $isLatest = ($script:CURRENT_VERSION -eq $LATEST_VERSION)

    if ($isLatest) {
        Write-C "✓ Already up to date! / 已是最新版本！" Green
        Write-Host ""
        Write-C "What would you like to do? / 您想做什么?" Yellow
        Write-Host "  1) Re-download current version / 重新下载当前版本"
    } else {
        Write-C "New version available! / 有新版本可用！" Yellow
        Write-Host ""
        Write-C "What would you like to do? / 您想做什么?" Yellow
        Write-Host "  1) Update to latest version / 更新到最新版本"
    }

    $hasAutoStart = Test-AutoStartInstalled
    if ($script:SERVICE_RUNNING) {
        Write-Host "  2) Stop ClawDeckX / 停止 ClawDeckX"
        Write-Host "  3) Uninstall / 卸载"
        Write-Host "  4) Exit / 退出"
    } elseif ($hasAutoStart) {
        Write-Host "  2) Start ClawDeckX / 启动 ClawDeckX"
        Write-Host "  3) Uninstall / 卸载"
        Write-Host "  4) Exit / 退出"
    } else {
        Write-Host "  2) Uninstall / 卸载"
        Write-Host "  3) Exit / 退出"
    }

    Write-Host ""
    $choice = Read-Choice "Enter your choice / 输入选择 [1-4]:" 1 4

    switch ($choice) {
        1 {
            Update-ClawDeckX -LatestVersion $LATEST_VERSION -Repo $REPO
            return
        }
        2 {
            if ($script:SERVICE_RUNNING) {
                Stop-ClawDeckXService
                return
            } elseif ($hasAutoStart) {
                Write-Host ""
                $null = Start-ClawDeckXService
                if (Test-ProcessRunning) {
                    Write-Host ""
                    Write-C "You can access ClawDeckX at: / 可以访问 ClawDeckX：" Cyan
                    Write-C "  http://localhost:$($script:PORT)" Green
                    Write-Host ""
                    Show-ServiceCommands
                }
                return
            } else {
                Uninstall-ClawDeckX
                return
            }
        }
        3 {
            if ($script:SERVICE_RUNNING -or $hasAutoStart) {
                Uninstall-ClawDeckX
            } else {
                Write-C "Exiting / 退出" Yellow
            }
            return
        }
        default {
            Write-C "Exiting / 退出" Yellow
            return
        }
    }
}

# -- Fresh install -------------------------------------------------------------

# Offer installation mode choice (Binary vs Docker)
Write-C "Choose installation mode / 选择安装模式：" Yellow
Write-Host "  1) Binary - Direct binary install / 直接安装二进制文件"
Write-Host "  2) Docker - Run in Docker container / 在 Docker 容器中运行"
Write-Host ""
$installMode = Read-Choice "Enter your choice / 输入选择 [1-2]:" 1 2
if ($installMode -eq 2) {
    Install-DockerClawDeckX
    return
}
Write-Host ""

$arch = Get-Architecture
Write-C "✓ Detected System / 检测到系统: windows/$arch" Green

Write-C "Fetching latest release info... / 正在获取最新版本信息... ($LATEST_VERSION)" Yellow

$apiUrl = "https://api.github.com/repos/$REPO/releases/latest"
$assetPattern = "clawdeckx-windows-${arch}.exe"
$downloadUrl = Get-DownloadUrl $apiUrl $assetPattern

if (-not $downloadUrl) {
    Write-C "Error: Could not find a release asset for windows/$arch" Red
    Write-C "错误：无法找到 windows/$arch 的发布资源" Red
    Write-Host "This might be because: / 可能的原因："
    Write-Host "1. No release has been published yet. / 尚未发布任何版本。"
    Write-Host "2. The asset naming does not match. / 资源文件名不匹配。"
    return
}

Write-C "✓ Found asset / 找到资源: $downloadUrl" Green

$script:INSTALLED_BINARY = Join-Path $PWD $BINARY_NAME
Write-C "Downloading $BINARY_NAME ... / 正在下载 $BINARY_NAME ..." Yellow

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    Invoke-WebRequest -Uri $downloadUrl -OutFile $script:INSTALLED_BINARY -UseBasicParsing
    Write-C "✓ Download complete! / 下载完成" Green
} catch {
    Write-C "✗ Download failed / 下载失败: $_" Red
    return
}

Write-Host ""
Write-C "Installing to current directory / 正在安装到当前目录 ($PWD) ..." Blue
Write-C "✓ Installed / 已安装: $($script:INSTALLED_BINARY)" Green

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Green
Write-C "✅ Installation complete! / 安装完成！" Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host ""
Write-C "Binary location / 二进制文件位置：        $($script:INSTALLED_BINARY)" Cyan
Write-C "Config & Data directory / 配置和数据目录： $(Join-Path (Split-Path $script:INSTALLED_BINARY -Parent) 'data')" Cyan
Write-Host ""
Write-C "✓ Installed in current directory / 已安装在当前目录" Green
Write-Host ""

# Resolve port (config may not exist yet on fresh install, will use default)
$script:PORT = Get-ConfigPort

# Ask if user wants to install auto-start service
$serviceJustInstalled = $false
if (-not (Test-AutoStartInstalled)) {
    Write-C "Would you like to install auto-start service?" Yellow
    Write-C "是否安装自动启动服务?（系统重启后自动运行）" Yellow
    if (Read-YesNo "Install auto-start service? / 安装自动启动服务?" $true) {
        Install-AutoStart
        $serviceJustInstalled = $true
    }
}

# Ask if user wants to start now
if ($serviceJustInstalled) {
    Write-Host ""
    Write-C "Note: Service is installed but NOT started." Cyan
    Write-C "说明：服务已安装但未启动。" Cyan
    Write-Host ""
}

if (Read-YesNo "Start ClawDeckX now? / 立即启动 ClawDeckX?" $true) {
    Write-C ">> Starting ClawDeckX... / 正在启动 ClawDeckX..." Blue
    Write-Host "----------------------------------------"
    Write-Host ""
    Write-C "First run: running in foreground so you can see initialization output." Cyan
    Write-C "首次运行：前台启动以便您查看初始化输出（用户名、密码等）" Cyan
    Write-C "Press Ctrl+C to stop. / 按 Ctrl+C 停止。" Yellow
    Write-Host "----------------------------------------"
    Write-Host ""

    $binaryPath = $script:INSTALLED_BINARY
    if (-not $binaryPath) { $binaryPath = $script:INSTALLED_LOCATION }
    & $binaryPath $args
} else {
    Write-Host ""
    Write-C "You can start it later with: / 稍后可以使用以下命令启动：" Yellow
    Write-C "  .\$BINARY_NAME" Green
    Show-ServiceCommands
}