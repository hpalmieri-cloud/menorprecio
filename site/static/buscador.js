// Buscador incremental sobre índices por letra.
// Cada archivo pesa poco y solo se descarga el de la inicial tipeada.
(function () {
  const input = document.getElementById("q");
  const caja = document.getElementById("resultados");
  if (!input || !caja) return;

  const cache = new Map();
  let timer = null;
  let ultimo = 0;

  const norm = (s) => (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const letra = (s) => {
    const c = norm(s).charAt(0);
    return /[a-z]/.test(c) ? c : "_";
  };

  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");

  async function cargar(letraInicial) {
    if (cache.has(letraInicial)) return cache.get(letraInicial);
    try {
      const r = await fetch(`/datos/indice/${letraInicial}.json`);
      if (!r.ok) return [];
      const datos = await r.json();
      cache.set(letraInicial, datos);
      return datos;
    } catch {
      return [];
    }
  }

  function pintar(items, q) {
    if (!items.length) {
      caja.innerHTML = `<div class="vacio">Sin resultados para “${q}”.</div>`;
      caja.hidden = false;
      return;
    }
    caja.innerHTML = items
      .map(([ean, nombre, marca, precio]) => `
        <a href="/precios/producto/${ean}/">
          <span>${nombre}${marca ? ` <small>· ${marca}</small>` : ""}</span>
          <span class="r-precio">${pesos(precio)}</span>
        </a>`)
      .join("");
    caja.hidden = false;
  }

  async function buscar() {
    const q = norm(input.value.trim());
    if (q.length < 2) {
      caja.hidden = true;
      return;
    }
    const inicio = performance.now();
    ultimo = inicio;
    const datos = await cargar(letra(q));
    if (ultimo !== inicio) return; // llegó otra búsqueda más nueva

    const hits = [];
    for (const item of datos) {
      if (norm(item[1]).includes(q) || norm(item[2]).includes(q)) {
        hits.push(item);
        if (hits.length >= 12) break;
      }
    }
    pintar(hits, input.value.trim());
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(buscar, 180);
  });

  document.addEventListener("click", (e) => {
    if (!caja.contains(e.target) && e.target !== input) caja.hidden = true;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") caja.hidden = true;
  });
})();
