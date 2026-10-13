// Pagos protegidos (modelo Grailed): el comprador paga a CowFace, CowFace retiene y le paga al vendedor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, flashOf, get, post, publishPolo, setSetting, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { runOrderTimers } = await import('../src/orders.js');

before(startServer);
after(stopServer);

let seller;
let buyer;
let admin;

const product = (id) => ({ ...db.prepare('SELECT quantity, status FROM products WHERE id = ?').get(id) });
const order = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
// Cada aviso de pago lleva un comprobante distinto (un comprobante no puede usarse en dos pedidos).
let receipt = 123456000;
const PAYMENT = {
  get reference() { receipt += 1; return String(receipt); },
  method: 'correos', address: 'Heredia, San Pablo, 100 m norte de la iglesia', phone: '8777-0000',
};

async function buyDirect(productId) {
  const res = await post(`/p/${productId}/comprar`, buyer);
  assert.equal(res.status, 302);
  return lastOrder();
}

test('sin cobro configurado no se puede comprar', async () => {
  seller = await signupSeller('vendedora@test.cr', 'Vendedora', '8888-1234');
  buyer = await signup('comprador@test.cr', 'Comprador', '8777-0000');
  admin = await adminLogin();
  const id = await publishPolo(seller);
  const res = await post(`/p/${id}/comprar`, buyer);
  assert.match(flashOf(res), /todavía no está recibiendo pagos/);
  assert.equal(product(id).quantity, 1, 'no reservó nada');

  const bad = await post('/admin/pagos-config', admin, { phone: '12', holder: '', window_hours: '24', release_days: '3' });
  assert.match(flashOf(bad), /SINPE/);
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'Dueño CowFace', window_hours: '24', release_days: '3' });
});

test('flujo completo: oferta aceptada → pago → verificación → envío → recibido → pago al vendedor', async () => {
  const id = await publishPolo(seller);
  await post(`/p/${id}/ofertar`, buyer, { amount: '20000' });
  const offer = db.prepare("SELECT * FROM offers WHERE status = 'pendiente' ORDER BY id DESC").get();
  assert.equal((await post(`/ofertas/${offer.id}/aceptar`, seller, {}, true)).status, 200);

  let o = lastOrder();
  assert.equal(o.status, 'por_pagar');
  assert.equal(o.price, 20000);
  assert.equal(o.commission_amount, 400, '2 % de 20 000');
  assert.equal(o.payout_amount, 19600);
  assert.deepEqual(product(id), { quantity: 0, status: 'reservado' });

  // El comprador ve el SINPE de CowFace, nunca el del vendedor.
  const buyerPage = await (await get(`/mensajes/${o.conversation_id}`, buyer)).text();
  assert.match(buyerPage, /60001111/);
  assert.doesNotMatch(buyerPage, /88881234/);

  // El vendedor no puede enviar antes de que CowFace confirme el pago.
  assert.match(flashOf(await post(`/pedidos/${o.id}/enviado`, seller)), /cambió de estado/);

  // Aviso de pago: valida comprobante y dirección.
  assert.match(flashOf(await post(`/pedidos/${o.id}/pago`, buyer, { ...PAYMENT, reference: '' })), /comprobante/);
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  o = order(o.id);
  assert.ok(o.payment_reported_at);
  assert.equal(o.delivery_phone, '87770000');

  // Antes de confirmar, el vendedor todavía no ve la dirección.
  assert.doesNotMatch(await (await get(`/mensajes/${o.conversation_id}`, seller)).text(), /iglesia/);
  // Otro usuario no puede tocar el pedido.
  const other = await signup('otro@test.cr', 'Otro');
  assert.equal((await post(`/pedidos/${o.id}/recibido`, other)).status, 404);

  const adminPage = await (await get('/admin', admin)).text();
  assert.match(adminPage, /Pagos por verificar/);
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  assert.equal(order(o.id).status, 'pagado');

  const sellerPage = await (await get(`/mensajes/${o.conversation_id}`, seller)).text();
  assert.match(sellerPage, /iglesia/);
  assert.match(sellerPage, /87770000/);

  await post(`/pedidos/${o.id}/enviado`, seller, { note: 'Guía Correos CR123' });
  o = order(o.id);
  assert.equal(o.status, 'enviado');
  assert.ok(o.auto_release_at > new Date(Date.now() + 2.9 * 86400e3).toISOString(), 'libera en ~3 días');

  await post(`/pedidos/${o.id}/recibido`, buyer);
  o = order(o.id);
  assert.equal(o.status, 'completado');
  assert.equal(o.payout_status, 'pendiente');
  assert.deepEqual(product(id), { quantity: 0, status: 'vendido' });

  assert.match(await (await get('/admin', admin)).text(), /Enviar <strong>₡19\s?600<\/strong> a <strong>88881234/);
  await post(`/admin/pedidos/${o.id}/pago-vendedor`, admin);
  assert.equal(order(o.id).payout_status, 'pagado');
});

