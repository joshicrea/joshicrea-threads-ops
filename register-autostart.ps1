# Threads Ops Assistant: register (or remove) the logon task that starts the server hidden.
param([switch]$Remove)
$name = if ($env:THREADS_TASK_NAME) { $env:THREADS_TASK_NAME } else { "ThreadsOpsAssistant" }
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "removed: $name"
  exit 0
}
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('//nologo "' + (Join-Path $dir "start-hidden.vbs") + '"') -WorkingDirectory $dir

# ログオン時に一度だけでは、サーバーが落ちた後そのログオンの間ずっと画面が開けない
# （2026-09-23 実測: LastTaskResult=0 で起動した後に停止し、/api/state が接続不能のまま4日近く放置されていた）。
# トリガーは2つ登録する。
#   1. AtLogOn  … PC を立ち上げた直後に動かす
#   2. Once（過去の時刻）+ 5分繰り返し … 落ちたときに戻す
# AtLogOn に Repetition を付けるだけでは足りない。ログオンは既に済んでいるのでトリガーが開始せず、
# NextRunTime が空のまま次のログオンまで1回も発火しない（2026-09-23 実測。設定値は入るので気づけない）。
# 過去の時刻の Once トリガーは登録した時点で有効になり、そこから5分ごとに回る。
# 二重起動は start-hidden.vbs 側の死活チェックが防ぐ（生きていれば node を起動せず終了する）。
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# 異常終了したときも3回まで1分間隔で復帰させる（次の5分が来るまでの穴を埋める）。
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $every5) -Settings $settings -RunLevel Limited -Force | Out-Null

# 設定が入ったことと、実際にスケジュールされたことは別。NextRunTime で後者を確かめる
$t = Get-ScheduledTask -TaskName $name
$rep = ($t.Triggers | ForEach-Object { $_.Repetition.Interval } | Where-Object { $_ }) -join ","
$next = (Get-ScheduledTaskInfo -TaskName $name).NextRunTime
if (-not $rep) { Write-Warning "繰り返し設定が入らなかった。落ちたときの自動復帰は効かない" }
if (-not $next) { Write-Warning "次回実行が予定されていない。繰り返しトリガーが開始していない（落ちても戻らない）" }
Write-Output ("registered: " + $t.State + " | repeat=" + $rep + " | next=" + $next + " | " + $t.Actions[0].Execute + " " + $t.Actions[0].Arguments)
