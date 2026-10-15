(() => {
  const catalog = JSON.parse(document.getElementById('catalog-data')?.textContent || '{}');

  // Al elegir categoría, llena los selects de tipo y talla que estén en el mismo formulario.
  for (const categorySelect of document.querySelectorAll('[data-category-select]')) {
    const form = categorySelect.form;
    const typeSelect = form.querySelector('[data-type-select]');
    const sizeSelect = form.querySelector('[data-size-select]');

    const fill = () => {
      const cat = catalog[categorySelect.value];
      if (typeSelect) {
        const keep = typeSelect.value || typeSelect.dataset.selected;
        typeSelect.replaceChildren(new Option(cat ? 'Elige…' : 'Elige categoría primero', ''));
        for (const t of cat?.types || []) typeSelect.add(new Option(t, t, false, t === keep));
      }
      if (sizeSelect) {
        const keep = sizeSelect.value || sizeSelect.dataset.selected;
        // En el buscador de portada, sin categoría se ofrecen tallas de letra; en el formulario, nada.
        const anyCategory = 'anyCategory' in sizeSelect.dataset;
        sizeSelect.replaceChildren(new Option(cat || anyCategory ? sizeSelect.dataset.placeholder || 'Elige…' : 'Elige categoría primero', ''));
        const groups = cat ? cat.sizes : anyCategory ? { Talla: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] } : {};
        for (const [label, sizes] of Object.entries(groups)) {
          const og = document.createElement('optgroup');
          og.label = label;
          for (const s of sizes) og.append(new Option(s, s, false, s === keep));
          sizeSelect.append(og);
        }
      }
    };
    categorySelect.addEventListener('change', () => {
      if (typeSelect) typeSelect.value = '';
      if (sizeSelect) sizeSelect.value = '';
      fill();
    });
    fill();
  }

  // Filtros que se aplican solos al cambiar.
  for (const el of document.querySelectorAll('[data-autosubmit]')) {
    el.addEventListener('change', () => el.form.requestSubmit());
  }

  // Confirmación antes de acciones importantes. Delegado, porque el hilo del chat se reemplaza en vivo.
  let confirmedButton = null;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-confirm-click]');
    if (btn && !confirm(btn.dataset.confirmClick)) e.preventDefault();
    confirmedButton = btn;
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-confirm]');
    if (form && !confirmedButton && !confirm(form.dataset.confirm)) e.preventDefault();
    confirmedButton = null;
  });

  // Galería del producto: miniaturas cambian la foto principal; tocarla abre la pantalla completa.
  const main = document.querySelector('[data-gallery-main]');
  const thumbs = [...document.querySelectorAll('.thumb')];
  const sources = thumbs.length ? thumbs.map((t) => t.dataset.src) : main ? [main.src] : [];
  // La pantalla completa muestra la foto original (máxima calidad); la página, la versión liviana.
  const fulls = thumbs.length ? thumbs.map((t) => t.dataset.full || t.dataset.src) : main ? [main.dataset.full || main.src] : [];
  const show = (i) => {
    main.src = sources[i];
    main.dataset.index = String(i);
    thumbs.forEach((t, n) => t.classList.toggle('active', n === i));
  };
  thumbs.forEach((thumb, i) => thumb.addEventListener('click', () => show(i)));

  const lightbox = document.querySelector('[data-lightbox]');
  if (lightbox && main) {
    const lbImg = lightbox.querySelector('[data-lightbox-img]');
    const count = lightbox.querySelector('[data-lb-count]');
    let current = 0;
    const go = (i) => {
      current = (i + sources.length) % sources.length;
      // Primero la versión liviana (ya está en caché) y enseguida la original.
      lbImg.src = sources[current];
      const full = new Image();
      const target = current;
      full.onload = () => { if (current === target) lbImg.src = full.src; };
      full.src = fulls[current];
      lbImg.classList.remove('zoomed');
      if (count) count.textContent = `${current + 1} / ${sources.length}`;
    };
    const open = () => { lightbox.hidden = false; document.body.classList.add('no-scroll'); go(Number(main.dataset.index) || 0); };
    const close = () => { lightbox.hidden = true; document.body.classList.remove('no-scroll'); show(current); };
    document.querySelector('[data-zoom-open]').addEventListener('click', open);
    lightbox.querySelector('[data-lb-close]').addEventListener('click', close);
    lightbox.querySelector('[data-lb-prev]')?.addEventListener('click', () => go(current - 1));
    lightbox.querySelector('[data-lb-next]')?.addEventListener('click', () => go(current + 1));
    // Tocar la foto alterna el zoom al tamaño real; tocar el fondo cierra.
    lbImg.addEventListener('click', () => lbImg.classList.toggle('zoomed'));
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) close(); });
    document.addEventListener('keydown', (e) => {
      if (lightbox.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') go(current - 1);
      if (e.key === 'ArrowRight') go(current + 1);
    });
    // Deslizar con el dedo para cambiar de foto.
    let startX = null;
    lightbox.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    lightbox.addEventListener('touchend', (e) => {
      if (startX == null || lbImg.classList.contains('zoomed')) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) go(current + (dx < 0 ? 1 : -1));
      startX = null;
    });
  }

})();


