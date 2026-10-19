// Admin → Rutas: pedidos de la Mensajería CowFace de un día, ubicaciones que faltan, mensajeros,
// armar/deshacer rutas, mandarlas por WhatsApp y pagarle a cada mensajero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { parseCoords } = await import('../src/courier-runs.js');
const { nextDays } = await import('../src/courier.js');

before(startServer);
after(stopServer);

const [d1, d2] = nextDays().map((d) => d.value);
let admin;
let storeA;
let storeB;
let storeBId;
let buyer;
const orders = [];
const page = async (date = d1) => (await get(`/admin/rutas?fecha=${date}`, admin)).text();

test('coordenadas: a mano, de Google Maps o de Waze; fuera de Costa Rica no', () => {
  assert.deepEqual(parseCoords('9.9335, -84.0510'), { lat: 9.9335, lng: -84.051 });
  assert.deepEqual(parseCoords('https://www.google.com/maps/place/Mall/@9.9981,-84.1166,17z'), { lat: 9.9981, lng: -84.1166 });
  assert.deepEqual(parseCoords('https://waze.com/ul?ll=9.8644%2C-83.9194&navigate=yes'), { lat: 9.8644, lng: -83.9194 });
  assert.equal(parseCoords('40.7128, -74.0060'), null);
  assert.equal(parseCoords('San Pedro'), null);
});

test('preparación: dos tiendas y tres pedidos pagados por mensajería', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  storeA = await signupSeller('a@test.cr', 'Closet Heredia');
  storeB = await signupSeller('b@test.cr', 'Closet Cartago');
  storeBId = db.prepare("SELECT id FROM users WHERE email = 'b@test.cr'").get().id;
  buyer = await signup('compra@test.cr', 'Compradora');
  // La tienda A manda su ubicación desde el celular al guardar su dirección.
  const saved = await post('/vendedor/tienda', storeA, { store_address: 'Heredia centro, 100 m norte del parque', pickup_points: 'Parque de Heredia', lat: '9.9981', lng: '-84.1166' });
  assert.match(flashOf(saved), /ubicación de recogida/);
  await post('/vendedor/tienda', storeB, { store_address: 'Cartago, frente a las ruinas', pickup_points: 'Ruinas de Cartago' });

  const buy = async (store, title, coords) => {
    const id = await publishPolo(store, { title });
    await post(`/p/${id}/comprar`, buyer);
    const o = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
    const body = new URLSearchParams({ method: 'mensajeria', address: `Dirección de ${title}`, ...(coords || {}) });
    body.append('days', d1);
    await post(`/pedidos/${o.id}/entrega`, buyer, body);
    await post(`/pedidos/${o.id}/pago`, buyer, { phone: '8777-1234' });
    await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
    orders.push(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id));
  };
  await buy(storeA, 'Camisa', { lat: '9.9580', lng: '-84.0830' });
  await buy(storeA, 'Jeans', { lat: '10.0163', lng: '-84.2116' });
  await buy(storeB, 'Chaqueta');
  assert.equal(orders[0].delivery_dates, d1);
  assert.deepEqual(orders.map((o) => o.status), ['pagado', 'pagado', 'pagado']);
});

test('solo el admin; avisa qué ubicaciones faltan y se pegan desde Maps', async () => {
  assert.equal((await get('/admin/rutas', storeA)).status, 403);
  let html = await page();
  assert.match(html, /3 pagados, sin salir/);
  assert.match(html, /Falta la ubicación de 1 pedido/);
  assert.match(html, /Primero agrega a tus mensajeros/);
  assert.match(await (await get('/admin', admin)).text(), /Rutas<\/span>\s*<span class="badge">3</);
  const chaqueta = orders[2];
  assert.match(flashOf(await post(`/admin/rutas/ubicacion/pedido/${chaqueta.id}`, admin, { fecha: d1, coords: 'por ahí' })), /No encontré coordenadas/);
  await post(`/admin/rutas/ubicacion/pedido/${chaqueta.id}`, admin, { fecha: d1, coords: '9.9010, -84.0570' });
  await post(`/admin/rutas/ubicacion/tienda/${storeBId}`, admin, { fecha: d1, coords: 'https://www.google.com/maps/@9.8644,-83.9194,15z' });
  html = await page();
  assert.doesNotMatch(html, /Falta la ubicación/);
  assert.match(await page(d2), /3 pedidos para otros días/, 'otro día: no le tocan');
});

