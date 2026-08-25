@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title E.V.A - Iniciador

REM ── Log de inicio ──────────────────────────────────────────────
set "LOG=%~dp0eva-startup.log"
echo ============================================================ > "%LOG%"
echo   E.V.A - Inicio: %date% %time% >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo. >> "%LOG%"

echo ============================================================
echo   E.V.A - Entidad de Verificacion Administrativa
echo ============================================================
echo.
echo   Los mensajes tambien se guardan en: eva-startup.log
echo.

REM ── Diagnostico del sistema ────────────────────────────────────
echo [SYS] Windows: %OS% %PROCESSOR_ARCHITECTURE% >> "%LOG%"
echo [SYS] Carpeta: %~dp0 >> "%LOG%"
echo.
echo [SYS] Diagnostico del sistema:
echo   OS       : %OS% %PROCESSOR_ARCHITECTURE%
echo   Carpeta  : %~dp0
echo.

REM ── 1. Motor Bun (se descarga solo la primera vez) ──────────
echo [1/4] Verificando motor Bun...
echo [1/4] Verificando motor Bun... >> "%LOG%"

if not exist "bin\bun.exe" (
  echo   Motor Bun no encontrado. Descargando ^(solo la primera vez^)...
  echo   Motor Bun no encontrado. Descargando... >> "%LOG%"
  where curl >nul 2>nul
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: no se encontro 'curl'. Se requiere Windows 10 o superior.
    echo   Instalelo desde: https://aka.ms/curl
    echo.
    echo   ERROR: curl no encontrado >> "%LOG%"
    pause
    exit /b 1
  )
  mkdir bin 2>nul
  echo   Descargando bun-windows-x64.zip...
  curl -fsSL -o bin\bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: no se pudo descargar Bun. Revise su conexion a internet.
    echo   Detalle: el curl devolvio error !errorlevel!
    echo.
    echo   ERROR: descarga de Bun fallo, curl error !errorlevel! >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Descomprimiendo...
  tar -xf bin\bun.zip -C bin
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: no se pudo descomprimir bun.zip
    echo.
    echo   ERROR: tar fallo >> "%LOG%"
    pause
    exit /b 1
  )
  if exist "bin\bun-windows-x64\bun.exe" (
    move /y "bin\bun-windows-x64\bun.exe" "bin\bun.exe" >nul
    rmdir /s /q "bin\bun-windows-x64" 2>nul
  )
  del /q "bin\bun.zip" 2>nul
  if not exist "bin\bun.exe" (
    echo.
    echo   ERROR: bun.exe no se encontro despues de descomprimir.
    echo   Contenido de bin\:
    dir /b "bin\" 2>nul
    echo.
    echo   ERROR: bun.exe no encontrado post-extraccion >> "%LOG%"
    dir /b "bin\" >> "%LOG%" 2>nul
    pause
    exit /b 1
  )
  echo   Motor Bun descargado correctamente.
  echo   Motor Bun descargado OK >> "%LOG%"
) else (
  echo   Motor Bun listo.
  echo   Motor Bun listo >> "%LOG%"
)
echo.

REM ── 2. Librerias web (three.js, TalkingHead) ────────────────
echo [2/4] Verificando librerias web...
echo [2/4] Verificando librerias web... >> "%LOG%"
if not exist "node_modules" (
  echo   node_modules no encontrado. Instalando librerias ^(solo la primera vez^)...
  echo   Instalando librerias... >> "%LOG%"
  bin\bun.exe install --frozen-lockfile
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: fallo 'bun install'. Codigo de error: !errorlevel!
    echo.
    echo   ERROR: bun install fallo, error !errorlevel! >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Librerias instaladas.
  echo   Librerias instaladas OK >> "%LOG%"
) else (
  echo   Librerias web listas.
  echo   Librerias web listas >> "%LOG%"
)
echo.

