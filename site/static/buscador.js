// Buscador de productos sobre índices por letra.
// Si hay una localidad elegida, filtra a los productos que se venden ahí y
// muestra el precio y el comercio de esa localidad.
(function () {
  "use strict";

  const input = document.getElementById("q");
  const caja = document.getElementById("resultados");
  if (!input || !caja) return;

  const CLAVE = "menorprecio.zona";
  const MAX = 12;

  // El índice y los precios se regeneran con cada volcado; el sufijo evita la
  // copia vieja que deja el CDN con cache inmutable.
  const meta = document.querySelector('meta[name="mp-version"]');
  const sufijo = meta && meta.content ? `?v=${encodeURIComponent(meta.content)}` : "";

  const panel = document.getElementById("panel-localidad");

  const cache = new Map();
  let timer = null;
  let turno = 0;
  let zona = null;
  let local = null;
  let cargandoLocal = null;
  let todoElPais = false;

  const LETRAS = "abcdefghijklmnopqrstuvwxyz_".split("");

  const norm = (s) => (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const letra = (s) => {
    const c = norm(s).charAt(0);
    return /[a-z]/.test(c) ? c : "_";
  };

  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));

  function leerZona() {
    try {
      return JSON.parse(localStorage.getItem(CLAVE) || "null");
    } catch (e) {
      return null;
    }
  }

  async function cargarLetra(letraInicial) {
    if (cache.has(letraInicial)) return cache.get(letraInicial);
    try {
      const r = await fetch(`/datos/indice/${letraInicial}.json${sufijo}`);
      if (!r.ok) return [];
      const datos = await r.json();
      cache.set(letraInicial, datos);
      return datos;
    } catch (e) {
      return [];
    }
  }

  // Todos los índices juntos pesan poco (~200 KB) y quedan en memoria.
  async function cargarTodo() {
    await Promise.all(LETRAS.map(cargarLetra));
    return LETRAS.reduce((acc, l) => acc.concat(cache.get(l) || []), []);
  }

  function filtrar(indices, q, mapa) {
    const hits = [];
    let fuera = 0;
    for (const item of indices) {
      if (!(norm(item[1]).includes(q) || norm(item[2]).includes(q))) continue;
      if (mapa) {
        const enZona = mapa.get(item[0]);
        if (!enZona) {
          fuera += 1;
          continue;
        }
        hits.push({ item, precio: enZona[0], cadena: enZona[1], local: true });
      } else {
        hits.push({ item, precio: item[3], cadena: "", local: false });
      }
      if (hits.length >= MAX) break;
    }
    return { hits, fuera };
  }

  // Precio de cada producto en la localidad elegida: ean -> [precio, cadena].
  function cargarLocal(z) {
    if (!z || !z.id) return Promise.resolve(null);
    if (local && local.id === z.id) return Promise.resolve(local.mapa);
    if (cargandoLocal && cargandoLocal.id === z.id) return cargandoLocal.p;

    const p = fetch(`/datos/localidad/${encodeURIComponent(z.id)}.json${sufijo}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return null;
        const cadenas = d.c || [];
        const mapa = new Map();
        const t = d.t || [];
        for (let i = 0; i + 2 < t.length; i += 3) {
          mapa.set(t[i], [t[i + 1], cadenas[t[i + 2]] || ""]);
        }
        local = { id: z.id, mapa };
        return mapa;
      })
      .catch(() => null)
      .then((mapa) => {
        cargandoLocal = null;
        return mapa;
      });

    cargandoLocal = { id: z.id, p };
    return p;
  }

  function marcarPanel(oculto) {
    if (panel) panel.classList.toggle("oculto-busqueda", oculto);
  }

  function ocultar() {
    caja.hidden = true;
    caja.innerHTML = "";
    marcarPanel(false);
  }

  function pintar(texto, hits, ctx) {
    const cabecera = ctx.conZona
      ? `<div class="r-zona">Precios en ${esc(zona.nombre)}</div>`
      : "";

    if (!hits.length) {
      let aviso = `Sin resultados para “${esc(texto)}”.`;
      if (ctx.conZona && ctx.fuera) {
        aviso = `No encontramos “${esc(texto)}” en ${esc(zona.nombre)}.`;
      } else if (ctx.conZona) {
        aviso = `“${esc(texto)}” no figura en el relevamiento de ${esc(zona.nombre)}.`;
      }
      const boton = ctx.conZona && ctx.fuera
        ? '<button type="button" class="r-pais" id="r-pais">Ver precios en todo el país</button>'
        : "";
      caja.innerHTML = `${cabecera}<div class="vacio">${aviso}${boton}</div>`;
      const b = document.getElementById("r-pais");
      if (b) {
        b.addEventListener("click", () => {
          todoElPais = true;
          buscar();
        });
      }
      caja.hidden = false;
      marcarPanel(true);
      return;
    }

    const filas = hits.map(({ item, precio, cadena, local }) => {
      const ean = item[0];
      const nombre = item[1];
      const marca = item[2];
      const donde = local
        ? `<small class="r-cadena">${esc(cadena)}</small>`
        : "";
      return `<a href="/precios/producto/${esc(ean)}/">
        <span>${esc(nombre)}${marca ? ` <small>· ${esc(marca)}</small>` : ""}${donde}</span>
        <span class="r-precio">${pesos(precio)}</span>
      </a>`;
    }).join("");

    caja.innerHTML = cabecera + filas;
    caja.hidden = false;
    marcarPanel(true);
  }

  async function buscar() {
    const texto = input.value.trim();
    const q = norm(texto);
    if (q.length < 2) {
      ocultar();
      return;
    }

    const mio = ++turno;
    const conZona = Boolean(zona && !todoElPais);

    let indices = await cargarLetra(letra(q));
    const mapa = conZona ? await cargarLocal(zona) : null;
    if (mio !== turno) return; // llegó una búsqueda más nueva

    let r = filtrar(indices, q, mapa);
    if (r.hits.length < MAX) {
      // El nombre puede no empezar con la letra buscada («coca cola» dentro de
      // «Gaseosa Coca-Cola»): se completa con el resto de los índices.
      indices = await cargarTodo();
      if (mio !== turno) return;
      r = filtrar(indices, q, mapa);
    }

    // Si la zona guardada ya no existe, se muestran los precios del país.
    pintar(texto, r.hits, { conZona: Boolean(conZona && mapa), fuera: r.fuera });
  }

  input.addEventListener("input", () => {
    todoElPais = false;
    clearTimeout(timer);
    timer = setTimeout(buscar, 180);
  });

  document.addEventListener("click", (e) => {
    if (!caja.contains(e.target) && e.target !== input) ocultar();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ocultar();
  });

  // La zona se elige en la cabecera: al cambiar, se repite la búsqueda.
  document.addEventListener("mp:zona", (e) => {
    zona = e.detail || leerZona();
    local = null;
    cargandoLocal = null;
    todoElPais = false;
    if (input.value.trim().length >= 2) buscar();
  });

  zona = leerZona();
})();
