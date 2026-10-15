// Varias tallas con su cantidad (como StockX) y detalles por categoría (modelo, SKU, caja, defectos).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLO, adminLogin, db, flashOf, get, photoOf, post, productIdFrom, publish, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { allSizes } = await import('../src/catalog.js');

before(startServer);
after(stopServer);

let seller;
let buyer;
let buyer2;
let id;
const vs = (size) => `vs_zapatos_${allSizes('zapatos').indexOf(size)}`;
const JORDAN = {
  ...POLO, title: 'Air Jordan 1 Chicago', brand: 'Nike', category: 'zapatos', item_type: 'Tenis', size: '', price: '₡120.000',
  condition: 'nuevo', multi_size: '1', [vs('US 8')]: '2', [vs('US 9')]: '1', [vs('US 10')]: '',
  d_zapatos_modelo: 'Air Jordan 1 Retro High OG', d_zapatos_sku: '555088-101', d_zapatos_colorway: 'Chicago',
  d_zapatos_anio: '2022', d_zapatos_caja: 'Caja original', d_defectos: 'Caja con una esquina golpeada.', d_comprobante: '1',
  retail_price: '150000',
};
const product = () => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const sizes = () => Object.fromEntries(db.prepare('SELECT size, quantity FROM product_sizes WHERE product_id = ?').all(id).map((r) => [r.size, r.quantity]));

test('preparación', async () => {
  const admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tenis@test.cr', 'Tenis CR');
  buyer = await signup('compra@test.cr', 'Compradora');
  buyer2 = await signup('compra2@test.cr', 'Otro Comprador');
});

