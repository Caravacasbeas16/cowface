// Marcar como vendida, reseñas en el artículo, "Mis ganancias" y promos / descuentos de las tiendas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLO, adminLogin, ctx, db, flashOf, get, photoOf, post, publish, publishPolo, quoted, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { expirePromos } = await import('../src/promos.js');

before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let sellerId;
const product = (id) => db.prepare('SELECT price, compare_at_price, promo_until, promo_store, status, quantity FROM products WHERE id = ?').get(id);
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
const tomorrow = () => new Date(Date.now() + 30 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
});

// ---------- Vendida ----------

test('"Vendida": sale de la venta y las ofertas pendientes quedan sin efecto', async () => {
  const id = await publishPolo(seller, { title: 'Camisa vendida por fuera' });
  await post(`/p/${id}/ofertar`, buyer, { amount: '20000' });
  assert.match(await (await get(`/p/${id}`, seller)).text(), /Marcar como vendida/);
  assert.match(flashOf(await post(`/vendedor/productos/${id}/vendida`, seller)), /quedó como vendida/);
  assert.deepEqual([product(id).status, product(id).quantity], ['vendido', 0]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM offers WHERE product_id = ? AND status = 'pendiente'").get(id).n, 0);
  assert.match(await (await get('/mensajes', buyer)).text(), /ya se vendió/);
  assert.doesNotMatch(await (await get('/buscar?q=fuera')).text(), /Camisa vendida por fuera/);
  assert.equal((await post(`/vendedor/productos/${id}/vendida`, buyer)).status, 404, 'solo la dueña');
  assert.match(await (await get('/terminos')).text(), /márcala como vendida de inmediato/);
});

// ---------- Reseñas y ganancias ----------

test('venta completa: la reseña se ve como comentario en sus artículos y la tienda ve sus ganancias', async () => {
  const id = await publishPolo(seller, { title: 'Jeans 501', price: '20000' });
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  quoted(o.id, 'correos', 2000);
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '30303030', address: 'Heredia centro', phone: '8777-0000' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await post(`/pedidos/${o.id}/recibido`, buyer);
  assert.match(await (await get(`/mensajes/${o.conversation_id}`, buyer)).text(), /Deja tu reseña/);
  await post(`/resenas/${o.id}`, buyer, { rating: '5', comment: 'Todo perfecto, llegó rapidísimo y como en las fotos.' });

  const other = await publishPolo(seller, { title: 'Chaqueta' });
  const page = await (await get(`/p/${other}`)).text();
  assert.match(page, /Lo que dicen de Closet Vintage/);
  assert.match(page, /Todo perfecto, llegó rapidísimo/);

  let earn = await (await get('/vendedor/ganancias', seller)).text();
  assert.match(earn, /Mis ganancias/);
  assert.match(earn, /Por recibir/);
  assert.match(earn, /₡21\s?600/, '20 000 − 2 % + 2 000 de envío');
  assert.match(earn, /Se paga (hoy|mañana|el )/);
  await post(`/admin/pedidos/${o.id}/pago-vendedor`, admin);
  earn = await (await get('/vendedor/ganancias', seller)).text();
  assert.match(earn, /Ya recibiste/);
  assert.match(earn, /Pagado/);
  assert.match(await (await get('/vendedor', seller)).text(), /ver mis ganancias/);
  assert.equal((await get('/vendedor/ganancias')).status, 302, 'sin sesión no se ve');
});

// ---------- Descuentos ----------

test('descuento en un artículo: precio tachado, −%, el pedido cobra con descuento y vence solo', async () => {
  const id = await publishPolo(seller, { title: 'Hoodie en oferta', price: '25000' });
  assert.match(flashOf(await post(`/vendedor/productos/${id}/descuento`, seller, { pct: '90' })), /de 5 % a 80 %/);
  await post(`/vendedor/productos/${id}/descuento`, seller, { pct: '20', until: tomorrow() });
  assert.deepEqual([product(id).price, product(id).compare_at_price], [20000, 25000]);
  const page = await (await get(`/p/${id}`)).text();
  assert.match(page, /₡20\s?000 <s class="was">₡25\s?000<\/s> <span class="sale-pill">−20 %/);
  assert.match(page, /En oferta hasta el/);
  assert.match(await (await get('/buscar?oferta=1')).text(), /Hoodie en oferta/);
  assert.doesNotMatch(await (await get('/buscar?oferta=1')).text(), /Chaqueta/);
  assert.match(await (await get('/')).text(), /−20 %/);

  // Editar el precio normal mantiene el descuento sobre el precio nuevo.
  assert.match(await (await get(`/vendedor/productos/${id}/editar`, seller)).text(), /name="price"[^>]*value="25000"/);
  await post(`/vendedor/productos/${id}/rapido`, seller, { price: '30000', quantity: '1' });
  assert.deepEqual([product(id).price, product(id).compare_at_price], [24000, 30000]);

  await post(`/p/${id}/comprar`, buyer);
  assert.equal(lastOrder().price, 24000, 'se compra al precio con descuento');
  await post(`/pedidos/${lastOrder().id}/cancelar`, buyer);

  db.prepare("UPDATE products SET promo_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  expirePromos();
  assert.deepEqual([product(id).price, product(id).compare_at_price], [30000, null], 'al vencer vuelve al precio normal');
});

test('promo en toda la tienda: aplica a todo (y a lo nuevo), se ve en el perfil y se termina', async () => {
  const a = await publishPolo(seller, { title: 'Bolso A', price: '10000' });
  const own = await publishPolo(seller, { title: 'Con descuento propio', price: '10000' });
  await post(`/vendedor/productos/${own}/descuento`, seller, { pct: '50' });
  assert.match(flashOf(await post('/vendedor/promo', seller, { pct: '10', until: tomorrow(), label: 'Fin de temporada' })), /Promo activa/);
  assert.equal(product(a).price, 9000);
  assert.equal(product(own).price, 5000, 'el descuento propio se respeta');
  const nuevo = productIdOf(await publish(seller, { ...POLO, title: 'Publicado en promo', price: '20000' }, [photoOf()]));
  assert.equal(product(nuevo).price, 18000, 'lo que se publica durante la promo entra');
  assert.match(flashOf(await post(`/vendedor/productos/${a}/descuento`, seller, { pct: '30' })), /promo de toda la tienda/);

  const profile = await (await get(`/u/${sellerId}`)).text();
  assert.match(profile, /Fin de temporada:<\/strong> 10 % de descuento en toda la tienda hasta el/);
  assert.match(await (await get('/tiendas')).text(), /−10 % en todo/);

  await post('/vendedor/promo/terminar', seller);
  assert.equal(product(a).price, 10000);
  assert.equal(product(nuevo).price, 20000);
  assert.equal(product(own).price, 5000, 'el descuento propio sigue');
  assert.doesNotMatch(await (await get(`/u/${sellerId}`)).text(), /promo-banner/);
});

const productIdOf = (res) => Number((res.headers.get('location') || '').match(/\/p\/(\d+)/)?.[1]);
