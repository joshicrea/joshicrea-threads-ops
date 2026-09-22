@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-autostart.ps1"
echo.
echo 次のログオンから自動で起動します（黒い窓は出ません）。今すぐ使うなら 起動.cmd を実行してください。
pause