test('al publicar: sin unidades en ninguna talla no se puede; opciones inválidas se rechazan', async () => {
  let res = await publish(seller, { ...JORDAN, [vs('US 8')]: '', [vs('US 9')]: '' }, [photoOf()]);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Pon cuántas unidades tienes en al menos una talla/);
  res = await publish(seller, { ...JORDAN, d_zapatos_caja: 'Caja de oro' }, [photoOf()]);
  assert.match(await res.text(), /Elige una opción de la lista en (&quot;|")Caja/);
});

test('publicar con varias tallas: suma de unidades, resumen de tallas y detalles guardados', async () => {
  const res = await publish(seller, JORDAN, [photoOf()]);
  assert.equal(res.status, 302);
  id = productIdFrom(res);
  const p = product();
  assert.equal(p.has_sizes, 1);
  assert.equal(p.quantity, 3);
  assert.equal(p.size, 'US 8 – US 9');
  assert.deepEqual(sizes(), { 'US 8': 2, 'US 9': 1 });
  assert.equal(JSON.parse(p.details).sku, '555088-101');
  assert.equal(p.retail_price, 150000);
});

test('la página del artículo muestra la cuadrícula de tallas y los detalles como StockX', async () => {
  const page = await (await get(`/p/${id}`, buyer)).text();
  assert.match(page, /Elige tu talla/);
  assert.match(page, /value="US 9"[\s\S]*?Última/);
  for (const t of ['555088-101', 'Air Jordan 1 Retro High OG', 'Chicago', 'Caja original', 'Caja con una esquina golpeada', 'comprobante de compra', 'ahorras 20 %']) {
    assert.ok(page.includes(t), t);
  }
});

test('búsqueda por código de estilo y filtro por talla (solo las que tienen unidades)', async () => {
  assert.match(await (await get('/buscar?q=555088')).text(), /Air Jordan 1 Chicago/);
  assert.match(await (await get('/buscar?categoria=zapatos&talla=US+9')).text(), /Air Jordan 1 Chicago/);
  assert.doesNotMatch(await (await get('/buscar?categoria=zapatos&talla=US+10')).text(), /Air Jordan 1 Chicago/);
});

test('comprar: hay que elegir talla; se reserva esa talla y vuelve si se cancela', async () => {
  let res = await post(`/p/${id}/comprar`, buyer);
  assert.match(flashOf(res), /Elige tu talla/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);

  res = await post(`/p/${id}/comprar`, buyer, { size: 'US 9' });
  assert.match(res.headers.get('location'), /^\/mensajes\/\d+$/);
  const order = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  assert.equal(order.chosen_size, 'US 9');
  assert.equal(order.product_title, 'Air Jordan 1 Chicago · Talla US 9');
  assert.deepEqual(sizes(), { 'US 8': 2, 'US 9': 0 });
  assert.equal(product().quantity, 2);
  assert.equal(product().status, 'disponible');
  assert.doesNotMatch(await (await get('/buscar?categoria=zapatos&talla=US+9')).text(), /Air Jordan 1 Chicago/);

  res = await post(`/p/${id}/comprar`, buyer2, { size: 'US 9' });
  assert.match(flashOf(res), /Ya no queda la talla US 9/);

  await post(`/pedidos/${order.id}/cancelar`, buyer);
  assert.deepEqual(sizes(), { 'US 8': 2, 'US 9': 1 });
  assert.equal(product().quantity, 3);
});

test('ofertar con talla desde el artículo; al aceptar, el pedido lleva esa talla', async () => {
  const res = await post(`/p/${id}/ofertar`, buyer2, { amount: '100000', size: 'US 8' });
  const conv = Number(res.headers.get('location').split('/').pop());
  assert.equal(db.prepare('SELECT chosen_size FROM conversations WHERE id = ?').get(conv).chosen_size, 'US 8');
  assert.match(await (await get(`/mensajes/${conv}`, seller)).text(), /Talla elegida: US 8/);
  const offer = db.prepare("SELECT id FROM offers WHERE conversation_id = ? AND status = 'pendiente'").get(conv);
  await post(`/ofertas/${offer.id}/aceptar`, seller);
  const order = db.prepare('SELECT * FROM orders WHERE conversation_id = ?').get(conv);
  assert.equal(order.chosen_size, 'US 8');
  assert.equal(order.price, 100000);
  assert.deepEqual(sizes(), { 'US 8': 1, 'US 9': 1 });
  await post(`/pedidos/${order.id}/cancelar`, seller);
  assert.deepEqual(sizes(), { 'US 8': 2, 'US 9': 1 });
});

test('inventario: editar las unidades por talla; con todo en 0 queda agotado y vuelve al subirlas', async () => {
  const inv = await (await get('/vendedor/inventario', seller)).text();
  assert.match(inv, /US 8 · 2/);
  assert.match(inv, new RegExp(`name="${vs('US 9')}"`));
  let res = await post(`/vendedor/productos/${id}/tallas`, seller, { [vs('US 8')]: '0', [vs('US 9')]: '0' });
  assert.match(flashOf(res), /0 unidades/);
  assert.equal(product().status, 'vendido');
  res = await post(`/vendedor/productos/${id}/tallas`, seller, { [vs('US 8')]: '4', [vs('US 9')]: '0' });
  assert.equal(product().status, 'disponible');
  assert.equal(product().quantity, 4);
  assert.equal(product().size, 'US 8');
  // La edición rápida solo cambia el precio (las unidades van por talla).
  await post(`/vendedor/productos/${id}/rapido`, seller, { price: '115000', quantity: '99' }, true);
  assert.equal(product().price, 115000);
  assert.equal(product().quantity, 4);
});

test('editar: el formulario trae las tallas y los detalles; quitar "varias tallas" vuelve a talla única', async () => {
  const form = await (await get(`/vendedor/productos/${id}/editar`, seller)).text();
  assert.match(form, /name="multi_size" value="1" data-multi-size checked/);
  assert.match(form, new RegExp(`name="${vs('US 8')}"[^>]*value="4"`));
  assert.match(form, /name="d_zapatos_sku"[^>]*value="555088-101"/);
  const res = await publish(seller, { ...JORDAN, multi_size: '', size: 'US 10', quantity: 1 }, [photoOf()]);
  assert.equal(res.status, 302, 'se crea otro artículo de talla única');
  const single = db.prepare('SELECT * FROM products WHERE id = ?').get(productIdFrom(res));
  assert.equal(single.has_sizes, 0);
  assert.equal(single.size, 'US 10');
});

test('ropa con estado "con detalles" y su explicación', async () => {
  const res = await publish(seller, { ...POLO, condition: 'con_detalles', d_ropa_material: '100 % algodón', d_ropa_corte: 'Oversize' }, [photoOf()]);
  const page = await (await get(`/p/${productIdFrom(res)}`, buyer)).text();
  assert.match(page, /Usado - con detalles/);
  assert.match(page, /Tiene detalles visibles/);
  assert.match(page, /100 % algodón/);
  assert.match(page, /Oversize/);
  assert.match(await (await get('/buscar?estado=usado&q=polo')).text(), /Camisa polo azul/);
});
