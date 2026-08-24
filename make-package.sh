#!/usr/bin/env bash
# Build a self-contained downloadable E.V.A package: dist/EVA-avatar-<fecha>.zip
# The zip is end-user ready: double-click a launcher, no dev tools required.
set -euo pipefail
cd "$(dirname "$0")"

STAMP=$(date +%Y%m%d)
NAME="EVA-avatar-${STAMP}"
mkdir -p dist
OUT="dist/${NAME}.zip"
rm -f "$OUT"

zip -r -q "$OUT" \
  index.ts index.html package.json tsconfig.json bun.lock \
  tts_server.py README.md LEEME.txt \
  Iniciar-EVA-WINDOWS.bat Cerrar-EVA-WINDOWS.bat \
  Iniciar-EVA-MAC.command iniciar-eva-linux.sh \
  src public voices \
  -x "src/*.log" ".DS_Store" "*/.DS_Store"

echo "Paquete creado: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Contenido:"
unzip -l "$OUT" | tail -n +4 | head -20 || true
