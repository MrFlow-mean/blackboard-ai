@echo off
setlocal

set "BACKEND_DIR=%~dp0"
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
exit /b 0

