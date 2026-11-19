#!/usr/bin/env bash
# Actualiza los precios y publica el sitio en Cloudflare Pages en Linux (VPS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
SELLO="$(date +%Y%m%d-%H%M)"
LOG="$LOG_DIR/publicar-$SELLO.log"

escribir() {
    local linea="[$(date +%H:%M:%S)] $1"
    echo "$linea" | tee -a "$LOG"
}

correr() {
    local nombre="$1"
    shift
    escribir "-> $nombre"
    if ! "$@" >> "$LOG" 2>&1; then
        escribir "FALLO $nombre"
        exit 1
    fi
}

escribir "Inicio"

export PYTHONIOENCODING="utf-8"
PY="$ROOT/.venv/bin/python3"
if [ ! -f "$PY" ]; then
    escribir "Falta el entorno virtual en $PY"
    exit 1
fi

correr "Descargar y normalizar" "$PY" "pipeline/ingest.py"
correr "Clasificar productos" "$PY" "pipeline/productos.py"
correr "Generar sitio" "$PY" "pipeline/build.py"

export CI="1"
export WRANGLER_SEND_METRICS="false"

if [ -f "$ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    escribir "Falta CLOUDFLARE_API_TOKEN"
    exit 1
fi

WRANGLER="$(which wrangler 2>/dev/null || echo "npx wrangler")"
correr "Publicar en Cloudflare" $WRANGLER pages deploy dist --project-name=menorprecio --branch=main --commit-dirty=true

escribir "Listo"
