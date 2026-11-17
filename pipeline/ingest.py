"""Descarga el volcado diario del SEPA y lo normaliza a parquet.

Uso:
    python pipeline/ingest.py                # descarga el ZIP del día
    python pipeline/ingest.py --from-dir X   # usa CSV ya extraídos (desarrollo)
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import duckdb

from config import (
    CSV,
    DATA,
    PRECIO_MAXIMO,
    PRECIO_MINIMO,
    PRECIOS_PARQUET,
    RAW,
    SEPA_API,
    SEPA_ZIP_FALLBACK,
)

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
}

SQL_NORMALIZA = """
CREATE OR REPLACE TABLE precios AS
SELECT
    p.id_comercio                       AS id_comercio,
    p.id_bandera                        AS id_bandera,
    p.id_sucursal                       AS id_sucursal,
    p.id_comercio || '-' || p.id_sucursal AS suc_key,
    p.id_producto                       AS ean,
    upper(trim(p.productos_descripcion)) AS nombre,
    nullif(upper(trim(p.productos_marca)), '') AS marca,
    TRY_CAST(p.productos_precio_lista AS DOUBLE)          AS precio_lista,
    TRY_CAST(p.productos_precio_unitario_promo1 AS DOUBLE) AS promo1,
    nullif(trim(p.productos_leyenda_promo1), '')           AS promo1_leyenda,
    TRY_CAST(p.productos_precio_unitario_promo2 AS DOUBLE) AS promo2,
    nullif(trim(p.productos_leyenda_promo2), '')           AS promo2_leyenda,
    TRY_CAST(p.productos_cantidad_presentacion AS DOUBLE)  AS cantidad,
    upper(trim(p.productos_unidad_medida_presentacion))    AS unidad,
    c.comercio_bandera_nombre           AS bandera,
    c.comercio_razon_social             AS razon_social,
    trim(s.sucursales_nombre)           AS sucursal,
    trim(s.sucursales_tipo)             AS tipo,
    trim(s.sucursales_calle)            AS calle,
    trim(s.sucursales_numero)           AS numero,
    trim(s.sucursales_localidad)        AS localidad,
    trim(s.sucursales_provincia)        AS provincia,
    TRY_CAST(s.sucursales_latitud AS DOUBLE)  AS lat,
    TRY_CAST(s.sucursales_longitud AS DOUBLE) AS lng
FROM read_csv(
    '{productos}',
    delim = '|', header = true, quote = '', escape = '',
    strict_mode = false, ignore_errors = true, all_varchar = true
) p
LEFT JOIN read_csv(
    '{comercio}',
    delim = '|', header = true, quote = '', escape = '',
    strict_mode = false, ignore_errors = true, all_varchar = true
) c USING (id_comercio, id_bandera)
LEFT JOIN read_csv(
    '{sucursales}',
    delim = '|', header = true, quote = '', escape = '',
    strict_mode = false, ignore_errors = true, all_varchar = true
) s USING (id_comercio, id_bandera, id_sucursal)
WHERE regexp_matches(p.id_producto, '^[0-9]{{13}}$')
  AND p.productos_precio_lista IS NOT NULL
  AND TRY_CAST(p.productos_precio_lista AS DOUBLE) BETWEEN {pmin} AND {pmax};
