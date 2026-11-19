"""Genera el sitio estático a partir de los parquet normalizados."""
from __future__ import annotations

import json
import re
import shutil
import unicodedata
from datetime import date, datetime
from pathlib import Path

import duckdb
from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import (
    ADSENSE_CLIENT,
    DATA,
    DIST,
    FICHAS_MVP,
    PRECIOS_PARQUET,
    PRODUCTOS_PARQUET,
    SITE,
)
from ubicaciones import (
    PROVINCIAS,
    clave_localidad,
    iso_provincia,
    nombre_localidad,
    slug,
    slug_provincia,
    zona_localidad,
)

BASE_URL = "https://menorprecio.com.ar"
OFERTAS_POR_FICHA = 20
PRODUCTOS_POR_CATEGORIA = 100

NOMBRES_CATEGORIA = {
    "lacteos": "Lácteos",
    "bebidas": "Bebidas",
    "almacen": "Almacén",
    "carnes": "Carnes y pescados",
    "frutas_verduras": "Frutas y verduras",
    "panificados": "Panificados",
    "congelados": "Congelados",
    "limpieza": "Limpieza",
    "higiene": "Higiene y perfumería",
    "bebes": "Bebés",
    "mascotas": "Mascotas",
    "textil": "Textil y hogar",
    "bazar": "Bazar y deco",
    "electro": "Electrodomésticos",
    "construccion": "Construcción",
    "otros": "Otros",
}


# ---------- utilidades de formato ----------

def ars(v: float | None) -> str:
    if v is None:
        return "—"
    return "$" + f"{v:,.0f}".replace(",", ".")


def corto(texto: str, limite: int = 58) -> str:
    texto = re.sub(r"\s+", " ", texto).strip()
    if len(texto) <= limite:
        return texto.title()
    recorte = texto[:limite].rsplit(" ", 1)[0]
    return (recorte + "…").title()


def slug_letra(texto: str) -> str:
    base = unicodedata.normalize("NFD", texto)
    base = "".join(c for c in base if unicodedata.category(c) != "Mn").lower()
    m = re.match(r"[a-z]", base)
    return m.group(0) if m else "_"


def fecha_larga(d: date) -> str:
    meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
             "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
    return f"{d.day} de {meses[d.month - 1]} de {d.year}"


def leer_fecha() -> date:
    f = DATA / "fecha.txt"
    if f.exists():
        try:
            return date.fromisoformat(f.read_text().strip())
        except ValueError:
            pass
    return date.today()


# ---------- carga de datos ----------

def cargar(con: duckdb.DuckDBPyConnection):
    fecha = leer_fecha()
    cols = [d[0] for d in con.execute(f"SELECT * FROM '{PRODUCTOS_PARQUET.as_posix()}' LIMIT 0").description]
    productos = [dict(zip(cols, r)) for r in con.execute(
        f"SELECT * FROM '{PRODUCTOS_PARQUET.as_posix()}'"
    ).fetchall()]

    mvp = [p for p in productos
           if p["categoria"] != "otros"
           and (p["n_cadenas"] or 0) >= 4          # comparable entre cadenas
           and not p["ean"].startswith(("0", "2"))]  # fuera códigos internos/PLU
    mvp.sort(key=lambda p: (-(p["n_sucursales"] or 0), p["precio_min"] or 0))
    # cuota por categoría para que ninguna domine
    cuota: dict[str, int] = {}
    seleccion = []
    for p in mvp:
        c = p["categoria"]
        if cuota.get(c, 0) >= 500:
            continue
        cuota[c] = cuota.get(c, 0) + 1
        seleccion.append(p)
        if len(seleccion) >= FICHAS_MVP:
            break
    return productos, seleccion, fecha


