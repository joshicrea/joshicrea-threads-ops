' Threads Ops Assistant: start the server without a console window (used by the logon task).
' Reads threads-ops.env (KEY=VALUE) next to this file so the data dir and options match the plugin install.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
Set env = sh.Environment("PROCESS")
env("THREADS_NO_BROWSER") = "1"
logDir = dir & "/data"
envPath = dir & "\threads-ops.env"
If fso.FileExists(envPath) Then
  Set f = fso.OpenTextFile(envPath, 1)
  Do Until f.AtEndOfStream
    line = Trim(f.ReadLine)
    If Len(line) > 0 And Left(line, 1) <> "#" Then
      p = InStr(line, "=")
      If p > 1 Then
        k = Trim(Left(line, p - 1))
        v = Trim(Mid(line, p + 1))
        If Len(env(k)) = 0 Then env(k) = v
        If k = "THREADS_DATA_DIR" And Len(v) > 0 Then logDir = v
      End If
    End If
  Loop
  f.Close
End If
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
sh.Run "cmd /c node start.js >> """ & logDir & "/autostart.log"" 2>&1", 0, False
