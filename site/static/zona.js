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
      cargando = fetch("/datos/localidades.json")
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

  function aplicar(zona) {
    marcarProvincia(zona.iso);
    const ficha = document.getElementById("panel-zona");
    if (ficha) {
      pintarFicha(zona, ficha);
      return;
    }
    const home = document.getElementById("panel-localidad");
    if (home) pintarLocalidad(zona, home);
  }

  async function pintarFicha(zona, panel) {
    const cuerpo = document.getElementById("panel-zona-cuerpo");
    const titulo = document.getElementById("panel-zona-titulo");
    if (!cuerpo) return;
    panel.hidden = false;
    titulo.textContent = `Precios en ${zona.nombre}`;
    cuerpo.innerHTML = '<p class="nota-campo">Buscando precios en tu zona…</p>';

    let d = null;
    try {
      const r = await fetch(`/datos/zona/${panel.dataset.ean}.json`);
      if (r.ok) d = await r.json();
    } catch (e) { /* sin datos locales */ }

    const provincia = zona.iso && d && d.z ? d.z[zona.iso] : null;
    let filas = null;
    if (provincia) {
      const clave = norm(zona.nombre);
      for (const [nombre, precios] of provincia) {
        if (norm(nombre) === clave) {
          filas = precios;
          break;
        }
      }
    }

    if (filas && filas.length) {
      const cadena = (i) => (d && d.b[i]) || "—";
      const pares = [];
      for (let i = 0; i < filas.length; i += 2) {
        pares.push([cadena(filas[i]), filas[i + 1]]);
      }
      pares.sort((a, b) => a[1] - b[1]);
      const cuerpoTabla = pares
        .map(([c, p]) => `<tr><td>${esc(c)}</td><td class="num">${pesos(p)}</td></tr>`)
        .join("");
      cuerpo.innerHTML = `
        <p class="zona-destacado">Más barato: <strong>${pesos(pares[0][1])}</strong>
          en <strong>${esc(pares[0][0])}</strong>.</p>
        <table class="tabla tabla-compacta">
          <thead><tr><th>Comercio</th><th class="num">Precio</th></tr></thead>
          <tbody>${cuerpoTabla}</tbody>
        </table>
        <p class="nota-campo">Precios de lista informados al SEPA el
          ${esc(panel.dataset.fecha)}.
          <a href="/precios/zona/${esc(slugs[zona.iso] || "")}/">Ver todo en
          ${esc(provincias[zona.iso] || "la provincia")}</a>.</p>`;
      return;
    }

    const tr = document.querySelector(`#bloque-provincias tr[data-iso="${zona.iso}"]`);
    const desde = tr ? tr.children[1].textContent.trim() : "";
    const donde = tr ? tr.children[2].textContent.trim() : "";
    if (!desde) {
      cuerpo.innerHTML = `<p>No registramos este producto en ${esc(zona.nombre)}
        ni en el resto de ${esc(provincias[zona.iso] || "la provincia")}.</p>`;
      return;
    }
    cuerpo.innerHTML = `
      <p>No registramos este producto en ${esc(zona.nombre)}.</p>
      <p>En ${esc(provincias[zona.iso] || "la provincia")} está desde
        <strong>${esc(desde)}</strong>${donde ? ` en ${esc(donde)}` : ""}.</p>
      <p class="nota-campo">Puede estar en una localidad cercana:
        <a href="/precios/zona/${esc(slugs[zona.iso] || "")}/">ver precios en
        ${esc(provincias[zona.iso] || "la provincia")}</a>.</p>`;
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
      const r = await fetch(`/datos/localidad/${zona.id}.json`);
      if (!r.ok) throw new Error("sin datos");
      const d = await r.json();
      if (!d.p || !d.p.length) throw new Error("vacio");
      cuerpo.innerHTML = d.p.map(([ean, nombre, marca, precio, bandera]) => `
        <a class="tarjeta-producto" href="/precios/producto/${esc(ean)}/">
          <span class="prod-nombre">${esc(nombre)}</span>
          <span class="prod-marca">${esc(marca || "Sin marca")}</span>
          <span class="prod-precio">${pesos(precio)}</span>
          <span class="prod-dato">${esc(bandera)}</span>
        </a>`).join("");
      if (pie) {
        pie.innerHTML = `Precios de lista del ${esc(panel.dataset.fecha || "")} en
          ${esc(zona.nombre)}, ${esc(provincias[zona.iso] || "")}.
          <a href="/precios/zona/${esc(slugs[zona.iso] || "")}/">Ver todo en
          ${esc(provincias[zona.iso] || "la provincia")}</a>.`;
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

  cargar().then(() => {
    if (!guardada || !guardada.iso) return;
    input.value = guardada.nombre;
    marcarEstado(guardada);
    aplicar(guardada);
  });
})();
