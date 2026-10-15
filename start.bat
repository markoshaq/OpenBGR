@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

:: ============================================================================
:: REMOVEBG — Zero-Config Bootstrapper for Windows
:: ============================================================================
:: 1. Launches immediately (<1s) if .venv\.installed exists.
:: 2. Auto-installs standalone Python 3.12 via uv if Python is not installed.
:: 3. Auto-detects NVIDIA GPUs (nvidia-smi) to install CUDA-accelerated PyTorch.
:: ============================================================================

set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"

if exist ".venv\.installed" (
    if exist ".venv\Scripts\python.exe" (
        call ".venv\Scripts\python.exe" app.py
        exit /b 0
    )
)

echo --------------------------------------------------------------------
echo   REMOVEBG // FIRST-TIME LOCAL SETUP
echo --------------------------------------------------------------------

if not exist ".venv" (
    where uv >nul 2>nul
    if !errorlevel! equ 0 (
        echo [1/2] Creating virtual environment with uv...
        uv venv .venv --python 3.12
    ) else (
        where python >nul 2>nul
        if !errorlevel! equ 0 (
            echo [1/2] Creating local Python virtual environment ^(.venv^)...
            python -m venv .venv
        ) else (
            echo [1/2] Python not found. Automatically installing standalone Python via uv...
            powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
            set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"
            uv venv .venv --python 3.12
        )
    )
)

if not exist ".venv\.installed" (
    echo [2/2] Installing AI engine dependencies ^(one-time setup^)...
    where uv >nul 2>nul
    if !errorlevel! equ 0 (
        where nvidia-smi >nul 2>nul
        if !errorlevel! equ 0 (
            echo       NVIDIA GPU detected — installing CUDA-accelerated PyTorch...
            uv pip install --python ".venv\Scripts\python.exe" torch torchvision --index-url https://download.pytorch.org/whl/cu124
        )
        uv pip install --python ".venv\Scripts\python.exe" -r requirements.txt
    ) else (
        call ".venv\Scripts\pip.exe" install --upgrade pip -q
        where nvidia-smi >nul 2>nul
        if !errorlevel! equ 0 (
            echo       NVIDIA GPU detected — installing CUDA-accelerated PyTorch...
            call ".venv\Scripts\pip.exe" install torch torchvision --index-url https://download.pytorch.org/whl/cu124
        )
        call ".venv\Scripts\pip.exe" install -r requirements.txt
    )
    type nul > ".venv\.installed"
)

call ".venv\Scripts\python.exe" app.py
pause
