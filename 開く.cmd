@echo off
REM Threads Ops Assistant: open the screen.
REM start-hidden.vbs checks whether the server answers on /api/state first:
REM   alive -> just open the browser
REM   down  -> start the server hidden, start.js opens the browser when it is ready
REM No console window is left behind, so closing anything never kills the server.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS build from https://nodejs.org and try again.
  pause
  exit /b 1
)
start "" wscript.exe //nologo "%~dp0start-hidden.vbs" open
exit /b 0
