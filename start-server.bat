@echo off
setlocal

set "BAT_DIR=%~dp0"
set "BACKEND_DIR=%BAT_DIR%backend\"
cd /d "%BACKEND_DIR%"

echo == Backend launcher ==
echo Dir: %CD%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%start-server.ps1"
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  echo Failed (exit code: %EC%).
  pause
  exit /b %EC%
)
echo Server exited. Press any key to close...
pause
exit /b 0

