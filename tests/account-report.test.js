// Borrar la cuenta y reportar (requisitos de Google Play / App Store).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminLogin, db, flashOf, get, post, publishPolo, quoted, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let sellerId;
let buyerId;
const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['reporte'] });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  buyerId = db.prepare("SELECT id FROM users WHERE email = 'compra@test.cr'").get().id;
});

// ---------- Reportar ----------

test('reportar un artículo: llega al admin, que lo oculta; la tienda no puede volver a publicarlo', async () => {
  const id = await publishPolo(seller, { title: 'Bolso dudoso' });
  const page = await (await get(`/p/${id}`, buyer)).text();
  assert.match(page, /Reportar este artículo/);
  assert.doesNotMatch(await (await get(`/p/${id}`, seller)).text(), /Reportar este artículo/, 'no a lo propio');
  assert.match(flashOf(await post('/reportar', buyer, { type: 'articulo', id, reason: '', back: `/p/${id}` })), /Elige el motivo/);
  assert.match(flashOf(await post('/reportar', buyer, { type: 'articulo', id, reason: 'otro', details: 'x', back: `/p/${id}` })), /Cuéntanos/);

  const from = outbox.length;
  const res = await post('/reportar', buyer, { type: 'articulo', id, reason: 'replica', details: 'El logo está mal hecho.', back: `/p/${id}` });
  assert.equal(res.headers.get('location'), `/p/${id}`);
  assert.match(flashOf(res), /Gracias por avisar/);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(outbox.slice(from).find((m) => m.to === 'yo@test.cr').subject, /Reporte: Réplica o falsificación/);
  // Repetir el mismo reporte no lo duplica.
  await post('/reportar', buyer, { type: 'articulo', id, reason: 'replica', back: `/p/${id}` });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'abierto'").get().n, 1);

  const panel = await (await get('/admin', admin)).text();
  assert.match(panel, /🚩 Reportes/);
  assert.match(panel, /El logo está mal hecho/);
  const r = db.prepare("SELECT id FROM reports WHERE status = 'abierto'").get();
  await post(`/admin/reportes/${r.id}/ocultar`, admin);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'pausado');
  assert.doesNotMatch(await (await get('/buscar?q=dudoso')).text(), /Bolso dudoso/);
  assert.match(flashOf(await post(`/vendedor/productos/${id}/estado`, seller, { status: 'disponible' })), /CowFace ocultó este artículo/);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'pausado');
});

test('reportar una cuenta o una conversación; el admin suspende o descarta', async () => {
  assert.match(await (await get(`/u/${sellerId}`, buyer)).text(), /Reportar esta cuenta/);
  await post('/reportar', buyer, { type: 'usuario', id: sellerId, reason: 'estafa', back: `/u/${sellerId}` });
  const id = await publishPolo(seller, { title: 'Gorra' });
  const conv = Number((await post(`/p/${id}/mensaje`, buyer, { body: 'Hola' })).headers.get('location').split('/').pop());
  assert.match(await (await get(`/mensajes/${conv}`, seller)).text(), /Reportar esta conversación/);
  await post('/reportar', seller, { type: 'conversacion', id: conv, reason: 'ofensivo', details: 'Me insultó.', back: `/mensajes/${conv}` });
  // No se puede reportar una conversación ajena ni a uno mismo.
  const otra = await signup('otra@test.cr', 'Otra');
  assert.equal((await post('/reportar', otra, { type: 'conversacion', id: conv, reason: 'ofensivo' })).status, 404);
  assert.equal((await post('/reportar', buyer, { type: 'usuario', id: buyerId, reason: 'estafa' })).status, 404);
  assert.equal((await post('/reportar', '', { type: 'usuario', id: sellerId, reason: 'estafa', back: '/' })).status, 302, 'sin sesión: a entrar');

  const convReport = db.prepare("SELECT id FROM reports WHERE target_type = 'conversacion'").get();
  await post(`/admin/reportes/${convReport.id}/descartar`, admin);
  const userReport = db.prepare("SELECT id FROM reports WHERE target_type = 'usuario' AND status = 'abierto'").get();
  assert.equal((await post(`/admin/reportes/${userReport.id}/suspender`, buyer)).status, 403);
  await post(`/admin/reportes/${userReport.id}/suspender`, admin);
  assert.equal(user(sellerId).active, 0);
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(sellerId); // para seguir probando
  seller = (await post('/entrar', '', { email: 'tienda@test.cr', password: 'clave-segura-1' })).headers.get('set-cookie').split(';')[0];
});

