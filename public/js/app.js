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

// Artículos con varias tallas: la cuadrícula (como StockX) llena la talla de cada formulario.
(() => {
  const picker = document.querySelector('[data-size-picker]');
  if (!picker) return;
  const fields = [...document.querySelectorAll('[data-size-field]')];
  const label = picker.querySelector('[data-size-chosen]');
  for (const f of fields) f.hidden = true;
  const set = (size) => {
    for (const f of fields) f.querySelector('select').value = size;
    label.textContent = size ? `· ${size}` : '';
    picker.classList.remove('needs-size');
  };
  picker.addEventListener('change', (e) => { if (e.target.name === 'size_pick') set(e.target.value); });
  const checked = picker.querySelector('input:checked');
  if (checked) set(checked.value);
  // Comprar u ofertar sin talla: se marca la cuadrícula (antes de la confirmación de compra).
  document.addEventListener('submit', (e) => {
    const select = e.target.querySelector('[data-size-field] select[required]');
    if (!select || select.value) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    picker.classList.add('needs-size');
    label.textContent = '· elige una para continuar';
    picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, true);
})();

// Favoritos (♥) y "Seguir tienda" sin recargar la página. Sin JS, los formularios funcionan igual.
(() => {
  const send = (form) => fetch(form.getAttribute('action'), {
    method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' },
  }).then((r) => (r.status === 401 || r.redirected ? null : r.json())).catch(() => null);

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.matches('[data-fav]')) {
      e.preventDefault();
      const data = await send(form);
      if (!data) { form.submit(); return; }
      const btn = form.querySelector('.fav-btn');
      btn.classList.toggle('is-on', data.saved);
      btn.setAttribute('aria-pressed', String(data.saved));
      btn.setAttribute('aria-label', data.saved ? 'Quitar de favoritos' : 'Guardar en favoritos');
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
      const label = form.querySelector('[data-fav-label]');
      if (label) label.textContent = data.saved ? 'Guardado' : 'Guardar';
    } else if (form.matches('[data-follow]')) {
      e.preventDefault();
      const data = await send(form);
      if (!data) { form.submit(); return; }
      const id = form.getAttribute('action').match(/\/u\/(\d+)\//)[1];
      const btn = form.querySelector('button');
      const count = document.querySelector('[data-followers]');
      form.setAttribute('action', `/u/${id}/${data.following ? 'dejar-de-seguir' : 'seguir'}`);
      btn.textContent = data.following ? '✓ Siguiendo' : '+ Seguir';
      btn.classList.toggle('btn-ghost', data.following);
      btn.setAttribute('aria-pressed', String(data.following));
      if (count) count.textContent = Math.max(0, Number(count.textContent) + (data.following ? 1 : -1));
    }
  });
})();

// Página de la tienda: buscar y ordenar dentro de la tienda, y pestaña activa según la sección.
(() => {
  const search = document.querySelector('[data-store-search]');
  if (!search) return;
  const sort = document.querySelector('[data-store-sort]');
  const sections = [...document.querySelectorAll('[data-store-section]')];
  const empty = document.querySelector('[data-store-empty]');
  const norm = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  for (const grid of document.querySelectorAll('[data-store-section] .grid')) {
    [...grid.children].forEach((c, i) => { c.dataset.order = i; });
  }
  const apply = () => {
    const words = norm(search.value).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const sec of sections) {
      const cards = [...sec.querySelectorAll('.card-wrap')];
      let n = 0;
      for (const c of cards) {
        const ok = words.every((w) => norm(c.dataset.search || '').includes(w));
        c.hidden = !ok;
        if (ok) n += 1;
      }
      sec.hidden = n === 0;
      shown += n;
      const grid = sec.querySelector('.grid');
      const by = {
        recientes: (a, b) => (b.dataset.date || '').localeCompare(a.dataset.date || ''),
        precio_asc: (a, b) => a.dataset.price - b.dataset.price,
        precio_desc: (a, b) => b.dataset.price - a.dataset.price,
      }[sort.value] || ((a, b) => a.dataset.order - b.dataset.order);
      grid.append(...cards.sort(by));
    }
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', apply);
  sort.addEventListener('change', apply);

  const tabs = [...document.querySelectorAll('[data-store-tabs] a')];
  const setActive = (hash) => tabs.forEach((t) => t.classList.toggle('is-active', t.getAttribute('href') === hash));
  tabs.forEach((t) => t.addEventListener('click', () => setActive(t.getAttribute('href'))));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(`#${top.target.id}`);
    }, { rootMargin: '-80px 0px -60% 0px' });
    sections.forEach((s) => io.observe(s));
  }
})();

