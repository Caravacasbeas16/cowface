// Entrega: el comprador elige Correos, Mensajería CowFace (GAM) o pick up; en Correos la tienda cotiza el envío
// (y lo puede cambiar mientras hablan); recién con la entrega definida se ve el total y se paga.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, flashOf, get, post, publishPolo, shipWithPhoto, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

before(startServer);
after(stopServer);

let seller;
let buyer;
let admin;
let o;
const order = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
const thread = async (cookie) => (await get(`/mensajes/${o.conversation_id}`, cookie)).text();

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller, { price: '20000' });
  await post(`/p/${id}/comprar`, buyer);
  o = lastOrder();
});

test('al comprar no hay envío ni total con envío: primero se elige la entrega', async () => {
  assert.deepEqual([o.shipping_cost, o.total, o.delivery_method], [0, 20000, null]);
  const page = await thread(buyer);
  assert.match(page, /¿Cómo lo quieres recibir\?/);
  assert.match(page, /Correos de Costa Rica/);
  assert.match(page, /Mensajería CowFace \(GAM\)/);
  assert.match(page, /Pick up/);
  assert.doesNotMatch(page, /60001111/, 'todavía no se muestra a dónde pagar');
  // Pagar sin entrega definida no se puede.
  const early = await post(`/pedidos/${o.id}/pago`, buyer, { reference: '11112222', phone: '8777-0000' });
  assert.match(flashOf(early), /Primero elijan la forma de entrega/);
});

test('el comprador pide Correos de Costa Rica con dirección; a la tienda le aparece para cotizar', async () => {
  assert.match(flashOf(await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: '' })), /dirección para el envío/);
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'Heredia, San Pablo, de la iglesia 200 m norte' });
  o = order(o.id);
  assert.deepEqual([o.delivery_requested, o.delivery_method, o.delivery_quote_at], ['correos', null, null]);
  const sellerPage = await thread(seller);
  assert.match(sellerPage, /El comprador lo quiere por <strong>Correos de Costa Rica<\/strong>/);
  assert.match(sellerPage, /de la iglesia 200 m norte/);
  assert.match(sellerPage, /Enviar cotización/);
  assert.match(await thread(buyer), /esperando la cotización de la tienda/);
  // Solo la tienda cotiza.
  assert.equal((await post(`/pedidos/${o.id}/cotizar`, buyer, { method: 'correos', cost: '1' })).status, 404);
});

test('la tienda cotiza; el comprador ve el total exacto y el SINPE; la tienda puede ajustar', async () => {
  assert.match(flashOf(await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '' })), /costo del envío/);
  const before = o.payment_due_at;
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '₡2.800', note: 'Sale hoy a las 4 p. m.' });
  o = order(o.id);
  assert.deepEqual([o.delivery_method, o.shipping_cost, o.total, o.payout_amount], ['correos', 2800, 22800, 20000 - 400 + 2800]);
  assert.ok(o.payment_due_at >= before, 'el plazo para pagar corre desde la cotización');
  let page = await thread(buyer);
  assert.match(page, /Entrega: Correos de Costa Rica · ₡2\s?800/);
  assert.match(page, /Sale hoy a las 4 p\. m\./);
  assert.match(page, /Total a pagar<\/span><span>₡22\s?800/);
  assert.match(page, /60001111/);
  assert.match(page, /La tienda cotizó la entrega/);

  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '3500' });
  page = await thread(buyer);
  assert.match(page, /Entrega: Correos de Costa Rica · ₡3\s?500/);
  assert.equal(order(o.id).total, 23500);
});

test('el comprador puede cambiar de forma de entrega: se vuelve a cotizar', async () => {
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'Mejor a mi trabajo: Heredia centro, edificio Plaza' });
  o = order(o.id);
  assert.deepEqual([o.delivery_requested, o.delivery_method, o.shipping_cost, o.total], ['correos', null, 0, 20000]);
  assert.match(await thread(seller), /Mejor a mi trabajo/);
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '2500' });
});

test('al pagar se cobra lo cotizado; después ya no se cambia; la tienda sube la foto del envío', async () => {
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '55556666', phone: '8777-0000', address: 'Heredia centro, edificio Plaza' });
  o = order(o.id);
  assert.equal(o.total, 22500);
  assert.ok(o.payment_reported_at);
  assert.match(flashOf(await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '9999' })), /ya avisó el pago/);
  assert.match(flashOf(await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'Otra dirección larga' })), /ya no se puede cambiar/);
  assert.equal(order(o.id).total, 22500);

  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  assert.match(await thread(seller), /Foto de la guía/);
  assert.match(await (await get('/admin', admin)).text(), /Entrega: Correos de Costa Rica/);
  await shipWithPhoto(seller, o.id);
  assert.equal(order(o.id).status, 'enviado');
});

