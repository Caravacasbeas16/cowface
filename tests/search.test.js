// Búsqueda: tildes, plurales, sinónimos, categoría y "para quién" en el texto, tallas, filtros y sugerencias.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { POLO, db, get, publishPolo, signupSeller, startServer, stopServer } from './helpers.js';

const { parseFilters, searchProducts, searchSuggestions } = await import('../src/products.js');

before(startServer);
after(stopServer);

const titles = (query) => searchProducts(parseFilters(query)).items.map((p) => p.title).sort();

test('preparación', async () => {
  const seller = await signupSeller('busca@test.cr', 'Tienda Búsqueda');
  const add = (extra) => publishPolo(seller, extra);
  await add({ title: 'Suéter de lana', category: 'ropa', item_type: 'Suéteres y hoodies', size: 'L', department: 'mujer', condition: 'como_nuevo', brand: '' });
  await add({ title: 'Air Force 1 blancas', brand: 'Nike', category: 'zapatos', item_type: 'Tenis', size: 'US 9', department: 'unisex', condition: 'nuevo' });
  await add({ title: 'Jeans 501', brand: "Levi's", category: 'ropa', item_type: 'Jeans', size: 'Cintura 32', department: 'hombre', condition: 'usado' });
  await add({ title: 'Tenis con luces', brand: 'Skechers', category: 'zapatos', item_type: 'Tenis', size: 'Niño 28', department: 'ninos', condition: 'usado' });
  await add({ title: 'Vestido floral', brand: 'Zara', category: 'ropa', item_type: 'Vestidos', size: 'S', department: 'mujer', condition: 'nuevo' });
  await add({ title: 'Lentes Wayfarer', brand: 'Ray-Ban', category: 'accesorios', item_type: 'Lentes', size: 'Única', department: 'unisex', condition: 'usado' });
  await add({ ...POLO, title: 'Polo clásica', size: 'M', department: 'hombre' });
});

test('sin tildes, en plural o en mayúsculas encuentra lo mismo', () => {
  assert.deepEqual(titles({ q: 'sueter' }), ['Suéter de lana']);
  assert.deepEqual(titles({ q: 'SUÉTERES' }), ['Suéter de lana']);
  assert.deepEqual(titles({ q: 'vestidos' }), ['Vestido floral']);
});

test('busca también por categoría, para quién, marca escrita junta y sinónimos', () => {
  assert.deepEqual(titles({ q: 'zapatos nike' }), ['Air Force 1 blancas']);
  assert.deepEqual(titles({ q: 'vestido mujer' }), ['Vestido floral']);
  assert.ok(titles({ q: 'mujer' }).includes('Air Force 1 blancas'), 'lo unisex aparece para mujer');
  assert.deepEqual(titles({ q: 'nino' }), ['Tenis con luces']);
  assert.deepEqual(titles({ q: 'rayban' }), ['Lentes Wayfarer']);
  assert.deepEqual(titles({ q: 'levis' }), ['Jeans 501']);
  assert.deepEqual(titles({ q: 'gafas' }), ['Lentes Wayfarer']);
  assert.deepEqual(titles({ q: 'sudadera' }), ['Suéter de lana']);
  assert.deepEqual(titles({ q: 'zapatillas' }).length, 2);
  assert.deepEqual(titles({ q: 'pantalones' }), ['Jeans 501'], 'pantalones incluye jeans');
});

test('no confunde palabras: "nino" no encuentra "femenino" ni "nuevo" lo que es "usado como nuevo"', () => {
  assert.ok(!titles({ q: 'nuevo' }).includes('Suéter de lana'));
  assert.ok(titles({ q: 'usado' }).includes('Suéter de lana'));
  assert.deepEqual(titles({ q: 'talla m' }), ['Polo clásica'], 'una talla de letra busca esa talla, no cualquier "m"');
  assert.deepEqual(titles({ q: 'polo xl' }), []);
});

test('filtros: niños no mezcla lo unisex; mínimo y máximo al revés se corrigen', () => {
  assert.deepEqual(titles({ para: 'ninos' }), ['Tenis con luces']);
  assert.ok(titles({ para: 'hombre' }).includes('Lentes Wayfarer'));
  const f = parseFilters({ min: '50000', max: '10000' });
  assert.deepEqual([f.min, f.max], [10000, 50000]);
  assert.equal(searchProducts(f).total, 7);
});

test('los artículos viejos sin texto de búsqueda se completan solos', () => {
  db.prepare("UPDATE products SET search_text = ''").run();
  assert.deepEqual(titles({ q: 'sueter' }), ['Suéter de lana']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE search_text = ''").get().n, 0);
});

test('la página no arrastra filtros de otra categoría y cuenta los filtros activos', async () => {
  const page = await (await get('/buscar?categoria=zapatos&talla=M&tipo=Jeans&para=mujer')).text();
  assert.match(page, /Filtros \(2 activos\)/, 'zapatos + mujer; la talla M y el tipo Jeans no aplican a zapatos');
  assert.doesNotMatch(page, /name="query" value="[^"]*talla=M/);
  assert.match(await (await get('/buscar?para=hombre')).text(), /Filtros \(1 activo\)/);
});

test('sugerencias: categorías, tipos y marcas que existen, sin tildes', async () => {
  const labels = (q) => searchSuggestions(q).map((s) => s.label);
  assert.ok(labels('ten').includes('Tenis'));
  assert.ok(labels('zap').includes('Zapatos'));
  assert.ok(labels('rayb').includes('Ray-Ban'));
  assert.ok(labels('suet').includes('Suéteres y hoodies'));
  assert.deepEqual(labels('x'), [], 'con una letra no sugiere');
  const tenis = searchSuggestions('tenis').find((s) => s.label === 'Tenis');
  assert.equal(tenis.url, '/buscar?categoria=zapatos&tipo=Tenis');
  assert.equal(tenis.count, 2);
  const res = await get('/buscar/sugerencias?q=nik');
  assert.match(res.headers.get('content-type'), /json/);
  assert.equal((await res.json())[0].label, 'Nike');
});