test('pago no encontrado: el comprador puede volver a avisar', async () => {
  const id = await publishPolo(seller);
  const o = await buyDirect(id);
  assert.equal(o.price, 25000);
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  assert.match(flashOf(await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT)), /verificando/);
  await post(`/admin/pedidos/${o.id}/rechazar-pago`, admin);
  assert.equal(order(o.id).payment_reported_at, null);
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  assert.ok(order(o.id).payment_reported_at);
});

test('reclamo resuelto a favor del comprador: reembolso y el artículo vuelve a la venta', async () => {
  const id = await publishPolo(seller);
  const o = await buyDirect(id);
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);

  assert.match(flashOf(await post(`/pedidos/${o.id}/reclamo`, buyer, { reason: 'corto' })), /qué pasó/);
  await post(`/pedidos/${o.id}/reclamo`, buyer, { reason: 'El vendedor no responde y no lo ha enviado.' });
  assert.equal(order(o.id).status, 'en_disputa');
  assert.match(flashOf(await post(`/pedidos/${o.id}/recibido`, buyer)), /cambió de estado/, 'en reclamo no se libera');

  await post(`/admin/pedidos/${o.id}/reembolsar`, admin);
  assert.equal(order(o.id).status, 'reembolso_pendiente');
  assert.deepEqual(product(id), { quantity: 1, status: 'disponible' }, 'no se había enviado: vuelve al inventario');
  await post(`/admin/pedidos/${o.id}/reembolsado`, admin);
  assert.equal(order(o.id).status, 'reembolsado');
});

test('el vendedor no puede entregar: queda reembolso pendiente', async () => {
  const id = await publishPolo(seller);
  const o = await buyDirect(id);
  await post(`/pedidos/${o.id}/pago`, buyer, PAYMENT);
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await post(`/pedidos/${o.id}/no-puedo-entregar`, seller);
  assert.equal(order(o.id).status, 'reembolso_pendiente');
  assert.equal(product(id).status, 'disponible');
});

test('plazos automáticos: sin pago se cancela; enviado sin reclamo se completa', async () => {
  const id1 = await publishPolo(seller);
  const unpaid = await buyDirect(id1);
  db.prepare("UPDATE orders SET payment_due_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(unpaid.id);

  const id2 = await publishPolo(seller);
  const shipped = await buyDirect(id2);
  await post(`/pedidos/${shipped.id}/pago`, buyer, PAYMENT);
  await post(`/admin/pedidos/${shipped.id}/confirmar-pago`, admin);
  await post(`/pedidos/${shipped.id}/enviado`, seller, { note: 'Guía Correos RR123CR' });
  db.prepare("UPDATE orders SET auto_release_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(shipped.id);

  const result = runOrderTimers();
  assert.deepEqual(result, { expired: 1, released: 1 });
  assert.equal(order(unpaid.id).status, 'cancelado');
  assert.deepEqual(product(id1), { quantity: 1, status: 'disponible' });
  assert.equal(order(shipped.id).status, 'completado');
  assert.equal(order(shipped.id).payout_status, 'pendiente');
});

test('el comprador puede cancelar antes de pagar; después de avisar el pago, no', async () => {
  const id = await publishPolo(seller);
  const a = await buyDirect(id);
  await post(`/pedidos/${a.id}/cancelar`, buyer);
  assert.equal(order(a.id).status, 'cancelado');
  assert.equal(product(id).status, 'disponible');

  const b = await buyDirect(id);
  await post(`/pedidos/${b.id}/pago`, buyer, PAYMENT);
  assert.match(flashOf(await post(`/pedidos/${b.id}/cancelar`, buyer)), /ya reportó el pago/);
});

test('cambiar la comisión no altera pedidos anteriores', async () => {
  const before = lastOrder();
  await post('/admin/comision', admin, { percent: '8' });
  const id = await publishPolo(seller);
  const o = await buyDirect(id);
  assert.equal(o.commission_amount, 2000, '8 % de 25 000');
  assert.equal(order(before.id).commission_rate, 0.02);
  setSetting('commission_rate', '0.02');
});
