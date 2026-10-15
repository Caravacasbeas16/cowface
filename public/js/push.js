// Notificaciones en el celular: activar/desactivar en "Mi cuenta" y aviso para activarlas en los mensajes.
(() => {
  const panel = document.querySelector('[data-push-panel]');
  const ctas = document.querySelectorAll('[data-push-cta]');
  if (!panel && !ctas.length) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const post = (url, data = {}) => fetch(url, {
    method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(data),
  }).then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, ...j })));

  const keyBytes = (base64) => {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function currentSubscription() {
    if (!supported) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function enable() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: 'denied' };
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { key } = await fetch('/push/clave').then((r) => r.json());
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    const json = sub.toJSON();
    const device = `${iOS ? 'iPhone/iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computadora'}`;
    return post('/push/suscribir', { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, device });
  }

  async function disable() {
    const sub = await currentSubscription();
    if (sub) {
      await post('/push/quitar', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  }

  // Estado del panel en "Mi cuenta".
  const show = (state, extra = '') => {
    if (!panel) return;
    for (const el of panel.querySelectorAll('[data-state]')) el.hidden = el.dataset.state !== state;
    const msg = panel.querySelector('[data-push-msg]');
    if (msg) { msg.textContent = extra; msg.hidden = !extra; }
  };

  const showCtas = (visible) => { for (const cta of ctas) cta.hidden = !visible; };

  async function refresh() {
    // iPhone: solo funcionan si CowFace se agregó a la pantalla de inicio y se abre desde ese ícono.
    if (iOS && !standalone) { showCtas(true); return show('ios'); }
    if (!supported) { showCtas(false); return show('unsupported'); }
    if (Notification.permission === 'denied') { showCtas(false); return show('denied'); }
    const sub = await currentSubscription();
    const on = Boolean(sub) && Notification.permission === 'granted';
    show(on ? 'on' : 'off');
    showCtas(!on);
  }

  const busy = (btn, on) => { if (btn) { btn.disabled = on; } };

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-push-enable], [data-push-disable], [data-push-test]');
    if (!btn) return;
    e.preventDefault();
    busy(btn, true);
    try {
      if (btn.matches('[data-push-enable]')) {
        if (iOS && !standalone) { window.location.assign('/vendedor/configuracion#celular'); return; }
        const r = await enable();
        if (r.error === 'denied') show('denied');
        else if (!r.ok) show('off', r.error || 'No se pudo activar. Intenta de nuevo.');
        else { await refresh(); show('on', 'Activadas. Te mandamos una de prueba.'); await post('/push/prueba'); }
      } else if (btn.matches('[data-push-disable]')) {
        await disable();
        await refresh();
      } else {
        const r = await post('/push/prueba');
        show('on', r.ok ? 'Enviada. Debería llegarte en unos segundos.' : (r.error || 'No se pudo enviar.'));
      }
    } catch (err) {
      show('off', 'No se pudo activar en este navegador. Revisa que no esté en modo privado.');
    } finally {
      busy(btn, false);
    }
  });

  refresh();
})();
