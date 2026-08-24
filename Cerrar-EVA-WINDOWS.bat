@echo off
title Cerrar E.V.A
echo Deteniendo E.V.A...
taskkill /fi "WINDOWTITLE eq EVA-TTS*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq EVA-SERVIDOR*" /t /f >nul 2>&1
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5000,3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
echo E.V.A detenida.
timeout /t 2 >nul
