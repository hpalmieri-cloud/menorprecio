// Buscador de productos sobre índices por letra.
// Los resultados se muestran como una tabla independiente debajo del buscador,
// ordenada de menor a mayor precio. Con una localidad elegida, cada fila trae
// el proveedor y la dirección del local más barato de esa zona.
(function () {
  "use strict";

  const input = document.getElementById("q");
  const cuerpo = document.getElementById("resultados");
  const seccion = document.getElementById("resultados-seccion");
  const titulo = document.getElementById("resultados-titulo");
  const nota = document.getElementById("resultados-nota");
  const tabla = document.getElementById("resultados-tabla");
  const vacio = document.getElementById("resultados-vacio");
  const empresas = document.getElementById("resultados-empresas");
  const empresasTitulo = document.getElementById("resultados-empresas-titulo");
  const empresasLista = document.getElementById("resultados-empresas-lista");
  if (!input || !cuerpo || !seccion) return;

  const CLAVE = "menorprecio.zona";
  const MAX = 20;

  // El índice y los precios se regeneran con cada volcado; el sufijo evita la
  // copia vieja que deja el CDN con cache inmutable.
  const meta = document.querySelector('meta[name="mp-version"]');
  const sufijo = meta && meta.content ? `?v=${encodeURIComponent(meta.content)}` : "";

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

  async function cargarLetra(inicial) {
    if (cache.has(inicial)) return cache.get(inicial);
    try {
      const r = await fetch(`/datos/indice/${inicial}.json${sufijo}`);
      if (!r.ok) return [];
      const datos = await r.json();
      cache.set(inicial, datos);
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

  // Precio de cada producto en la localidad elegida:
  // ean -> [precio, cadena, dirección del local más barato].
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
        for (let i = 0; i + 3 < t.length; i += 4) {
          mapa.set(t[i], [t[i + 1], cadenas[t[i + 2]] || "", t[i + 3] || ""]);
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

  function ocultar() {
    seccion.hidden = true;
    cuerpo.innerHTML = "";
    tabla.hidden = true;
    vacio.hidden = true;
    vacio.innerHTML = "";
    empresas.hidden = true;
    empresasLista.innerHTML = "";
  }

  const SINONIMOS = {
    televisor: ["televisor", "smart tv", "led tv", "tv"],
    televisores: ["televisor", "smart tv", "led tv", "tv"],
    tele: ["tv", "smart tv", "led tv"],
    tvs: ["tv", "smart tv", "led tv"],
    heladeras: ["heladera"],
    lavarropa: ["lavarropas"],
    microonda: ["microondas"],
    celulares: ["celular"],
  };

  function procesarHits(seleccion, mapa) {
    const hits = [];
    let fuera = 0;
    for (const { item } of seleccion) {
      if (mapa) {
        const enZona = mapa.get(item[0]);
        if (!enZona) {
          fuera += 1;
          continue;
        }
        hits.push({
          item,
          precio: enZona[0],
          cadena: enZona[1],
          direccion: enZona[2],
          local: true,
        });
      } else {
        hits.push({
          item,
          precio: item[3],
          cadena: item[6] || "",
          direccion: "",
          local: false,
        });
      }
    }
    hits.sort((a, b) =>
      (a.precio || Infinity) - (b.precio || Infinity) ||
      a.item[1].localeCompare(b.item[1], "es")
    );
    const empresas = Array.from(
      new Set(hits.map((h) => h.cadena).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "es"));
    return { hits: hits.slice(0, MAX), empresas, fuera };
  }

  function filtrar(indices, q, mapa) {
    const rawQ = q.trim();
    if (!rawQ) return { hits: [], empresas: [], fuera: 0 };

    // Si es un código numérico (escaneado o tipeado)
    if (/^\d{6,14}$/.test(rawQ)) {
      const qSinCero = rawQ.replace(/^0+/, "");
      const candidatosNum = [];
      for (const item of indices) {
        const eanItem = item[0];
        const eanSinCero = eanItem.replace(/^0+/, "");
        if (eanItem === rawQ || eanSinCero === qSinCero || eanItem.includes(rawQ)) {
          candidatosNum.push({ item, esPrefijo: true });
        }
      }
      if (candidatosNum.length > 0) {
        return procesarHits(candidatosNum, mapa);
      }
    }

    const tokens = rawQ.split(/\s+/).filter(Boolean);
    if (!tokens.length) return { hits: [], empresas: [], fuera: 0 };

    // Expandir tokens con sinónimos (ej: "televisor" busca "smart tv", "led tv", "tv", "televisor")
    const tokensGrupos = tokens.map((t) => {
      const syns = SINONIMOS[t] || [t];
      return syns.map(norm);
    });

    const primerGrupo = tokensGrupos[0];

    // 1. Encontrar todos los productos que contienen las palabras buscadas
    const candidatos = [];
    for (const item of indices) {
      const nom = norm(item[1]);
      const mrc = norm(item[2]);
      const ean = item[0];
      const textoCompleto = nom + " " + mrc + " " + ean;

      // Cada token (o alguno de sus sinónimos) debe figurar en el texto
      const coincide = tokensGrupos.every((grupo) =>
        grupo.some((syn) => textoCompleto.includes(syn))
      );
      if (!coincide) continue;

      // Es prefijo si el nombre comienza con la búsqueda o con el primer término/sinónimo
      const esPrefijo =
        nom.startsWith(q) ||
        primerGrupo.some((syn) =>
          nom.startsWith(syn + " ") || nom.startsWith(syn) || nom === syn
        );

      candidatos.push({ item, esPrefijo });
    }

    // 2. Si hay coincidencias donde el nombre del producto empieza con el término buscado
    // (ej: "leche", "arroz", "aceite", "yerba playadito", "dulce de leche", "heladera", "televisor"), filtramos estrictamente
    // para excluir productos derivados que solo contienen la palabra en el medio (alfajores, flanes, etc.).
    const prefijos = candidatos.filter((c) => c.esPrefijo);
    const usarEstricto =
      prefijos.length >= 3 || (prefijos.length > 0 && prefijos.length === candidatos.length);

    const seleccion = usarEstricto ? prefijos : candidatos;
    return procesarHits(seleccion, mapa);
  }

  function pintarVacio(texto, ctx) {
    titulo.textContent = ctx.conZona
      ? `Precios en ${zona.nombre}`
      : `Resultados para “${texto}”`;
    nota.textContent = "";
    tabla.hidden = true;
    empresas.hidden = true;
    empresasLista.innerHTML = "";

    let aviso = `Sin resultados para “${esc(texto)}”.`;
    if (ctx.conZona && ctx.fuera) {
      aviso = `No encontramos “${esc(texto)}” en ${esc(zona.nombre)}.`;
    } else if (ctx.conZona) {
      aviso = `“${esc(texto)}” no figura en el relevamiento de ${esc(zona.nombre)}.`;
    }
    const boton = ctx.conZona
      ? '<p><button type="button" class="zona-boton" id="r-pais">Ver precios en todo el país</button></p>'
      : "";
    vacio.innerHTML = `<p>${aviso}</p>${boton}`;
    vacio.hidden = false;
    seccion.hidden = false;

    const b = document.getElementById("r-pais");
    if (b) {
      b.addEventListener("click", () => {
        todoElPais = true;
        buscar();
      });
    }
  }

  function pintar(texto, hits, ctx) {
    if (!hits.length) {
      pintarVacio(texto, ctx);
      return;
    }

    titulo.textContent = ctx.conZona
      ? `“${texto}” en ${zona.nombre}`
      : `“${texto}” en todo el país`;
    nota.textContent = ctx.conZona
      ? "Proveedor y dirección del local más barato de tu zona. Ordenado de menor a mayor precio."
      : "Proveedor del precio mínimo nacional. Elegí tu localidad para ver también la dirección. Ordenado de menor a mayor precio.";

    cuerpo.innerHTML = hits.map((h) => {
      const ean = h.item[0];
      const nombre = h.item[1];
      const presentacion = h.item[5] || "";
      const precio = h.precio
        ? (h.local ? pesos(h.precio) : `desde ${pesos(h.precio)}`)
        : "—";
      const url = `/precios/producto/${encodeURIComponent(ean)}/`;
      const subDetalles = [presentacion, h.cadena, h.direccion].filter(Boolean).map(esc).join(" · ");
      return `<tr>
        <td class="col-prod">
          <a class="prod-nombre" href="${url}">${esc(nombre)}</a>
          ${subDetalles ? `<span class="prod-sub-movil">${subDetalles}</span>` : ""}
        </td>
        <td class="col-pres">${esc(presentacion || "—")}</td>
        <td class="col-cadena">${esc(h.cadena || "—")}</td>
        <td class="col-dir">${esc(h.direccion || "—")}</td>
        <td class="num col-precio"><a class="precio-lista" href="${url}">${precio}</a></td>
      </tr>`;
    }).join("");

    tabla.hidden = false;
    vacio.hidden = true;
    vacio.innerHTML = "";

    // Desplegable con las empresas de la búsqueda: solo el nombre, y la
    // cantidad en la cabecera.
    const lista = ctx.empresas || [];
    if (lista.length) {
      empresasTitulo.textContent = `Empresas incluidas (${lista.length})`;
      empresasLista.innerHTML = lista.map((n) => `<li>${esc(n)}</li>`).join("");
      empresas.hidden = false;
    } else {
      empresas.hidden = true;
      empresasLista.innerHTML = "";
    }

    seccion.hidden = false;
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

    const indices = await cargarTodo();
    const mapa = conZona ? await cargarLocal(zona) : null;
    if (mio !== turno) return; // llegó una búsqueda más nueva

    const r = filtrar(indices, q, mapa);
    // Si la zona guardada ya no existe, se muestran los precios del país.
    pintar(texto, r.hits, {
      conZona: Boolean(conZona && mapa),
      fuera: r.fuera,
      empresas: r.empresas,
    });
  }

  input.addEventListener("input", () => {
    todoElPais = false;
    clearTimeout(timer);
    if (input.value.trim().length < 2) {
      ocultar();
      return;
    }
    timer = setTimeout(buscar, 180);
  });

  // La zona se elige en la cabecera: al cambiar, se repite la búsqueda.
  document.addEventListener("mp:zona", (e) => {
    zona = e.detail || leerZona();
    local = null;
    cargandoLocal = null;
    todoElPais = false;
    if (input.value.trim().length >= 2) buscar();
  });

  // ---------- Lector de código de barras con Quagga2 (Cámara) ----------
  const btnEscanear = document.getElementById("btn-escanear");
  const modalEscaner = document.getElementById("modal-escaner");
  const btnCerrarEscaner = document.getElementById("btn-cerrar-escaner");
  const fondoEscaner = document.getElementById("modal-escaner-fondo");
  const escanerMensaje = document.getElementById("escaner-mensaje");
  const escanerManualForm = document.getElementById("escaner-manual-form");
  const escanerManualInput = document.getElementById("escaner-manual-input");
  const escanerManualBtn = document.getElementById("escaner-manual-btn");

  let escaneando = false;
  let ultimoCodigo = null;
  let conteoLecturas = 0;

  function validarChecksumEAN(ean) {
    if (!/^\d{8}$|^\d{12,14}$/.test(ean)) return false;
    const digits = ean.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      const d = digits[digits.length - 1 - i];
      sum += d * (i % 2 === 0 ? 3 : 1);
    }
    const calc = (10 - (sum % 10)) % 10;
    return calc === check;
  }

  async function cargarLibreriaEscaner() {
    if (window.Quagga) return true;
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "/assets/quagga.min.js" + sufijo;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function detenerEscaner() {
    if (window.Quagga && escaneando) {
      try {
        Quagga.stop();
      } catch (e) {}
    }
    escaneando = false;
    const lector = document.getElementById("escaner-lector");
    if (lector) lector.innerHTML = "";
  }

  function cerrarModalEscaner() {
    detenerEscaner();
    if (modalEscaner) modalEscaner.hidden = true;
  }

  async function procesarCodigoDetectado(codigo) {
    const rawEan = String(codigo || "").replace(/\D/g, "").trim();
    if (!rawEan || rawEan.length < 8) return;

    // Normalizar a 13 dígitos si es un UPC de 12 dígitos
    const ean = rawEan.length === 12 ? "0" + rawEan : rawEan;

    // Pausar el escáner para congelar el fotograma y evitar lecturas repetidas
    if (window.Quagga && escaneando) {
      try { Quagga.pause(); } catch (e) {}
    }

    if (navigator.vibrate) {
      try { navigator.vibrate(120); } catch (e) {}
    }

    if (escanerMensaje) {
      escanerMensaje.className = "escaner-mensaje exito";
      escanerMensaje.innerHTML = `¡Código detectado: <strong>${esc(ean)}</strong>!<br>Buscando producto...`;
    }

    // 1. Verificar si está en los índices cargados en memoria
    const indices = await cargarTodo();
    const eanSinCero = ean.replace(/^0+/, "");
    const hit = indices.find((it) => it[0] === ean || it[0].replace(/^0+/, "") === eanSinCero);

    if (hit) {
      if (escanerMensaje) {
        escanerMensaje.innerHTML = `¡Encontrado!<br><strong>${esc(hit[1])}</strong><br><span style="font-size:0.85em;color:#16a34a">Abriendo precios...</span>`;
      }
      setTimeout(() => {
        window.location.href = `/precios/producto/${encodeURIComponent(hit[0])}/`;
      }, 400);
      return;
    }

    // 2. Si no está en el índice directo, intentar chequear si existe la página estática
    try {
      const resp = await fetch(`/precios/producto/${encodeURIComponent(ean)}/`, { method: "HEAD" });
      if (resp.ok) {
        if (escanerMensaje) {
          escanerMensaje.innerHTML = `¡Encontrado!<br><span style="font-size:0.85em;color:#16a34a">Abriendo precios...</span>`;
        }
        setTimeout(() => {
          window.location.href = `/precios/producto/${encodeURIComponent(ean)}/`;
        }, 300);
        return;
      }
    } catch (e) {}

    // 3. Si no existe entre los productos del catálogo actual, no cerrar de golpe el modal:
    detenerEscaner();
    if (escanerMensaje) {
      escanerMensaje.className = "escaner-mensaje aviso";
      escanerMensaje.innerHTML = `
        Código leído: <strong>${esc(ean)}</strong><br>
        <span style="font-size:0.85em;color:#92400e">Este producto específico no está entre los 3.500 más vendidos del catálogo actual.</span><br>
        <div style="margin-top:0.6rem;display:flex;gap:0.4rem;justify-content:center">
          <button type="button" id="btn-escaner-reintentar" style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid #ccc;background:#f3f4f6;font-size:0.85rem;cursor:pointer">Escanear otro</button>
          <button type="button" id="btn-escaner-buscar" style="padding:0.4rem 0.8rem;border-radius:6px;border:none;background:#2563eb;color:#fff;font-size:0.85rem;cursor:pointer">Buscar código</button>
        </div>
      `;

      const btnReintentar = document.getElementById("btn-escaner-reintentar");
      if (btnReintentar) {
        btnReintentar.onclick = () => abrirEscaner();
      }
      const btnBuscar = document.getElementById("btn-escaner-buscar");
      if (btnBuscar) {
        btnBuscar.onclick = () => {
          cerrarModalEscaner();
          input.value = ean;
          buscar();
        };
      }
    }
    input.value = ean;
  }

  async function abrirEscaner() {
    if (!modalEscaner) return;
    modalEscaner.hidden = false;
    if (escanerManualInput) escanerManualInput.value = "";
    if (escanerMensaje) {
      escanerMensaje.className = "escaner-mensaje";
      escanerMensaje.textContent = "Iniciando cámara...";
    }

    // Pre-cargar índices en segundo plano mientras enciende la cámara
    cargarTodo();

    const ok = await cargarLibreriaEscaner();
    if (!ok || !window.Quagga) {
      if (escanerMensaje) {
        escanerMensaje.className = "escaner-mensaje error";
        escanerMensaje.textContent = "No se pudo cargar el lector de cámara. Verificá tu conexión.";
      }
      return;
    }

    detenerEscaner();
    ultimoCodigo = null;
    conteoLecturas = 0;

    const lector = document.getElementById("escaner-lector");
    if (!lector) return;
    lector.innerHTML = '<div class="escaner-mira-guia"></div>';

    Quagga.init({
      inputStream: {
        name: "Live",
        type: "LiveStream",
        target: lector,
        constraints: {
          facingMode: "environment",
        },
      },
      locator: {
        patchSize: "medium",
        halfSample: true,
      },
      numOfWorkers: 0,
      frequency: 10,
      decoder: {
        readers: [
          "ean_reader",
          "ean_8_reader",
          "upc_reader",
        ],
      },
      locate: true,
    }, function(err) {
      if (err) {
        console.error("Error Quagga:", err);
        escaneando = false;
        if (escanerMensaje) {
          escanerMensaje.className = "escaner-mensaje error";
          escanerMensaje.textContent = "No se pudo iniciar la cámara. Podés ingresar los números del código abajo.";
        }
        return;
      }
      Quagga.start();
      escaneando = true;
      if (escanerMensaje) {
        escanerMensaje.textContent = "Apuntá la barra roja al código (a unos 15-20 cm)";
      }
    });

    Quagga.offDetected();
    Quagga.onDetected((result) => {
      if (!result || !result.codeResult || !result.codeResult.code) return;
      const code = String(result.codeResult.code).replace(/\D/g, "");
      if (!code || code.length < 8) return;

      // Descartar lecturas de ruido que no cumplan el checksum EAN oficial
      if (!validarChecksumEAN(code)) {
        return;
      }

      // Si pasa checksum oficial, procesarlo directamente
      procesarCodigoDetectado(code);
    });
  }

  function buscarManual() {
    if (!escanerManualInput) return;
    const val = escanerManualInput.value.trim();
    if (val) {
      procesarCodigoDetectado(val);
    }
  }

  if (btnEscanear) {
    btnEscanear.addEventListener("click", abrirEscaner);
  }
  if (btnCerrarEscaner) {
    btnCerrarEscaner.addEventListener("click", cerrarModalEscaner);
  }
  if (fondoEscaner) {
    fondoEscaner.addEventListener("click", cerrarModalEscaner);
  }
  if (escanerManualBtn) {
    escanerManualBtn.addEventListener("click", buscarManual);
  }
  if (escanerManualForm) {
    escanerManualForm.addEventListener("submit", (e) => {
      e.preventDefault();
      buscarManual();
    });
  }

  zona = leerZona();
})();
