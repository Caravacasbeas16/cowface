// Protecciones agregadas tras la auditoría de seguridad.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLO, adminLogin, ctx, db, flashOf, get, post, publish, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { ensureAdmin } = await import('../src/admin-account.js');
const { findBlocked } = await import('../src/moderation.js');

process.env.ADMIN_EMAIL = 'jefe@cowface.test';
before(startServer);
after(stopServer);

let seller;
let buyer;
let admin;
let receipt = 900000000;
const pay = (orderId, cookie) => post(`/pedidos/${orderId}/pago`, cookie, {
  reference: String(++receipt), method: 'correos', address: 'Cartago centro, frente al parque', phone: '8777-0000',
});
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();

test('preparación', async () => {
  seller = await signupSeller('vende@test.cr', 'Vendedora');
  buyer = await signup('compra@test.cr', 'Comprador', '8777-0000');
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
});

test('nadie puede registrarse con el correo del admin ni convertirse en admin', async () => {
  const res = await post('/registro', '', { name: 'X', email: 'jefe@cowface.test', phone: '8888-0000', province: 'Heredia', password: 'clave-segura-1' });
  assert.equal(res.status, 400);

  // Si ya existiera una cuenta normal con ese correo, al arrancar NO se convierte en admin.
  db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('usuario', 'Intruso', 'nuevo-admin@cowface.test', '!')").run();
  assert.equal(ensureAdmin({ email: 'nuevo-admin@cowface.test', password: 'clave-muy-segura-1' }), false);
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'nuevo-admin@cowface.test'").get().role, 'usuario');
});

test('cambiar la contraseña del admin cierra sus sesiones', async () => {
  ensureAdmin({ email: 'otro-admin@cowface.test', password: 'clave-original-123' });
  const login = await post('/entrar', '', { email: 'otro-admin@cowface.test', password: 'clave-original-123' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/admin', cookie)).status, 200);
  ensureAdmin({ email: 'otro-admin@cowface.test', password: 'clave-original-123' });
  assert.equal((await get('/admin', cookie)).status, 200, 'misma contraseña: la sesión sigue');
  ensureAdmin({ email: 'otro-admin@cowface.test', password: 'clave-nueva-456789' });
  assert.equal((await get('/admin', cookie)).status, 302, 'contraseña nueva: sesión cerrada');
});

test('10 contraseñas fallidas bloquean la cuenta aunque cambien de IP', async () => {
  const attempt = (ip, password) => fetch(`${ctx.base}/entrar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'compra@test.cr', password }),
    headers: { 'X-Forwarded-For': ip },
  });
  for (let i = 0; i < 10; i++) assert.equal((await attempt(`10.0.0.${i}`, 'mala')).status, 401);
  const locked = await attempt('10.0.1.1', 'clave-segura-1');
  assert.equal(locked.status, 429, 'ni con la contraseña correcta desde otra IP');
  assert.match(await locked.text(), /para esta cuenta/);
});

test('un comprobante de SINPE no sirve para dos pedidos', async () => {
  const a = await publishPolo(seller);
  const b = await publishPolo(seller);
  await post(`/p/${a}/comprar`, buyer);
  const first = lastOrder();
  await post(`/p/${b}/comprar`, buyer);
  const second = lastOrder();
  const data = { reference: '777000111', method: 'correos', address: 'Cartago centro, frente al parque', phone: '8777-0000' };
  await post(`/pedidos/${first.id}/pago`, buyer, data);
  assert.match(flashOf(await post(`/pedidos/${second.id}/pago`, buyer, data)), /ya se usó/);
  assert.equal(db.prepare('SELECT payment_reported_at FROM orders WHERE id = ?').get(second.id).payment_reported_at, null);
  await pay(second.id, buyer);
});

test('máximo 3 pedidos sin pagar por comprador', async () => {
  const other = await signup('acaparador@test.cr', 'Acaparador', '8777-1111');
  for (let i = 0; i < 3; i++) {
    const id = await publishPolo(seller);
    assert.equal((await post(`/p/${id}/comprar`, other)).status, 302);
  }
  const id = await publishPolo(seller);
  assert.match(flashOf(await post(`/p/${id}/comprar`, other)), /3 pedidos sin pagar/);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'disponible', 'no reservó');
});

test('no se acepta una oferta si el precio bajó por debajo de ella', async () => {
  const id = await publishPolo(seller);
  await post(`/p/${id}/ofertar`, buyer, { amount: '20000' });
  const offer = db.prepare("SELECT id FROM offers WHERE status = 'pendiente' ORDER BY id DESC").get();
  db.prepare('UPDATE products SET price = 18000 WHERE id = ?').run(id);
  assert.equal((await post(`/ofertas/${offer.id}/aceptar`, seller, {}, true)).status, 409);
  assert.equal(db.prepare('SELECT status FROM offers WHERE id = ?').get(offer.id).status, 'pendiente');
});

test('con un pedido en curso el artículo no se edita ni se borra', async () => {
  const id = await publishPolo(seller);
  await post(`/p/${id}/comprar`, buyer);
  assert.match(flashOf(await get(`/vendedor/productos/${id}/editar`, seller)), /pedido en curso/);
  assert.match(flashOf(await post(`/vendedor/productos/${id}/borrar`, seller)), /pedido en curso/);
  assert.ok(db.prepare('SELECT 1 FROM products WHERE id = ?').get(id), 'sigue existiendo');
});

test('un archivo que dice ser imagen pero no lo es se rechaza', async () => {
  const fake = await publish(seller, POLO, [{ data: Buffer.from('<script>alert(1)</script>'), type: 'image/png', name: 'x.png' }]);
  assert.equal(fake.status, 400);
  assert.match(await fake.text(), /no es una imagen válida/);
});

test('el filtro atrapa más formas de pasar un teléfono, sin bloquear precios', () => {
  for (const text of ['88 88 88 88', '8888/8888', '８８８８８８８８', 'ocho ocho ocho ocho siete siete siete siete', '+506 8888 8888']) {
    assert.ok(findBlocked(text), `debió bloquear: "${text}"`);
  }
  for (const text of ['Te lo dejo en ₡22 000', 'Entre 25000 y 30000', 'Mide 72 x 55 cm', 'Talla 32, largo 30', 'Tengo dos o tres más']) {
    assert.equal(findBlocked(text), null, `no debió bloquear: "${text}"`);
  }
});
