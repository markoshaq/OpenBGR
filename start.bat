@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Python is not installed or not in PATH.
    echo Download Python 3.10+ from https://www.python.org/downloads/ and check "Add Python to PATH".
    pause
    exit /b 1
)

if not exist ".venv" (
    echo [1/2] Creating local Python virtual environment ^(.venv^)...
    python -m venv .venv
)

if not exist ".venv\.installed" (
    echo [2/2] Installing dependencies ^(one-time setup^)...
    call .venv\Scripts\pip.exe install --upgrade pip -q
    call .venv\Scripts\pip.exe install -r requirements.txt
    type nul > ".venv\.installed"
)

call .venv\Scripts\python.exe app.py
pause