test('mensajeros: se agregan con su WhatsApp y el pago por envío', async () => {
  assert.match(flashOf(await post('/admin/mensajeros', admin, { fecha: d1, name: 'Luis', phone: '12' })), /8 dígitos/);
  await post('/admin/mensajeros', admin, { fecha: d1, name: 'Luis', phone: '7000-1111', start: '9.9981, -84.1166' });
  await post('/admin/mensajeros', admin, { fecha: d1, name: 'Marta', phone: '7000-2222' });
  assert.match(await page(), /Luis<\/strong> · 70001111 · sale de su punto/);
  assert.match(await page(), /name="pay" inputmode="numeric" value="2000"/);
});

test('armar las rutas: cada pedido se recoge antes de entregarse y sale el mensaje para WhatsApp', async () => {
  const ids = db.prepare('SELECT id FROM couriers ORDER BY id').all().map((c) => String(c.id));
  assert.match(flashOf(await post('/admin/rutas/armar', admin, { fecha: d1 })), /al menos un mensajero/);
  const body = new URLSearchParams({ fecha: d1 });
  for (const id of ids) body.append('couriers', id);
  assert.match(flashOf(await post('/admin/rutas/armar', admin, body)), /rutas? para el/);
  const assigned = db.prepare('SELECT courier_id, route_date FROM orders WHERE id IN (?, ?, ?)').all(...orders.map((o) => o.id));
  assert.ok(assigned.every((o) => o.route_date === d1 && o.courier_id));

  const routes = db.prepare('SELECT plan FROM courier_routes WHERE route_date = ?').all(d1).map((r) => JSON.parse(r.plan));
  for (const r of routes) {
    const seen = new Set();
    for (const s of r.stops) {
      if (s.kind === 'entregar') for (const id of s.orders) assert.ok(seen.has(id), 'recogido antes de entregar');
      if (s.kind === 'recoger') s.orders.forEach((id) => seen.add(id));
    }
  }
  const html = await page();
  assert.match(html, /href="https:\/\/wa\.me\/50670001111\?text=Ruta%20CowFace/);
  assert.match(html, /Recoger<\/span>\s*<strong>Closet Heredia/);
  assert.match(html, /href="https:\/\/waze\.com\/ul\?ll=/);
  assert.match(html, /Volver a armar las rutas/);
  assert.match(await (await get('/admin', admin)).text(), /Rutas<\/span>\s*(?!<span class="badge">)/, 'ya no hay pendientes');
});

test('deshacer y volver a armar con un solo mensajero: el mensaje trae el pago', async () => {
  await post('/admin/rutas/deshacer', admin, { fecha: d1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE route_date IS NOT NULL').get().n, 0);
  const luis = db.prepare("SELECT id FROM couriers WHERE name = 'Luis'").get().id;
  await post('/admin/rutas/armar', admin, { fecha: d1, couriers: String(luis) });
  const html = await page();
  // 2 tiendas (una parada cada una) + 3 compradores.
  assert.match(html, /5 paradas · [\d.]+ km/);
  assert.match(html, /Pago: 3 envíos × ₡2\s?000 = ₡6\s?000/);
});

test('cuando las tiendas entregan al mensajero, se le debe y se marca pagado', async () => {
  for (const o of orders.slice(0, 2)) await post(`/pedidos/${o.id}/enviado`, storeA, {});
  let html = await page();
  assert.match(html, /Por pagarles[\s\S]*Luis[\s\S]*2 envíos × ₡2\s?000/);
  const luis = db.prepare("SELECT id FROM couriers WHERE name = 'Luis'").get().id;
  assert.match(flashOf(await post(`/admin/mensajeros/${luis}/pagado`, admin, { fecha: d1 })), /2 envíos marcados como pagados/);
  html = await page();
  assert.doesNotMatch(html, /Por pagarles/);
  assert.ok(storeB);
});
