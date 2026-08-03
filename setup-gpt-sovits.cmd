@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-gpt-sovits.ps1" %*
set "SETUP_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%SETUP_EXIT_CODE%"=="0" echo GPT-SoVITS installation did not complete. Review the messages above.
pause
exit /b %SETUP_EXIT_CODE%
