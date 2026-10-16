// Panel del admin: Tiendas (aprobar, prioridad, destacar), Pagos (verificar SINPE y pagarle a cada
// tienda de una vez) y Pedidos (búsqueda). Solo el admin entra.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, flashOf, get, post, publishPolo, quoted, shipWithPhoto, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

before(startServer);
after(stopServer);

let admin;
let seller;
let other;
let buyer;
let sellerId;
let otherId;
const ids = {};

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  other = await signupSeller('otra@test.cr', 'Tenis CR');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  otherId = db.prepare("SELECT id FROM users WHERE email = 'otra@test.cr'").get().id;
  ids.polo = await publishPolo(seller, { title: 'Camisa polo azul' });
  ids.tenis = await publishPolo(other, { title: 'Tenis Samba' });
});

test('solo el admin entra a las páginas del panel', async () => {
  for (const url of ['/admin/tiendas', '/admin/pagos', '/admin/pedidos', '/admin/pagos.csv']) {
    assert.equal((await get(url, buyer)).status, 403, url);
    assert.equal((await get(url)).status, 302, url);
    assert.equal((await get(url, admin)).status, 200, url);
  }
  const home = await (await get('/admin', admin)).text();
  assert.match(home, /class="portal-nav" aria-label="Panel del admin"/);
  assert.match(home, /href="\/admin\/pagos"/);
});

test('tiendas: solicitud por aprobar, aprobar y volver a la misma página', async () => {
  const applicant = await signup('nueva@test.cr', 'Tienda Nueva');
  const id = db.prepare("SELECT id FROM users WHERE email = 'nueva@test.cr'").get().id;
  db.prepare("UPDATE users SET seller_status = 'pendiente', store_name = 'Vintage Nueva', seller_request = ? WHERE id = ?")
    .run(JSON.stringify({ instagram: 'vintage.nueva', about: 'Ropa americana de segunda.', product_photos: [], shipment_photos: [] }), id);
  let page = await (await get('/admin/tiendas', admin)).text();
  assert.match(page, /Por aprobar <span class="tab-n">1/);
  assert.match(page, /Vintage Nueva/);
  assert.match(page, /@vintage\.nueva/);
  const res = await post(`/admin/tiendas/${id}/aprobar`, admin, { back: '/admin/tiendas?tab=pendientes' });
  assert.equal(res.headers.get('location'), '/admin/tiendas?tab=pendientes');
  assert.equal(db.prepare('SELECT seller_status FROM users WHERE id = ?').get(id).seller_status, 'aprobado');
  // No se puede mandar de vuelta a otro sitio.
  const evil = await post(`/admin/tiendas/${id}/quitar-aprobacion`, admin, { back: '//evil.com' });
  assert.equal(evil.headers.get('location'), '/admin#usuarios');
  page = await (await get('/admin/tiendas?tab=aprobadas&q=tenis', admin)).text();
  assert.match(page, /Tenis CR/);
  assert.doesNotMatch(page, /Closet Vintage/);
});

test('prioridad: Máxima hace que sus artículos salgan antes que otros más nuevos', async () => {
  db.prepare("UPDATE products SET created_at = datetime('now', '-2 days') WHERE id = ?").run(ids.polo);
  db.prepare("UPDATE products SET created_at = datetime('now', '-1 hours') WHERE id = ?").run(ids.tenis);
  let list = await (await get('/buscar?orden=recientes')).text();
  assert.ok(list.indexOf('Tenis Samba') < list.indexOf('Camisa polo azul'), 'sin prioridad, el más nuevo primero');

  const res = await post(`/admin/tiendas/${sellerId}/prioridad`, admin, { priority: '2', back: '/admin/tiendas?tab=aprobadas' });
  assert.match(flashOf(res), /Prioridad: Máxima/);
  assert.equal(res.headers.get('location'), '/admin/tiendas?tab=aprobadas');
  list = await (await get('/buscar?orden=recientes')).text();
  assert.ok(list.indexOf('Camisa polo azul') < list.indexOf('Tenis Samba'), 'con prioridad máxima va primero');
  assert.match(await (await get('/admin/tiendas?tab=aprobadas', admin)).text(), /Prioridad Máxima/);
  assert.match(flashOf(await post(`/admin/tiendas/${sellerId}/prioridad`, admin, { priority: '9' })), /No se pudo/);
  await post(`/admin/tiendas/${sellerId}/destacar`, admin, { days: '7', back: '/admin/tiendas' });
  assert.match(await (await get('/admin/tiendas?tab=aprobadas', admin)).text(), /★ Destacada hasta/);
});