def cargar_ofertas(con, eans: list[str]) -> dict[str, list[dict]]:
    if not eans:
        return {}
    lista = ",".join("'" + e.replace("'", "") + "'" for e in eans)
    filas = con.execute(f"""
        SELECT ean, bandera, sucursal, localidad, precio_lista,
               promo1, promo1_leyenda, promo2, promo2_leyenda
        FROM '{PRECIOS_PARQUET.as_posix()}'
        WHERE ean IN ({lista})
        ORDER BY ean, precio_lista
    """).fetchall()
    ofertas: dict[str, list[dict]] = {}
    for ean, bandera, sucursal, localidad, precio, promo1, ley1, promo2, ley2 in filas:
        promo = promo1 if promo1 is not None else promo2
        leyenda = ley1 if promo1 is not None else ley2
        ofertas.setdefault(ean, []).append({
            "bandera": (bandera or "—").strip(),
            "sucursal": (sucursal or "—").strip().title(),
            "localidad": (localidad or "—").strip().title(),
            "precio": precio,
            "precio_fmt": ars(precio),
            "promo_fmt": ars(promo) if promo else "",
            "promo_leyenda": leyenda or "",
        })
    return ofertas


def cargar_ubicaciones(con) -> list[dict]:
    """Localidades con coordenadas y cantidad de sucursales, ya normalizadas."""
    filas = con.execute(f"""
        WITH suc AS (
            SELECT DISTINCT provincia, localidad, suc_key, lat, lng
            FROM '{PRECIOS_PARQUET.as_posix()}'
            WHERE localidad IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
        )
        SELECT provincia, localidad, COUNT(*) AS n, AVG(lat), AVG(lng)
        FROM suc GROUP BY 1, 2
    """).fetchall()

    acumulado: dict[tuple[str, str], dict] = {}
    for prov, loc, n, lat, lng in filas:
        zona = zona_localidad(prov, loc)
        if not zona:
            continue
        iso, clave_loc = zona
        clave = (iso, clave_loc)
        actual = acumulado.get(clave)
        if actual is None:
            acumulado[clave] = {
                "iso": iso,
                "nombre": nombre_localidad(loc),
                "n": n,
                "lat": [lat], "lng": [lng],
            }
        else:
            actual["n"] += n
            actual["lat"].append(lat)
            actual["lng"].append(lng)

    localidades = []
    usados: set[str] = set()
    for (iso, _), d in sorted(acumulado.items()):
        base = f"{slug_provincia(iso)}--{slug(d['nombre'])}"
        ident = base
        i = 2
        while ident in usados:
            ident = f"{base}-{i}"
            i += 1
        usados.add(ident)
        localidades.append({
            "nombre": d["nombre"],
            "iso": iso,
            "id": ident,
            "lat": sum(d["lat"]) / len(d["lat"]),
            "lng": sum(d["lng"]) / len(d["lng"]),
            "n": d["n"],
        })

    # Nombres repetidos en distintas provincias: hay que aclarar cuál es.
    conteo: dict[str, int] = {}
    for l in localidades:
        k = clave_localidad(l["nombre"])
        conteo[k] = conteo.get(k, 0) + 1
    for l in localidades:
        l["repetida"] = conteo[clave_localidad(l["nombre"])] > 1
        # Alias de búsqueda: la ciudad de Buenos Aires también se busca como CABA.
        l["alias"] = "CABA Capital Federal" if l["nombre"] == "Ciudad de Buenos Aires" else ""

    localidades.sort(key=lambda l: (PROVINCIAS[l["iso"]], l["nombre"]))
    return localidades


