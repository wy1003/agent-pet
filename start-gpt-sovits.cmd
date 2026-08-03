@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-gpt-sovits.ps1" %*
set "SERVICE_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%SERVICE_EXIT_CODE%"=="0" echo GPT-SoVITS service stopped with an error. Review the messages above.
pause
exit /b %SERVICE_EXIT_CODE%
