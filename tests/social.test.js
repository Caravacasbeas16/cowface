// Reseñas, bloqueos entre usuarios, entrar con Google/Facebook y completar perfil.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  adminLogin, ctx, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { loginWithProvider } = await import('../src/oauth.js');
const { parseFilters, searchProducts } = await import('../src/products.js');

before(startServer);
after(stopServer);

let seller;
let buyer;
let admin;
let sellerId;
let buyerId;
let receipt = 555666000;
const PAYMENT = {
  get reference() { receipt += 1; return String(receipt); },
  method: 'en_persona', address: 'Mall San Pedro, sábado 3 p. m.', phone: '8777-0000',
};
const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();

// Sesión directa para un usuario (como si hubiera entrado con Google).
function sessionFor(id) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, id, new Date(Date.now() + 86400e3).toISOString());
  return `sid=${token}`;
}

async function completedOrder() {
  const id = await publishPolo(seller);
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await post(`/pedidos/${o.id}/enviado`, seller);
  await post(`/pedidos/${o.id}/recibido`, buyer);
  return { productId: id, order: lastOrder() };
}

test('preparación: vendedora, comprador y cobro configurado', async () => {
  seller = await signupSeller('vende@test.cr', 'Vendedora', '8888-1234');
  buyer = await signup('compra@test.cr', 'Comprador', '8777-0000');
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  sellerId = userId('vende@test.cr');
  buyerId = userId('compra@test.cr');
});

// ---------- Reseñas ----------

test('reseñas en los dos sentidos después de completar un pedido', async () => {
  const id = await publishPolo(seller);
  await post(`/p/${id}/comprar`, buyer);
  const pending = lastOrder();
  assert.match(flashOf(await post(`/resenas/${pending.id}`, buyer, { rating: '5' })), /pedido completado/, 'no antes de completar');

  const { order } = await completedOrder();
  assert.equal(order.status, 'completado');
  assert.match(flashOf(await post(`/resenas/${order.id}`, buyer, { rating: '9' })), /1 a 5/);
  assert.match(flashOf(await post(`/resenas/${order.id}`, buyer, { rating: '4', comment: 'escribime al whatsapp' })), /whatsapp/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM flagged_messages WHERE context = 'reseña'").get().n, 1);

  await post(`/resenas/${order.id}`, buyer, { rating: '4', comment: 'Todo bien, llegó rápido.' });
  await post(`/resenas/${order.id}`, seller, { rating: '5', comment: 'Pagó al toque.' });
  assert.match(flashOf(await post(`/resenas/${order.id}`, buyer, { rating: '1' })), /Ya dejaste/);

  const outsider = await signup('fuera@test.cr', 'Fuera');
  assert.equal((await post(`/resenas/${order.id}`, outsider, { rating: '1' })).status, 404);

  const rows = db.prepare('SELECT role, rating, subject_id FROM reviews WHERE order_id = ? ORDER BY role').all(order.id).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { role: 'comprador', rating: 5, subject_id: buyerId },
    { role: 'vendedor', rating: 4, subject_id: sellerId },
  ]);

  const profile = await (await get(`/u/${sellerId}`)).text();
  assert.match(profile, /Todo bien, llegó rápido/);
  assert.match(profile, /<strong>4\.0<\/strong>/);
});

// ---------- Bloqueos ----------

test('bloquear: sin chat ni tratos nuevos y sin ver sus artículos; el pedido pagado sigue', async () => {
  const id = await publishPolo(seller, { title: 'Chaqueta Columbia vintage' });
  await post(`/p/${id}/mensaje`, buyer, { body: '¿Sigue disponible?' });
  const convId = db.prepare('SELECT id FROM conversations WHERE product_id = ? AND buyer_id = ?').get(id, buyerId).id;

  // Un pedido ya pagado antes del bloqueo.
  const paidProduct = await publishPolo(seller, { title: 'Hoodie Xbox' });
  await post(`/p/${paidProduct}/comprar`, buyer);
  const paid = lastOrder();
  await post(`/pedidos/${paid.id}/pago`, buyer, PAYMENT);
  await post(`/admin/pedidos/${paid.id}/confirmar-pago`, admin);

  await post(`/u/${sellerId}/bloquear`, buyer);
  assert.ok(!searchProducts(parseFilters({ q: 'chaqueta columbia' }, buyerId)).items.some((p) => p.id === id), 'el comprador ya no la ve');
  assert.ok(searchProducts(parseFilters({ q: 'chaqueta columbia' })).items.some((p) => p.id === id), 'los demás sí');

  assert.equal((await post(`/mensajes/${convId}`, seller, { body: 'Hola?' }, true)).status, 403, 'la vendedora tampoco puede escribir');
  assert.match(flashOf(await post(`/p/${id}/ofertar`, buyer, { amount: '20000' })), /bloque/);
  assert.match(flashOf(await post(`/p/${id}/comprar`, buyer)), /bloque/);
  assert.match(await (await get(`/p/${id}`, buyer)).text(), /bloqueó a la otra/);

  await post(`/pedidos/${paid.id}/enviado`, seller);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'enviado', 'el pedido pagado sigue');

  assert.match(await (await get('/bloqueados', buyer)).text(), /Vendedora/);
  await post(`/u/${sellerId}/desbloquear`, buyer);
  assert.equal((await post(`/mensajes/${convId}`, seller, { body: 'Ahora sí' }, true)).status, 200);
});