def cargar_zonas(con, eans: list[str]) -> dict[str, dict[str, list[dict]]]:
    """Precio mínimo por producto, provincia y cadena."""
    if not eans:
        return {}
    lista = ",".join("'" + e.replace("'", "") + "'" for e in eans)
    filas = con.execute(f"""
        SELECT ean, provincia, bandera,
               MIN(precio_lista) AS precio,
               arg_min(localidad, precio_lista) AS localidad,
               COUNT(DISTINCT suc_key) AS n
        FROM '{PRECIOS_PARQUET.as_posix()}'
        WHERE ean IN ({lista}) AND precio_lista > 0 AND provincia IS NOT NULL
        GROUP BY 1, 2, 3
    """).fetchall()
    zonas: dict[str, dict[str, list[dict]]] = {}
    for ean, prov, bandera, precio, localidad, n in filas:
        iso = iso_provincia(prov)
        if not iso:
            continue
        zonas.setdefault(ean, {}).setdefault(iso, []).append({
            "bandera": (bandera or "—").strip(),
            "precio": precio,
            "localidad": nombre_localidad(localidad) if localidad else "",
            "n": n,
        })
    for por_iso in zonas.values():
        for filas_iso in por_iso.values():
            filas_iso.sort(key=lambda r: r["precio"])
    return zonas


