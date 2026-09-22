# Threads運用アシスタント: アンインストール（自動起動の解除 → 本体停止 → プラグイン登録の削除 → フォルダ削除）
# ダブルクリック（アンインストール.cmd）で確認つき。-Force を付けると確認なし
param([switch]$Force)
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $AppDir
$ClaudeDir = [IO.Path]::Combine($env:USERPROFILE, ".claude")
$CacheDir = [IO.Path]::Combine($ClaudeDir, "plugins", "cache", "joshicrea", "joshicrea-threads-ops")
$Key = "joshicrea-threads-ops@joshicrea"
$taskName = if ($env:THREADS_TASK_NAME) { $env:THREADS_TASK_NAME } else { "ThreadsOpsAssistant" }

Write-Host ""
Write-Host "Threads運用アシスタントをアンインストールします。"
Write-Host "データ（投稿・コメント・Threads のトークン・アクセスキー）も消えます: $BaseDir\data"
Write-Host "残したいものがあれば、この画面を閉じて data フォルダをコピーしてから実行してください。"
if (-not $Force) {
    $ans = Read-Host "続けますか？ (y/N)"
    if ($ans -ne "y" -and $ans -ne "Y") { Write-Host "やめました。何も変えていません（y と答えると実行します）。"; exit 2 }
}

# 1. 自動起動の解除
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "自動起動を解除しました"

# 2. 本体の停止（stop.ps1 と同じ手順）
$stop = [IO.Path]::Combine($AppDir, "stop.ps1")
if (Test-Path $stop) { & powershell -NoProfile -ExecutionPolicy Bypass -File $stop }

# 3. プラグイン登録の削除（JSON を読んで書き戻す。手編集しない）
foreach ($f in @([IO.Path]::Combine($ClaudeDir, "plugins", "installed_plugins.json"), [IO.Path]::Combine($ClaudeDir, "settings.json"))) {
    if (-not (Test-Path $f)) { continue }
    try {
        $j = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $changed = $false
        foreach ($sec in @("plugins", "enabledPlugins")) {
            if ($j.PSObject.Properties[$sec] -and $j.$sec -and $j.$sec.PSObject.Properties[$Key]) { $j.$sec.PSObject.Properties.Remove($Key); $changed = $true }
        }
        if ($changed) {
            [System.IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
            Write-Host "登録を外しました: $f"
        }
    } catch {
        Write-Host "登録の削除に失敗しました（$f）: $_"
    }
}
if (Test-Path $CacheDir) { Remove-Item $CacheDir -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "プラグイン本体を消しました: $CacheDir" }

# 4. フォルダ削除（このスクリプト自身が入っているので、少し待ってから別プロセスで消す）
# 自分と消す側の cwd を外に出す。cwd がフォルダ内にあると Windows は rd できず、app/ が残る
Set-Location $env:TEMP
Write-Host "フォルダを消します: $BaseDir"
Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "ping -n 3 127.0.0.1 >nul & rd /s /q `"$BaseDir`"") -WorkingDirectory $env:TEMP -WindowStyle Hidden | Out-Null
Write-Host ""
Write-Host "アンインストールが終わりました。Claude Code を閉じて開き直してください。"
Write-Host "Threads 側の連携を切るときは、Threads アプリの 設定 → アカウント → ウェブサイトのアクセス許可 から解除してください。"
exit 0
