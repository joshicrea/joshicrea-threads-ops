# SessionStart hook for joshicrea-threads-ops for Windows PowerShell
# プラグインの CLAUDE.md をセッションのコンテキストへ注入し、本体サーバーの生死とセットアップ状況を1行添える。
# このファイルは UTF-8 BOM 付きで保存すること。BOM が無いと Windows PowerShell 5.1 は CP932 として読み、日本語が壊れる。

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$ClaudeMd   = Join-Path $PluginRoot "CLAUDE.md"
$BaseDir    = Join-Path $env:USERPROFILE ".claude\threads-ops"
$ErrorLog   = Join-Path $BaseDir "logs\hook_errors.log"

function Write-HookError {
    param([string]$Message)
    try {
        $dir = Split-Path -Parent $ErrorLog
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -Path $ErrorLog -Value "$stamp session-start.ps1: $Message" -Encoding UTF8
    } catch { }
}

if (-not (Test-Path $ClaudeMd)) {
    Write-HookError "CLAUDE.md が見つかりません: $ClaudeMd"
    exit 0
}

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $content = [System.IO.File]::ReadAllText($ClaudeMd, $utf8NoBom)
} catch {
    Write-HookError "CLAUDE.md の読み込みに失敗しました: $_"
    exit 0
}

# 本体の生死（2秒で諦める）。401 はアクセスキー付きで動いている状態
$serverLine = "本体サーバー: 停止中（利用者に 起動.cmd の実行か PC の再起動を案内する）"
try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:4173/api/state")
    $req.Timeout = 2000
    $req.Headers.Add("x-threads-ops", "1")
    try {
        $res = $req.GetResponse()
        $res.Close()
        $serverLine = "本体サーバー: 稼働中（http://localhost:4173）"
    } catch [System.Net.WebException] {
        $r = $_.Exception.Response
        if ($r -and [int]$r.StatusCode -eq 401) { $serverLine = "本体サーバー: 稼働中（アクセスキー付き・http://localhost:4173）" }
    }
} catch { }

# セットアップ状況（db.json の発信者情報があるか）
$setupLine = "初回セットアップ: 未（スキル threads-setup を始める）"
try {
    $dbPath = Join-Path $BaseDir "data\db.json"
    if (Test-Path $dbPath) {
        $db = [System.IO.File]::ReadAllText($dbPath, $utf8NoBom) | ConvertFrom-Json
        if ($db.settings -and $db.settings.brandName) { $setupLine = "初回セットアップ: 済（発信者: " + $db.settings.brandName + "）" }
    }
} catch { }

$sessionContext = "<EXTREMELY_IMPORTANT>`nThreads運用アシスタント（joshicrea-threads-ops plugin is active）。以下の指示に従うこと:`n`n$content`n`n[今の状態] $serverLine ／ $setupLine`n</EXTREMELY_IMPORTANT>"

$payload = [PSCustomObject]@{
    hookSpecificOutput = [PSCustomObject]@{
        hookEventName     = "SessionStart"
        additionalContext = $sessionContext
    }
}

$json = $payload | ConvertTo-Json -Depth 10 -Compress
$stdout = [Console]::OpenStandardOutput()
$bytes = $utf8NoBom.GetBytes($json)
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
exit 0
