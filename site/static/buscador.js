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

  function filtrar(indices, q, mapa) {
    const tokens = q.trim().split(/\s+/).filter(Boolean);
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
      const textoCompleto = nom + " " + mrc;

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
    // Empresas de todos los resultados, no solo de las filas que se ven.
    const empresas = Array.from(
      new Set(hits.map((h) => h.cadena).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "es"));
    return { hits: hits.slice(0, MAX), empresas, fuera };
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
    const ean = String(codigo || "").replace(/\D/g, "").trim();
    if (!ean || ean.length < 6) return;

    if (navigator.vibrate) {
      try { navigator.vibrate(120); } catch (e) {}
    }

    if (escanerMensaje) {
      escanerMensaje.className = "escaner-mensaje exito";
      escanerMensaje.textContent = `¡Código detectado (${ean})! Buscando...`;
    }

    detenerEscaner();

    // 1. Verificar si está en los índices cargados en memoria
    const indices = await cargarTodo();
    const hit = indices.find((it) => it[0] === ean);

    if (hit) {
      if (escanerMensaje) {
        escanerMensaje.textContent = `¡Encontrado! Entrando a ${hit[1]}...`;
      }
      setTimeout(() => {
        window.location.href = `/precios/producto/${encodeURIComponent(ean)}/`;
      }, 300);
      return;
    }

    // 2. Si no está en el índice directo, intentar chequear si existe la página estática
    try {
      const resp = await fetch(`/precios/producto/${encodeURIComponent(ean)}/`, { method: "HEAD" });
      if (resp.ok) {
        window.location.href = `/precios/producto/${encodeURIComponent(ean)}/`;
        return;
      }
    } catch (e) {}

    // 3. Si no existe ficha exacta, cerrar modal y escribir el código en el buscador
    cerrarModalEscaner();
    input.value = ean;
    buscar();
  }

  async function abrirEscaner() {
    if (!modalEscaner) return;
    modalEscaner.hidden = false;
    if (escanerManualInput) escanerManualInput.value = "";
    if (escanerMensaje) {
      escanerMensaje.className = "escaner-mensaje";
      escanerMensaje.textContent = "Iniciando cámara...";
    }

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
          "upc_e_reader",
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
      if (code.length < 8) return;

      // Si pasa el checksum EAN oficial, es una lectura 100% válida y confirmada
      if (validarChecksumEAN(code)) {
        procesarCodigoDetectado(code);
        return;
      }

      // Si no tiene checksum estándar, exigir 2 lecturas consecutivas iguales
      if (code === ultimoCodigo) {
        conteoLecturas++;
      } else {
        ultimoCodigo = code;
        conteoLecturas = 1;
      }

      if (conteoLecturas >= 2) {
        procesarCodigoDetectado(code);
      }
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
