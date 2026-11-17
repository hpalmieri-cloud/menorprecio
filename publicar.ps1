# Actualiza los precios y publica el sitio en Cloudflare Pages.
#
# Se ejecuta a diario desde el Programador de tareas de Windows. La descarga
# del SEPA tiene que hacerse desde una conexion argentina: desde IPs de
# datacenter (GitHub Actions) el sitio responde 403 o directamente no responde.
#
# Requiere las variables de usuario CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$sello = Get-Date -Format "yyyyMMdd-HHmm"
$log = Join-Path $logDir ("publicar-" + $sello + ".log")

function Escribir($texto) {
    $linea = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $texto
    $linea | Tee-Object -FilePath $log -Append
}

function Correr($nombre, $exe, $argumentos) {
    Escribir ("-> " + $nombre)
    & $exe @argumentos *>&1 | Tee-Object -FilePath $log -Append | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Escribir ("FALLO " + $nombre + " (codigo " + $LASTEXITCODE + ")")
        exit 1
    }
}

Escribir "Inicio"

$env:PYTHONIOENCODING = "utf-8"
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Escribir ("Falta el entorno virtual en " + $py)
    exit 1
}

Correr "Descargar y normalizar" $py @("pipeline\ingest.py")
Correr "Clasificar productos" $py @("pipeline\productos.py")
Correr "Generar sitio" $py @("pipeline\build.py")

$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "User")
$env:CLOUDFLARE_ACCOUNT_ID = [Environment]::GetEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID", "User")
if (-not $env:CLOUDFLARE_API_TOKEN) {
    Escribir "Falta CLOUDFLARE_API_TOKEN"
    exit 1
}

$env:CI = "1"
$env:WRANGLER_SEND_METRICS = "false"
$env:PATH = (Join-Path $root "tools\node") + ";" + $env:PATH
$wrangler = Join-Path $root "tools\node\wrangler.cmd"

Correr "Publicar en Cloudflare" $wrangler @(
    "pages", "deploy", "dist",
    "--project-name=menorprecio",
    "--branch=main",
    "--commit-dirty=true"
)

Escribir "Listo"
