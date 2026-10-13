// Importar fotos desde un PDF (catálogo, lookbook): el navegador convierte cada página en una foto
// de alta resolución con pdf.js; el vendedor elige cuáles usar y se agregan a sus fotos.
// Todo ocurre en el navegador: el PDF no se sube al servidor.
const pickBtn = document.querySelector('[data-pdf-pick]');
const fileInput = document.querySelector('[data-pdf-input]');
const panel = document.querySelector('[data-pdf-pages]');

const MAX_PAGES = 30;
const TARGET_PX = 2400; // lado mayor de cada página convertida

if (pickBtn && fileInput && panel) {
  pickBtn.hidden = false;
  const grid = panel.querySelector('[data-pdf-grid]');
  const title = panel.querySelector('[data-pdf-title]');
  let pages = []; // [{ blob, url, checkbox }]
  let pdfjs = null;

  const reset = () => {
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    pages = [];
    grid.replaceChildren();
    panel.hidden = true;
    fileInput.value = '';
  };

  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    pdfjs = await import('/vendor/pdfjs/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    return pdfjs;
  }

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    reset();
    panel.hidden = false;
    title.textContent = `Leyendo "${file.name}"…`;
    try {
      const lib = await loadPdfJs();
      const doc = await lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        isEvalSupported: false,
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
        wasmUrl: '/vendor/pdfjs/wasm/',
        iccUrl: '/vendor/pdfjs/iccs/',
      }).promise;
      const count = Math.min(doc.numPages, MAX_PAGES);
      title.textContent = `${file.name} · ${doc.numPages} página${doc.numPages === 1 ? '' : 's'}${doc.numPages > MAX_PAGES ? ` (se muestran las primeras ${MAX_PAGES})` : ''}`;
      for (let n = 1; n <= count; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(4, TARGET_PX / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        const url = URL.createObjectURL(blob);

        const label = document.createElement('label');
        label.className = 'pdf-page';
        const img = document.createElement('img');
        img.src = url;
        img.alt = `Página ${n}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        const caption = document.createElement('span');
        caption.textContent = `Página ${n}`;
        label.append(img, checkbox, caption);
        grid.append(label);
        pages.push({ blob, url, checkbox, name: `${file.name.replace(/\.pdf$/i, '')}-pag-${n}.jpg` });
      }
    } catch (err) {
      console.error(err);
      title.textContent = 'No se pudo leer ese PDF. Si tiene contraseña, quítasela; o exporta las fotos como JPG.';
    }
  });

  panel.querySelector('[data-pdf-add]').addEventListener('click', () => {
    const chosen = pages.filter((p) => p.checkbox.checked)
      .map((p) => new File([p.blob], p.name, { type: 'image/jpeg' }));
    window.CowFaceListing?.addFiles(chosen);
    reset();
  });
  panel.querySelector('[data-pdf-cancel]').addEventListener('click', reset);
}
