// Mensajería CowFace (GAM): el comprador manda su dirección, ubicación y los días en que puede recibir;
// paga la tarifa fija (₡2000 por defecto, se cambia en Admin → Cobro) sin esperar cotización; el envío
// es de CowFace (no se le suma a la tienda) y la tienda solo le entrega el paquete al mensajero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { availabilityText, nextDays } = await import('../src/courier.js');
const { orderDataText } = await import('../src/order-data.js');

before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let o;
const reload = () => { o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id); };
const thread = async (cookie) => (await get(`/mensajes/${o.conversation_id}`, cookie)).text();
const [d1, d2, d3] = nextDays();

test('días: los próximos 7 desde mañana (hora de Costa Rica); solo se aceptan esos', () => {
  // 11 p. m. del 18 de octubre en Costa Rica = 05:00 UTC del 19.
  const days = nextDays(Date.parse('2026-10-19T05:00:00Z'));
  assert.equal(days.length, 7);
  assert.equal(days[0].value, '2026-10-19');
  assert.match(days[0].label, /^lun 19 oct$/);
  const from = Date.parse('2026-10-19T05:00:00Z');
  assert.equal(availabilityText({ days: ['2026-10-21', '2026-10-19', '2030-01-01'], slot: 'tarde' }, from), 'lun 19 oct, mié 21 oct · en la tarde');
  assert.throws(() => availabilityText({ days: ['2030-01-01'] }, from), /al menos un día/);
});

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/mensajeria', admin, { on: '1' }); // apagada por defecto
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller, { price: '20000' });
  await post(`/p/${id}/comprar`, buyer);
  o = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
});

test('el comprador ve la mensajería con su tarifa y los días para elegir; ya no hay Uber Flash', async () => {
  const page = await thread(buyer);
  assert.match(page, /Mensajería CowFace \(GAM\)/);
  assert.match(page, /Dentro del GAM · ₡2\s?000/);
  assert.match(page, new RegExp(`name="days" value="${d1.value}"`));
  assert.match(page, /Mandar mi ubicación/);
  assert.doesNotMatch(page, /Uber/);
});

test('sin días o sin dirección no se puede; con todo queda lista para pagar, con el envío fijo', async () => {
  assert.match(flashOf(await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'mensajeria', address: 'San Pedro, del Mall 200 m este' })), /al menos un día/);
  assert.match(flashOf(await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'mensajeria', address: '', days: d1.value })), /dirección exacta/);
  const body = new URLSearchParams({ method: 'mensajeria', address: 'San Pedro, del Mall 200 m este', slot: 'manana', lat: '9.9331', lng: '-84.0537' });
  body.append('days', d1.value);
  body.append('days', d3.value);
  await post(`/pedidos/${o.id}/entrega`, buyer, body);
  reload();
  assert.equal(o.delivery_method, 'mensajeria');
  assert.ok(o.delivery_quote_at, 'no espera cotización de la tienda');
  assert.deepEqual([o.shipping_cost, o.total, o.payout_amount], [2000, 22000, 20000 - 400], 'el envío es de CowFace, no de la tienda');
  assert.equal(o.delivery_days, `${d1.label}, ${d3.label} · en la mañana`);
  assert.equal(o.delivery_lat, 9.9331);

  const buyerPage = await thread(buyer);
  assert.match(buyerPage, /Total a pagar<\/span><span>₡22\s?000/);
  assert.match(buyerPage, /60001111/);
  assert.match(buyerPage, new RegExp(`Puedes recibir: ${d1.label}`));
  const sellerPage = await thread(seller);
  assert.match(sellerPage, /nosotros pasamos a recoger el paquete/);
  assert.doesNotMatch(sellerPage, /Enviar cotización/);
  // La tienda no puede cotizar la mensajería (ni ponerle otro precio).
  assert.match(flashOf(await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'mensajeria', cost: '9000' })), /la elige el comprador/);
  assert.equal(db.prepare('SELECT total FROM orders WHERE id = ?').get(o.id).total, 22000);
});