REM ── 3. Python + voz local ───────────────────────────────────
echo [3/4] Preparando voz local ^(Piper^)...
echo [3/4] Preparando Python y Piper... >> "%LOG%"
set "PY="
REM Intentar py launcher primero (mas fiable que 'python')
where py >nul 2>nul
if !errorlevel! equ 0 (
  py -3 --version >nul 2>nul
  if !errorlevel! equ 0 (
    set "PY=py -3"
    echo   Python encontrado via 'py -3'
    echo   Python encontrado via py -3 >> "%LOG%"
  )
)
REM Intentar 'python' — verificar que no sea el stub del Microsoft Store
if not defined PY (
  where python >nul 2>nul
  if !errorlevel! equ 0 (
    python --version >nul 2>nul
    if !errorlevel! equ 0 (
      set "PY=python"
      echo   Python encontrado via 'python'
      echo   Python encontrado via python >> "%LOG%"
    ) else (
      echo   AVISO: se encontro 'python' pero no responde ^(probablemente es el stub de Microsoft Store^).
      echo   AVISO: python stub de Store detectado >> "%LOG%"
    )
  )
)
if not defined PY (
  echo.
  echo   No se encontro Python en el sistema.
  echo   Intentando instalar automaticamente via winget...
  echo   Python no encontrado. Intentando winget... >> "%LOG%"
  where winget >nul 2>nul
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: 'winget' no esta disponible. No se puede instalar Python automaticamente.
    echo.
    echo   Instale Python 3.10+ manualmente desde:
    echo     https://www.python.org/downloads/
    echo.
    echo   IMPORTANTE: Marque "Add Python to PATH" durante la instalacion.
    echo   Despues de instalar, reinicie la PC y vuelva a ejecutar este archivo.
    echo.
    echo   ERROR: winget no disponible para instalar Python >> "%LOG%"
    pause
    exit /b 1
  )
  winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: winget fallo al instalar Python ^(error !errorlevel!^).
    echo.
    echo   Instale Python 3.10+ manualmente desde:
    echo     https://www.python.org/downloads/
    echo.
    echo   IMPORTANTE: Marque "Add Python to PATH" durante la instalacion.
    echo   Despues de instalar, reinicie la PC y vuelva a ejecutar este archivo.
    echo.
    echo   ERROR: winget instPython fallo, error !errorlevel! >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Python instalado via winget. Verificando...
  echo   Python instalado via winget >> "%LOG%"
  where py >nul 2>nul
  if !errorlevel! equ 0 (
    py -3 --version >nul 2>nul
    if !errorlevel! equ 0 set "PY=py -3"
  )
  if not defined PY (
    where python >nul 2>nul
    if !errorlevel! equ 0 (
      python --version >nul 2>nul
      if !errorlevel! equ 0 set "PY=python"
    )
  )
)
if not defined PY (
  echo.
  echo   ERROR: No se encontro un Python funcional en el sistema.
  echo.
  echo   Si 'python' existe pero no funciona, es probablemente el stub de Microsoft Store.
  echo   Solucion: desinstalelo desde Configuracion ^> Aplicaciones ^> "Python"
  echo   e instale Python real desde https://www.python.org/downloads/
  echo.
  echo   IMPORTANTE: Marque "Add Python to PATH" durante la instalacion.
  echo   Despues de instalar, reinicie la PC y vuelva a ejecutar este archivo.
  echo.
  echo   ERROR: Python no encontrado funcional >> "%LOG%"
  pause
  exit /b 1
)
echo   Usando: %PY%
echo   Usando: %PY% >> "%LOG%"
echo.

REM ── 3b. Entorno virtual ─────────────────────────────────────
if not exist ".venv\Scripts\python.exe" (
  echo   Creando entorno virtual...
  echo   Creando entorno virtual... >> "%LOG%"
  %PY% -m venv .venv
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: no se pudo crear el entorno virtual ^(venv^).
    echo   Codigo de error: !errorlevel!
    echo.
    echo   Esto puede ocurrir si Python no incluye el modulo 'venv'.
    echo   Reinstale Python marcando "Add to PATH" y con opcion "pyvenv.cfg".
    echo.
    echo   ERROR: venv fallo, error !errorlevel! >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Entorno virtual creado.
  echo   Entorno virtual creado OK >> "%LOG%"
) else (
  echo   Entorno virtual listo.
  echo   Entorno virtual listo >> "%LOG%"
)

REM ── 3c. Paquetes Piper / Whisper ─────────────────────────────
".venv\Scripts\python.exe" -m pip show piper-tts >nul 2>nul
if !errorlevel! neq 0 (
  echo.
  echo   Instalando Piper y Whisper ^(descarga grande, solo la primera vez^)...
  echo   Instalando piper-tts y faster-whisper... >> "%LOG%"
  ".venv\Scripts\python.exe" -m pip install --no-warn-script-location piper-tts faster-whisper
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: fallo la instalacion de paquetes de voz.
    echo   Codigo de error: !errorlevel!
    echo.
    echo   ERROR: pip install fallo, error !errorlevel! >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Paquetes de voz instalados.
  echo   Paquetes de voz instalados OK >> "%LOG%"
) else (
  echo   Piper y Whisper ya instalados.
  echo   Piper y Whisper OK >> "%LOG%"
)
echo.

REM ── 3d. Voz Piper (114 MB, solo si falta) ───────────────────
if not exist "voices\es_AR-daniela-high.onnx" (
  echo   Descargando la voz Daniela ^(114 MB, solo la primera vez^)...
  echo   Descargando voz Daniela... >> "%LOG%"
  mkdir voices 2>nul
  curl -fsSL -o voices\es_AR-daniela-high.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx?download=true"
  if !errorlevel! neq 0 (
    echo.
    echo   ERROR: no se pudo descargar la voz. Revise su conexion a internet.
    echo.
    echo   ERROR: descarga de voz fallo >> "%LOG%"
    pause
    exit /b 1
  )
  echo   Voz Daniela descargada.
  echo   Voz Daniela descargada OK >> "%LOG%"
) else (
  echo   Voz Daniela ya disponible.
  echo   Voz Daniela OK >> "%LOG%"
)
echo.