// ---------- Google / Facebook ----------

test('los botones de Google/Facebook solo aparecen si están configurados', async () => {
  assert.equal((await get('/auth/google')).status, 404);
  assert.doesNotMatch(await (await get('/entrar')).text(), /Continuar con Google/);

  process.env.GOOGLE_CLIENT_ID = 'id-de-prueba';
  process.env.GOOGLE_CLIENT_SECRET = 'secreto-de-prueba';
  assert.match(await (await get('/entrar')).text(), /Continuar con Google/);
  const res = await get('/auth/google?next=/buscar');
  const url = new URL(res.headers.get('location'));
  assert.equal(url.host, 'accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), `${ctx.base}/auth/google/callback`);
  assert.ok(url.searchParams.get('state').length >= 32);

  // Al volver con un "state" distinto al de la cookie, se rechaza.
  const cb = await get(`/auth/google/callback?code=x&state=otro`, res.headers.get('set-cookie').split(';')[0]);
  assert.equal(cb.headers.get('location'), '/entrar');
  assert.match(flashOf(cb), /expiró o no es válido/);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

test('cuentas de Google/Facebook: crear, vincular por correo verificado y casos que se rechazan', () => {
  const fresh = loginWithProvider('google', { subject: 'g-1', email: 'Nueva@Gmail.com', emailVerified: true, name: 'Nueva Persona' });
  assert.equal(fresh.isNew, true);
  assert.deepEqual(loginWithProvider('google', { subject: 'g-1', email: '', emailVerified: false }), { userId: fresh.userId, isNew: false });

  const linked = loginWithProvider('google', { subject: 'g-2', email: 'compra@test.cr', emailVerified: true, name: 'X' });
  assert.deepEqual(linked, { userId: buyerId, isNew: false }, 'Google con correo verificado se une a la cuenta existente');

  assert.throws(() => loginWithProvider('facebook', { subject: 'f-1', email: 'vende@test.cr', emailVerified: true }), /correo y contraseña/);
  assert.throws(() => loginWithProvider('google', { subject: 'g-3', email: 'x@y.com', emailVerified: false }), /correo confirmado/);
  assert.throws(() => loginWithProvider('google', { subject: 'g-4', email: 'admin@test.cr', emailVerified: true }), /No puedes entrar/);
});

test('una cuenta nueva de Google completa teléfono y provincia antes de usar el sitio', async () => {
  const id = userId('nueva@gmail.com');
  const cookie = sessionFor(id);
  const home = await get('/', cookie);
  assert.equal(home.headers.get('location'), '/completar-perfil?next=%2F');
  assert.equal((await get('/terminos', cookie)).status, 200, 'puede leer los términos');

  const bad = await post('/completar-perfil', cookie, { phone: '8555-1212', province: 'Heredia', next: '/buscar' });
  assert.equal(bad.status, 400, 'debe aceptar los términos');
  const ok = await post('/completar-perfil', cookie, { phone: '8555-1212', province: 'Heredia', terms: '1', next: '/buscar' });
  assert.equal(ok.headers.get('location'), '/buscar');
  assert.equal((await get('/', cookie)).status, 200);

  // No tiene contraseña: no puede entrar con correo y contraseña.
  const login = await post('/entrar', '', { email: 'nueva@gmail.com', password: '!' });
  assert.equal(login.status, 401);
});
