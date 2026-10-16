// Chat en vivo: escucha avisos del servidor (Server-Sent Events) y envía mensajes sin recargar.
(() => {
  if (!document.body.hasAttribute('data-live')) return;

  const badges = document.querySelectorAll('[data-unread]');
  const chat = document.querySelector('[data-chat]');
  const thread = document.querySelector('[data-thread]');
  const errorBox = document.querySelector('[data-chat-error]');
  const conversationId = chat ? Number(chat.dataset.chat) : null;

  const scrollToEnd = () => {
    const list = thread?.querySelector('[data-messages]');
    if (list) list.scrollTop = list.scrollHeight;
  };
  scrollToEnd();

  const dealState = () => thread?.querySelector('[data-deal-state]')?.dataset.dealState;

  let refreshing = false;
  let again = false;
  async function refreshThread() {
    if (!thread) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const res = await fetch(`/mensajes/${conversationId}/hilo`, { headers: { Accept: 'text/html' } });
      if (res.ok) {
        const list = thread.querySelector('[data-messages]');
        const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 120;
        const tpl = document.createElement('template');
        tpl.innerHTML = await res.text();
        const nextState = tpl.content.querySelector('[data-deal-state]')?.dataset.dealState;
        if (nextState !== dealState()) {
          // Cambió el pedido o el artículo: recarga para mostrar los formularios correctos
          // (salvo que la persona esté escribiendo; entonces solo actualiza el hilo).
          if (!hasDraft()) return location.reload();
          thread.replaceChildren(...tpl.content.childNodes);
        } else {
          // Mismo estado: solo los mensajes, para no borrar lo que se esté llenando en el recuadro del pedido.
          list?.replaceWith(tpl.content.querySelector('[data-messages]'));
        }
        if (nearBottom) scrollToEnd();
      }
    } finally {
      refreshing = false;
      if (again) { again = false; refreshThread(); }
    }
  }

  // ¿Hay algo escrito en el chat o en el recuadro del pedido? (sin contar campos prellenados)
  const hasDraft = () => [...document.querySelectorAll('[data-chat] textarea, [data-chat] input:not([type=hidden])')]
    .some((el) => el.value.trim() && el.value !== el.defaultValue);

  function showError(message) {
    if (!errorBox) return alert(message);
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  // Enviar mensajes y ofertas sin recargar; si el filtro bloquea algo, el texto se queda para corregirlo.
  for (const form of document.querySelectorAll('[data-chat-form]')) {
    const field = form.querySelector('textarea, input:not([type="file"])');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new URLSearchParams(new FormData(form)),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showError(data.error || 'No se pudo enviar. Intenta de nuevo.');
        showError('');
        field.value = '';
        form.closest('details')?.removeAttribute('open');
        await refreshThread();
        scrollToEnd();
      } catch {
        showError('Sin conexión. Revisa tu internet e intenta de nuevo.');
      } finally {
        button.disabled = false;
        field.focus();
      }
    });
    // Enter envía; Shift+Enter hace salto de línea.
    if (field.tagName === 'TEXTAREA') {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
      });
    }
  }

  // Fotos y PDF en el chat: se elige el archivo, se ve una vista previa y se envía con texto opcional.
  const fileInput = document.querySelector('[data-chat-file]');
  const attachForm = document.querySelector('[data-attach-form]');
  if (fileInput && attachForm) {
    const previewBox = attachForm.querySelector('[data-attach-preview]');
    let chosen = null;
    const resetAttach = () => {
      chosen = null;
      fileInput.value = '';
      previewBox.replaceChildren();
      attachForm.hidden = true;
      attachForm.reset();
    };
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!okTypes.includes(file.type)) { showError('Solo se pueden enviar fotos (JPG, PNG, WebP) o PDF.'); fileInput.value = ''; return; }
      if (file.size > 10 * 1024 * 1024) { showError('El archivo debe pesar menos de 10 MB.'); fileInput.value = ''; return; }
      showError('');
      chosen = file;
      if (file.type === 'application/pdf') {
        const tag = document.createElement('span');
        tag.className = 'attach-pdf';
        tag.textContent = `📄 ${file.name}`;
        previewBox.replaceChildren(tag);
      } else {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.alt = 'Vista previa';
        previewBox.replaceChildren(img);
      }
      attachForm.hidden = false;
    });
    attachForm.querySelector('[data-attach-cancel]').addEventListener('click', resetAttach);
    attachForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!chosen) return;
      const button = attachForm.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = button.dataset.busyText;
      const data = new FormData(attachForm);
      data.append('file', chosen, chosen.name);
      try {
        const res = await fetch(attachForm.action, { method: 'POST', headers: { Accept: 'application/json' }, body: data });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { showError(json.error || 'No se pudo enviar el archivo.'); return; }
        showError('');
        resetAttach();
        await refreshThread();
        scrollToEnd();
      } catch {
        showError('Sin conexión. Revisa tu internet e intenta de nuevo.');
      } finally {
        button.disabled = false;
        button.textContent = 'Enviar archivo';
      }
    });
  }

  // Panel de la tienda (Inicio y Pedidos): como la tablet de DoorDash, suena y se actualiza solo
  // cuando entra un pedido o un mensaje. Si la tienda está escribiendo algo, solo muestra un aviso.
  let audio;
  function ding() {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      for (const [freq, at] of [[880, 0], [1320, 0.16]]) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, audio.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + 0.3);
        osc.connect(gain).connect(audio.destination);
        osc.start(audio.currentTime + at);
        osc.stop(audio.currentTime + at + 0.32);
      }
    } catch { /* sin sonido */ }
  }
  function portalAlert() {
    ding();
    const busy = document.activeElement?.matches('input, textarea, select') || document.querySelector('details[open]');
    if (!busy) { setTimeout(() => location.reload(), 900); return; }
    if (document.querySelector('[data-live-toast]')) return;
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'live-toast';
    toast.dataset.liveToast = '';
    toast.textContent = '🔔 Hay novedades en tus pedidos · Actualizar';
    toast.addEventListener('click', () => location.reload());
    document.body.append(toast);
  }

  // Canal en vivo. EventSource se reconecta solo si se cae.
  const events = new EventSource('/mensajes/eventos');
  events.addEventListener('no-leidos', (e) => {
    const { count } = JSON.parse(e.data);
    for (const badge of badges) {
      badge.textContent = count;
      badge.hidden = !count;
    }
  });
  // CowFace escribió por el chat directo: si está viendo ese chat o la bandeja, se actualiza.
  events.addEventListener('soporte', () => {
    if (document.querySelector('[data-support]') || document.querySelector('.inbox-pinned, [data-inbox]')) location.reload();
  });
  events.addEventListener('conversacion', (e) => {
    const { id } = JSON.parse(e.data);
    if (id === conversationId) refreshThread();
    else if (document.querySelector('[data-inbox]')) location.reload();
    else if (document.querySelector('[data-portal-live]')) portalAlert();
  });
})();
