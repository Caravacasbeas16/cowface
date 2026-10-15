// Panel de la tienda (como el de DoorDash): inicio, pedidos por etapa, inventario con filtros,
// guardado rápido, acciones en lote, pausar la tienda y visitas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminLogin, ctx, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

before(startServer);
after(stopServer);

let seller;
let buyer;
const ids = {};
const product = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
// Acción en lote con varios artículos (el formulario manda ids repetido).
const lote = (cookie, action, list) => fetch(`${ctx.base}/vendedor/inventario/lote`, {
  method: 'POST', redirect: 'manual', headers: { cookie },
  body: new URLSearchParams([['action', action], ...list.map((id) => ['ids', String(id)])]),
});

test('preparación', async () => {
  const admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  ids.polo = await publishPolo(seller, { title: 'Camisa polo azul', quantity: 3 });
  ids.jeans = await publishPolo(seller, { title: 'Jeans Levis 501', brand: 'Levis', item_type: 'Jeans', size: 'Cintura 32' });
  ids.tenis = await publishPolo(seller, { title: 'Tenis Jordan 1', brand: 'Nike', category: 'zapatos', item_type: 'Tenis', size: 'US 9' });
});

test('quien no tiene tienda ve su cuenta de comprador; las páginas de tienda lo mandan ahí', async () => {
  const page = await (await get('/vendedor', buyer)).text();
  assert.match(page, /Mi cuenta/);
  assert.match(page, /Vender en CowFace/);
  assert.doesNotMatch(page, /Estado de la tienda/);
  assert.equal((await get('/vendedor/inventario', buyer)).headers.get('location'), '/vendedor');
  assert.equal((await get('/vendedor/compras', buyer)).status, 200);
});

test('inicio de la tienda: estado, ventas, por atender y lista para completar la tienda', async () => {
  const page = await (await get('/vendedor', seller)).text();
  for (const text of [/Estado de la tienda/, /Recibiendo pedidos/, /Por atender/, /Completa tu tienda/, /Lo más visto/, /Jeans Levis 501/]) {
    assert.match(page, text);
  }
  assert.match(page, /href="\/vendedor\/inventario"/, 'menú lateral');
  assert.match(page, /portal\.css/);
});

test('las visitas se cuentan una vez por persona y no cuentan las del dueño', async () => {
  await get(`/p/${ids.tenis}`, buyer);
  await get(`/p/${ids.tenis}`, buyer);
  await get(`/p/${ids.tenis}`, seller);
  assert.equal(product(ids.tenis).views, 1);
  assert.match(await (await get('/vendedor/inventario?orden=vistas', seller)).text(), /Tenis Jordan 1[\s\S]*👁 1/);
});

test('inventario: filtros por estado, categoría y búsqueda', async () => {
  const all = await (await get('/vendedor/inventario', seller)).text();
  for (const t of ['Camisa polo azul', 'Jeans Levis 501', 'Tenis Jordan 1']) assert.ok(all.includes(t));
  const shoes = await (await get('/vendedor/inventario?categoria=zapatos', seller)).text();
  assert.ok(shoes.includes('Tenis Jordan 1') && !shoes.includes('Jeans Levis 501'));
  const found = await (await get('/vendedor/inventario?q=levis', seller)).text();
  assert.ok(found.includes('Jeans Levis 501') && !found.includes('Camisa polo azul'));
  const last = await (await get('/vendedor/inventario?estado=ultima', seller)).text();
  assert.ok(last.includes('Jeans Levis 501') && !last.includes('Camisa polo azul'), 'la polo tiene 3 unidades');
  assert.match(last, /Última unidad/);
});

test('guardado rápido (sin recargar): precio y unidades; con 0 queda agotado y vuelve al subirlas', async () => {
  let res = await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: '27000', quantity: '5' }, true);
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.statusChanged, false);
  assert.equal(product(ids.polo).price, 27000);
  assert.equal(product(ids.polo).quantity, 5);

  body = await (await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: '27000', quantity: '0' }, true)).json();
  assert.equal(body.statusChanged, true);
  assert.equal(product(ids.polo).status, 'vendido');
  assert.match(await (await get('/vendedor/inventario?estado=agotado', seller)).text(), /Camisa polo azul/);
  await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: '27000', quantity: '2' }, true);
  assert.equal(product(ids.polo).status, 'disponible');

  res = await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: 'abc', quantity: '2' }, true);
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /Revisa el precio/);
  // Sin JS: redirige al inventario con los mismos filtros.
  res = await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: '27000', quantity: '2', back: '/vendedor/inventario?estado=disponible' });
  assert.equal(res.headers.get('location'), '/vendedor/inventario?estado=disponible');
  res = await post(`/vendedor/productos/${ids.polo}/rapido`, seller, { price: '27000', quantity: '2', back: 'https://otro.com' });
  assert.equal(res.headers.get('location'), '/vendedor/inventario', 'no redirige afuera');
});

