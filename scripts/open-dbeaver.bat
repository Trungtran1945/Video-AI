@echo off
set DBEAVER_DIR=%LOCALAPPDATA%\DBeaver
set DBEAVER_EXE=%DBEAVER_DIR%\dbeaver.exe

if not exist "%DBEAVER_EXE%" (
    echo [ERROR] DBeaver not found at %DBEAVER_EXE%
    pause
    exit /b 1
)

echo Opening DBeaver for Video_AI...
echo Pre-configured connection: Video_AI (localhost:5433 / video_ai)
cd /d "%DBEAVER_DIR%"
start "" "%DBEAVER_EXE%"
