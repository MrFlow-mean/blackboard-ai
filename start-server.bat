@echo off
setlocal

set "BAT_DIR=%~dp0"
set "BACKEND_DIR=%BAT_DIR%backend\"
cd /d "%BACKEND_DIR%"

echo == Backend launcher ==
echo Dir: %CD%
echo.

set "BACKEND_LAUNCHED_FROM_BAT=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%start-server.ps1"
set "EC=%ERRORLEVEL%"
echo.
if "%EC%"=="10" (
  echo Backend is already running.
  echo Health: http://127.0.0.1:3002/health
  pause
  exit /b 0
)
if not "%EC%"=="0" (
  echo Failed (exit code: %EC%).
  pause
  exit /b %EC%
)
echo Server exited. Press any key to close...
pause
exit /b 0
