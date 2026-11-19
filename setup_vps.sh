#!/usr/bin/env bash
# Script de aprovisionamiento inicial para el VPS en DonWeb.
set -euo pipefail

echo "=========================================================="
echo "  Iniciando configuración de Menor Precio en DonWeb VPS   "
echo "=========================================================="

# 1. Paquetes del sistema operativo
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-pip python3-venv git curl unzip

# 2. Node.js 20 LTS & Wrangler
if ! command -v node >/dev/null 2>&1; then
    echo "Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "Instalando Wrangler globalmente..."
npm install -g wrangler

# 3. Entorno virtual de Python
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Crear archivo .env si no existe
if [ ! -f .env ]; then
    echo "Configurando credenciales de Cloudflare en .env..."
    cat << 'EOF' > .env
CLOUDFLARE_ACCOUNT_ID=f4cc89a75c13843ecf49e1ab81066a5b
CLOUDFLARE_API_TOKEN=cfut_c94hfyXTFGDtvcIXqgpBZ5VG3clgpjuRU3l6SPHsca554bee
EOF
fi

echo "Creando entorno virtual Python..."
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

chmod +x publicar.sh

# 4. Programar tarea automática (todos los días a las 07:00 AM)
echo "Programando cron diario a las 07:00 AM..."
CRON_CMD="0 7 * * * cd $ROOT && ./publicar.sh >> $ROOT/logs/cron.log 2>&1"
(crontab -l 2>/dev/null | grep -Fv "publicar.sh" ; echo "$CRON_CMD") | crontab -

echo "=========================================================="
echo "  ¡Listo! El servidor está 100% configurado y automatizado"
echo "=========================================================="
