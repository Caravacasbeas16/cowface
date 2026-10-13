// Formulario para publicar: fotos (arrastrar, elegir, importar de PDF, portada y orden),
// medidas según categoría, cálculo de lo que recibe el vendedor y subida con barra de progreso.
// Sin JavaScript el formulario sigue funcionando con el selector de archivos normal.
(() => {
  const form = document.querySelector('[data-listing-form]');
  if (!form) return;

  const input = form.querySelector('[data-photo-input]');
  const dropzone = form.querySelector('[data-dropzone]');
  const preview = form.querySelector('[data-photo-preview]');
  const photoError = form.querySelector('[data-photo-error]');
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  const max = Number(input.dataset.max) || 8;
  const maxMb = Number(input.dataset.maxMb) || 20;
  const existing = Number(input.dataset.existing) || 0;
  let selected = []; // [{ file, url }]

  const showError = (msg) => { photoError.textContent = msg; photoError.hidden = !msg; };

  function check(file) {
    if (/\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type)) return 'Las fotos HEIC no se pueden subir. En iPhone: Ajustes → Cámara → Formatos → "Más compatible".';
    if (!OK_TYPES.includes(file.type)) return `"${file.name}" no es una foto JPG, PNG, WebP o AVIF.`;
    if (file.size > maxMb * 1024 * 1024) return `"${file.name}" pesa más de ${maxMb} MB.`;
    return '';
  }

  function addFiles(files) {
    const problems = [];
    for (const file of files) {
      const problem = check(file);
      if (problem) { problems.push(problem); continue; }
      if (selected.length >= max) { problems.push(`Máximo ${max + existing} fotos por artículo.`); break; }
      selected.push({ file, url: URL.createObjectURL(file) });
    }
    showError(problems[0] || '');
    render();
  }
  window.CowFaceListing = { addFiles };

  function move(i, to) {
    if (to < 0 || to >= selected.length) return;
    const [item] = selected.splice(i, 1);
    selected.splice(to, 0, item);
    render();
  }

  function button(text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    preview.replaceChildren(...selected.map((item, i) => {
      const fig = document.createElement('figure');
      fig.className = 'photo-tile';
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = `Foto nueva ${i + 1}`;
      fig.append(img);
      if (i === 0 && !existing) {
        const cap = document.createElement('figcaption');
        cap.className = 'cover-badge';
        cap.textContent = 'Portada';
        fig.append(cap);
      } else if (!existing) {
        const cover = button('Usar de portada', 'Usar como portada', () => move(i, 0));
        cover.className = 'cover-btn';
        fig.append(cover);
      }
      const tools = document.createElement('div');
      tools.className = 'tile-tools';
      tools.append(
        button('‹', 'Mover a la izquierda', () => move(i, i - 1)),
        button('›', 'Mover a la derecha', () => move(i, i + 1)),
      );
      const remove = button('×', 'Quitar foto', () => { URL.revokeObjectURL(item.url); selected.splice(i, 1); render(); });
      remove.className = 'remove-btn';
      fig.append(tools, remove);
      return fig;
    }));
  }

  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

  // Medidas: solo se muestran (y se envían) las de la categoría elegida.
  const category = form.querySelector('[data-measure-switch]');
  const syncMeasures = () => {
    for (const group of form.querySelectorAll('[data-measure-for]')) {
      const on = group.dataset.measureFor === category.value;
      group.hidden = !on;
      group.querySelectorAll('input').forEach((el) => { el.disabled = !on; });
    }
    form.querySelector('[data-measure-empty]').hidden = Boolean(category.value);
  };
  category.addEventListener('change', syncMeasures);

  // Lo que recibe el vendedor, en vivo.
  const earnings = form.querySelector('[data-earnings]');
  const money = (n) => '₡' + Math.round(n).toLocaleString('es-CR');
  const toInt = (v) => Number(String(v).replace(/[₡,.\s]/g, '')) || 0;
  const syncEarnings = () => {
    const price = toInt(form.querySelector('[data-price]').value);
    const ship = toInt(form.querySelector('[data-shipping]').value);
    const fee = Math.round(price * Number(earnings.dataset.rate));
    earnings.querySelector('[data-e-price]').textContent = price ? money(price) : '—';
    earnings.querySelector('[data-e-fee]').textContent = price ? `− ${money(fee)}` : '—';
    earnings.querySelector('[data-e-ship]').textContent = ship ? `+ ${money(ship)}` : 'Envío gratis';
    earnings.querySelector('[data-e-total]').textContent = price ? money(price - fee + ship) : '—';
  };
  form.querySelector('[data-price]').addEventListener('input', syncEarnings);
  form.querySelector('[data-shipping]').addEventListener('input', syncEarnings);
  syncEarnings();

  // Envío con barra de progreso. Los botones de las fotos ya guardadas (portada/quitar) usan su
  // propia dirección y se envían de forma normal.
  const progress = form.querySelector('[data-progress]');
  form.addEventListener('submit', (e) => {
    const submitter = e.submitter;
    if (submitter?.hasAttribute('formaction')) return;
    e.preventDefault();
    const data = new FormData(form, submitter);
    data.delete('photos');
    for (const item of selected) data.append('photos', item.file, item.file.name);

    form.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = true; });
    if (submitter?.dataset.busyText) submitter.textContent = submitter.dataset.busyText;
    progress.hidden = false;
    const bar = progress.querySelector('[data-progress-bar]');
    const label = progress.querySelector('[data-progress-text]');

    const xhr = new XMLHttpRequest();
    // form.action no sirve: los botones se llaman "action" y lo tapan.
    const target = form.getAttribute('action') || window.location.pathname;
    xhr.open('POST', target);
    xhr.upload.addEventListener('progress', (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      bar.style.width = `${pct}%`;
      label.textContent = pct < 100 ? `Subiendo fotos… ${pct}%` : 'Procesando fotos en alta calidad…';
    });
    xhr.addEventListener('load', () => {
      // Éxito: el servidor redirige a la página del artículo. Error de validación: muestra el formulario con avisos.
      if (xhr.status < 400 && xhr.responseURL && !xhr.responseURL.endsWith(target)) {
        window.location.assign(xhr.responseURL);
        return;
      }
      document.open();
      document.write(xhr.responseText);
      document.close();
    });
    xhr.addEventListener('error', () => {
      progress.hidden = true;
      form.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = false; });
      showError('Se cortó la conexión mientras se subían las fotos. Revisa tu internet e intenta de nuevo.');
    });
    xhr.send(data);
  });
})();
