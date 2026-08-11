@echo off
setlocal

cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [Agent Pet] Node.js was not found.
  echo Install Node.js 20 or later, then run this file again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [Agent Pet] npm.cmd was not found. Check your Node.js installation.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Agent Pet] Installing project dependencies for the first launch...
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo [Agent Pet] Dependency installation failed. Review the messages above.
    pause
    exit /b 1
  )
)

echo [Agent Pet] Starting the desktop companion...
echo This launcher window will close automatically.
echo.
set "AGENT_PET_DETACHED=1"
call npm.cmd run companion
set "APP_EXIT_CODE=%ERRORLEVEL%"

if not "%APP_EXIT_CODE%"=="0" (
  echo.
  echo [Agent Pet] Startup failed. Review the messages above.
  pause
)

exit /b %APP_EXIT_CODE%
