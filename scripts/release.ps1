param(
    [Parameter(Position=0)]
    [string]$Version,

    [Parameter(Position=1)]
    [Alias("r")]
    [switch]$Replace,

    [Parameter()]
    [switch]$Clean,

    [Parameter()]
    [Alias("d")]
    [switch]$NoDocker
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# ── Smart Changelog Generation ──

function Get-PreviousTag {
    param([string]$ExcludeTag = $null)

    $tags = git tag --sort=-v:refname 2>$null | Where-Object {
        $_ -match '^v\d+\.\d+\.\d+$' -and ($_ -ne $ExcludeTag)
    }
    if ($tags -and $tags.Count -gt 0) {
        return $tags[0]
    }
    return $null
}

function Classify-Commit {
    param([string]$Message)

    $msg = $Message.ToLower()

    # Strip conventional commit prefix for classification
    $prefixMatch = [regex]::Match($Message, '^(feat|fix|perf|style|i18n|refactor|docs|test|build|ci|chore)(\([^)]*\))?:\s*')

    if ($prefixMatch.Success) {
        $type = $prefixMatch.Groups[1].Value
        switch ($type) {
            'feat'     { return 'feat' }
            'fix'      { return 'fix' }
            'perf'     { return 'perf' }
            'style'    { return 'style' }
            'i18n'     { return 'i18n' }
            'refactor' { return 'refactor' }
            'docs'     { return 'docs' }
            'test'     { return 'test' }
            'build'    { return 'build' }
            'ci'       { return 'build' }
            'chore'    {
                if ($msg -match 'release') { return 'release' }
                return 'chore'
            }
        }
    }

    # Fuzzy keyword matching (Chinese + English)
    if ($msg -match '修复|fix|bug|repair|patch|resolve') { return 'fix' }
    if ($msg -match '新增|添加|feat|add[^r]|支持|implement|新功能') { return 'feat' }
    if ($msg -match '美化|style|ui|theme|css|样式|主题|界面') { return 'style' }
    if ($msg -match 'i18n|locale|翻译|translate|国际化|多语言') { return 'i18n' }
    if ($msg -match '优化|perf|speed|cache|性能|加速') { return 'perf' }
    if ($msg -match '文档|doc|readme') { return 'docs' }
    if ($msg -match '重构|refactor') { return 'refactor' }
    if ($msg -match '构建|build|docker|ci|deploy|dockerfile|部署') { return 'build' }
    if ($msg -match 'release|版本|发版|bump') { return 'release' }
    if ($msg -match 'test|测试') { return 'test' }

    return 'chore'
}

function Generate-Changelog {
    param(
        [string]$NewTag,
        [string]$ExcludeTag = $null
    )

    $prevTag = Get-PreviousTag -ExcludeTag $ExcludeTag
    if ($prevTag) {
        $range = "$prevTag..HEAD"
        $compareUrl = "$(git remote get-url origin 2>$null)".TrimEnd('.git')
        $compareUrl = $compareUrl -replace 'git@github\.com:', 'https://github.com/'
        $fullChangelogLink = "**Full Changelog**: [$prevTag...$NewTag]($compareUrl/compare/$prevTag...$NewTag)"
    } else {
        $range = "HEAD"
        $fullChangelogLink = ""
    }

    # Get commits (skip merge commits)
    $commits = git log $range --no-merges --pretty=format:"%s" 2>$null
    if (-not $commits) {
        return "自上次发布以来无变更。`n"
    }

    # Categorize
    $categories = @{
        'feat'     = [System.Collections.ArrayList]@()
        'fix'      = [System.Collections.ArrayList]@()
        'perf'     = [System.Collections.ArrayList]@()
        'style'    = [System.Collections.ArrayList]@()
        'i18n'     = [System.Collections.ArrayList]@()
        'refactor' = [System.Collections.ArrayList]@()
        'build'    = [System.Collections.ArrayList]@()
        'docs'     = [System.Collections.ArrayList]@()
        'test'     = [System.Collections.ArrayList]@()
        'chore'    = [System.Collections.ArrayList]@()
        'release'  = [System.Collections.ArrayList]@()
    }

    foreach ($commit in $commits) {
        $msg = $commit.Trim()
        if (-not $msg) { continue }

        $cat = Classify-Commit $msg

        # Clean up message: strip conventional prefix for cleaner display
        $displayMsg = $msg -replace '^(feat|fix|perf|style|i18n|refactor|docs|test|build|ci|chore)(\([^)]*\))?:\s*', ''
        if (-not $displayMsg) { $displayMsg = $msg }

        [void]$categories[$cat].Add($displayMsg)
    }

    # Build markdown
    $categoryMeta = [ordered]@{
        'feat'     = @{ emoji = '✨'; title = 'New Features / 新功能' }
        'fix'      = @{ emoji = '🐛'; title = 'Bug Fixes / 修复' }
        'perf'     = @{ emoji = '⚡'; title = 'Performance / 性能优化' }
        'style'    = @{ emoji = '🎨'; title = 'UI & Styling / 界面优化' }
        'i18n'     = @{ emoji = '🌐'; title = 'Internationalization / 国际化' }
        'refactor' = @{ emoji = '♻️'; title = 'Refactoring / 重构' }
        'build'    = @{ emoji = '📦'; title = 'Build & Deploy / 构建部署' }
        'docs'     = @{ emoji = '📝'; title = 'Documentation / 文档' }
        'test'     = @{ emoji = '✅'; title = 'Tests / 测试' }
        'chore'    = @{ emoji = '🔧'; title = 'Maintenance / 维护' }
    }

    $lines = [System.Collections.ArrayList]@()
    [void]$lines.Add("## What's Changed`n")

    foreach ($catKey in $categoryMeta.Keys) {
        $items = $categories[$catKey]
        if ($items.Count -eq 0) { continue }

        $meta = $categoryMeta[$catKey]
        [void]$lines.Add("### $($meta.emoji) $($meta.title)`n")
        foreach ($item in $items) {
            [void]$lines.Add("- $item")
        }
        [void]$lines.Add("")
    }

    if ($fullChangelogLink) {
        [void]$lines.Add("---`n$fullChangelogLink`n")
    }

    return ($lines -join "`n")
}

function Get-ChangelogWithReview {
    param(
        [string]$NewTag,
        [string]$ExcludeTag = $null
    )

    $changelog = Generate-Changelog -NewTag $NewTag -ExcludeTag $ExcludeTag
    $tempFile = Join-Path $env:TEMP "clawdeckx-changelog-$NewTag.md"

    # Write changelog to temp file
    Set-Content -Path $tempFile -Value $changelog -Encoding UTF8

    Write-Host "`n=== 生成的 Changelog 预览 ===" -ForegroundColor Cyan
    Write-Host $changelog
    Write-Host "============================" -ForegroundColor Cyan

    $edit = Read-Host "发布前是否编辑 Changelog? (y/N)"
    if ($edit -eq "y" -or $edit -eq "Y") {
        # Try to open in user's preferred editor
        $editor = $env:EDITOR
        if (-not $editor) { $editor = $env:VISUAL }
        if (-not $editor) {
            # Try common editors
            if (Get-Command code -ErrorAction SilentlyContinue) { $editor = "code --wait" }
            elseif (Get-Command notepad -ErrorAction SilentlyContinue) { $editor = "notepad" }
            else { $editor = "notepad" }
        }

        Write-Host "打开编辑器: $editor $tempFile" -ForegroundColor Yellow
        Invoke-Expression "$editor `"$tempFile`""
        Write-Host "编辑器已关闭，读取更新后的 Changelog..." -ForegroundColor Yellow
    }

    $finalChangelog = Get-Content -Path $tempFile -Raw -Encoding UTF8
    Remove-Item -Path $tempFile -ErrorAction SilentlyContinue

    return $finalChangelog
}

if ($Clean) {
    Write-Host "=== 清理所有 Release ===" -ForegroundColor Yellow

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "错误: 未找到 gh CLI" -ForegroundColor Red
        Write-Host "安装: https://cli.github.com/" -ForegroundColor Cyan
        exit 1
    }

    Write-Host "获取所有 Release..." -ForegroundColor Yellow
    $releases = gh release list --limit 100 | ForEach-Object { ($_ -split '\s+')[0] }

    if (-not $releases) {
        Write-Host "未找到任何 Release" -ForegroundColor Green
        exit 0
    }

    Write-Host "找到以下 Release:" -ForegroundColor Yellow
    $releases | ForEach-Object { Write-Host "  $_" }
    Write-Host ""

    $confirm = Read-Host "确认删除所有 Release? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "已取消" -ForegroundColor Red
        exit 0
    }

    foreach ($release in $releases) {
        Write-Host "删除 $release..." -ForegroundColor Yellow
        gh release delete $release -y 2>&1 | Out-Null
    }

    Write-Host "所有 Release 已删除" -ForegroundColor Green
    exit 0
}

if (-not $Version) {
    Write-Host "用法: .\scripts\release.ps1 <版本号> [-r] | -Clean" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  .\scripts\release.ps1 0.0.5        # 新版本发布（含 Docker）"
    Write-Host "  .\scripts\release.ps1 0.0.5 -d     # 新版本发布（跳过 Docker）"
    Write-Host "  .\scripts\release.ps1 0.0.4 -r     # 替换已有版本"
    Write-Host "  .\scripts\release.ps1 0.0.4 -r -d  # 替换版本（跳过 Docker）"
    Write-Host "  .\scripts\release.ps1 -Clean       # 删除所有 Release"
    exit 1
}

if ($Version -notmatch "^\d+\.\d+\.\d+$") {
    Write-Host "错误: 版本号格式无效，请使用 x.y.z" -ForegroundColor Red
    exit 1
}

$Tag = "v$Version"

# Validate version is greater than current
$currentVersion = (Get-Content "web/package.json" -Raw | ConvertFrom-Json).version
if ($currentVersion -and -not $Replace) {
    $cur = [version]$currentVersion
    $new = [version]$Version
    if ($new -le $cur) {
        Write-Host "错误: 新版本 $Version 必须大于当前版本 $currentVersion" -ForegroundColor Red
        exit 1
    }
}

function Invoke-PreReleaseChecks {
    Write-Host "`n=== 发布前验证 ===" -ForegroundColor Cyan

    # 1. Git 工作区必须干净
    $gitStatus = git status --porcelain 2>$null
    if ($gitStatus) {
        Write-Host "错误: 工作区不干净，请先提交或 stash 变更。" -ForegroundColor Red
        $gitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
        exit 1
    }
    Write-Host "[OK] Git 工作区干净" -ForegroundColor Green

    # 2. 运行代码质量检查
    $devBuild = Join-Path $PSScriptRoot "dev-build.ps1"
    if (Test-Path $devBuild) {
        Write-Host "运行代码质量检查..." -ForegroundColor Yellow
        & powershell -ExecutionPolicy Bypass -File $devBuild -Check
        if ($LASTEXITCODE -ne 0) {
            Write-Host "错误: 代码质量检查未通过，请修复后再发布。" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "警告: 未找到 dev-build.ps1，跳过质量检查" -ForegroundColor Yellow
    }

    # 3. 检查 OpenClaw 兼容性
    $syncScript = Join-Path $PSScriptRoot "sync-openclaw.ps1"
    if (Test-Path $syncScript) {
        Write-Host "检查 OpenClaw 兼容性..." -ForegroundColor Yellow
        & powershell -ExecutionPolicy Bypass -File $syncScript 2>$null
    }

    Write-Host "`n=== 发布前验证通过 ===" -ForegroundColor Green
}

function Update-VersionFiles {
    Write-Host "更新版本文件..." -ForegroundColor Yellow

    $packageJson = Get-Content "web/package.json" -Raw
    $packageJson = $packageJson -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
    Set-Content "web/package.json" $packageJson -NoNewline

    $versionGo = Get-Content "internal/version/version.go" -Raw
    $versionGo = $versionGo -replace 'var Version = "[^"]*"', "var Version = `"$Version`""
    Set-Content "internal/version/version.go" $versionGo -NoNewline

    Write-Host "版本已更新为 $Version" -ForegroundColor Green
}

function Commit-AndPush {
    Write-Host "提交变更..." -ForegroundColor Yellow

    git add -A
    git commit -m "chore: release v$Version" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "无变更需要提交" -ForegroundColor Yellow
    }
    git push

    Write-Host "变更已提交并推送" -ForegroundColor Green
}

function New-Tag {
    param([string]$Changelog = "")

    Write-Host "创建标签 $Tag..." -ForegroundColor Yellow

    $skipDockerSuffix = ""
    if ($NoDocker) {
        $skipDockerSuffix = "`n`n[skip-docker]"
        Write-Host "标记 [skip-docker]：跳过 Docker 构建" -ForegroundColor Yellow
    }

    if ($Changelog) {
        $tagMsg = "Release $Tag`n`n$Changelog$skipDockerSuffix"
        git tag -a $Tag -m $tagMsg
    } else {
        git tag -a $Tag -m "Release $Tag$skipDockerSuffix"
    }
    git push origin $Tag

    Write-Host "标签 $Tag 已创建并推送" -ForegroundColor Green
}

function Save-ReleaseNotes {
    param([string]$Notes)

    $notesFile = Join-Path $ProjectRoot "RELEASE_NOTES.md"
    Set-Content -Path $notesFile -Value $Notes -Encoding UTF8
    Write-Host "发布说明已保存到 RELEASE_NOTES.md" -ForegroundColor Green
}

function Update-Changelog {
    param([string]$Notes)

    $changelogFile = Join-Path $ProjectRoot "CHANGELOG.md"
    $header = "# $Tag`n`n_$(Get-Date -Format 'yyyy-MM-dd')_`n`n$Notes`n`n---`n`n"

    if (Test-Path $changelogFile) {
        $existing = Get-Content -Path $changelogFile -Raw -Encoding UTF8
        $versionHeaderPattern = "(?m)^#\s+$([regex]::Escape($Tag))\s*$"
        $nextVersionPattern = '(?m)^#\s+v\d+\.\d+\.\d+\s*$'
        $match = [regex]::Match($existing, $versionHeaderPattern)

        if ($match.Success) {
            $remaining = $existing.Substring($match.Index + $match.Length)
            $nextVersionMatch = [regex]::Match($remaining, $nextVersionPattern)

            if ($nextVersionMatch.Success) {
                $suffixStart = $match.Index + $match.Length + $nextVersionMatch.Index
                $updated = $existing.Substring(0, $match.Index) + $header + $existing.Substring($suffixStart)
            } else {
                $updated = $existing.Substring(0, $match.Index) + $header
            }

            Set-Content -Path $changelogFile -Value $updated -Encoding UTF8
        } elseif ([regex]::IsMatch($existing, '(?m)^# Changelog\s*$')) {
            Set-Content -Path $changelogFile -Value ($existing.TrimEnd() + "`n`n" + $header) -Encoding UTF8
        } else {
            Set-Content -Path $changelogFile -Value ($header + $existing) -Encoding UTF8
        }
    } else {
        Set-Content -Path $changelogFile -Value ("# Changelog`n`n" + $header) -Encoding UTF8
    }
    Write-Host "CHANGELOG.md 已更新" -ForegroundColor Green
}

function Remove-Release {
    Write-Host "删除 GitHub Release $Tag..." -ForegroundColor Yellow

    if (Get-Command gh -ErrorAction SilentlyContinue) {
        gh release delete $Tag -y 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Release 未找到，跳过..." -ForegroundColor Yellow
        }
    } else {
        Write-Host "未找到 gh CLI，跳过 Release 删除..." -ForegroundColor Yellow
        Write-Host "安装: https://cli.github.com/" -ForegroundColor Cyan
    }

    Write-Host "Release 已删除" -ForegroundColor Green
}

function Remove-Tag {
    Write-Host "删除标签 $Tag..." -ForegroundColor Yellow

    git tag -d $Tag 2>$null | Out-Null
    git push origin --delete $Tag 2>&1 | Out-Null

    Write-Host "标签已删除" -ForegroundColor Green
}

# Run pre-release validation
Invoke-PreReleaseChecks

if ($Replace) {
    Write-Host "=== 替换发布 v$Version ===" -ForegroundColor Yellow
    Write-Host "警告: 这将删除已有的 Release 和标签!" -ForegroundColor Red
    $confirm = Read-Host "确认继续? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "已取消" -ForegroundColor Red
        exit 1
    }

    # Generate changelog before removing old release
    $changelog = Get-ChangelogWithReview -NewTag $Tag -ExcludeTag $Tag

    Remove-Release
    Remove-Tag
    Update-VersionFiles
    Commit-AndPush
    Save-ReleaseNotes -Notes $changelog
    Update-Changelog -Notes $changelog
    git add RELEASE_NOTES.md CHANGELOG.md
    git commit --amend --no-edit 2>$null
    git push --force
    New-Tag -Changelog $changelog
    Write-Host "发布 v$Version 替换成功!" -ForegroundColor Green
    Write-Host "GitHub Actions 将重新构建并发布" -ForegroundColor Yellow
} else {
    Write-Host "=== 创建新发布 v$Version ===" -ForegroundColor Green

    # Generate changelog before committing
    $changelog = Get-ChangelogWithReview -NewTag $Tag

    Update-VersionFiles
    Save-ReleaseNotes -Notes $changelog
    Update-Changelog -Notes $changelog
    Commit-AndPush
    New-Tag -Changelog $changelog
    Write-Host "发布 v$Version 创建成功!" -ForegroundColor Green
    Write-Host "GitHub Actions 将自动构建并发布" -ForegroundColor Yellow
}