test('acciones en lote: pausar, activar, marcar vendidos y borrar (con sus fotos)', async () => {
  let res = await post('/vendedor/inventario/lote', seller, { action: 'pausar', ids: ids.polo, back: '/vendedor/inventario?estado=pausado' });
  assert.equal(res.headers.get('location'), '/vendedor/inventario?estado=pausado');
  assert.match(flashOf(res), /1 artículo pausado\./);
  res = await lote(seller, 'pausar', [ids.polo, ids.jeans]);
  assert.match(flashOf(res), /1 artículo pausado\. 1 no se pudo cambiar/, 'la polo ya estaba pausada');
  assert.equal(product(ids.jeans).status, 'pausado');
  res = await lote(seller, 'activar', [ids.polo, ids.jeans]);
  assert.match(flashOf(res), /2 artículos activados/);
  assert.equal(product(ids.jeans).status, 'disponible');

  res = await post('/vendedor/inventario/lote', seller, { action: 'vendidos', ids: ids.jeans });
  assert.equal(product(ids.jeans).status, 'vendido');
  assert.equal(product(ids.jeans).quantity, 0);

  const files = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').all(ids.jeans).map((r) => r.filename);
  res = await post('/vendedor/inventario/lote', seller, { action: 'borrar', ids: ids.jeans });
  assert.match(flashOf(res), /1 artículo borrado/);
  assert.equal(product(ids.jeans), undefined);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(files.every((f) => !fs.existsSync(path.join(process.env.UPLOAD_DIR, f))));

  assert.match(flashOf(await post('/vendedor/inventario/lote', seller, { action: 'borrar' })), /Selecciona al menos un artículo/);
  // Artículos de otra tienda no se tocan.
  const other = await signupSeller('otra@test.cr', 'Otra Tienda');
  assert.match(flashOf(await post('/vendedor/inventario/lote', other, { action: 'borrar', ids: ids.polo })), /Selecciona al menos/);
  assert.ok(product(ids.polo));
});

test('pedidos por etapa: elegir entrega → cotizar (por atender) → esperando el SINPE', async () => {
  const buy = await post(`/p/${ids.tenis}/comprar`, buyer);
  const conv = Number(buy.headers.get('location').split('/').pop());
  const order = db.prepare('SELECT * FROM orders WHERE conversation_id = ?').get(conv);
  let page = await (await get('/vendedor/pedidos?tab=proceso', seller)).text();
  assert.match(page, /El comprador elige la entrega/);

  await post(`/pedidos/${order.id}/entrega`, buyer, { method: 'correos', address: 'San Pedro, 100 m norte' });
  page = await (await get('/vendedor/pedidos', seller)).text();
  assert.match(page, /Cotiza el envío/);
  assert.match(page, /Cotizar envío/);
  assert.match(await (await get('/vendedor', seller)).text(), /Tenis Jordan 1/, 'aparece en Por atender del inicio');
  assert.match(await (await get('/vendedor/inventario', seller)).text(), /Pedido en curso/);

  await post(`/pedidos/${order.id}/cotizar`, seller, { method: 'correos', cost: '2500' });
  page = await (await get('/vendedor/pedidos?tab=proceso', seller)).text();
  assert.match(page, /Esperando el SINPE/);
  // Con pedido en curso, el lote no lo borra.
  const res = await post('/vendedor/inventario/lote', seller, { action: 'borrar', ids: ids.tenis });
  assert.match(flashOf(res), /0 artículos borrados\. 1 no se pudo cambiar/);
});

test('pausar la tienda: sale de la búsqueda, no se puede comprar ni ofertar; al reanudar vuelve', async () => {
  const res = await post('/vendedor/pausa', seller, { action: 'pausar', note: 'De vacaciones hasta el lunes' });
  assert.match(flashOf(res), /Tienda en pausa/);
  assert.match(await (await get('/vendedor', seller)).text(), /De vacaciones hasta el lunes/);
  assert.doesNotMatch(await (await get('/buscar?q=polo')).text(), /Camisa polo azul/);
  await post('/vendedor/inventario/lote', seller, { action: 'activar', ids: ids.polo });
  const page = await (await get(`/p/${ids.polo}`, buyer)).text();
  assert.match(page, /Tienda en pausa/);
  assert.doesNotMatch(page, /Comprar ahora/);
  const buy = await post(`/p/${ids.polo}/comprar`, buyer);
  assert.match(flashOf(buy), /está en pausa/);
  const offer = await post(`/p/${ids.polo}/ofertar`, buyer, { amount: '20000' });
  assert.match(flashOf(offer), /está en pausa/);

  await post('/vendedor/pausa', seller, { action: 'reanudar' });
  assert.match(await (await get('/buscar?q=polo')).text(), /Camisa polo azul/);
});

test('promos, ganancias, reseñas y configuración con el menú del panel', async () => {
  for (const url of ['/vendedor/promos', '/vendedor/ganancias', '/vendedor/resenas', '/vendedor/configuracion', '/vendedor/compras']) {
    const page = await (await get(url, seller)).text();
    assert.match(page, /class="portal-nav"/, url);
  }
  await post('/vendedor/perfil', seller, { store_about: 'Ropa vintage americana, subimos todos los jueves.' });
  assert.match(await (await get('/vendedor/configuracion', seller)).text(), /subimos todos los jueves/);
});