test('pick up: sin costo, se paga enseguida y la tienda lo entrega sin foto', async () => {
  const id = await publishPolo(seller, { title: 'Gorra', price: '9000' });
  await post(`/p/${id}/comprar`, buyer);
  const p = lastOrder();
  await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'pick_up' });
  const page = await (await get(`/mensajes/${p.conversation_id}`, buyer)).text();
  assert.match(page, /Pick up · sin costo/);
  assert.match(page, /Total a pagar<\/span><span>₡9\s?000/);
  await post(`/pedidos/${p.id}/pago`, buyer, { reference: '77778888', phone: '8777-0000' });
  await post(`/admin/pedidos/${p.id}/confirmar-pago`, admin);
  assert.match(await (await get(`/mensajes/${p.conversation_id}`, seller)).text(), /Coordina el pick up/);
  await post(`/pedidos/${p.id}/enviado`, seller, { note: 'Entregado en el Mall Oxígeno' });
  assert.equal(order(p.id).status, 'enviado');
});

test('la tienda también puede cotizar sin que el comprador haya elegido, y no puede ofrecer pick up si no lo tiene', async () => {
  const id = await publishPolo(seller, { title: 'Bolso', price: '30000', meetup: '' });
  await post(`/p/${id}/comprar`, buyer);
  const p = lastOrder();
  assert.match(flashOf(await post(`/pedidos/${p.id}/cotizar`, seller, { method: 'pick_up' })), /no tiene pick up/);
  await post(`/pedidos/${p.id}/cotizar`, seller, { method: 'correos', cost: '0' });
  const page = await (await get(`/mensajes/${p.conversation_id}`, buyer)).text();
  assert.match(page, /Entrega: Correos de Costa Rica · envío gratis/);
  assert.doesNotMatch(page, /value="pick_up"/, 'sin pick up activado no se ofrece');
});

test('con puntos de pick up: se muestran en el artículo y el comprador elige uno', async () => {
  const bad = await post('/vendedor/tienda', seller, { store_address: 'Heredia', pickup_points: 'Llamame al 8888-8888' });
  assert.match(flashOf(bad), /dirección|teléfonos/);
  await post('/vendedor/tienda', seller, {
    store_address: 'Heredia, San Pablo, 100 m norte de la iglesia',
    pickup_points: 'Mall Oxígeno, Heredia — sábados 2 a 5 p. m.\nEstación del tren de Heredia — después de las 6 p. m.',
  });
  assert.match(await (await get('/vendedor/configuracion', seller)).text(), /al final del día/);
  const id = await publishPolo(seller, { title: 'Chaqueta', price: '18000' });
  const productPage = await (await get(`/p/${id}`)).text();
  assert.match(productPage, /Pick up: Mall Oxígeno, Heredia — sábados 2 a 5 p\. m\. · Estación del tren/);
  assert.doesNotMatch(productPage, /100 m norte de la iglesia/, 'la dirección de la tienda es privada');

  await post(`/p/${id}/comprar`, buyer);
  const p = lastOrder();
  assert.match(await (await get(`/mensajes/${p.conversation_id}`, buyer)).text(), /¿dónde lo recoges\?/);
  assert.match(flashOf(await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'pick_up' })), /Elige en cuál punto/);
  assert.match(flashOf(await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'pick_up', point: 'Otro lugar inventado' })), /Elige en cuál punto/);
  await post(`/pedidos/${p.id}/entrega`, buyer, { method: 'pick_up', point: 'Estación del tren de Heredia — después de las 6 p. m.' });
  assert.equal(order(p.id).delivery_address, 'Estación del tren de Heredia — después de las 6 p. m.');
  assert.match(await (await get(`/mensajes/${p.conversation_id}`, buyer)).text(), /Lo recoges en: Estación del tren de Heredia/);
  await post(`/pedidos/${p.id}/pago`, buyer, { reference: '99990000', phone: '8777-0000' });
  await post(`/admin/pedidos/${p.id}/confirmar-pago`, admin);
  assert.match(await (await get(`/mensajes/${p.conversation_id}`, seller)).text(), /Punto de pick up/);
});
