# Threads運用アシスタント プラグイン インストールスクリプト for Windows
# 対象: PowerShell 5.1 以上。Claude Code のチャットに次の1行を貼って実行する
#
#   以下のURLからThreads運用アシスタントのインストールスクリプトを取得して、
#   内容を確認してから実行してください:
#   https://raw.githubusercontent.com/joshicrea/joshicrea-threads-ops/master/install.ps1
#
# やること: プラグインを ~/.claude/plugins/cache に置き、本体を ~/.claude/threads-ops/app に配置、
#           Node.js を確認し、ログオン時の自動起動を登録し、本体を起動して疎通を確かめる。
# 検証用: -LocalSource <フォルダ> を付けると GitHub からではなく手元のフォルダから入れる。
param([string]$LocalSource = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# TLS 1.2 を明示的に有効化 for Windows PowerShell 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host ""
Write-Host "Threads運用アシスタントをインストールしています..."
Write-Host ""

# UTF-8 BOMなしでファイルを書き込む。PS5.1/PS7 両対応
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

$HomeDir    = $env:USERPROFILE
$TempDir    = [IO.Path]::GetTempPath()
$ClaudeDir  = [IO.Path]::Combine($HomeDir, ".claude")
$PluginsDir = [IO.Path]::Combine($ClaudeDir, "plugins")
$PluginKey  = "joshicrea-threads-ops@joshicrea"
$CacheDir   = [IO.Path]::Combine($PluginsDir, "cache", "joshicrea", "joshicrea-threads-ops")
$BaseDir    = [IO.Path]::Combine($ClaudeDir, "threads-ops")
$AppDir     = [IO.Path]::Combine($BaseDir, "app")
$DataDir    = [IO.Path]::Combine($BaseDir, "data")
$Repo       = "joshicrea/joshicrea-threads-ops"

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# --- 1. プラグイン本体を取得 ---
if ($LocalSource) {
    if (-not (Test-Path ([IO.Path]::Combine($LocalSource, "server.js")))) {
        Write-Host "LocalSource に server.js がありません: $LocalSource"
        exit 1
    }
    $shortSha = "local-" + (Get-Date -Format "yyyyMMddHHmmss")
    $fullSha  = $shortSha
    $InstallPath = [IO.Path]::Combine($CacheDir, $shortSha)
    New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
    Get-ChildItem $LocalSource -Force | Where-Object { $_.Name -notin @("data", ".git", "node_modules", "test", "Meta審査申請") } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination ([IO.Path]::Combine($InstallPath, $_.Name)) -Recurse -Force
    }
    Write-Host "手元のフォルダから配置しました ($shortSha)"
} else {
    try {
        $commitInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/master" -Headers @{"User-Agent"="joshicrea-install"} -UseBasicParsing
        $fullSha = $commitInfo.sha
        $shortSha = $fullSha.Substring(0, 12)
    } catch {
        Write-Host "GitHubへの接続に失敗しました。インターネット接続を確認してください。"
        exit 1
    }
    $InstallPath = [IO.Path]::Combine($CacheDir, $shortSha)
    if (Test-Path $InstallPath) {
        Write-Host "すでに最新版がインストールされています ($shortSha)"
    } else {
        $ZipUrl  = "https://github.com/$Repo/archive/refs/heads/master.zip"
        $ZipPath = [IO.Path]::Combine($TempDir, "joshicrea-threads-ops.zip")
        $ExtTemp = [IO.Path]::Combine($TempDir, "joshicrea-threads-ops-extract-$shortSha")
        try {
            Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
        } catch {
            Write-Host "ダウンロードに失敗しました: $_"
            exit 1
        }
        if (Test-Path $ExtTemp) { Remove-Item $ExtTemp -Recurse -Force }
        Expand-Archive -Path $ZipPath -DestinationPath $ExtTemp -Force
        $ExtractedFolder = Get-ChildItem $ExtTemp | Select-Object -First 1
        Move-Item $ExtractedFolder.FullName $InstallPath -Force
        Remove-Item $ExtTemp -Force -ErrorAction SilentlyContinue
        Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
        Write-Host "ダウンロード完了 ($shortSha)"
        foreach ($junk in @("test", "Meta審査申請", "deploy", "data")) {
            $jp = [IO.Path]::Combine($InstallPath, $junk)
            if (Test-Path $jp) { Remove-Item $jp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

# 古いキャッシュは最新2世代だけ残す
$existingVersions = Get-ChildItem $CacheDir -Directory | Sort-Object LastWriteTime -Descending
$existingVersions | Select-Object -Skip 2 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# --- 2. installed_plugins.json を更新 ---
$InstalledPath = [IO.Path]::Combine($PluginsDir, "installed_plugins.json")
if (Test-Path $InstalledPath) {
    $Installed = [System.IO.File]::ReadAllText($InstalledPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
} else {
    New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
    $Installed = [PSCustomObject]@{ version = 2; plugins = [PSCustomObject]@{} }
}
$PluginEntry = [PSCustomObject]@{
    scope        = "user"
    installPath  = $InstallPath
    version      = $shortSha
    installedAt  = (Get-Date -Format "o")
    lastUpdated  = (Get-Date -Format "o")
    gitCommitSha = $fullSha
}
if ($Installed.plugins.PSObject.Properties[$PluginKey]) {
    $Installed.plugins.PSObject.Properties[$PluginKey].Value = @($PluginEntry)
} else {
    $Installed.plugins | Add-Member -Name $PluginKey -Value @($PluginEntry) -MemberType NoteProperty
}
Write-Utf8NoBom -Path $InstalledPath -Content ($Installed | ConvertTo-Json -Depth 10)

# --- 3. settings.json の enabledPlugins を更新 ---
$SettingsPath = [IO.Path]::Combine($ClaudeDir, "settings.json")
if (Test-Path $SettingsPath) {
    $Settings = [System.IO.File]::ReadAllText($SettingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
} else {
    $Settings = [PSCustomObject]@{}
}
if (-not ($Settings.PSObject.Properties["enabledPlugins"])) {
    $Settings | Add-Member -Name "enabledPlugins" -Value ([PSCustomObject]@{}) -MemberType NoteProperty
}
if ($Settings.enabledPlugins.PSObject.Properties[$PluginKey]) {
    $Settings.enabledPlugins.PSObject.Properties[$PluginKey].Value = $true
} else {
    $Settings.enabledPlugins | Add-Member -Name $PluginKey -Value $true -MemberType NoteProperty
}
Write-Utf8NoBom -Path $SettingsPath -Content ($Settings | ConvertTo-Json -Depth 10)
Write-Host "プラグインを登録しました"

# --- 4. Node.js を確認。無ければ winget で入れる ---
function Get-NodeMajor {
    try {
        $v = (& node -v 2>$null)
        if ($v -match "^v(\d+)") { return [int]$Matches[1] }
    } catch {}
    return 0
}
$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js が見つからず、winget も使えません。Microsoft Storeで「アプリ インストーラー」を更新するか、https://nodejs.org から LTS 版を入れてから、もう一度実行してください:"
        Write-Host "https://www.microsoft.com/p/app-installer/9nblggh4nns1"
        exit 1
    }
    Write-Host "Node.js を入れています。1〜3分かかります。「このアプリがデバイスに変更を加えることを許可しますか」と出たら「はい」を押してください..."
    & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Host "winget が終了コード $LASTEXITCODE を返しました（管理者の許可が要る、またはネットワーク制限の可能性）" }
    # このセッションの PATH を更新して node を見えるようにする
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nodeMajor = Get-NodeMajor
    if ($nodeMajor -lt 20) {
        Write-Host "Node.js の導入を確認できませんでした。管理者の許可で止めた場合は「はい」を押してもう一度。直らなければ https://nodejs.org から LTS 版を入れてから、もう一度このスクリプトを実行してください。"
        exit 1
    }
}
Write-Host "Node.js: v$nodeMajor"
# プラグインの MCP は PATH に頼らず、いま見つかった node のフルパスで起動する
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$mcpJsonPath = [IO.Path]::Combine($InstallPath, ".mcp.json")
if ($nodeExe -and (Test-Path $mcpJsonPath)) {
    try {
        $mcp = [System.IO.File]::ReadAllText($mcpJsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $mcp.mcpServers."threads-ops".command = $nodeExe
        Write-Utf8NoBom -Path $mcpJsonPath -Content ($mcp | ConvertTo-Json -Depth 10)
    } catch { Write-Host "注意: .mcp.json の書き換えに失敗しました。PATH の node で起動します: $_" }
}

# --- 5. 本体を安定した場所へ配置。データは別フォルダに置き、更新で消えないようにする ---
$appItems = @("server.js", "start.js", "package.json", "public", "start-hidden.vbs", "register-autostart.ps1", "stop.ps1", "uninstall.ps1", "README.md", "アンインストール.md", "relay")
foreach ($item in $appItems) {
    $src = [IO.Path]::Combine($InstallPath, $item)
    if (Test-Path $src) {
        $dst = [IO.Path]::Combine($AppDir, $item)
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item -Path $src -Destination $dst -Recurse -Force
    }
}
# 日本語名の .cmd は ZIP の文字コードに左右されないよう、ここで生成する（中身は CP932）
$cp932 = [System.Text.Encoding]::GetEncoding(932)
$cmdFiles = @{
    "起動.cmd" = "@echo off`r`nsetlocal`r`ncd /d `"%~dp0`"`r`nwhere node >nul 2>nul`r`nif errorlevel 1 (`r`n  echo Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてください。`r`n  pause`r`n  exit /b 1`r`n)`r`nnode start.js`r`necho.`r`npause`r`n"
    "停止.cmd" = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0stop.ps1`"`r`necho.`r`npause`r`n"
    "アンインストール.cmd" = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0uninstall.ps1`"`r`ncd /d `"%TEMP%`"`r`necho.`r`npause`r`n"
    "自動起動を登録.cmd" = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0register-autostart.ps1`"`r`necho.`r`necho 次のログオンから自動で起動します（黒い画面は出ません）。今すぐ使うなら 起動.cmd を実行してください。`r`npause`r`n"
    "自動起動を解除.cmd" = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0register-autostart.ps1`" -Remove`r`necho.`r`necho 自動起動を解除しました。起動中のサーバーは 停止.cmd で止められます。`r`npause`r`n"
}
foreach ($name in $cmdFiles.Keys) { [System.IO.File]::WriteAllText([IO.Path]::Combine($AppDir, $name), $cmdFiles[$name], $cp932) }
$envText = "# Threads運用アシスタントの起動設定。install.ps1 が作成。データの置き場所はここで決まる`nTHREADS_DATA_DIR=$DataDir`n"
Write-Utf8NoBom -Path ([IO.Path]::Combine($AppDir, "threads-ops.env")) -Content $envText
Write-Host "本体を配置しました: $AppDir"

# --- 6. 自動起動を登録し、動いている旧版があれば止めて、新版を起動する ---
$verifyOk = $true
& powershell -NoProfile -ExecutionPolicy Bypass -File ([IO.Path]::Combine($AppDir, "register-autostart.ps1")) | Out-Null
$taskName = if ($env:THREADS_TASK_NAME) { $env:THREADS_TASK_NAME } else { "ThreadsOpsAssistant" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Host "自動起動を登録しました"
} else {
    Write-Host "自動起動の登録に失敗しました。あとで 自動起動を登録.cmd を実行してください。"
    $verifyOk = $false
}
# 更新のとき: 旧版のプロセスが残っていると server.js を差し替えても新版にならない。pid は DataDir にある
$pidFile = [IO.Path]::Combine($DataDir, "server.pid")
if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ("$oldPid" -match "^\d+$") {
        $oldProc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($oldProc -and $oldProc.ProcessName -eq "node") {
            Stop-Process -Id $oldProc.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Write-Host "動いていた旧版を止めました"
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
Start-Process -FilePath "wscript.exe" -ArgumentList @("//nologo", ([IO.Path]::Combine($AppDir, "start-hidden.vbs"))) -WorkingDirectory $AppDir | Out-Null

# --- 7. 検証: 必須ファイルと本体の疎通 ---
foreach ($f in @(
    [IO.Path]::Combine($InstallPath, ".claude-plugin", "plugin.json"),
    [IO.Path]::Combine($InstallPath, ".mcp.json"),
    [IO.Path]::Combine($InstallPath, "mcp", "server.mjs"),
    [IO.Path]::Combine($InstallPath, "hooks", "session-start.ps1"),
    [IO.Path]::Combine($AppDir, "server.js"),
    [IO.Path]::Combine($AppDir, "threads-ops.env"),
    [IO.Path]::Combine($AppDir, "stop.ps1"),
    [IO.Path]::Combine($AppDir, "uninstall.ps1"),
    [IO.Path]::Combine($AppDir, "起動.cmd"),
    [IO.Path]::Combine($AppDir, "停止.cmd"),
    [IO.Path]::Combine($AppDir, "アンインストール.cmd")
)) {
    if (-not (Test-Path $f)) { Write-Host "エラー: $f が作成されませんでした"; $verifyOk = $false }
}
$up = $false
for ($i = 0; $i -lt 15; $i++) {
    try {
        $req = [System.Net.WebRequest]::Create("http://127.0.0.1:4173/api/state")
        $req.Timeout = 2000
        $req.Headers.Add("x-threads-ops", "1")
        try { $res = $req.GetResponse(); $res.Close(); $up = $true } catch [System.Net.WebException] { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $up = $true } }
    } catch {}
    if ($up) { break }
    Start-Sleep -Seconds 1
}
if (-not $up) {
    Write-Host "本体が起動しませんでした。$DataDir\autostart.log と server-error.log を確認してください。"
    $verifyOk = $false
}
if (-not $verifyOk) {
    Write-Host ""
    Write-Host "インストールに問題が発生しました。もう一度試してください。"
    exit 1
}

# --- 完了 ---
Write-Host ""
Write-Host "インストール完了！"
Write-Host ""
Write-Host "次の手順:"
Write-Host "  1. Claude Code を完全に閉じる（Node.js を今回入れた場合は、Claude Code を動かしているターミナルやエディタごと閉じる）"
Write-Host "  2. Claude Code を再度開く"
Write-Host "  3. チャットに「はじめまして」と送るとセットアップが始まります"
Write-Host "  画面: http://localhost:4173"
Write-Host ""
