# Menor Precio

Comparador de precios de supermercados de Argentina, construido sobre los datos
abiertos del **SEPA — Precios Claros** (Secretaría de Comercio de la Nación).

Reemplaza la versión anterior de `menorprecio.com.ar`, que dependía de un
endpoint interno no documentado y se caía con frecuencia.

---

## Por qué la versión anterior fallaba

El sitio publicado consultaba desde el navegador:

```js
const CLOUD_API = "https://d3e6htiiul5ek9.cloudfront.net/prod/";
```

Un endpoint interno del SEPA, **sin contrato ni documentación**, con un proxy
propio como respaldo. Todo el trabajo (búsqueda, detalle, geolocalización)
ocurría en el cliente. Si el endpoint cambiaba, tardaba o aplicaba CORS, la
página quedaba en «actualización en curso».

## Qué hace distinto esta versión

**No consulta ningún endpoint en tiempo de ejecución.** Descarga el volcado
oficial diario, lo procesa una vez y publica HTML estático.

```
datos.produccion.gob.ar  →  GitHub Actions + Python + DuckDB  →  HTML estático  →  Cloudflare Pages
```

Ventajas: carga instantánea, sin CORS, sin dependencia de un backend ajeno,
indexable por Google y coste de hosting cero en el plan gratuito.

---

## Datos de partida (censo del 2026-11-16)

| Métrica | Valor |
|---|---|
| Registros de precio | 14.917.722 |
| Productos distintos (EAN-13) | 81.455 |
| Cadenas (comercios) | 16 |
| Banderas | 30 |
| Sucursales (clave comercio+sucursal) | 2.998 |
| Filas con promo A | 1.294.944 (8,7 %) |
| Filas con promo B | 514.370 (3,4 %) |
| Precio mediana | $4.750 |
| Productos > $5 M (outliers) | 332 |

Cobertura por provincia: CABA 807 sucursales, Buenos Aires 713, Santa Fe 167,
Córdoba 89, Mendoza 72, Río Negro 66. El resto, menos de 60 cada una.

Cadenas presentes: Carrefour (incl. Maxi, Market, Express), ChangoMàs, Coto,
Cooperativa Obrera, Día, La Anónima (incl. Topsy, Bomba), Toledo, Axion,
Farmcity, Vea/Disco/Jumbo, California, Comodín, Mariano Max, Unicoop y otras.

## Trampas del dataset (verificadas)

1. **`productos_ean` no es el EAN.** Es un flag (1/0). El código real está en
   `id_producto`. Un parseo ingenuo deja la base sin productos.
2. **No hay categoría.** El CSV no trae rubro ni subcategoría: hay que
   clasificar los ~81 k productos por nombre y marca.
3. **Códigos internos.** Algunos `id_producto` empiezan con `0` o `2` y son
   PLU de productos pesados, no EAN comerciales.
4. **Marcas basura.** `SIN MARCA`, `S/D` y `GENERICO` concentran cientos de
   miles de filas.
5. **Precios extremos.** Hay filas de más de $12 M; se filtran como outliers.
6. **Duplicados.** 2.409 pares (sucursal, EAN) repetidos.
7. **Un ZIP vacío.** El comercio 36 viene con un archivo de 0 bytes: hay que
   tolerar fallos sin abortar el proceso.
8. **`id_sucursal` no es único global.** Solo lo es dentro de cada comercio.
   Se usa la clave compuesta `id_comercio-id_sucursal`.
9. **El dataset rota 7 archivos.** Hay un ZIP por día de la semana
   (`sepa_lunes.zip`, `sepa_martes.zip`, …) y cada uno se reemplaza el día que
   le toca. Si el cron siempre baja `sepa_lunes.zip`, publica el lunes toda la
   semana. `ingest.py` consulta la API de datos abiertos y elige el recurso con
   `last_modified` más reciente.

## Clasificación

Cada producto se asigna a una de 16 categorías con reglas regex sobre
`strip_accents(nombre || ' ' || marca)`. Dos cuidados importantes:

- **Orden por especificidad**: mascotas y bebés antes de carnes/almacén,
  porque «ALIM. P/GATOS … PESCADO» o «LECHE INFANTIL» mencionan palabras de
  otras categorías.
- **Anclas `\b` en tokens cortos**: sin anclas, «CRIOLLA» caía en bazar
  (OLLA), «TIRABUZÓN» en textil (BUZO) y «SENSODYNE» en textil (BODY).

