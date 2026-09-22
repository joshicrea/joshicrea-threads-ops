@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-autostart.ps1" -Remove
echo.
echo 自動起動を解除しました。起動中のサーバーは 停止.cmd で止められます。
pause
