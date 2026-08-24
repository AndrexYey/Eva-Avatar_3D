@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title E.V.A - Iniciador
chcp 65001 >nul

echo ============================================================
echo   E.V.A - Entidad de Verificacion Administrativa
echo ============================================================
echo.

REM ── 1. Motor Bun (se descarga solo la primera vez) ──────────
if not exist "bin\bun.exe" (
  echo [1/4] Descargando el motor de E.V.A ^(solo la primera vez^)...
  where curl >nul 2>nul || (
    echo   ERROR: se requiere Windows 10 actualizado ^(incluye curl y tar^).
    pause & exit /b 1
  )
  mkdir bin 2>nul
  curl -fsSL -o bin\bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip || (
    echo   ERROR: no se pudo descargar. Revise su conexion a internet.
    pause & exit /b 1
  )
  tar -xf bin\bun.zip -C bin || (
    echo   ERROR: no se pudo descomprimir el motor.
    pause & exit /b 1
  )
  move /y bin\bun-windows-x64\bun.exe bin\bun.exe >nul
  rmdir /s /q bin\bun-windows-x64
  del /q bin\bun.zip 2>nul
) else (
  echo [1/4] Motor listo.
)

REM ── 2. Librerias web (three.js, TalkingHead) ────────────────
if not exist "node_modules" (
  echo [2/4] Instalando librerias web ^(solo la primera vez^)...
  bin\bun.exe install --frozen-lockfile || (echo   ERROR al instalar librerias. & pause & exit /b 1)
) else (
  echo [2/4] Librerias web listas.
)

REM ── 3. Python + voz local ───────────────────────────────────
echo [3/4] Preparando voz local ^(Piper^)...
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo   No se encontro Python. Instalandolo automaticamente...
  winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements || (
    echo   ERROR: instale Python gratis desde https://www.python.org/downloads/
    echo   y vuelva a ejecutar este archivo.
    pause & exit /b 1
  )
  where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo   ERROR: reinicie el PC tras instalar Python y vuelva a intentarlo.
  pause & exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv || (echo   ERROR al crear el entorno local. & pause & exit /b 1)
)
".venv\Scripts\python.exe" -m pip show piper-tts >nul 2>nul || (
  echo   Instalando Piper y Whisper ^(descarga grande, solo la primera vez^)...
  ".venv\Scripts\python.exe" -m pip install --quiet --no-warn-script-location piper-tts faster-whisper || (
    echo   ERROR al instalar los paquetes de voz.
    pause & exit /b 1
  )
)

REM Voz Piper (114 MB, solo si falta - GitHub no aloja el .onnx)
if not exist "voices\es_AR-daniela-high.onnx" (
  echo   Descargando la voz Daniela ^(114 MB, solo la primera vez^)...
  mkdir voices 2>nul
  curl -fsSL -o voices\es_AR-daniela-high.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx?download=true" || (
    echo   ERROR al descargar la voz. Revise su conexion a internet.
    pause & exit /b 1
  )
)

REM ── 4. Arrancar E.V.A ───────────────────────────────────────
echo [4/4] Iniciando E.V.A...
start "EVA-TTS" /min ".venv\Scripts\python.exe" tts_server.py
start "EVA-SERVIDOR" /min "bin\bun.exe" index.ts

REM Esperar a que responda y abrir el navegador
set /a n=0
:esperar
timeout /t 1 >nul
curl -s -o NUL http://localhost:3000/api/config && goto abrir
set /a n+=1
if %n% lss 40 goto esperar
echo   AVISO: el servidor tardo demasiado en responder. Abra http://localhost:3000 manualmente.
goto fin
:abrir
start "" http://localhost:3000
echo.
echo   E.V.A esta lista en tu navegador: http://localhost:3000
echo   Pega tu clave de Gemini API en el panel inferior derecho y pulsa Verify.
echo.
echo   Para DETENER E.V.A ejecuta:  Cerrar-EVA-WINDOWS.bat
echo   (esta ventana puedes minimizarla; si la cierras E.V.A sigue activa).
:fin
echo.
pause
