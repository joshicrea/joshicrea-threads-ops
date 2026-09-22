# 公開リポジトリ joshicrea/joshicrea-threads-ops へ、このフォルダの git 追跡ファイル（Meta審査申請/ を除く）を反映する
# 使い方: このフォルダで  powershell -NoProfile -ExecutionPolicy Bypass -File publish-github.ps1 [-Message "..."]
# 親リポの HEAD を使うので、先に親リポでコミットしておく。data/ は追跡外なので入らない
param([string]$Message = "")
$ErrorActionPreference = "Stop"
# git の出力（UTF-8 のパス）を PowerShell が CP932 で読まないようにする
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:TEMP "threads-ops-publish"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
Push-Location $here
try {
    $rel = (git rev-parse --show-prefix).TrimEnd("/")
    # git archive はバイナリ安全で、追跡ファイルだけを HEAD の内容で書き出す（PowerShell のパイプを通さない）
    $zip = Join-Path $env:TEMP "threads-ops-publish.zip"
    # git archive はサブフォルダで実行すると cwd を pathspec として掛け、HEAD:<prefix> のツリーに対しては 0 件になる（2026-09-22 実測・公開リポの全ファイルを消した）。必ずトップレベルで実行する
    $top = git rev-parse --show-toplevel
    git -C "$top" archive --format=zip --output "$zip" "HEAD:$rel"
    if ($LASTEXITCODE -ne 0) { throw "git archive に失敗しました（prefix=$rel）" }
    Expand-Archive -Path $zip -DestinationPath $work -Force
    Remove-Item $zip -Force
    foreach ($must in @("server.js", "install.ps1", "install.py", "mcp\server.mjs", ".claude-plugin\plugin.json")) {
        if (-not (Test-Path (Join-Path $work $must))) { throw "書き出しに $must が無い。公開リポジトリには何も送らない" }
    }
    $meta = Join-Path $work "Meta審査申請"
    if (Test-Path $meta) { Remove-Item $meta -Recurse -Force }
    if (-not $Message) { $Message = "sync " + (git rev-parse --short HEAD) + " " + (Get-Content VERSION -Raw).Trim() }
} finally { Pop-Location }
# 秘密の値が混ざっていないか
$hit = Get-ChildItem $work -Recurse -File | Select-String -Pattern "EAA[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30}|sk-ant-[A-Za-z0-9_-]{20,}" -List
if ($hit) { Write-Host "秘密らしい値が見つかりました。反映を中止します:"; $hit | ForEach-Object { Write-Host "  $($_.Path)" }; exit 1 }
Push-Location $work
try {
    git init -q -b master .
    git remote add origin https://github.com/joshicrea/joshicrea-threads-ops.git
    git fetch -q origin master
    git reset -q --soft origin/master
    git add -A
    if (-not (git diff --cached --quiet)) {
        git -c user.name=joshicrea -c user.email=info@joshicrea.com commit -q -m $Message
        git push origin master
        Write-Host "反映しました: $Message"
    } else {
        Write-Host "差分なし。公開リポジトリは最新です"
    }
} finally { Pop-Location }
