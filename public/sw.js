// Service worker de CowFace: recibe las notificaciones aunque la página esté cerrada, y si no hay
// internet muestra la pantalla "Sin conexión" en vez del error del navegador.
// No guarda páginas del sitio en caché: siempre se pide la versión al día; solo la pantalla sin conexión.
const OFFLINE_CACHE = 'cowface-offline-v1';
const OFFLINE_FILES = ['/offline.html', '/css/offline.css', '/js/offline.js', '/img/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('cowface-') && key !== OFFLINE_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  // Los archivos de la pantalla sin conexión salen de la caché (los necesita cuando no hay internet).
  if (OFFLINE_FILES.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(request)));
    return;
  }
  // Páginas: siempre a la red; si no hay conexión, la pantalla sin conexión.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/offline.html')) || Response.error()));
  }
});

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