test('pagos: verificar el SINPE desde Pagos y pagarle a la tienda todo de una vez', async () => {
  const orderFor = async (productId) => {
    await post(`/p/${productId}/comprar`, buyer);
    const o = db.prepare('SELECT * FROM orders WHERE product_id = ? ORDER BY id DESC').get(productId);
    quoted(o.id, 'correos', 2000);
    await post(`/pedidos/${o.id}/pago`, buyer, { payer_name: `Pagador ${o.id}`, address: 'San José centro', phone: '8777-1234' });
    return o;
  };
  const a = await orderFor(ids.polo);
  ids.polo2 = await publishPolo(seller, { title: 'Jeans Levis' });
  const b = await orderFor(ids.polo2);

  let page = await (await get('/admin/pagos', admin)).text();
  assert.match(page, new RegExp(`Pagó <strong class="copy" data-copy="Pagador ${a.id}"`));
  const res = await post(`/admin/pedidos/${a.id}/confirmar-pago`, admin, { back: '/admin/pagos' });
  assert.equal(res.headers.get('location'), '/admin/pagos');
  await post(`/admin/pedidos/${b.id}/confirmar-pago`, admin, { back: '/admin/pagos' });
  for (const o of [a, b]) {
    await shipWithPhoto(seller, o.id);
    await post(`/pedidos/${o.id}/recibido`, buyer);
  }
  // Completados un miércoles a las 9 a. m. (Costa Rica): toca pagarlos ese mismo día.
  db.prepare("UPDATE orders SET completed_at = '2026-10-14T15:00:00.000Z' WHERE id IN (?, ?)").run(a.id, b.id);

  page = await (await get('/admin/pagos', admin)).text();
  const due = db.prepare('SELECT SUM(payout_amount) AS t FROM orders WHERE id IN (?, ?)').get(a.id, b.id).t;
  assert.match(page, /Closet Vintage/);
  assert.match(page, new RegExp(`Ya le pagué ₡${due.toLocaleString('es-CR').replace(/\s/g, '\\s')}`));
  const paid = await post(`/admin/pagos/tienda/${sellerId}`, admin);
  assert.match(flashOf(paid), /2 pedidos de Closet Vintage marcados como pagados/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE payout_status = 'pagado'").get().n, 2);
  assert.match(flashOf(await post(`/admin/pagos/tienda/${sellerId}`, admin)), /no tiene pagos pendientes/);
  page = await (await get('/admin/pagos', admin)).text();
  assert.match(page, /Hoy no hay que pagarle a ninguna tienda/);
  assert.match(page, /Últimos pagos a tiendas[\s\S]*Closet Vintage/);

  const csv = await (await get('/admin/pagos.csv', admin)).text();
  assert.match(csv, /Pedido,Completado,Pagado a la tienda,Tienda/);
  assert.ok(csv.includes(a.code));

  const search = await (await get(`/admin/pedidos?q=${a.code}`, admin)).text();
  assert.ok(search.includes(a.code) && !search.includes(b.code));
  assert.match(await (await get('/admin/pedidos?estado=completado', admin)).text(), new RegExp(b.code));
});

test('comisión por tienda: el admin la cambia, aplica a los pedidos nuevos y vacío vuelve a la general', async () => {
  let res = await post(`/admin/tiendas/${otherId}/comision`, admin, { percent: '3.5', back: '/admin/tiendas?tab=aprobadas' });
  assert.match(flashOf(res), /Comisión de esta tienda: 3\.5 %/);
  assert.equal(res.headers.get('location'), '/admin/tiendas?tab=aprobadas');
  assert.match(await (await get('/admin/tiendas?tab=aprobadas', admin)).text(), /name="percent"[^>]*value="3\.5"/);
  assert.match(flashOf(await post(`/admin/tiendas/${otherId}/comision`, admin, { percent: '80' })), /de 0 % a 50 %/);
  assert.equal((await post(`/admin/tiendas/${otherId}/comision`, other, { percent: '0' })).status, 403, 'solo el admin');

  // El formulario de publicar le muestra su comisión, y el pedido nuevo la usa.
  assert.match(await (await get('/vendedor/productos/nuevo', other)).text(), /Comisión CowFace \(3\.5 %\)/);
  const id = await publishPolo(other, { title: 'Gorra con comisión propia', price: '₡20.000' });
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders WHERE product_id = ?').get(id);
  assert.equal(o.commission_rate, 0.035);
  assert.equal(o.commission_amount, 700);

  // Vacío: vuelve a la general (2 % en las pruebas).
  res = await post(`/admin/tiendas/${otherId}/comision`, admin, { percent: '' });
  assert.match(flashOf(res), /la general \(2 %\)/);
  assert.equal(db.prepare('SELECT commission_rate FROM users WHERE id = ?').get(otherId).commission_rate, null);
});
