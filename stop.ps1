# Threads運用アシスタント: 本体を止める。threads-ops.env の THREADS_DATA_DIR にある server.pid を見る（無ければ app\data）
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $AppDir "data"
$envFile = Join-Path $AppDir "threads-ops.env"
if (Test-Path $envFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
        if ($line -match '^\s*THREADS_DATA_DIR\s*=\s*(.+?)\s*$') { $DataDir = $Matches[1] }
    }
}
$pidFile = Join-Path $DataDir "server.pid"
if (-not (Test-Path $pidFile)) {
    Write-Host "起動中のサーバーは見つかりません（$pidFile がありません）。"
    exit 0
}
$serverPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not ("$serverPid" -match "^\d+$")) {
    Write-Host "server.pid の中身が読めません。ファイルを消して終わります。"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}
$p = Get-Process -Id ([int]$serverPid) -ErrorAction SilentlyContinue
if (-not $p -or $p.ProcessName -ne "node") {
    Write-Host "既に止まっています（PID $serverPid は node.exe ではありません）。"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "サーバーを止めました（PID $serverPid）。"
exit 0
