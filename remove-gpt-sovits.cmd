@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove-gpt-sovits.ps1" %*
set "REMOVE_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%REMOVE_EXIT_CODE%"=="0" echo GPT-SoVITS cleanup did not complete. Review the messages above.
pause
exit /b %REMOVE_EXIT_CODE%