---

## Estructura

```
pipeline/
  config.py     rutas, URL del volcado y límites de sanidad
  ingest.py     descarga el ZIP diario, extrae y normaliza a parquet
  productos.py  arma el maestro de productos y asigna categorías
  build.py      genera el sitio estático (HTML, JSON, sitemap)
site/
  templates/    plantillas Jinja2
  static/       CSS, JS del buscador y favicon
.github/
  workflows/
    actualizar.yml   cron diario + deploy a Cloudflare Pages
data/           parquet y fecha del relevamiento (no se versiona)
dist/           sitio generado (no se versiona)
tools/          uv y Python portátil (no se versiona)
```

## Alcance del MVP

- 3.000 fichas de producto seleccionadas por disponibilidad
  (`n_cadenas >= 4`, fuera códigos internos) con cuota de 500 por categoría.
- 15 páginas de categoría, hub `/precios/`, portada con buscador.
- Índices de búsqueda por letra en `/datos/indice/*.json`.
- Resto del catálogo accesible por búsqueda, sin ficha propia.

---

## Cómo correrlo en local

El proyecto no requiere instalar Python en el sistema: usa un toolchain
portátil dentro de `tools/`.

### Primera vez

```powershell
# uv portátil
curl.exe -sL -o tools\uv.zip https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip
Expand-Archive -Force tools\uv.zip tools

# Python 3.12 dentro del proyecto
$env:UV_PYTHON_INSTALL_DIR = "$PWD\tools\python"
.\tools\uv.exe python install 3.12

# entorno virtual + dependencias
.\tools\uv.exe venv .venv -p 3.12
.\tools\uv.exe pip install duckdb jinja2 --python .venv\Scripts\python.exe
```

### Uso diario

```powershell
# pipeline completo (descarga ~335 MB y procesa)
.\.venv\Scripts\python.exe pipeline\ingest.py
.\.venv\Scripts\python.exe pipeline\productos.py
.\.venv\Scripts\python.exe pipeline\build.py
```

Para desarrollo, reutilizando CSV ya extraídos:

```powershell
.\.venv\Scripts\python.exe pipeline\ingest.py --from-dir "ruta\a\csv"
```

La fecha del relevamiento se detecta en el nombre de los ZIP internos y se
guarda en `data/fecha.txt`. El build la usa para el `<lastmod>` del sitemap y
para los textos.

El resultado queda en `dist/`. Para verlo:

```powershell
.\.venv\Scripts\python.exe -m http.server 8000 -d dist
```

---

## Publicación en Cloudflare Pages

1. Crear un proyecto de Pages llamado `menorprecio`.
2. En el repositorio de GitHub, cargar dos secretos:
   - `CLOUDFLARE_API_TOKEN` — token con permiso *Cloudflare Pages: Edit*.
   - `CLOUDFLARE_ACCOUNT_ID` — ID de la cuenta.
3. El workflow `.github/workflows/actualizar.yml` corre todos los días a las
   **17:00 UTC (14:00 ART)**, procesa el volcado y despliega en la rama `main`.

El SEPA publica el archivo alrededor de las 13:20 ART, así que hay margen.

También se puede disparar a mano desde *Actions → Actualizar precios → Run
workflow*.

### Dominio

`menorprecio.com.ar` ya está en Cloudflare. Cuando el sitio nuevo esté
aprobado, en el proyecto de Pages: *Custom domains → Set up a domain*, y se
reemplaza el destino actual. No cambiar el DNS antes de aprobar el contenido.

---

## Monetización

Pendiente: el dominio necesita su propia revisión de AdSense (el alta de la
versión anterior no se hereda). Cuando esté aprobado hay que agregar:

- el script de AdSense en `site/templates/base.html`;
- `ads.txt` en `dist/` (o en `site/static/` para que lo copie el build);
- un bloque de consentimiento si se activa publicidad personalizada.

---

## Licencia y atribución

Datos: **CC BY 4.0**. Es obligatorio acreditar al SEPA y enlazar la licencia en
todas las páginas de precios; ya está en el pie de cada plantilla.

Las marcas, nombres comerciales e imágenes pertenecen a sus titulares. El sitio
no usa fotos de comercios y no tiene vínculo con el Estado ni con las cadenas.

## Aviso

Los precios son los informados por los comercios al SEPA y pueden diferir en
góndola. El reclamo formal por diferencias corresponde al SEPA: 0800-666-1518.
