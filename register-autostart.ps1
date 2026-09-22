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
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
$t = Get-ScheduledTask -TaskName $name
Write-Output ("registered: " + $t.State + " | " + $t.Actions[0].Execute + " " + $t.Actions[0].Arguments)
