// "Instalar CowFace" como app y registro del service worker (notificaciones y pantalla sin conexión).
// - Android / Chrome / Edge: el navegador ofrece instalar; se guarda ese aviso y se usa con nuestro botón.
// - iPhone / iPad (Safari): no hay botón automático; se muestran los pasos (página /instalar).
// - Si ya está instalada (se abrió desde el ícono), no se muestra nada.
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}));
  }

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const buttons = document.querySelectorAll('[data-install]');
  const banner = document.querySelector('[data-install-banner]');
  const DISMISS_KEY = 'cowface-install-dismissed';
  let deferred = null;

  const dismissedRecently = () => {
    try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < 30 * 86400e3; } catch { return false; }
  };
  const show = (on) => {
    for (const b of buttons) b.hidden = !on;
    if (banner) banner.hidden = !on || dismissedRecently();
    document.documentElement.classList.toggle('can-install', on);
  };

  if (standalone) { show(false); return; }
  // iPhone: siempre se puede "agregar a la pantalla de inicio" desde Safari.
  show(iOS);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    show(true);
  });
  window.addEventListener('appinstalled', () => { deferred = null; show(false); });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-install-dismiss]')) {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* sin almacenamiento */ }
      if (banner) banner.hidden = true;
      return;
    }
    const btn = e.target.closest('[data-install]');
    if (!btn) return;
    e.preventDefault();
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') show(false);
    } else {
      // iPhone (o un navegador que no ofrece instalar): los pasos.
      window.location.assign('/instalar');
    }
  });
})();
