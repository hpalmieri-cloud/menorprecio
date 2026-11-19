// Buscador de zona: autocompletado de localidades desde 3 letras, geolocalización
// y precios locales en las fichas de producto.
(function () {
  "use strict";

  const CLAVE = "menorprecio.zona";
  const input = document.getElementById("zona-q");
  const lista = document.getElementById("zona-lista");
  if (!input || !lista) return;

  const gps = document.getElementById("zona-gps");
  const estado = document.getElementById("zona-estado");

  // Los datos cambian con cada relevamiento y los assets se sirven inmutables:
  // el sufijo de versión evita quedarse con una copia vieja en el CDN.
  const meta = document.querySelector('meta[name="mp-version"]');
  const sufijo = meta && meta.content ? `?v=${encodeURIComponent(meta.content)}` : "";

  let datos = null;
  let cargando = null;
  let provincias = {};
  let slugs = {};
  let repetidas = new Set();
  let sugerencias = [];
  let activo = -1;

  const norm = (s) => (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));

  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");

  function cargar() {
    if (datos) return Promise.resolve(datos);
    if (!cargando) {
      cargando = fetch(`/datos/localidades.json${sufijo}`)
        .then((r) => (r.ok ? r.json() : { localidades: [] }))
        .then((d) => {
          datos = d.localidades || [];
          provincias = d.provincias || {};
          slugs = d.slugs || {};
          const cuenta = new Map();
          for (const l of datos) {
            const k = norm(l[0]);
            cuenta.set(k, (cuenta.get(k) || 0) + 1);
          }
          repetidas = new Set(
            [...cuenta].filter(([, n]) => n > 1).map(([k]) => k)
          );
          return datos;
        })
        .catch(() => {
          datos = [];
          return datos;
        });
    }
    return cargando;
  }

  function ocultar() {
    lista.hidden = true;
    input.setAttribute("aria-expanded", "false");
    activo = -1;
  }

  function pintarLista(items) {
    if (!items.length) {
      lista.innerHTML = '<li class="zona-vacio">Sin coincidencias</li>';
      lista.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }
    lista.innerHTML = items.map((l, i) => {
      const prov = provincias[l[1]] || "";
      const aclarar = repetidas.has(norm(l[0]));
      return `<li role="option" data-i="${i}" id="zona-op-${i}"` +
        (i === activo ? ' aria-selected="true"' : "") + `>
        <span>${esc(l[0])}</span>` +
        (aclarar ? `<small>${esc(prov)}</small>` : "") + "</li>";
    }).join("");
    lista.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function buscar(texto) {
    const q = norm(texto);
    if (q.length < 3) {
      ocultar();
      return;
    }
    const empiezan = [];
    const contienen = [];
    for (const l of datos || []) {
      const n = norm(l[0]);
      const hay = l[6] ? `${n} ${norm(l[6])}` : n;
      if (n.startsWith(q)) {
        empiezan.push(l);
        if (empiezan.length >= 8) break;
      } else if (hay.includes(q) && contienen.length < 8) {
        contienen.push(l);
      }
    }
    sugerencias = empiezan.concat(contienen).slice(0, 8);
    activo = -1;
    pintarLista(sugerencias);
  }

  function marcarEstado(zona) {
    if (!estado) return;
    const destino = slugs[zona.iso];
    const provincia = provincias[zona.iso] || zona.nombre;
    if (destino) {
      estado.innerHTML = `<a href="/precios/zona/${esc(destino)}/" ` +
        `title="Ver los precios de ${esc(provincia)}">${esc(provincia)}</a>`;
    } else {
      estado.textContent = provincia;
    }
  }

  function elegir(loc) {
    if (!loc) return;
    const zona = { id: loc[2], nombre: loc[0], iso: loc[1] };
    try {
      localStorage.setItem(CLAVE, JSON.stringify(zona));
    } catch (e) { /* modo privado */ }
    input.value = loc[0];
    marcarEstado(zona);
    ocultar();
    aplicar(zona);
  }

  function marcarProvincia(iso) {
    const filas = document.querySelectorAll("#bloque-provincias tr[data-iso]");
    filas.forEach((tr) => {
      tr.classList.toggle("fila-zona", tr.dataset.iso === iso);
    });
  }

  // La lista de localidades cambia con cada volcado: se valida el id guardado
  // contra la lista del día y, si cambió, se busca por nombre y provincia.
  function zonaVigente(zona) {
    if (!zona || !zona.nombre) return null;
    const lista = datos || [];
    if (lista.some((l) => l[2] === zona.id)) return zona;
    const mismo = lista.find((l) => l[1] === zona.iso && norm(l[0]) === norm(zona.nombre));
    return mismo ? { ...zona, id: mismo[2] } : null;
  }

  function aplicar(zona) {
    zona = zonaVigente(zona);
    if (!zona) {
      // La localidad ya no está en el relevamiento: se vuelve a todo el país.
      document.body.classList.remove("con-zona");
      try {
        localStorage.removeItem(CLAVE);
      } catch (e) { /* modo privado */ }
      return;
    }
    try {
      localStorage.setItem(CLAVE, JSON.stringify(zona));
    } catch (e) { /* modo privado */ }
    document.body.classList.add("con-zona");
    marcarProvincia(zona.iso);
    // El buscador de productos escucha este aviso para filtrar por la zona.
    document.dispatchEvent(new CustomEvent("mp:zona", { detail: zona }));
    const ficha = document.getElementById("panel-zona");
    if (ficha) pintarFicha(zona, ficha);
    const home = document.getElementById("panel-localidad");
    if (home) pintarLocalidad(zona, home);
    localizarTarjetas(zona);
  }

  // Un solo pedido por localidad, compartido por el panel y las tarjetas.
  const cacheLocalidad = new Map();

  function cargarLocalidad(id) {
    if (!cacheLocalidad.has(id)) {
      const p = fetch(`/datos/localidad/${encodeURIComponent(id)}.json${sufijo}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      cacheLocalidad.set(id, p);
    }
    return cacheLocalidad.get(id);
  }

  function mapaLocalidad(d) {
    const cadenas = (d && d.c) || [];
    const mapa = new Map();
    const t = (d && d.t) || [];
    for (let i = 0; i + 2 < t.length; i += 3) {
      mapa.set(t[i], [t[i + 1], cadenas[t[i + 2]] || ""]);
    }
    return mapa;
  }

  function precioOriginal(el) {
    if (el.dataset.pais === undefined) el.dataset.pais = el.textContent;
    return el.dataset.pais;
  }

  // Mientras haya una localidad elegida, ninguna tarjeta muestra el precio
  // mínimo del país: o el de la zona, o «no está en tu zona».
  async function localizarTarjetas(zona) {
    const d = await cargarLocalidad(zona.id);
    if (!d) return;
    const mapa = mapaLocalidad(d);
    document.querySelectorAll('a[href^="/precios/producto/"]').forEach((a) => {
      if (a.closest("#panel-localidad")) return;
      const m = (a.getAttribute("href") || "").match(/\/precios\/producto\/(\d+)\//);
      const precio = a.querySelector(".prod-precio");
      if (!m || !precio) return;
      const enZona = mapa.get(m[1]);
      precioOriginal(precio);
      if (enZona) {
        precio.textContent = pesos(enZona[0]);
        precio.classList.remove("precio-sin-zona");
      } else {
        precio.textContent = "No está en tu zona";
        precio.classList.add("precio-sin-zona");
      }
    });

    document.querySelectorAll("tr[data-ean]").forEach((tr) => {
      const celda = tr.querySelector("[data-precio]");
      if (!celda) return;
      const enZona = mapa.get(tr.dataset.ean);
      precioOriginal(celda);
      if (enZona) {
        celda.textContent = pesos(enZona[0]);
        tr.classList.remove("fila-sin-zona");
      } else {
        celda.textContent = "No está en tu zona";
        tr.classList.add("fila-sin-zona");
      }
    });
  }

  function quitarZona() {
    try {
      localStorage.removeItem(CLAVE);
    } catch (e) { /* modo privado */ }
    document.body.classList.remove("con-zona");
    document.querySelectorAll("[data-pais]").forEach((el) => {
      el.textContent = el.dataset.pais;
      el.classList.remove("precio-sin-zona");
      delete el.dataset.pais;
    });
    document.querySelectorAll(".fila-sin-zona").forEach((el) => el.classList.remove("fila-sin-zona"));
    const ficha = document.getElementById("panel-zona");
    if (ficha) ficha.hidden = true;
    const home = document.getElementById("panel-localidad");
    if (home) home.hidden = true;
    input.value = "";
    if (estado) estado.textContent = "";
    document.dispatchEvent(new CustomEvent("mp:zona", { detail: null }));
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-zona-quitar]")) {
      e.preventDefault();
      quitarZona();
      return;
    }
    if (e.target.closest("[data-zona-cambiar]")) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  async function pintarFicha(zona, panel) {
    const cuerpo = document.getElementById("panel-zona-cuerpo");
    const titulo = document.getElementById("panel-zona-titulo");
    if (!cuerpo) return;
    panel.hidden = false;
    titulo.textContent = `Precios en ${zona.nombre}`;
    cuerpo.innerHTML = '<p class="nota-campo">Buscando precios en tu zona…</p>';

    let d = null;
    try {
      const r = await fetch(`/datos/zona/${encodeURIComponent(panel.dataset.ean)}.json${sufijo}`);
      if (r.ok) d = await r.json();
    } catch (e) { /* sin datos locales */ }

    const provincia = zona.iso && d && d.z ? d.z[zona.iso] : null;
    let fila = null;
    if (provincia) {
      const clave = norm(zona.nombre);
      for (const f of provincia) {
        if (norm(f[0]) === clave) {
          fila = f;
          break;
        }
      }
    }

    const acciones = `<div class="zona-acciones">
      <button type="button" class="zona-boton" data-zona-cambiar>Cambiar de localidad</button>
      <button type="button" class="zona-boton" data-zona-quitar>Ver precios de todo el país</button>
    </div>`;

    if (!fila || !fila[1] || !fila[1].length) {
      cuerpo.innerHTML = `
        <p>No registramos este producto en ${esc(zona.nombre)}.</p>
        <p class="nota-campo">Puede que el comercio no lo haya informado en tu zona
          o que esté sin stock. No mostramos precios de otras localidades.</p>
        ${acciones}`;
      return;
    }

    const cadenas = (d && d.b) || [];
    const pares = [];
    for (let i = 0; i < fila[1].length; i += 2) {
      pares.push([cadenas[fila[1][i]] || "—", fila[1][i + 1]]);
    }
    pares.sort((a, b) => a[1] - b[1]);

    const min = pares[0][1];
    const max = pares[pares.length - 1][1];
    const dif = max - min;
    const pct = min ? Math.round((dif / min) * 100) : 0;
    const sucursales = fila[2] || 0;
    const cuerpoTabla = pares
      .map(([c, p]) => `<tr><td>${esc(c)}</td><td class="num">${pesos(p)}</td></tr>`)
      .join("");

    cuerpo.innerHTML = `
      <p class="zona-destacado">Más barato: <strong>${pesos(min)}</strong>
        en <strong>${esc(pares[0][0])}</strong>.</p>
      <div class="panel-precios panel-precios--zona">
        <div class="dato">
          <span class="etiqueta">Más barato</span>
          <strong class="cifra destacada">${pesos(min)}</strong>
        </div>
        <div class="dato">
          <span class="etiqueta">Más caro</span>
          <strong class="cifra">${pesos(max)}</strong>
        </div>
        <div class="dato">
          <span class="etiqueta">Diferencia</span>
          <strong class="cifra">${pesos(dif)} <span class="pct">(${pct}%)</span></strong>
        </div>
      </div>
      <table class="tabla tabla-compacta">
        <thead><tr><th>Comercio</th><th class="num">Precio</th></tr></thead>
        <tbody>${cuerpoTabla}</tbody>
      </table>
      <p class="nota-campo">
        ${sucursales} ${sucursales === 1 ? "sucursal" : "sucursales"} en
        ${esc(zona.nombre)} · precios de lista informados al SEPA el
        ${esc(panel.dataset.fecha)}.
      </p>
      ${acciones}`;
  }

  async function pintarLocalidad(zona, panel) {
    const cuerpo = document.getElementById("panel-localidad-cuerpo");
    const titulo = document.getElementById("panel-localidad-titulo");
    const pie = document.getElementById("panel-localidad-pie");
    if (!cuerpo) return;
    panel.hidden = false;
    titulo.textContent = `Los 30 más baratos en ${zona.nombre}`;
    cuerpo.innerHTML = '<p class="nota-campo">Buscando precios en tu zona…</p>';
    if (pie) pie.textContent = "";
    try {
      const d = await cargarLocalidad(zona.id);
      if (!d || !d.p || !d.p.length) throw new Error("vacio");
      cuerpo.innerHTML = d.p.map(([ean, nombre, marca, precio, bandera]) => `
        <a class="tarjeta-producto" href="/precios/producto/${esc(ean)}/">
          <span class="prod-nombre">${esc(nombre)}</span>
          <span class="prod-marca">${esc(marca || "Sin marca")}</span>
          <span class="prod-precio">${pesos(precio)}</span>
          <span class="prod-dato">${esc(bandera)}</span>
        </a>`).join("");
      if (pie) {
        pie.innerHTML = `Precios de lista del ${esc(panel.dataset.fecha || "")} en
          ${esc(zona.nombre)}. Buscá un producto arriba para ver su precio acá.
          <button type="button" class="zona-boton" data-zona-quitar>Ver todo el país</button>`;
      }
    } catch (e) {
      cuerpo.innerHTML = `<p class="nota-campo">No pudimos cargar los precios de
        ${esc(zona.nombre)}.</p>`;
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(input._timer);
    input._timer = setTimeout(() => cargar().then(() => buscar(input.value)), 140);
  });

  input.addEventListener("focus", () => {
    cargar().then(() => {
      if (norm(input.value).length >= 3) buscar(input.value);
    });
  });

  input.addEventListener("blur", () => setTimeout(ocultar, 120));

  lista.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    elegir(sugerencias[Number(li.dataset.i)]);
  });

  input.addEventListener("keydown", (e) => {
    if (lista.hidden || !sugerencias.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activo = (activo + (e.key === "ArrowDown" ? 1 : -1) + sugerencias.length) % sugerencias.length;
      pintarLista(sugerencias);
      input.setAttribute("aria-activedescendant", `zona-op-${activo}`);
      const op = document.getElementById(`zona-op-${activo}`);
      if (op) op.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      elegir(sugerencias[activo >= 0 ? activo : 0]);
    } else if (e.key === "Escape") {
      ocultar();
    }
  });

  if (gps) {
    gps.addEventListener("click", () => {
      if (!navigator.geolocation) {
        if (estado) estado.textContent = "Sin geolocalización";
        return;
      }
      if (estado) estado.textContent = "Ubicando…";
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await cargar();
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        let mejor = null;
        let dist = Infinity;
        for (const l of datos) {
          const dy = l[3] - lat;
          const dx = (l[4] - lng) * Math.cos((lat * Math.PI) / 180);
          const d2 = dy * dy + dx * dx;
          if (d2 < dist) {
            dist = d2;
            mejor = l;
          }
        }
        if (mejor) elegir(mejor);
        else if (estado) estado.textContent = "";
      }, () => {
        if (estado) estado.textContent = "No pudimos ubicarte";
      }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 600000 });
    });
  }

  let guardada = null;
  try {
    guardada = JSON.parse(localStorage.getItem(CLAVE) || "null");
  } catch (e) { /* sin preferencia */ }

  // Se oculta el contenido nacional antes de pedir los datos, para que no
  // aparezca un precio de otra localidad mientras carga.
  if (guardada && guardada.iso) document.body.classList.add("con-zona");

  cargar().then(() => {
    if (!guardada || !guardada.iso) return;
    const vigente = zonaVigente(guardada);
    if (!vigente) {
      // La localidad guardada ya no está en el relevamiento de hoy.
      document.body.classList.remove("con-zona");
      try {
        localStorage.removeItem(CLAVE);
      } catch (e) { /* modo privado */ }
      return;
    }
    input.value = vigente.nombre;
    marcarEstado(vigente);
    aplicar(vigente);
  });
})();