def escribir_zonas_locales(con, eans: list[str], destino: Path) -> int:
    """Un JSON por producto con el precio de cada cadena en cada localidad."""
    if not eans:
        return 0
    lista = ",".join("'" + e.replace("'", "") + "'" for e in eans)
    destino.mkdir(parents=True, exist_ok=True)
    cur = con.execute(f"""
        SELECT ean, provincia, localidad, bandera, MIN(precio_lista), COUNT(DISTINCT suc_key)
        FROM '{PRECIOS_PARQUET.as_posix()}'
        WHERE ean IN ({lista}) AND precio_lista > 0
          AND localidad IS NOT NULL AND provincia IS NOT NULL
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4
    """)

    estado = {"ean": None, "cadenas": [], "por_prov": {}}
    escritos = 0

    def cerrar() -> None:
        nonlocal escritos
        idx = {c: i for i, c in enumerate(estado["cadenas"])}
        provincias = {}
        for iso, locales in estado["por_prov"].items():
            filas = []
            for clave in sorted(locales):
                entrada = locales[clave]
                plano: list[int] = []
                for cadena, precio in sorted(entrada["c"].items(), key=lambda kv: kv[1]):
                    plano.extend((idx[cadena], round(precio)))
                filas.append([entrada["n"], plano, entrada["suc"]])
            provincias[iso] = filas
        payload = {"b": estado["cadenas"], "z": provincias}
        (destino / f"{estado['ean']}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        escritos += 1

    while True:
        lote = cur.fetchmany(200_000)
        if not lote:
            break
        for ean, prov, loc, bandera, precio, sucursales in lote:
            if ean != estado["ean"]:
                if estado["ean"] is not None:
                    cerrar()
                estado["ean"] = ean
                estado["cadenas"] = []
                estado["por_prov"] = {}
            zona = zona_localidad(prov, loc)
            if not zona:
                continue
            iso, clave_loc = zona
            cadena = (bandera or "—").strip()
            if cadena not in estado["cadenas"]:
                estado["cadenas"].append(cadena)
            entrada = estado["por_prov"].setdefault(iso, {}).setdefault(
                clave_loc, {"n": nombre_localidad(loc), "c": {}, "suc": 0}
            )
            entrada["suc"] += sucursales
            previo = entrada["c"].get(cadena)
            if previo is None or precio < previo:
                entrada["c"][cadena] = precio

    if estado["ean"] is not None:
        cerrar()
    return escritos


def escribir_localidades(con, eans: list[str], localidades: list[dict],
                         productos: dict[str, dict], destino: Path) -> int:
    """Un JSON por localidad con el precio de cada producto disponible.

    Incluye los 30 más baratos (para la portada) y, aparte, el precio mínimo
    de todos los productos de la zona, que usa el buscador para responder
    «cuánto sale X en mi localidad».
    """
    if not eans:
        return 0
    lista = ",".join("'" + e.replace("'", "") + "'" for e in eans)
    precios = f"'{PRECIOS_PARQUET.as_posix()}'"

    # Mapa (provincia, localidad tal como viene) -> zona normalizada.
    pares = con.execute(f"""
        SELECT DISTINCT provincia, localidad
        FROM {precios}
        WHERE ean IN ({lista}) AND precio_lista > 0
          AND localidad IS NOT NULL AND provincia IS NOT NULL
    """).fetchall()
    con.execute("""
        CREATE TEMP TABLE zona_mapa (
            provincia VARCHAR, localidad VARCHAR, iso VARCHAR, clave VARCHAR
        )
    """)
    mapa_filas = []
    for prov, loc in pares:
        z = zona_localidad(prov, loc)
        if z:
            mapa_filas.append((prov, loc, z[0], z[1]))
    if mapa_filas:
        con.executemany("INSERT INTO zona_mapa VALUES (?, ?, ?, ?)", mapa_filas)

    cur = con.execute(f"""
        SELECT m.iso, m.clave, g.ean, g.precio, g.bandera, g.n
        FROM (
            SELECT provincia, localidad, ean,
                   MIN(precio_lista) AS precio,
                   arg_min(bandera, precio_lista) AS bandera,
                   COUNT(DISTINCT suc_key) AS n
            FROM {precios}
            WHERE ean IN ({lista}) AND precio_lista > 0
              AND localidad IS NOT NULL AND provincia IS NOT NULL
            GROUP BY 1, 2, 3
        ) g
        JOIN zona_mapa m USING (provincia, localidad)
        ORDER BY 1, 2, 4, 3
    """)

    indice = {(l["iso"], clave_localidad(l["nombre"])): l for l in localidades}
    destino.mkdir(parents=True, exist_ok=True)

    estado = {"zona": None, "cadenas": [], "idx": {}, "filas": []}
    escritos = 0

    def cerrar() -> None:
        nonlocal escritos
        if estado["zona"] is None:
            return
        iso, clave_loc = estado["zona"]
        entrada = indice.get((iso, clave_loc))
        if not entrada:
            return
        # Al fusionar variantes de una misma localidad puede haber repetidos:
        # como vienen ordenados por precio, el primero es el más barato.
        filas: list[tuple] = []
        vistos: set[str] = set()
        for ean, precio, idx, n in estado["filas"]:
            if ean in vistos:
                continue
            vistos.add(ean)
            filas.append((ean, precio, idx, n))

        cadenas = estado["cadenas"]
        plano: list = []
        for ean, precio, idx, _ in filas:
            plano.extend((ean, precio, idx))

        top = []
        for ean, precio, idx, n in filas:
            p = productos.get(ean)
            if not p:
                continue
            top.append([
                ean,
                corto(p["nombre"], 64),
                (p["marca_limpia"] or "").title(),
                precio,
                cadenas[idx],
                n,
            ])
            if len(top) >= 30:
                break

        payload = {
            "n": entrada["nombre"],
            "iso": iso,
            "provincia": PROVINCIAS[iso],
            "c": cadenas,
            "p": top,
            "t": plano,
        }
        (destino / f"{entrada['id']}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        escritos += 1

    while True:
        lote = cur.fetchmany(200_000)
        if not lote:
            break
        for iso, clave_loc, ean, precio, bandera, n in lote:
            if (iso, clave_loc) != estado["zona"]:
                cerrar()
                estado["zona"] = (iso, clave_loc)
                estado["cadenas"] = []
                estado["idx"] = {}
                estado["filas"] = []
            cadena = (bandera or "—").strip()
            idx = estado["idx"].get(cadena)
            if idx is None:
                idx = len(estado["cadenas"])
                estado["cadenas"].append(cadena)
                estado["idx"][cadena] = idx
            estado["filas"].append((ean, round(precio), idx, n))

    cerrar()
    return escritos


# ---------- render ----------

def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    env = Environment(
        loader=FileSystemLoader(SITE / "templates"),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals["adsense"] = ADSENSE_CLIENT

    con = duckdb.connect()
    productos, seleccion, fecha = cargar(con)
    eans = [p["ean"] for p in seleccion]
    ofertas = cargar_ofertas(con, eans)
    localidades = cargar_ubicaciones(con)
    zonas = cargar_zonas(con, eans)

    total_sucursales = con.execute(
        f"SELECT COUNT(DISTINCT suc_key) FROM '{PRECIOS_PARQUET.as_posix()}'"
    ).fetchone()[0]

    ctx_base = {
        "fecha_larga": fecha_larga(fecha),
        "version": datetime.now().strftime("%Y%m%d%H%M"),
        "total_productos": f"{len(productos):,}".replace(",", "."),
        "total_sucursales": f"{total_sucursales:,}".replace(",", "."),
    }

    por_categoria: dict[str, list[dict]] = {}
    for p in productos:
        por_categoria.setdefault(p["categoria"], []).append(p)
    for lst in por_categoria.values():
        lst.sort(key=lambda p: (-(p["n_sucursales"] or 0), p["precio_min"] or 0))

    categorias_ctx = []
    for slug, lista in por_categoria.items():
        if slug == "otros":
            continue
        precios = [p["precio_min"] for p in lista if p["precio_min"]]
        categorias_ctx.append({
            "slug": slug,
            "nombre": NOMBRES_CATEGORIA.get(slug, slug.title()),
            "n_productos": f"{len(lista):,}".replace(",", "."),
            "precio_desde": ars(min(precios)) if precios else "—",
        })
    categorias_ctx.sort(key=lambda c: -int(c["n_productos"].replace(".", "")))

    # --- portada ---
    destacados = []
    for p in seleccion[:12]:
        destacados.append({
            "ean": p["ean"],
            "nombre_corto": corto(p["nombre"]),
            "marca": (p["marca_limpia"] or p["marca"] or "").title(),
            "precio_min_fmt": ars(p["precio_min"]),
            "n_sucursales": p["n_sucursales"],
        })

    brecha = con.execute(f"""
        SELECT AVG((precio_max - precio_min) / nullif(precio_min, 0)) * 100
        FROM '{PRODUCTOS_PARQUET.as_posix()}'
        WHERE n_cadenas >= 5 AND precio_min > 0
    """).fetchone()[0] or 0

    (DIST / "index.html").write_text(env.get_template("index.html").render(
        **ctx_base,
        ruta="/",
        titulo="Menor Precio — Comparador de precios de supermercados de Argentina",
        descripcion=("Precios oficiales de supermercados de Argentina, actualizados "
                     "todos los días. Compará por producto, cadena y sucursal."),
        categorias=categorias_ctx,
        destacados=destacados,
        brecha_promedio=f"{brecha:.0f}",
    ), encoding="utf-8")

    # --- categorías ---
    cat_dir = DIST / "precios"
    for c in categorias_ctx:
        lista = por_categoria[c["slug"]][:PRODUCTOS_POR_CATEGORIA]
        filas = [{
            "ean": p["ean"],
            "nombre_corto": corto(p["nombre"], 70),
            "marca": (p["marca_limpia"] or "").title(),
            "precio_min_fmt": ars(p["precio_min"]),
            "precio_mediana_fmt": ars(p["precio_mediana"]),
            "n_sucursales": p["n_sucursales"],
        } for p in lista]
        destino = cat_dir / c["slug"]
        destino.mkdir(parents=True, exist_ok=True)
        (destino / "index.html").write_text(env.get_template("categoria.html").render(
            **ctx_base,
            ruta=f"/precios/{c['slug']}/",
            titulo=f"Precios de {c['nombre'].lower()} — Menor Precio",
            descripcion=(f"Precios actualizados de {c['nombre'].lower()}: "
                         f"{c['n_productos']} productos comparados por cadena y sucursal en Argentina."),
            nombre=c["nombre"],
            n_productos=c["n_productos"],
            productos=filas,
        ), encoding="utf-8")

    # --- hub de precios y páginas fijas ---
    cat_dir.mkdir(parents=True, exist_ok=True)
    (cat_dir / "index.html").write_text(env.get_template("precios.html").render(
        **ctx_base,
        ruta="/precios/",
        titulo="Precios por categoría — Menor Precio",
        descripcion="Precios oficiales de supermercados de Argentina por rubro, "
                    "comparados por cadena y sucursal.",
        categorias=categorias_ctx,
    ), encoding="utf-8")

    (cat_dir / "como-funciona").mkdir(exist_ok=True)
    (cat_dir / "como-funciona" / "index.html").write_text(
        env.get_template("como-funciona.html").render(
            **ctx_base, ruta="/precios/como-funciona/",
            titulo="Cómo funciona — Menor Precio",
            descripcion="De dónde salen los precios, cómo se calculan los rangos y "
                        "qué no podemos garantizar.",
        ), encoding="utf-8")

    for nombre, archivo, titulo, desc in [
        ("privacidad", "privacidad.html", "Política de privacidad — Menor Precio",
         "Qué datos usa Menor Precio y cómo se gestionan cookies y publicidad."),
        ("contacto", "contacto.html", "Contacto — Menor Precio",
         "Escribinos por precios mal informados, productos faltantes o cadenas ausentes."),
    ]:
        (DIST / archivo).write_text(env.get_template(f"{nombre}.html").render(
            **ctx_base, ruta=f"/{archivo}", titulo=titulo, descripcion=desc,
        ), encoding="utf-8")

    # --- fichas de producto ---
    prod_dir = DIST / "precios" / "producto"
    prod_dir.mkdir(parents=True, exist_ok=True)
    por_ean = {p["ean"]: p for p in productos}

    for p in seleccion:
        ops = ofertas.get(p["ean"], [])
        if not ops:
            continue

        # Las sucursales más baratas primero: el listado va de menor a mayor.
        mostrar = ops[:OFERTAS_POR_FICHA]

        por_cadena: dict[str, list[float]] = {}
        for o in ops:
            por_cadena.setdefault(o["bandera"], []).append(o["precio"])
        cadena_ctx = [{
            "bandera": b,
            "min_fmt": ars(min(v)),
            "max_fmt": ars(max(v)),
            "n": len(v),
        } for b, v in sorted(por_cadena.items(), key=lambda kv: min(kv[1]))]

        prov_ctx = []
        for iso, filas_iso in zonas.get(p["ean"], {}).items():
            barato = filas_iso[0]
            prov_ctx.append({
                "iso": iso,
                "nombre": PROVINCIAS[iso],
                "slug": slug_provincia(iso),
                "precio_fmt": ars(barato["precio"]),
                "bandera": barato["bandera"],
                "localidad": barato["localidad"],
                "n": sum(r["n"] for r in filas_iso),
            })
        prov_ctx.sort(key=lambda r: r["nombre"])

        pmin, pmax = p["precio_min"], p["precio_max"]
        dif = (pmax or 0) - (pmin or 0)
        pct = (dif / pmin * 100) if pmin else 0

        parrafo = (
            f"En el relevamiento del {fecha_larga(fecha)}, {corto(p['nombre'], 90).lower()} "
            f"aparece en {p['n_sucursales']} sucursales de {p['n_cadenas']} cadenas. "
            f"El precio más bajo se registró en {p['mejor_bandera'] or 'una cadena'} "
            f"({(p['mejor_localidad'] or 'sin localidad').title()}) a {ars(pmin)}, y el más alto "
            f"llegó a {ars(pmax)}: una diferencia de {ars(dif)} ({pct:.0f}% sobre el mínimo). "
            f"La mediana del mercado es {ars(p['precio_mediana'])}. "
            f"Si la promo exige tarjeta o programa de fidelidad, conviene compararla contra "
            f"el precio de lista antes de decidir."
        )

        jsonld = json.dumps({
            "@context": "https://schema.org",
            "@type": "Product",
            "name": corto(p["nombre"], 90).title(),
            "gtin13": p["ean"],
            "brand": {"@type": "Brand", "name": (p["marca_limpia"] or "Sin marca").title()},
            "offers": {
                "@type": "AggregateOffer",
                "priceCurrency": "ARS",
                "lowPrice": round(pmin or 0, 2),
                "highPrice": round(pmax or 0, 2),
                "offerCount": p["n_sucursales"],
            },
        }, ensure_ascii=False)

        destino = prod_dir / p["ean"]
        destino.mkdir(exist_ok=True)
        (destino / "index.html").write_text(env.get_template("producto.html").render(
            **ctx_base,
            ruta=f"/precios/producto/{p['ean']}/",
            titulo=f"{corto(p['nombre'], 60)} — precios por cadena y localidad | Menor Precio",
            descripcion=(f"Precios de {corto(p['nombre'], 70).lower()} en supermercados de "
                         f"Argentina, comparables por cadena, provincia y localidad. "
                         f"Datos del SEPA al {fecha_larga(fecha)}."),
            ean=p["ean"],
            nombre=corto(p["nombre"], 90),
            marca=p["marca_limpia"] or p["marca"] or "",
            categoria_slug=p["categoria"],
            categoria_nombre=NOMBRES_CATEGORIA.get(p["categoria"], "Otros"),
            n_sucursales=p["n_sucursales"],
            n_cadenas=p["n_cadenas"],
            precio_min_fmt=ars(pmin),
            precio_mediana_fmt=ars(p["precio_mediana"]),
            precio_max_fmt=ars(pmax),
            diferencia_fmt=ars(dif),
            diferencia_pct=f"{pct:.0f}",
            ofertas=mostrar,
            ofertas_restantes=len(ops) > len(mostrar),
            por_cadena=cadena_ctx,
            provincias=prov_ctx,
            parrafo=parrafo,
            jsonld=jsonld,
        ), encoding="utf-8")

    # --- zonas: precios por provincia y por localidad ---
    zona_dir = DIST / "precios" / "zona"
    zona_dir.mkdir(parents=True, exist_ok=True)

    stats_prov: dict[str, dict] = {}
    for l in localidades:
        s = stats_prov.setdefault(l["iso"], {"n_sucursales": 0, "localidades": []})
        s["n_sucursales"] += l["n"]
        s["localidades"].append(l)

    por_provincia: dict[str, list[tuple]] = {}
    for ean, por_iso in zonas.items():
        for iso, filas_iso in por_iso.items():
            total_n = sum(r["n"] for r in filas_iso)
            por_provincia.setdefault(iso, []).append((total_n, filas_iso[0]["precio"], ean))
    for lista in por_provincia.values():
        # de menor a mayor precio; a igual precio, el que está en más sucursales
        lista.sort(key=lambda t: (t[1], -t[0], t[2]))

    prov_ctx = []
    for iso, nombre in PROVINCIAS.items():
        s = stats_prov.get(iso)
        if not s:
            continue
        s["localidades"].sort(key=lambda l: (-l["n"], l["nombre"]))
        prov_ctx.append({
            "iso": iso,
            "nombre": nombre,
            "slug": slug_provincia(iso),
            "n_sucursales": s["n_sucursales"],
            "n_localidades": len(s["localidades"]),
            "n_productos": len(por_provincia.get(iso, [])),
            "localidades": s["localidades"],
        })
    prov_ctx.sort(key=lambda p: p["nombre"])

    (zona_dir / "index.html").write_text(env.get_template("zona.html").render(
        **ctx_base,
        ruta="/precios/zona/",
        titulo="Precios por zona — Menor Precio",
        descripcion=("Precios de supermercados en cada provincia y localidad de "
                     "Argentina, con las cadenas y sucursales más baratas."),
        provincias=prov_ctx,
    ), encoding="utf-8")

    for prov in prov_ctx:
        top = []
        for _, precio, ean in por_provincia.get(prov["iso"], [])[:30]:
            p = por_ean.get(ean)
            if not p:
                continue
            top.append({
                "ean": ean,
                "nombre_corto": corto(p["nombre"], 70),
                "marca": (p["marca_limpia"] or "").title(),
                "precio_fmt": ars(precio),
                "categoria": NOMBRES_CATEGORIA.get(p["categoria"], "Otros"),
            })
        destino = zona_dir / prov["slug"]
        destino.mkdir(parents=True, exist_ok=True)
        (destino / "index.html").write_text(env.get_template("provincia.html").render(
            **ctx_base,
            ruta=f"/precios/zona/{prov['slug']}/",
            titulo=f"Precios en {prov['nombre']} — Menor Precio",
            descripcion=(f"Los 30 precios más bajos de supermercados en {prov['nombre']}: "
                         f"{prov['n_sucursales']} sucursales en {prov['n_localidades']} localidades."),
            provincia=prov,
            productos=top,
        ), encoding="utf-8")

    datos_dir = DIST / "datos"
    datos_dir.mkdir(parents=True, exist_ok=True)
    (datos_dir / "localidades.json").write_text(json.dumps({
        "provincias": PROVINCIAS,
        "slugs": {iso: slug_provincia(iso) for iso in PROVINCIAS},
        "localidades": [
            [l["nombre"], l["iso"], l["id"], round(l["lat"], 4), round(l["lng"], 4),
             1 if l["repetida"] else 0, l["alias"]]
            for l in localidades
        ],
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    n_zonas = escribir_zonas_locales(con, eans, datos_dir / "zona")
    n_loc = escribir_localidades(con, eans, localidades, por_ean, datos_dir / "localidad")

    # --- buscador ---
    indices: dict[str, list] = {}
    for p in seleccion:
        letra = slug_letra(p["nombre"])
        indices.setdefault(letra, []).append([
            p["ean"],
            corto(p["nombre"], 60),
            (p["marca_limpia"] or "").title(),
            round(p["precio_min"] or 0),
            p["categoria"],
        ])
    idx_dir = DIST / "datos" / "indice"
    idx_dir.mkdir(parents=True)
    for letra, arr in indices.items():
        (idx_dir / f"{letra}.json").write_text(
            json.dumps(arr, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

    # --- assets y páginas fijas ---
    shutil.copytree(SITE / "static", DIST / "assets")

    (DIST / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {BASE_URL}/sitemap.xml\n", encoding="utf-8"
    )

    if ADSENSE_CLIENT:
        pub = ADSENSE_CLIENT.replace("ca-", "")
        (DIST / "ads.txt").write_text(
            f"google.com, {pub}, DIRECT, f08c47fec0942fa0\n", encoding="utf-8"
        )

    (DIST / "_headers").write_text(
        "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n"
        "/datos/*\n  Cache-Control: public, max-age=3600\n\n"
        "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n",
        encoding="utf-8",
    )

    urls = ["/", "/precios/", "/precios/zona/", "/precios/como-funciona/",
            "/privacidad.html", "/contacto.html"]
    urls += [f"/precios/{c['slug']}/" for c in categorias_ctx]
    urls += [f"/precios/zona/{p['slug']}/" for p in prov_ctx]
    urls += [f"/precios/producto/{e}/" for e in eans]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sitemap.append(f"  <url><loc>{BASE_URL}{u}</loc><lastmod>{fecha.isoformat()}</lastmod></url>")
    sitemap.append("</urlset>")
    (DIST / "sitemap.xml").write_text("\n".join(sitemap), encoding="utf-8")

    print(f"Portada, {len(categorias_ctx)} categorías, {len(eans)} fichas, "
          f"{len(indices)} índices de búsqueda")
    print(f"{len(prov_ctx)} provincias, {n_loc} zonas con precios, {n_zonas} fichas con datos locales")
    print(f"Salida: {DIST}")


if __name__ == "__main__":
    main()
