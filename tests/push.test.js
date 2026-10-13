// Notificaciones en el celular (Web Push): activar, a quién le llegan y qué dicen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { pushOutbox, validSubscription } = await import('../src/push.js');

process.env.PUSH_TEST_OUTBOX = '1';
before(startServer);
after(stopServer);

let seller;
let buyer;
let convId;
const settle = () => new Promise((r) => setTimeout(r, 50));
const SUB = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`, p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg', device: 'Android' });
const sellerId = () => db.prepare("SELECT id FROM users WHERE email = 'vende@test.cr'").get().id;
const toSeller = (from) => pushOutbox.slice(from).filter((p) => p.userId === sellerId());

test('preparación', async () => {
  seller = await signupSeller('vende@test.cr', 'Tienda Push');
  buyer = await signup('compra@test.cr', 'Compradora');
});

test('la clave pública se crea sola una vez y se reutiliza', async () => {
  const a = await (await get('/push/clave')).json();
  const b = await (await get('/push/clave')).json();
  assert.ok(a.key.length > 80);
  assert.equal(a.key, b.key);
});

test('solo acepta direcciones de servicios de notificaciones reales', async () => {
  assert.equal(validSubscription({ endpoint: 'https://evil.example/x', keys: { p256dh: 'abc', auth: 'abc' } }), null);
  assert.equal(validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: 'abc', auth: 'abc' } }), null);
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com.evil.example/x', keys: { p256dh: 'abc', auth: 'abc' } }), null);
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'abc', auth: 'abc' } }));
  const bad = await post('/push/suscribir', seller, { ...SUB(1), endpoint: 'https://169.254.169.254/latest' });
  assert.equal(bad.status, 400);
  const ok = await post('/push/suscribir', seller, SUB(1));
  assert.equal((await ok.json()).devices, 1);
  // Volver a activarla en el mismo celular no duplica.
  await post('/push/suscribir', seller, SUB(1));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  // Sin sesión no se puede.
  assert.equal((await post('/push/suscribir', '', SUB(2))).status, 302);
});

test('cuando le escriben, al vendedor le llega una notificación con el mensaje y el enlace', async () => {
  const id = await publishPolo(seller);
  let from = pushOutbox.length;
  const res = await post(`/p/${id}/mensaje`, buyer, { body: '¿Todavía la tienes?' });
  convId = Number(res.headers.get('location').split('/').pop());
  await settle();
  const [n] = toSeller(from);
  assert.equal(n.title, 'Compradora · Camisa polo azul');
  assert.equal(n.body, '¿Todavía la tienes?');
  assert.equal(n.url, `/mensajes/${convId}`);
  assert.equal(n.tag, `conv-${convId}`);

  from = pushOutbox.length;
  await post(`/mensajes/${convId}/oferta`, buyer, { amount: '20000' }, true);
  await settle();
  assert.match(toSeller(from)[0].body, /Oferta: ₡20\s?000/);

  // Lo que escribe el vendedor no le llega a él (la compradora no activó notificaciones).
  from = pushOutbox.length;
  await post(`/mensajes/${convId}`, seller, { body: 'Sí, la tengo' }, true);
  await settle();
  assert.equal(pushOutbox.length, from);
});

test('los avisos de CowFace sobre el pedido también llegan', async () => {
  const admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  const id = await publishPolo(seller);
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '55511122', method: 'correos', address: 'Heredia centro', phone: '8777-0000' });
  const from = pushOutbox.length;
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await settle();
  const [n] = toSeller(from);
  assert.match(n.title, /^CowFace · /);
  assert.match(n.body, /confirmó el pago/);
});

test('desactivar en un dispositivo deja de mandar ahí', async () => {
  await post('/push/quitar', seller, { endpoint: SUB(1).endpoint });
  const from = pushOutbox.length;
  await post(`/mensajes/${convId}`, buyer, { body: '¿Me la apartas?' }, true);
  await settle();
  assert.equal(toSeller(from).length, 0);
});

test('Mi cuenta muestra el panel y los mensajes; el sitio se puede instalar', async () => {
  const page = await (await get('/vendedor', seller)).text();
  assert.match(page, /Notificaciones en el celular/);
  assert.match(page, /Agregar a pantalla de inicio/);
  assert.match(page, /Mis mensajes/);
  assert.match(page, /Compradora/);
  const manifest = await (await get('/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('cache-control'), /no-cache/);
  assert.match(await (await get('/')).text(), /rel="manifest"/);
});
