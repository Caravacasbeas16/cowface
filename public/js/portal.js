// Panel de la tienda: barras de progreso, inventario (guardar precio y unidades al instante,
// botones − / +, selección en lote) y atajos de promos. Sin JS, todo funciona con formularios normales.
(() => {
  for (const el of document.querySelectorAll('[data-width]')) el.style.width = `${Math.min(100, Number(el.dataset.width) || 0)}%`;

  // ---------- Guardado rápido de precio y unidades ----------
  const tick = (form, text, ok = true) => {
    let t = form.querySelector('.saved-tick');
    if (!t) { t = document.createElement('span'); t.className = 'saved-tick'; form.append(t); }
    t.textContent = text;
    t.style.color = ok ? '' : 'var(--danger)';
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.remove(), ok ? 2500 : 6000);
  };

  async function save(form) {
    form.classList.add('is-saving');
    try {
      const res = await fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!data.ok) return tick(form, data.message, false);
      tick(form, '✓ Guardado');
      // Si pasó a agotado (0 unidades) o volvió a la venta, la fila cambia: se recarga la lista.
      if (data.statusChanged) window.location.reload();
    } catch {
      form.submit();
    } finally {
      form.classList.remove('is-saving');
    }
  }

  for (const form of document.querySelectorAll('[data-quick]')) {
    let timer;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => save(form), 600); };
    const qty = form.querySelector('input[name="quantity"]');
    for (const b of form.querySelectorAll('[data-step]')) {
      b.addEventListener('click', () => {
        qty.value = Math.max(0, Math.min(999, (Number.parseInt(qty.value, 10) || 0) + Number(b.dataset.step)));
        later();
      });
    }
    for (const input of form.querySelectorAll('input:not([type=hidden])')) input.addEventListener('change', later);
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); save(form); });
  }

  // ---------- Selección en lote ----------
  const bulk = document.querySelector('[data-bulk]');
  if (bulk) {
    const boxes = [...document.querySelectorAll('input[name="ids"][form="bulk"]')];
    const all = bulk.querySelector('[data-select-all]');
    const label = bulk.querySelector('[data-bulk-count]');
    const refresh = () => {
      const n = boxes.filter((b) => b.checked).length;
      label.textContent = n ? `${n} seleccionado${n === 1 ? '' : 's'}` : 'Seleccionar todos';
      bulk.classList.toggle('has-selection', n > 0);
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
      for (const b of boxes) b.closest('[data-inv-row]')?.classList.toggle('is-selected', b.checked);
    };
    all.addEventListener('change', () => { for (const b of boxes) b.checked = all.checked; refresh(); });
    for (const b of boxes) b.addEventListener('change', refresh);
    bulk.addEventListener('submit', (e) => {
      const n = boxes.filter((b) => b.checked).length;
      const action = bulk.elements.action;
      if (!n || !action.value) {
        e.preventDefault();
        (n ? action : all).focus();
        label.textContent = n ? 'Elige qué hacer →' : 'Selecciona artículos primero';
        return;
      }
      const ask = { borrar: `¿Borrar ${n} artículo${n === 1 ? '' : 's'}? No se puede deshacer.`, vendidos: `¿Marcar ${n} como vendido${n === 1 ? '' : 's'}? Las ofertas pendientes quedan sin efecto.` }[action.value];
      if (ask && !window.confirm(ask)) e.preventDefault();
    });
    refresh();
  }

  // Un solo menú "⋯" abierto a la vez.
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.more[open], details.pause-box[open]')) if (!d.contains(e.target)) d.open = false;
  });

  // ---------- Promos: atajos ----------
  const promo = document.querySelector('[data-promo-form]');
  for (const b of document.querySelectorAll('[data-presets] [data-pct]')) {
    b.addEventListener('click', () => {
      promo.elements.pct.value = b.dataset.pct;
      promo.elements.label.value = b.dataset.label;
      promo.elements.pct.focus();
    });
  }
})();
