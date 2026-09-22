: << 'CMDBLOCK'
@echo off
REM Cross-platform polyglot wrapper for hook scripts.
REM On Windows: prefer the PowerShell .ps1 version over bash from Git for Windows.
REM On Unix: the shell interprets this as a script, since : is a no-op in bash.
REM
REM 2026-09-10 fix: this used to exit /b 0 silently when bash was missing.
REM The target users do not install Git for Windows, so on most Windows machines
REM the SessionStart injection never ran while everything looked fine.
REM Prefer .ps1 and fail loudly when neither is available, same as AI Keieisha.
REM
REM Keep this file ASCII only. cmd.exe reads it in the OEM code page, so UTF-8
REM Japanese in REM lines is misread and breaks parsing.

if "%~1"=="" (
    echo run-hook.cmd: missing script name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"
set "SCRIPT_BASE=%~1"

REM 1. Prefer the PowerShell version if present, so bash is not required
if exist "%HOOK_DIR%%SCRIPT_BASE%.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%HOOK_DIR%%SCRIPT_BASE%.ps1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM 2. Fallback to Git for Windows bash in the standard locations
if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%HOOK_DIR%%SCRIPT_BASE%" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%HOOK_DIR%%SCRIPT_BASE%" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM 3. Try bash on PATH
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    bash "%HOOK_DIR%%SCRIPT_BASE%" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM Neither the PowerShell version nor bash was found. Say so instead of failing quietly.
echo run-hook.cmd: ERROR - neither %SCRIPT_BASE%.ps1 nor bash were found. >&2
echo Please report this to info@joshicrea.com so we can fix the hook. >&2
exit /b 1
CMDBLOCK

# Unix: run the named script directly
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
