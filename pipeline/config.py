"""Configuración compartida del pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
CSV = RAW / "csv"
DIST = ROOT / "dist"
SITE = ROOT / "site"

# El dataset rota 7 ZIP, uno por día de la semana, y cada uno se reemplaza el
# día que le toca. Por eso no se fija una URL: se consulta la API y se elige el
# recurso con `last_modified` más reciente.
SEPA_API = (
    "https://datos.produccion.gob.ar/api/3/action/package_show"
    "?id=6f47ec76-d1ce-4e34-a7e1-621fe9b1d0b5"
)

# Respaldo por si la API no responde (lunes del dump usado en el censo).
SEPA_ZIP_FALLBACK = (
    "https://datos.produccion.gob.ar/dataset/"
    "6f47ec76-d1ce-4e34-a7e1-621fe9b1d0b5/resource/"
    "0a9069a9-06e8-4f98-874d-da5578693290/download/sepa_lunes.zip"
)

PRECIOS_PARQUET = DATA / "precios.parquet"
PRODUCTOS_PARQUET = DATA / "productos.parquet"

# Límites de sanidad: filas fuera de rango se descartan en la normalización.
PRECIO_MINIMO = 50.0
PRECIO_MAXIMO = 5_000_000.0
# Precios desactualizados o errores: descarta precios < 50% de la mediana si hay >= 3 cadenas.
RATIO_MINIMO_MEDIANA = 0.5

# Cuántas fichas de producto se publican en el MVP.
FICHAS_MVP = 3500

# ID de editor de AdSense ("ca-pub-..."). Vacío = sin anuncios ni ads.txt.
ADSENSE_CLIENT = "ca-pub-1989926070258685"