REM ── 4. Arrancar E.V.A ───────────────────────────────────────
echo [4/4] Iniciando E.V.A...
echo [4/4] Iniciando E.V.A... >> "%LOG%"
echo.

REM ── 4a. Lanzar servidor TTS (Python) ─────────────────────────
echo   Iniciando servidor de voz ^(TTS^) en puerto 5000...
echo   Iniciando TTS server... >> "%LOG%"
if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   ERROR: .venv\Scripts\python.exe no existe. Algo fallo en el paso 3.
  echo.
  echo   ERROR: python.exe del venv no encontrado >> "%LOG%"
  pause
  exit /b 1
)
if not exist "tts_server.py" (
  echo.
  echo   ERROR: tts_server.py no se encuentra en %~dp0
  echo.
  echo   ERROR: tts_server.py no encontrado >> "%LOG%"
  pause
  exit /b 1
)
start "EVA-TTS" /min ".venv\Scripts\python.exe" tts_server.py
timeout /t 2 >nul
tasklist /fi "WINDOWTITLE eq EVA-TTS*" /fo csv /nh 2>nul | find /i "python" >nul 2>nul
if !errorlevel! neq 0 (
  echo.
  echo   AVISO: el servidor TTS parece no haber arrancado.
  echo   Verifique que no haya otro proceso usando el puerto 5000.
  echo.
  echo   AVISO: TTS no verificado >> "%LOG%"
) else (
  echo   Servidor TTS iniciado ^(ventana minimizada^).
  echo   Servidor TTS iniciado OK >> "%LOG%"
)

REM ── 4b. Lanzar servidor Bun ──────────────────────────────────
echo   Iniciando servidor web en puerto 3000...
echo   Iniciando Bun server... >> "%LOG%"
if not exist "bin\bun.exe" (
  echo.
  echo   ERROR: bin\bun.exe no existe. Algo fallo en el paso 1.
  echo.
  echo   ERROR: bun.exe no encontrado >> "%LOG%"
  pause
  exit /b 1
)
if not exist "index.ts" (
  echo.
  echo   ERROR: index.ts no se encuentra en %~dp0
  echo.
  echo   ERROR: index.ts no encontrado >> "%LOG%"
  pause
  exit /b 1
)
start "EVA-SERVIDOR" /min "bin\bun.exe" index.ts
timeout /t 2 >nul
tasklist /fi "WINDOWTITLE eq EVA-SERVIDOR*" /fo csv /nh 2>nul | find /i "bun" >nul 2>nul
if !errorlevel! neq 0 (
  echo.
  echo   AVISO: el servidor Bun parece no haber arrancado.
  echo   Verifique que no haya otro proceso usando el puerto 3000.
  echo.
  echo   AVISO: Bun no verificado >> "%LOG%"
) else (
  echo   Servidor Bun iniciado ^(ventana minimizada^).
  echo   Servidor Bun iniciado OK >> "%LOG%"
)
echo.

REM ── 4c. Esperar a que el servidor responda ───────────────────
echo   Esperando a que E.V.A este lista ^(max 40 segundos^)...
echo   Esperando servidor... >> "%LOG%"
set /a "n=0"
:esperar
timeout /t 1 >nul
curl -s -o NUL http://localhost:3000/api/config 2>nul
if !errorlevel! equ 0 goto abrir
set /a "n+=1"
echo   ... esperando ^(%n%/40^)
if !n! lss 40 goto esperar

echo.
echo   AVISO: el servidor tardo demasiado en responder.
echo.
echo   Esto puede deberse a:
echo     - El servidor Bun no arranc correctamente (verifique eva-startup.log)
echo     - Otro programa usa el puerto 3000
echo     - Falta la clave GEMINI_API_KEY en el entorno
echo.
echo   Abra http://localhost:3000 manualmente si quiere intentar.
echo.
echo   AVISO: servidor no responde en 40s >> "%LOG%"
goto fin

:abrir
start "" http://localhost:3000
echo.
echo   E.V.A esta lista en tu navegador: http://localhost:3000
echo   Pega tu clave de Gemini API en el panel inferior derecho y pulsa Verify.
echo.
echo   Para DETENER E.V.A ejecuta:  Cerrar-EVA-WINDOWS.bat
echo   ^(esta ventana puedes minimizarla; si la cierras E.V.A sigue activa^).
echo.
echo   E.V.A iniciada correctamente >> "%LOG%"

:fin
echo.
echo ============================================================
echo   Log guardado en: eva-startup.log
echo ============================================================
echo.
echo   Log completado: %date% %time% >> "%LOG%"
pause