// ---------- Borrar cuenta ----------

test('la página pública explica cómo borrar la cuenta y qué se conserva', async () => {
  const page = await (await get('/borrar-cuenta')).text();
  assert.match(page, /Qué se borra/);
  assert.match(page, /Qué se conserva/);
  assert.match(await (await get('/')).text(), /href="\/borrar-cuenta"/, 'enlace en el pie de página');
  assert.match(await (await get('/privacidad')).text(), /Borrar tu cuenta/);
});

test('no se puede borrar con un pedido en curso; luego sí, y los pedidos quedan anónimos', async () => {
  const id = await publishPolo(seller, { title: 'Jeans' });
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  quoted(o.id, 'correos', 0);
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '50505050', address: 'Heredia centro', phone: '8777-0000' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);

  assert.match(await (await get('/vendedor/borrar-cuenta', buyer)).text(), /Todavía no se puede borrar/);
  assert.match(await (await get('/vendedor/borrar-cuenta', buyer)).text(), new RegExp(`${o.code} está en curso`));

  await post(`/pedidos/${o.id}/recibido`, buyer);
  // Comprador: ya puede. Contraseña y confirmación obligatorias.
  assert.match(await (await post('/vendedor/borrar-cuenta', buyer, { password: 'mala', confirm: 'BORRAR' })).text(), /contraseña no es correcta/);
  assert.match(await (await post('/vendedor/borrar-cuenta', buyer, { password: 'clave-segura-1', confirm: 'no' })).text(), /Escribe BORRAR/);
  const res = await post('/vendedor/borrar-cuenta', buyer, { password: 'clave-segura-1', confirm: 'borrar' });
  assert.equal(res.headers.get('location'), '/');
  assert.match(flashOf(res), /Tu cuenta se borró/);

  const u = user(buyerId);
  assert.equal(u.name, 'Cuenta eliminada');
  assert.equal(u.active, 0);
  assert.equal(u.phone, null);
  assert.match(u.email, /@cowface\.invalid$/);
  assert.ok(u.deleted_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(buyerId).n, 0);
  assert.equal((await get('/vendedor', buyer)).status, 302, 'la sesión ya no sirve');
  assert.equal((await post('/entrar', '', { email: 'compra@test.cr', password: 'clave-segura-1' })).status, 401, 'no se puede entrar');
  // El pedido se conserva, sin su nombre.
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'completado');
  assert.match(await (await get(`/mensajes/${o.conversation_id}`, seller)).text(), /Cuenta eliminada/);
  assert.doesNotMatch(await (await get('/admin', admin)).text(), /compra@test\.cr/);
});

test('la tienda con un pago pendiente no puede borrar; después de pagarle, se borran sus artículos y fotos', async () => {
  assert.match(await (await get('/vendedor/borrar-cuenta', seller)).text(), /todavía te debe el pago de 1 venta/);
  const o = db.prepare("SELECT id FROM orders WHERE status = 'completado' ORDER BY id DESC").get();
  await post(`/admin/pedidos/${o.id}/pago-vendedor`, admin);
  const photos = db.prepare('SELECT i.filename FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.seller_id = ?').all(sellerId);
  assert.ok(photos.length > 0);
  await post('/vendedor/borrar-cuenta', seller, { password: 'clave-segura-1', confirm: 'BORRAR' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products WHERE seller_id = ?').get(sellerId).n, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(photos.every((p) => !fs.existsSync(path.join(process.env.UPLOAD_DIR, p.filename))), 'las fotos se borran del disco');
  assert.equal((await get(`/u/${sellerId}`)).status, 404, 'su perfil ya no existe');
});