// Volver a los resultados de búsqueda conservando los filtros (si se llegó desde /buscar).
(() => {
  const back = document.querySelector('[data-back-results]');
  if (!back || !document.referrer) return;
  try {
    const ref = new URL(document.referrer);
    if (ref.origin === location.origin && ref.pathname === '/buscar') {
      back.href = ref.pathname + ref.search;
      back.hidden = false;
    }
  } catch { /* referrer inválido */ }
})();

// En pantallas angostas, los filtros empiezan plegados para que se vean los resultados.
(() => {
  const filters = document.querySelector('[data-filters]');
  if (filters && matchMedia('(max-width: 900px)').matches) filters.open = false;
})();

// Copiar número de SINPE o código de pedido con un toque.
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.dataset.copy);
    el.dataset.copied = '1';
    setTimeout(() => delete el.dataset.copied, 1500);
  } catch { /* sin permiso de portapapeles: no pasa nada */ }
});

// Gráfico de ganancias: la altura de cada barra (la política de seguridad no permite style="" en el HTML).
for (const bar of document.querySelectorAll('[data-height]')) bar.style.height = `${Number(bar.dataset.height) || 0}%`;

// Barra de búsqueda: sugerencias de categorías, tipos y marcas mientras se escribe.
(() => {
  const input = document.querySelector('[data-suggest-input]');
  const list = document.querySelector('[data-suggest]');
  if (!input || !list) return;
  let timer = null;
  let active = -1;
  let lastQuery = '';
  const items = () => [...list.querySelectorAll('[role="option"]')];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const highlight = (i) => {
    items().forEach((el, n) => el.setAttribute('aria-selected', String(n === i)));
    active = i;
  };
  const render = (suggestions, query) => {
    list.replaceChildren();
    if (!suggestions.length) return close();
    for (const s of suggestions) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const a = document.createElement('a');
      a.href = s.url;
      const label = document.createElement('span');
      label.textContent = s.label;
      const hint = document.createElement('span');
      hint.className = 'suggest-hint';
      hint.textContent = `${s.hint} · ${s.count}`;
      a.append(label, hint);
      li.append(a);
      list.append(li);
    }
    // Última opción: buscar el texto tal cual.
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const a = document.createElement('a');
    a.href = `/buscar?q=${encodeURIComponent(query)}`;
    a.className = 'suggest-all';
    a.textContent = `Buscar "${query}"`;
    li.append(a);
    list.append(li);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { lastQuery = ''; return close(); }
    timer = setTimeout(async () => {
      lastQuery = q;
      try {
        const res = await fetch(`/buscar/sugerencias?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok || q !== lastQuery) return;
        render(await res.json(), q);
      } catch { close(); }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const all = items();
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % all.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + all.length) % all.length); }
    else if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); window.location.assign(all[active].querySelector('a').href); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.topsearch')) close(); });
  input.addEventListener('blur', () => setTimeout(() => { if (!list.contains(document.activeElement)) close(); }, 150));
})();

// Menú hamburguesa en el celular.
(() => {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  if (!toggle || !menu) return;
  const set = (open) => { menu.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => set(!menu.classList.contains('open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
})();

// Formularios que tardan (carga de fotos): el botón muestra que está trabajando y no se envía dos veces.
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-busy]');
  if (!form) return;
  const btn = e.submitter || form.querySelector('button');
  setTimeout(() => {
    if (!btn) return;
    btn.disabled = true;
    if (btn.dataset.busyText) btn.textContent = btn.dataset.busyText;
  }, 0);
});
