@echo off
setlocal EnableDelayedExpansion
rem ============================================================================
rem OpenBGR - Windows right-click integration (per-user, no admin required)
rem ============================================================================
rem Adds under image files' context menu:
rem   "Remove background with OpenBGR"  -> app.py --cli "file"   (headless)
rem   "Open in OpenBGR"                 -> app.py "file"         (opens in a tab)
rem
rem Run once from the repo (or extracted release folder). Re-run after moving it.
rem ============================================================================

cd /d "%~dp0.."
set "ROOT=%CD%"

rem Prefer the packaged launcher: it self-provisions the venv on first run and
rem forwards arguments, so the context menu works even before first GUI launch.
set "APPEXE=%ROOT%\OpenBGR.exe"
set "PYW=%ROOT%\.venv\Scripts\pythonw.exe"
if exist "%APPEXE%" goto useexe
if not exist "%PYW%" set "PYW=%ROOT%\.venv\Scripts\python.exe"
if not exist "%PYW%" (
    echo [OpenBGR] Neither OpenBGR.exe nor a virtual environment was found.
    echo           Run start.bat once first, then re-run this installer.
    pause
    exit /b 1
)

set "BASE=HKCU\Software\Classes\SystemFileAssociations\image\shell"

rem --- "Remove background with OpenBGR" (headless cutout) ---------------------
reg add "%BASE%\OpenBGR.RemoveBG" /v MUIVerb /d "Remove background with OpenBGR" /f >nul
reg add "%BASE%\OpenBGR.RemoveBG" /v Icon /d "\"%PYW%\"" /f >nul
reg add "%BASE%\OpenBGR.RemoveBG\command" /ve /d "\"%PYW%\" \"%ROOT%\app.py\" --quick-action \"%%1\"" /f >nul

rem --- "Open in OpenBGR" (loads image into the studio) ------------------------
reg add "%BASE%\OpenBGR.Open" /v MUIVerb /d "Open in OpenBGR" /f >nul
reg add "%BASE%\OpenBGR.Open" /v Icon /d "\"%PYW%\"" /f >nul
reg add "%BASE%\OpenBGR.Open\command" /ve /d "\"%PYW%\" \"%ROOT%\app.py\" \"%%1\"" /f >nul
goto done

:useexe
set "BASE=HKCU\Software\Classes\SystemFileAssociations\image\shell"

rem --- "Remove background with OpenBGR" (headless cutout) ---------------------
reg add "%BASE%\OpenBGR.RemoveBG" /v MUIVerb /d "Remove background with OpenBGR" /f >nul
reg add "%BASE%\OpenBGR.RemoveBG" /v Icon /d "\"%APPEXE%\"" /f >nul
reg add "%BASE%\OpenBGR.RemoveBG\command" /ve /d "\"%APPEXE%\" --quick-action \"%%1\"" /f >nul

rem --- "Open in OpenBGR" (loads image into the studio) ------------------------
reg add "%BASE%\OpenBGR.Open" /v MUIVerb /d "Open in OpenBGR" /f >nul
reg add "%BASE%\OpenBGR.Open" /v Icon /d "\"%APPEXE%\"" /f >nul
reg add "%BASE%\OpenBGR.Open\command" /ve /d "\"%APPEXE%\" \"%%1\"" /f >nul

:done

echo [Done] Context menu entries installed.
echo        Right-click an image file -^> "Remove background with OpenBGR"
echo        or "Open in OpenBGR".
endlocal
