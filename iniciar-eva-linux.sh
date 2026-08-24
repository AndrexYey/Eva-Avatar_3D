#!/bin/bash
# E.V.A — lanzador para Linux (ejecutable o: bash iniciar-eva-linux.sh)
set -u
cd "$(dirname "$0")"

echo "============================================================"
echo "  E.V.A - Entidad de Verificación Administrativa"
echo "============================================================"

cleanup() {
  [ -n "${TTS_PID:-}" ] && kill "$TTS_PID" 2>/dev/null
}
trap cleanup INT TERM EXIT

# ── 1. Motor Bun (solo la primera vez) ─────────────────────────────────
if [ ! -x bin/bun ]; then
  echo "[1/4] Descargando el motor de E.V.A (solo la primera vez)..."
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64|arm64) B=bun-linux-aarch64 ;;
    *)             B=bun-linux-x64 ;;
  esac
  mkdir -p bin
  curl -fsSL -o bin/bun.zip "https://github.com/oven-sh/bun/releases/latest/download/$B.zip" || {
    echo "  ERROR: no se pudo descargar. Revise su conexión a internet."; read -r -p "Enter para salir"; exit 1; }
  unzip -q bin/bun.zip -d bin/
  mv "bin/$B/bun" bin/bun
  chmod +x bin/bun
  rm -rf bin/bun.zip "bin/$B"
else
  echo "[1/4] Motor listo."
fi

# ── 2. Python 3 + venv ──────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  echo "[2/4] Instalando Python 3 (pedirá su contraseña)..."
  sudo apt-get install -y python3 python3-venv 2>/dev/null || {
    echo "  ERROR: instale Python 3 con el gestor de paquetes de su distribución."
    read -r -p "Enter para salir"; exit 1; }
fi
echo "[2/4] Python listo."

# ── 3. Librerías + voz local (solo la primera vez) ──────────────────────
echo "[3/4] Preparando librerías y voz local..."
[ -d node_modules ] || ./bin/bun install --frozen-lockfile || { echo "  ERROR al instalar librerías."; read -r -p "Enter para salir"; exit 1; }
if [ ! -x .venv/bin/python ]; then python3 -m venv .venv || { echo "  ERROR: instale el paquete python3-venv de su distribución."; read -r -p "Enter para salir"; exit 1; }; fi
if ! ./.venv/bin/python -m pip show piper-tts >/dev/null 2>&1; then
  echo "  Instalando Piper y Whisper (descarga grande, solo la primera vez)..."
  ./.venv/bin/pip install --quiet piper-tts faster-whisper || {
    echo "  ERROR al instalar los paquetes de voz."; read -r -p "Enter para salir"; exit 1; }
fi

# Voz Piper (114 MB, solo si falta — GitHub no aloja el .onnx)
if [ ! -f voices/es_AR-daniela-high.onnx ]; then
  echo "  Descargando la voz Daniela (114 MB, solo la primera vez)..."
  mkdir -p voices
  curl -fsSL -o voices/es_AR-daniela-high.onnx \
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx?download=true" || {
    echo "  ERROR al descargar la voz."; read -r -p "Enter para salir"; exit 1; }
fi

# ── 4. Arrancar E.V.A ────────────────────────────────────────────────────
echo "[4/4] Iniciando E.V.A..."
./.venv/bin/python tts_server.py &
TTS_PID=$!

# Esperar a que responda y abrir el navegador
(
  for _ in $(seq 1 40); do
    curl -s -o /dev/null http://localhost:3000/api/config && break
    sleep 1
  done
  xdg-open http://localhost:3000 >/dev/null 2>&1 || true
) &

echo ""
echo "  E.V.A se está iniciando. Se abrirá tu navegador en http://localhost:3000"
echo "  Pega tu clave de Gemini API en el panel inferior derecho y pulsa Verify."
echo ""
echo "  Para DETENER E.V.A cierra esta ventana (o pulsa Ctrl+C)."
./bin/bun index.ts