"""


def abrir(url: str, timeout: int = 120):
    """Abre una URL con cabeceras de navegador.

    El WAF de datos.produccion.gob.ar devuelve 403 al User-Agent por defecto de
    urllib, sobre todo desde direcciones de datacenter (GitHub Actions).
    """
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout)


def elegir_volcado() -> tuple[str, str]:
    """Pide la API de datos abiertos y devuelve el ZIP más reciente.

    El dataset publica 7 archivos (uno por día) y el día que corresponde se
    reemplaza por el volcado nuevo. Fijar `sepa_lunes.zip` haría que el cron
    republicara el lunes toda la semana, así que se ordena por `last_modified`.
    """
    try:
        with abrir(SEPA_API, timeout=60) as r:
            data = json.load(r)
        recursos = [
            x for x in data["result"]["resources"]
            if x.get("format", "").upper() == "ZIP"
            and str(x.get("url", "")).endswith(".zip")
            and "/sepa_" in str(x.get("url", ""))
        ]
        if not recursos:
            raise ValueError("la API no devolvió recursos ZIP")
        recursos.sort(key=lambda x: x.get("last_modified") or "", reverse=True)
        mejor = recursos[0]
        desc = mejor.get("description") or mejor.get("name") or ""
        return mejor["url"], desc
    except Exception as e:  # red caída, cambio de esquema, etc.
        print(f"  Aviso: no se pudo consultar la API ({e}). Uso el respaldo.")
        return SEPA_ZIP_FALLBACK, "respaldo"


def descargar(url: str, destino: Path, intentos: int = 3) -> Path:
    destino.parent.mkdir(parents=True, exist_ok=True)
    print(f"Descargando {url}")
    for n in range(1, intentos + 1):
        try:
            with abrir(url) as r, open(destino, "wb") as f:
                shutil.copyfileobj(r, f, length=1 << 20)
            print(f"  {destino} ({destino.stat().st_size / 1e6:.0f} MB)")
            return destino
        except Exception as e:
            if n == intentos:
                raise
            espera = 20 * n
            print(f"  Falló ({e}). Reintento {n}/{intentos - 1} en {espera}s.")
            time.sleep(espera)
    return destino


def extraer(zip_path: Path, destino: Path) -> str | None:
    """El ZIP exterior contiene un ZIP por comercio; cada uno trae 3 CSV.

    Devuelve la fecha del relevamiento detectada en los nombres de archivo.
    """
    if destino.exists():
        shutil.rmtree(destino)
    destino.mkdir(parents=True)
    tmp = destino / "_outer"
    tmp.mkdir()
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)

    internos = sorted(tmp.rglob("*.zip"))
    fecha = None
    ok = vacios = 0
    for z in internos:
        if fecha is None:
            m = re.search(r"(\d{4}-\d{2}-\d{2})", z.name)
            if m:
                fecha = m.group(1)
        sub = destino / z.stem
        sub.mkdir(exist_ok=True)
        if z.stat().st_size == 0:
            vacios += 1
            continue
        try:
            with zipfile.ZipFile(z) as iz:
                iz.extractall(sub)
            ok += 1
        except zipfile.BadZipFile:
            vacios += 1
    shutil.rmtree(tmp)
    print(f"  comercios extraídos: {ok} (vacíos o corruptos: {vacios})")
    return fecha


def normalizar(csv_dir: Path) -> int:
    con = duckdb.connect()
    sql = SQL_NORMALIZA.format(
        productos=(csv_dir / "*" / "productos.csv").as_posix(),
        comercio=(csv_dir / "*" / "comercio.csv").as_posix(),
        sucursales=(csv_dir / "*" / "sucursales.csv").as_posix(),
        pmin=PRECIO_MINIMO,
        pmax=PRECIO_MAXIMO,
    )
    con.execute(sql)
    con.execute(
        f"COPY precios TO '{PRECIOS_PARQUET.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    filas = con.execute("SELECT COUNT(*) FROM precios").fetchone()[0]
    productos = con.execute("SELECT COUNT(DISTINCT ean) FROM precios").fetchone()[0]
    print(f"  {filas:,} precios · {productos:,} productos · {PRECIOS_PARQUET}")
    return filas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-dir", type=Path, default=None,
                    help="carpeta con CSV ya extraídos (omite la descarga)")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)

    if args.from_dir:
        csv_dir = args.from_dir.resolve()
        print(f"Usando CSV locales: {csv_dir}")
    else:
        url, descripcion = elegir_volcado()
        print(f"Volcado elegido: {descripcion}")
        zip_path = RAW / "sepa.zip"
        descargar(url, zip_path)
        fecha = extraer(zip_path, CSV)
        if fecha:
            (DATA / "fecha.txt").write_text(fecha)
        csv_dir = CSV

    normalizar(csv_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
