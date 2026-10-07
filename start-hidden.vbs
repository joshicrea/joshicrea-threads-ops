' Threads Ops Assistant: start the server without a console window.
' Used by the logon task (no argument) and by the "open" shortcut (argument "open").
' Reads threads-ops.env (KEY=VALUE) next to this file so the data dir and options match the plugin install.
'
' The logon task repeats every 5 minutes, so this script must be cheap when the server is already up:
' it probes /api/state first and exits without spawning node when the server answers.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
Set env = sh.Environment("PROCESS")
sh.Run "wscript //nologo """ & dir & "\start-hidden-gateway.vbs""", 0, False

wantBrowser = (WScript.Arguments.Count > 0)
If Not wantBrowser Then env("THREADS_NO_BROWSER") = "1"

logDir = dir & "/data"
port = "4173"
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
        If k = "PORT" And Len(v) > 0 Then port = v
      End If
    End If
  Loop
  f.Close
End If

' Already running? 200 = no access key, 401 = access key set. Either way the server is alive.
alive = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number = 0 Then
  http.SetTimeouts 2000, 2000, 2000, 3000
  http.Open "GET", "http://127.0.0.1:" & port & "/api/state", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Or http.Status = 401 Then alive = True
  End If
End If
Err.Clear
On Error GoTo 0

If alive Then
  If wantBrowser Then sh.Run "cmd /c start """" ""http://localhost:" & port & """", 0, False
  WScript.Quit 0
End If

If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
sh.Run "cmd /c node start.js >> """ & logDir & "/autostart.log"" 2>&1", 0, False

