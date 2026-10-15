// Herramientas de la tienda (subir al inicio, duplicar, exportar CSV) y recomendaciones en el
// artículo ("Más de esta tienda", "También te puede gustar", "Vistos recientemente").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POLO, adminLogin, db, flashOf, get, photoOf, post, productIdFrom, publish, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { allSizes } = await import('../src/catalog.js');

before(startServer);
after(stopServer);

let seller;
let other;
let buyer;
const ids = {};
const product = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const files = (id) => db.prepare('SELECT filename, thumb, original FROM product_images WHERE product_id = ?').all(id).flatMap((r) => [r.filename, r.thumb, r.original]);
const exists = (f) => fs.existsSync(path.join(process.env.UPLOAD_DIR, f));

test('preparación', async () => {
  await adminLogin();
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  other = await signupSeller('otra@test.cr', 'Otra Tienda');
  buyer = await signup('compra@test.cr', 'Compradora');
  ids.polo = await publishPolo(seller, { title: 'Camisa polo azul', price: '₡25.000' });
  ids.polo2 = await publishPolo(seller, { title: 'Camisa polo roja', price: '₡24.000' });
  ids.otherPolo = await publishPolo(other, { title: 'Polo Ralph Lauren', price: '₡26.000' });
  ids.otherJeans = await publishPolo(other, { title: 'Jeans Levis', item_type: 'Jeans', size: 'Cintura 32', price: '₡90.000' });
});

test('el artículo muestra "Más de la tienda" y "También te puede gustar" (de otras tiendas, primero el mismo tipo)', async () => {
  const page = await (await get(`/p/${ids.polo}`, buyer)).text();
  const more = page.slice(page.indexOf('Más de Closet Vintage'), page.indexOf('También te puede gustar'));
  assert.match(more, /Camisa polo roja/);
  const similar = page.slice(page.indexOf('También te puede gustar'));
  assert.ok(similar.indexOf('Polo Ralph Lauren') < similar.indexOf('Jeans Levis'), 'el mismo tipo va primero');
  assert.doesNotMatch(similar, /Camisa polo roja/, 'los de la misma tienda no se repiten');
  assert.match(page, /data-recent="/, 'para "Vistos recientemente"');
  assert.match(await (await get('/')).text(), /data-recent-section/);
});

test('subir al inicio: una vez cada 7 días; vuelve arriba en "Más recientes"', async () => {
  let res = await post(`/vendedor/productos/${ids.polo}/subir`, seller);
  assert.match(flashOf(res), /Podrás volver a subirlo el/);
  assert.equal(product(ids.polo).bumped_at, null);

  db.prepare("UPDATE products SET created_at = datetime('now', '-8 days') WHERE id = ?").run(ids.polo);
  db.prepare("UPDATE products SET created_at = datetime('now', '-1 minute') WHERE id != ?").run(ids.polo);
  assert.match(await (await get('/vendedor/inventario', seller)).text(), /⬆ Subir al inicio/);
  res = await post(`/vendedor/productos/${ids.polo}/subir`, seller, { back: '/vendedor/inventario?estado=disponible' });
  assert.match(flashOf(res), /subió al inicio/);
  assert.equal(res.headers.get('location'), '/vendedor/inventario?estado=disponible');
  assert.ok(product(ids.polo).bumped_at);
  const list = await (await get('/buscar?orden=recientes')).text();
  assert.ok(list.indexOf('Camisa polo azul') < list.indexOf('Jeans Levis'), 'quedó primero aunque se publicó antes');
  assert.match(flashOf(await post(`/vendedor/productos/${ids.polo}/subir`, seller)), /Podrás volver a subirlo/);
  assert.equal((await post(`/vendedor/productos/${ids.otherPolo}/subir`, seller)).status, 404, 'solo lo propio');
});

test('duplicar: borrador con los mismos datos, tallas y una copia de las fotos', async () => {
  const vs = (size) => `vs_zapatos_${allSizes('zapatos').indexOf(size)}`;
  const shoes = productIdFrom(await publish(seller, {
    ...POLO, title: 'Tenis Samba', category: 'zapatos', item_type: 'Tenis', multi_size: '1', [vs('US 8')]: '2', [vs('US 9')]: '1',
    d_zapatos_sku: 'B75806',
  }, [photoOf(), photoOf()]));
  const res = await post(`/vendedor/productos/${shoes}/duplicar`, seller);
  const copy = Number(res.headers.get('location').match(/productos\/(\d+)\/editar/)[1]);
  const c = product(copy);
  assert.equal(c.status, 'borrador');
  assert.equal(c.title, 'Tenis Samba (copia)');
  assert.equal(JSON.parse(c.details).sku, 'B75806');
  assert.deepEqual(db.prepare('SELECT size, quantity FROM product_sizes WHERE product_id = ? ORDER BY position').all(copy).map((r) => [r.size, r.quantity]), [['US 8', 2], ['US 9', 1]]);
  const originalFiles = files(shoes);
  const copyFiles = files(copy);
  assert.equal(copyFiles.length, originalFiles.length);
  assert.ok(copyFiles.every((f) => exists(f) && !originalFiles.includes(f)));
  // Borrar el original no borra las fotos de la copia.
  await post(`/vendedor/productos/${shoes}/borrar`, seller);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(copyFiles.every(exists));
});

test('exportar el inventario a CSV (con tildes y sin fórmulas de Excel)', async () => {
  await publishPolo(seller, { title: 'Suéter tejido', brand: '=HYPERLINK("x")' });
  const res = await get('/vendedor/inventario.csv', seller);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /inventario-cowface-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await res.text();
  assert.match(csv, /ID,Título,Marca,Categoría/);
  assert.match(csv, /Camisa polo azul/);
  assert.match(csv, /Suéter tejido,"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /US 8: 2 \| US 9: 1/);
  assert.equal((await get('/vendedor/inventario.csv', buyer)).headers.get('location'), '/vendedor');
});
