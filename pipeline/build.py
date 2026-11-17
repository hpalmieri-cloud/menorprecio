"""Genera el sitio estático a partir de los parquet normalizados."""
from __future__ import annotations

import json
import re
import shutil
import unicodedata
from datetime import date
from pathlib import Path

import duckdb
from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import DATA, DIST, FICHAS_MVP, PRECIOS_PARQUET, PRODUCTOS_PARQUET, SITE

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

    con = duckdb.connect()
    productos, seleccion, fecha = cargar(con)
    eans = [p["ean"] for p in seleccion]
    ofertas = cargar_ofertas(con, eans)

    total_sucursales = con.execute(
        f"SELECT COUNT(DISTINCT suc_key) FROM '{PRECIOS_PARQUET.as_posix()}'"
    ).fetchone()[0]

    ctx_base = {
        "fecha_larga": fecha_larga(fecha),
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

        # Primero la sucursal más barata de cada cadena; después el resto.
        vistas: set[str] = set()
        primeras, resto = [], []
        for o in ops:
            if o["bandera"] not in vistas:
                vistas.add(o["bandera"])
                primeras.append(o)
            else:
                resto.append(o)
        mostrar = (primeras + resto)[:OFERTAS_POR_FICHA]

        por_cadena: dict[str, list[float]] = {}
        for o in ops:
            por_cadena.setdefault(o["bandera"], []).append(o["precio"])
        cadena_ctx = [{
            "bandera": b,
            "min_fmt": ars(min(v)),
            "max_fmt": ars(max(v)),
            "n": len(v),
        } for b, v in sorted(por_cadena.items(), key=lambda kv: min(kv[1]))]

        pmin, pmax = p["precio_min"], p["precio_max"]
        dif = (pmax or 0) - (pmin or 0)
        pct = (dif / pmin * 100) if pmin else 0

        similares = [
            {
                "ean": s["ean"],
                "nombre_corto": corto(s["nombre"]),
                "marca": (s["marca_limpia"] or "").title(),
                "precio_min_fmt": ars(s["precio_min"]),
            }
            for s in por_categoria[p["categoria"]]
            if s["ean"] != p["ean"] and s["precio_min"]
        ][:6]

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
            titulo=f"{corto(p['nombre'], 60)} — precio desde {ars(pmin)} | Menor Precio",
            descripcion=(f"Precio de {corto(p['nombre'], 70).lower()} en Argentina: "
                         f"desde {ars(pmin)} hasta {ars(pmax)} en {p['n_sucursales']} sucursales. "
                         f"Comparado por cadena al {fecha_larga(fecha)}."),
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
            parrafo=parrafo,
            similares=similares,
            jsonld=jsonld,
        ), encoding="utf-8")

    # --- buscador ---
    indices: dict[str, list] = {}
    for p in productos:
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

    (DIST / "_headers").write_text(
        "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n"
        "/datos/*\n  Cache-Control: public, max-age=3600\n\n"
        "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n",
        encoding="utf-8",
    )

    urls = ["/", "/precios/", "/precios/como-funciona/", "/privacidad.html", "/contacto.html"]
    urls += [f"/precios/{c['slug']}/" for c in categorias_ctx]
    urls += [f"/precios/producto/{e}/" for e in eans]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sitemap.append(f"  <url><loc>{BASE_URL}{u}</loc><lastmod>{fecha.isoformat()}</lastmod></url>")
    sitemap.append("</urlset>")
    (DIST / "sitemap.xml").write_text("\n".join(sitemap), encoding="utf-8")

    print(f"Portada, {len(categorias_ctx)} categorías, {len(eans)} fichas, "
          f"{len(indices)} índices de búsqueda")
    print(f"Salida: {DIST}")


if __name__ == "__main__":
    main()
