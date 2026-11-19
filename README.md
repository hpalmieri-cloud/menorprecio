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
  ubicaciones.py provincias ISO y normalización de localidades
  build.py      genera el sitio estático (HTML, JSON, sitemap)
site/
  templates/    plantillas Jinja2
  static/       CSS, JS del buscador, JS de zonas y favicon
.github/
  workflows/
    actualizar.yml   pipeline manual (sin cron)
publicar.ps1    actualización diaria + deploy (Programador de tareas)
data/           parquet y fecha del relevamiento (no se versiona)
dist/           sitio generado (no se versiona)
logs/           salidas de cada actualización (no se versiona)
tools/          uv, Python, Node y wrangler portátiles (no se versiona)
```

## Alcance del MVP

- 3.000 fichas de producto seleccionadas por disponibilidad
  (`n_cadenas >= 4`, fuera códigos internos) con cuota de 500 por categoría.
- 15 páginas de categoría, hub `/precios/`, portada con buscador.
- Buscador de zona: autocompletado de **432 localidades** desde 3 letras (con
  la provincia cuando el nombre se repite), geolocalización del navegador y
  preferencia guardada en `localStorage`.
- Con una zona elegida, la búsqueda de productos filtra a los que se venden en
  esa localidad y muestra el precio y el comercio de ahí; si el producto no
  está, ofrece verlo en todo el país.
- Con zona elegida, la ficha y los listados muestran **solo precios de esa
  localidad**: se ocultan el resumen nacional, las sucursales de otras
  localidades y la tabla por provincia, y las tarjetas sin precio local dicen
  «No está en tu zona». Un botón vuelve a la vista de todo el país.
- Cada ficha muestra el precio por cadena en cada una de las 24 provincias.
- `/precios/zona/` y una página por provincia con los 30 precios más bajos.
- Los precios por localidad y cadena se cargan aparte, desde
  `/datos/zona/<ean>.json` y `/datos/localidad/<id>.json`, solo cuando hay una
  zona elegida: la ficha no engorda y el visitante sin zona no descarga nada
  extra.
- Índices de búsqueda por letra en `/datos/indice/*.json`.
- Los índices del buscador cubren esas mismas 3.000 fichas: todo resultado
  tiene página propia.

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

## Publicación

Sitio publicado: **https://menorprecio.com.ar** (proyecto de Pages
`menorprecio`, también accesible en `menorprecio.pages.dev`).

### Por qué no lo actualiza GitHub Actions

`datos.produccion.gob.ar` **solo responde a conexiones argentinas**. Desde los
runners de GitHub (IPs de datacenter en EE. UU.) la API de CKAN y la descarga
del ZIP devuelven `403`, y desde otros puntos del exterior la conexión
directamente expira. Probado con `User-Agent` de navegador: el bloqueo es por
IP, no por cabeceras.

Por eso la actualización corre en la PC, con el **Programador de tareas de
Windows**:

| | |
|---|---|
| Tarea | `MenorPrecio - actualizar y publicar` |
| Horario | todos los días 14:30 (ART) |
| Si la PC estaba apagada | corre al encenderse (`StartWhenAvailable`) |
| Script | `publicar.ps1` |
| Logs | `logs/publicar-*.log` (no se versionan) |

`publicar.ps1` encadena `ingest.py` → `productos.py` → `build.py` y publica el
resultado con `wrangler pages deploy`.

### Credenciales

Node y wrangler viven en `tools/` (portátiles, no versionados). Las
credenciales se guardan como variables de usuario de Windows:

```powershell
setx CLOUDFLARE_API_TOKEN "<token con permiso Cloudflare Pages: Edit>"
setx CLOUDFLARE_ACCOUNT_ID "<account id>"
```

El token se crea en *Mi perfil → Tokens de API* con un único permiso
(`Cuenta → Cloudflare Pages → Editar`) y **sin vencimiento**; si se filtra,
basta con revocarlo y reemplazar la variable de usuario.

Para una actualización manual:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File publicar.ps1
```

El workflow `.github/workflows/actualizar.yml` quedó **sin cron, solo manual**,
para probar cambios del pipeline donde la descarga sí funcione (por ejemplo un
runner self-hosted argentino).

### Dominio

`menorprecio.com.ar` ya sirve el sitio nuevo: el proyecto de Pages `menorprecio`
tiene el dominio como *custom domain*, con certificado activo. `www` redirige
con 301 al dominio principal mediante una regla de página de Cloudflare, para
no duplicar contenido.

El sitio anterior quedó en el Worker `menor-precio-2`, sin hostnames asignados:
no recibe tráfico, pero sigue existiendo por si hace falta volver atrás.

---

## Monetización

Cableado listo, falta el ID de editor. En `pipeline/config.py`:

```python
ADSENSE_CLIENT = ""   # "ca-pub-1234567890123456" cuando esté aprobado
```

Con el ID cargado, el build inyecta el script en el `<head>` de todas las
páginas y genera `ads.txt` con la línea de Google. Con el valor vacío no se
publica nada. Antes de activar anuncios personalizados conviene sumar un aviso
de consentimiento de cookies.

---

## Licencia y atribución

Datos: **CC BY 4.0**. Es obligatorio acreditar al SEPA y enlazar la licencia en
todas las páginas de precios; ya está en el pie de cada plantilla.

Las marcas, nombres comerciales e imágenes pertenecen a sus titulares. El sitio
no usa fotos de comercios y no tiene vínculo con el Estado ni con las cadenas.

## Aviso

Los precios son los informados por los comercios al SEPA y pueden diferir en
góndola. El reclamo formal por diferencias corresponde al SEPA: 0800-666-1518.
