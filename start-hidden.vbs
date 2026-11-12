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
' The gateway (multi-account front door) exists only on the provider PC. Customer installs do not ship it.
If fso.FileExists(dir & "\start-hidden-gateway.vbs") Then sh.Run "wscript //nologo """ & dir & "\start-hidden-gateway.vbs""", 0, False
' Provider PC only (the gateway file is not shipped): the provider's own accounts run without a license key.
If fso.FileExists(dir & "\start-hidden-gateway.vbs") Then env("THREADS_LICENSE_EXEMPT") = "1"

wantBrowser = (WScript.Arguments.Count > 0)
If Not wantBrowser Then env("THREADS_NO_BROWSER") = "1"

logDir = dir & "/data"
port = "4173"
envPath = dir & "\threads-ops.env"
If fso.FileExists(envPath) Then
  ' threads-ops.env is written as UTF-8 by the installers. FSO reads ANSI and breaks non-ASCII paths
  ' (a Japanese Windows user name), so read it with ADODB.Stream as UTF-8 and split the lines here.
  Set st = CreateObject("ADODB.Stream")
  st.Type = 2
  st.Charset = "utf-8"
  st.Open
  st.LoadFromFile envPath
  envText = st.ReadText
  st.Close
  envText = Replace(envText, vbCr, "")
  If Len(envText) > 0 Then
    If AscW(Left(envText, 1)) = &HFEFF Then envText = Mid(envText, 2)
  End If
  envLines = Split(envText, vbLf)
  For Each rawLine In envLines
    line = Trim(rawLine)
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
  Next
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

' Slow but listening? Under heavy load the server can miss the 3s window above; starting a second node would only hit EADDRINUSE
' (seen on 2026-10-18). If something already listens on the port, treat the server as up and do not spawn.
If Not alive Then
  lsFile = fso.GetSpecialFolder(2) & "\threads_listen_" & port & ".txt"
  On Error Resume Next
  sh.Run "cmd /c netstat -ano -p tcp | findstr LISTENING > """ & lsFile & """", 0, True
  If Err.Number = 0 And fso.FileExists(lsFile) Then
    Set lf = fso.OpenTextFile(lsFile, 1)
    If Not lf.AtEndOfStream Then lsText = lf.ReadAll
    lf.Close
    If InStr(lsText, ":" & port & " ") > 0 Then alive = True
    fso.DeleteFile lsFile
  End If
  Err.Clear
  On Error GoTo 0
End If

If alive Then
  If wantBrowser Then sh.Run "cmd /c start """" ""http://localhost:" & port & """", 0, False
  WScript.Quit 0
End If

If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
sh.Run "cmd /c node start.js >> """ & logDir & "/autostart.log"" 2>&1", 0, False

