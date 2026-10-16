@echo off
rem Removes the OpenBGR Explorer context-menu entries (per-user).
reg delete "HKCU\Software\Classes\SystemFileAssociations\image\shell\OpenBGR.RemoveBG" /f >nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\image\shell\OpenBGR.Open" /f >nul 2>&1
echo [Done] Context menu entries removed.