test('pagado: la tienda ve los días y entrega al mensajero sin foto; el comprador lo recibe', async () => {
  await post(`/pedidos/${o.id}/pago`, buyer, { phone: '8777-1234' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  reload();
  const text = orderDataText({ ...o, buyer_name: 'Compradora' });
  assert.match(text, new RegExp(`Puede recibir: ${d1.label}`));
  assert.ok(text.includes('Ubicación en Waze: https://waze.com/ul?ll=9.9331,-84.0537&navigate=yes'));
  assert.match(text, /pasamos a recoger el paquete/);
  assert.match(await (await get('/admin', admin)).text(), /href="https:\/\/waze\.com\/ul\?ll=9\.9331,-84\.0537&amp;navigate=yes"[^>]*>🚗 Abrir en Waze/);
  // Sin ubicación del celular: Waze busca la dirección escrita.
  const noGps = orderDataText({ ...o, delivery_lat: null, delivery_lng: null, buyer_name: 'Compradora' });
  assert.ok(noGps.includes('Ubicación en Waze (por la dirección): https://waze.com/ul?q=San+Pedro%2C+del+Mall+200+m+este&navigate=yes'));
  assert.doesNotMatch(text, /Envío pagado por el comprador/, 'a la tienda no se le dice que el envío es suyo');

  const sellerPage = await thread(seller);
  assert.match(sellerPage, /Puede recibir/);
  assert.match(sellerPage, /Ya se lo entregué al mensajero/);
  assert.match(await thread(buyer), /Nosotros te llevamos el pedido/);

  await post(`/pedidos/${o.id}/enviado`, seller, {});
  reload();
  assert.equal(o.status, 'enviado');
  assert.match(await thread(buyer), /al mensajero de CowFace/);
  await post(`/pedidos/${o.id}/recibido`, buyer);
  reload();
  assert.equal(o.status, 'completado');
  assert.equal(o.payout_amount, 19600);
  assert.match(await (await get('/vendedor/ganancias', seller)).text(), /₡19\s?600/);
  assert.doesNotMatch(await thread(seller), /\+ envío/);
});

test('el admin cambia la tarifa; aplica a los pedidos nuevos', async () => {
  const bad = await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3', courier_fee: 'mucho' });
  assert.match(flashOf(bad), /Tarifa de mensajería/);
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3', courier_fee: '₡2.500' });
  assert.match(await (await get('/admin', admin)).text(), /name="courier_fee"[^>]*value="2500"/);
  const id = await publishPolo(seller, { title: 'Gorra', price: '10000' });
  await post(`/p/${id}/comprar`, buyer);
  const p = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'mensajeria', address: 'Heredia centro, edificio Plaza', days: d2.value });
  assert.equal(db.prepare('SELECT total FROM orders WHERE id = ?').get(p.id).total, 12500);
});

test('el admin la apaga: deja de ofrecerse, y el GAM va por Correos', async () => {
  assert.match(flashOf(await post('/admin/mensajeria', admin, { on: '0' })), /apagada/);
  const id = await publishPolo(seller, { title: 'Bolso', price: '10000' });
  await post(`/p/${id}/comprar`, buyer);
  const p = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  const page = await (await get(`/mensajes/${p.conversation_id}`, buyer)).text();
  assert.doesNotMatch(page, /Mensajería CowFace \(GAM\)/);
  assert.match(flashOf(await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'mensajeria', address: 'Heredia centro', days: d1.value })), /no está disponible/);
  assert.doesNotMatch(await (await get('/como-funciona')).text(), /Mensajería/);
  assert.doesNotMatch(await (await get('/admin', admin)).text(), /href="\/admin\/rutas"/, 'sin pedidos pendientes, Rutas no sale en el menú');
  assert.equal((await post('/admin/mensajeria', buyer, { on: '1' })).status, 403);
});
