// Instalar como app: página de pasos, botón y aviso, manifiesto con atajos y pantalla sin conexión.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, startServer, stopServer } from './helpers.js';

before(startServer);
after(stopServer);

test('la página /instalar explica cómo instalarla en iPhone y Android', async () => {
  const res = await get('/instalar');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Agregar a pantalla de inicio/);
  assert.match(html, /Instalar app/);
  assert.match(html, /data-install hidden/, 'el botón se muestra solo si el navegador puede instalar');
});

test('menú, aviso y script de instalación', async () => {
  const home = await (await get('/')).text();
  assert.match(home, /data-install-banner hidden/, 'el aviso arranca oculto (lo muestra el script si se puede instalar)');
  assert.match(home, /href="\/instalar" class="menu-only menu-install" data-install hidden/);
  assert.match(home, /src="\/js\/install\.js\?v=/);
  assert.doesNotMatch(await (await get('/terminos')).text(), /data-install-banner/, 'el aviso no aparece en todas las páginas');
});

test('el manifiesto tiene lo necesario para instalarla, con atajos', async () => {
  const m = await (await get('/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.id, '/');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.deepEqual(m.shortcuts.map((s) => s.url), ['/buscar', '/mensajes', '/vender']);
  assert.equal((await get('/?app=1')).status, 200, 'la página de inicio de la app abre');
});

test('pantalla sin conexión: existe y el service worker la guarda y la usa', async () => {
  const off = await get('/offline.html');
  assert.equal(off.status, 200);
  assert.match(await off.text(), /Sin conexión/);
  for (const f of ['/css/offline.css', '/js/offline.js', '/img/icon-192.png']) assert.equal((await get(f)).status, 200, f);
  const sw = await (await get('/sw.js')).text();
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /'\/offline\.html'/);
  assert.match(sw, /request\.mode === 'navigate'/);
});
