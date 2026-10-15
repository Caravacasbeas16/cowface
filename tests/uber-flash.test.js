// Uber Flash: ubicación del comprador, botón para abrir Uber con el destino, captura y link del viaje,
// y el pedido se da por recibido al final del día (para pagarle a la tienda ese mismo día).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PNG, adminLogin, ctx, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { sameDayRelease } = await import('../src/payout-schedule.js');
const { orderDataText } = await import('../src/order-data.js');

before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let order;
const reload = () => { order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id); };
const ship = (cookie, id, fields) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  body.append('comprobante', new Blob([PNG], { type: 'image/png' }), 'viaje.png');
  return fetch(`${ctx.base}/pedidos/${id}/enviado`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
};

test('liberación al final del día (hora de Costa Rica), o al día siguiente si se envió cerca del corte', () => {
  // 10:00 a. m. en Costa Rica = 16:00 UTC → se libera 5:59 p. m. del mismo día (23:59 UTC).
  assert.equal(sameDayRelease(Date.parse('2026-10-14T16:00:00Z'), 18), '2026-10-14T23:59:00.000Z');
  // 4:00 p. m. (menos de 3 h antes del corte) → al día siguiente.
  assert.equal(sameDayRelease(Date.parse('2026-10-14T22:00:00Z'), 18), '2026-10-15T23:59:00.000Z');
});

test('preparación: compra con Uber Flash y la ubicación del comprador', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller, { title: 'Camisa polo azul' });
  await post(`/p/${id}/comprar`, buyer);
  order = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  assert.match(await (await get(`/mensajes/${order.conversation_id}`, buyer)).text(), /Mandar mi ubicación/);
  await post(`/pedidos/${order.id}/entrega`, buyer, { method: 'uber_flash', address: 'San Pedro, del Mall 200 m este', lat: '9.9331', lng: '-84.0537' });
  reload();
  assert.equal(order.delivery_lat, 9.9331);
  assert.equal(order.delivery_lng, -84.0537);
  // Fuera de Costa Rica no se guarda.
  await post(`/pedidos/${order.id}/entrega`, buyer, { method: 'uber_flash', address: 'San Pedro, del Mall 200 m este', lat: '40.7', lng: '-74' });
  reload();
  assert.equal(order.delivery_lat, null);
  await post(`/pedidos/${order.id}/entrega`, buyer, { method: 'uber_flash', address: 'San Pedro, del Mall 200 m este', lat: '9.9331', lng: '-84.0537' });
  await post(`/pedidos/${order.id}/cotizar`, seller, { method: 'uber_flash', cost: '2800' });
  await post(`/pedidos/${order.id}/pago`, buyer, { reference: '11223344', address: 'San Pedro, del Mall 200 m este', phone: '8777-1234' });
  await post(`/admin/pedidos/${order.id}/confirmar-pago`, admin);
  reload();
  assert.equal(order.status, 'pagado');
});

test('pagado: la tienda ve "Abrir Uber con el destino"; el comprador todavía no ve "Lo recibí"', async () => {
  const sellerPage = await (await get(`/mensajes/${order.conversation_id}`, seller)).text();
  assert.match(sellerPage, /Abrir Uber con el destino/);
  assert.match(sellerPage, /https:\/\/m\.uber\.com\/ul\/\?action=setPickup&amp;pickup=my_location[^"]*dropoff%5Blatitude%5D=9\.9331/);
  assert.match(sellerPage, /Link para seguir el viaje/);
  const buyerPage = await (await get(`/mensajes/${order.conversation_id}`, buyer)).text();
  assert.doesNotMatch(buyerPage, /Lo recibí, todo bien/);
  assert.match(buyerPage, /pide el Uber Flash/);
  const text = orderDataText({ ...order, buyer_name: 'Compradora' });
  assert.match(text, /maps\.google\.com\/\?q=9\.9331,-84\.0537/);
  assert.match(text, /m\.uber\.com\/ul/);
});

test('enviado: link de seguimiento validado; el comprador lo sigue en vivo y confirma; se libera al final del día', async () => {
  let res = await ship(seller, order.id, { track: 'https://estafa.com/uber.com/viaje' });
  assert.match(flashOf(res), /Compartir viaje/);
  reload();
  assert.equal(order.status, 'pagado');

  const before = Date.now();
  res = await ship(seller, order.id, { track: 'https://trip.uber.com/v2/share/abc123' });
  reload();
  assert.equal(order.status, 'enviado');
  assert.equal(order.track_url, 'https://trip.uber.com/v2/share/abc123');
  const release = Date.parse(order.auto_release_at);
  assert.ok(release > before && release - before <= 48 * 3600e3, 'mismo día o el siguiente, no 3 días');
  assert.equal(new Date(release).getUTCMinutes(), 59);

  const buyerPage = await (await get(`/mensajes/${order.conversation_id}`, buyer)).text();
  assert.match(buyerPage, /Tu pedido va en Uber Flash/);
  assert.match(buyerPage, /href="https:\/\/trip\.uber\.com\/v2\/share\/abc123"[^>]*>📍 Seguir el viaje en vivo/);
  assert.match(buyerPage, /Lo recibí, todo bien/);
  assert.match(buyerPage, /se da por recibido al final del día/);
});

test('el permiso de ubicación solo se permite para el mismo sitio', async () => {
  assert.match((await get('/')).headers.get('permissions-policy'), /geolocation=\(self\)/);
});
