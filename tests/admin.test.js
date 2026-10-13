// Herramientas del admin: ganancias, tiendas destacadas y notificaciones por correo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');

process.env.MAIL_TEST_OUTBOX = '1';
before(startServer);
after(stopServer);

let admin;
let seller;
let other;
let buyer;
let receipt = 900000000;
const settle = () => new Promise((r) => setTimeout(r, 100));
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
const mailsTo = (from) => outbox.slice(from).filter((m) => m.to === 'avisos@test.cr');

async function sell(cookie, price = '25000') {
  const id = await publishPolo(cookie, { price });
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: String(++receipt), method: 'correos', address: 'Heredia centro', phone: '8777-0000' });
  return o;
}

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Tienda Uno');
  other = await signupSeller('otra@test.cr', 'Tienda Dos');
  buyer = await signup('compra@test.cr', 'Compradora');
});

test('notificaciones: correo propio, eventos elegidos y nada si está apagado', async () => {
  assert.match(flashOf(await post('/admin/notificaciones', admin, { email: 'no-es-correo', events: 'pago' })), /no es válido/);
  await post('/admin/notificaciones', admin, { email: 'avisos@test.cr', events: ['pago', 'reclamo', 'vendedor', 'registro'] });
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /value="avisos@test.cr"/);
  assert.match(page, /value="registro" checked/);
  assert.doesNotMatch(page, /value="publicacion" checked/);

  let from = outbox.length;
  await signup('nueva@test.cr', 'Persona Nueva');
  await settle();
  assert.equal(mailsTo(from).length, 1);
  assert.match(mailsTo(from)[0].subject, /Cuenta nueva: Persona Nueva/);

  from = outbox.length;
  const o = await sell(seller);
  await settle();
  const [mail] = mailsTo(from);
  assert.match(mail.subject, new RegExp(`Pago por verificar: ${o.code}`));
  assert.match(mail.text, /\/admin#pagos/);

  // El badge de "Admin" cuenta la tarea.
  assert.match(await (await get('/', admin)).text(), /Admin<span class="badge" >1</);

  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  from = outbox.length;
  await post(`/pedidos/${o.id}/reclamo`, buyer, { reason: 'No ha llegado y no me contesta.' });
  await settle();
  assert.match(mailsTo(from)[0].subject, /Reclamo en/);
  assert.match(mailsTo(from)[0].text, /No ha llegado/);

  from = outbox.length;
  await post(`/admin/pedidos/${o.id}/liberar`, admin);
  await settle();
  assert.match(mailsTo(from)[0].subject, /Pagar al vendedor/);

  // Apagado: no llega nada.
  await post('/admin/notificaciones', admin, { email: 'avisos@test.cr' });
  from = outbox.length;
  await signup('otra-nueva@test.cr', 'Otra Nueva');
  await sell(seller);
  await settle();
  assert.equal(mailsTo(from).length, 0);
  assert.equal((await post('/admin/notificaciones', buyer, { email: 'x@y.cr' })).status, 403);
});

test('tienda destacada: sale primero, con marca, y se puede quitar', async () => {
  const oldId = await publishPolo(other, { title: 'Camisa vieja de la tienda dos' });
  db.prepare("UPDATE products SET created_at = datetime('now', '-10 days') WHERE id = ?").run(oldId);
  await publishPolo(seller, { title: 'Camisa nueva de la tienda uno' });
  const first = async () => (await (await get('/buscar')).text()).match(/class="card-title">([^<]+)/)[1];
  assert.equal(await first(), 'Camisa nueva de la tienda uno');

  const otherId = db.prepare("SELECT id FROM users WHERE email = 'otra@test.cr'").get().id;
  assert.match(flashOf(await post(`/admin/tiendas/${otherId}/destacar`, admin, { days: '30' })), /30 días/);
  assert.equal(await first(), 'Camisa vieja de la tienda dos');
  assert.match(await (await get('/buscar')).text(), /★ Destacada/);
  assert.match(await (await get(`/p/${oldId}`)).text(), /Tienda destacada/);
  assert.match(await (await get('/')).text(), /Camisa vieja de la tienda dos/);

  // Vencida: deja de estar destacada sola.
  db.prepare("UPDATE users SET featured_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(otherId);
  assert.equal(await first(), 'Camisa nueva de la tienda uno');

  await post(`/admin/tiendas/${otherId}/destacar`, admin, { days: 'siempre' });
  assert.match(await (await get('/admin', admin)).text(), /sin fecha de fin/);
  await post(`/admin/tiendas/${otherId}/destacar`, admin, { days: 'quitar' });
  assert.equal(db.prepare('SELECT featured_until FROM users WHERE id = ?').get(otherId).featured_until, null);
  assert.equal((await post(`/admin/tiendas/${otherId}/destacar`, seller, { days: '30' })).status, 403);
});

test('ganancias: comisión por mes y por tienda, lo que está por entrar y el Excel', async () => {
  // Una venta completada más (25 000 → 500 de comisión) y una en curso.
  const done = await sell(other, '40000');
  await post(`/admin/pedidos/${done.id}/confirmar-pago`, admin);
  await post(`/pedidos/${done.id}/recibido`, buyer);

  const page = await (await get('/admin/ganancias', admin)).text();
  const completed = db.prepare("SELECT SUM(commission_amount) AS c FROM orders WHERE status = 'completado'").get().c;
  assert.equal(completed, 500 + 800);
  assert.match(page, /Este mes \(2 ventas\)/);
  assert.match(page, /₡1\s?300/);
  assert.match(page, /Tienda Dos/);
  assert.match(page, /Por entrar: 1 pedidos en curso/, 'el pedido avisado y sin completar');
  assert.match(page, /Debes a vendedores \(2\)/);

  const csv = await get('/admin/ganancias?formato=csv', admin);
  assert.match(csv.headers.get('content-disposition'), /cowface-ventas\.csv/);
  const text = await csv.text();
  assert.equal(text.trim().split('\r\n').length, 3, 'encabezado + 2 ventas');
  assert.match(text, /Pedido;Completado;Artículo/);
  assert.match(text, /;800;39200;pendiente/);

  const year = new Date().getFullYear();
  assert.match(await (await get(`/admin/ganancias?anio=${year}`, admin)).text(), new RegExp(`Año ${year}`));
  assert.match(await (await get('/admin/ganancias?anio=abc', admin)).text(), /Últimos 12 meses/);
  assert.equal((await get('/admin/ganancias', buyer)).status, 403);
});
