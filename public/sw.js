// Service worker de CowFace: recibe las notificaciones aunque la página esté cerrada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'CowFace', {
    body: data.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/badge-96.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/mensajes' },
  }));
});

// Al tocarla: si CowFace ya está abierto, lo trae al frente en esa conversación; si no, lo abre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mensajes', self.location.origin);
  // Si el sitio se mudó a otro dominio, se abre la dirección nueva.
  if (url.origin !== self.location.origin) { event.waitUntil(self.clients.openWindow(url.href)); return; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === url.origin && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url.href);
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
