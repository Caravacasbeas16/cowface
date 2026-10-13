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

  // Galería del producto.
  const main = document.querySelector('[data-gallery-main]');
  for (const thumb of document.querySelectorAll('.thumb')) {
    thumb.addEventListener('click', () => {
      main.src = thumb.dataset.src;
      document.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('active', t === thumb));
    });
  }

  // Vista previa de fotos antes de subirlas.
  const input = document.querySelector('[data-photo-input]');
  const preview = document.querySelector('[data-photo-preview]');
  input?.addEventListener('change', () => {
    preview.replaceChildren(...[...input.files].slice(0, 6).map((file) => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      return img;
    }));
  });
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