// "Vistos recientemente" (como Grailed / StockX): se guarda solo en este navegador.
(() => {
  const KEY = 'cowface-recent';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* sin almacenamiento */ } };
  const here = document.querySelector('[data-recent]');
  if (here) {
    try {
      const item = JSON.parse(here.dataset.recent);
      write([item, ...read().filter((x) => x.id !== item.id)].slice(0, 12));
    } catch { /* nada */ }
  }
  const section = document.querySelector('[data-recent-section]');
  if (!section) return;
  const list = read();
  if (!list.length) return;
  const row = section.querySelector('[data-recent-list]');
  for (const x of list) {
    const a = document.createElement('a');
    a.className = 'recent-item';
    a.href = `/p/${Number(x.id)}`;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = x.i ? `/fotos/${encodeURIComponent(x.i)}` : `/sin-foto/${encodeURIComponent(x.c || 'ropa')}/${Number(x.id)}.svg?v=2`;
    const t = document.createElement('span');
    t.className = 'recent-title';
    t.textContent = x.t;
    const pr = document.createElement('span');
    pr.className = 'recent-price';
    pr.textContent = `₡${Number(x.pr || 0).toLocaleString('es-CR')}`;
    a.append(img, t, pr);
    row.append(a);
  }
  section.hidden = false;
  section.querySelector('[data-recent-clear]').addEventListener('click', () => { write([]); section.hidden = true; });
})();

// "Mandar mi ubicación" para la Mensajería CowFace: el GPS del celular llena latitud y longitud del pedido.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-geo-btn]');
  if (!btn) return;
  const box = btn.closest('[data-geo]');
  const msg = box.querySelector('[data-geo-msg]');
  if (!navigator.geolocation) { msg.textContent = 'Este navegador no puede compartir la ubicación. Escribe las señas lo más exactas posible.'; return; }
  msg.textContent = 'Buscando tu ubicación…';
  navigator.geolocation.getCurrentPosition((pos) => {
    box.querySelector('[name="lat"]').value = pos.coords.latitude.toFixed(6);
    box.querySelector('[name="lng"]').value = pos.coords.longitude.toFixed(6);
    msg.textContent = '✓ Ubicación lista. Se guarda al tocar Continuar.';
    const courier = box.closest('form')?.querySelector('input[name="method"][value="mensajeria"]');
    if (courier && !box.closest('form').querySelector('input[name="method"]:checked')) courier.checked = true;
  }, () => {
    msg.textContent = 'No se pudo obtener la ubicación (revisa el permiso en el navegador). Puedes escribir las señas.';
  }, { enableHighAccuracy: true, timeout: 15000 });
});

// Marcar un día de la Mensajería CowFace la elige como forma de entrega (si no eligió otra).
document.addEventListener('change', (e) => {
  if (!e.target.matches('.courier-fields input[name="days"]') || !e.target.checked) return;
  const form = e.target.closest('form');
  const courier = form?.querySelector('input[name="method"][value="mensajeria"]');
  if (courier && !form.querySelector('input[name="method"]:checked')) courier.checked = true;
});

// Chat directo con CowFace: abre al final de la conversación.
(() => {
  const box = document.querySelector('[data-support] [data-messages], .admin-support [data-messages]');
  if (box) box.scrollTop = box.scrollHeight;
})();
