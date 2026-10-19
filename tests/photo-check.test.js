// Filtro de fotos antes de la revisión del admin, la revisión en Admin → Fotos (aprobar o pausar y
// avisarle a la tienda) y el WhatsApp de soporte que solo ven las tiendas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { POLO, adminLogin, db, flashOf, get, post, publish, signup, signupSeller, startServer, stopServer } from './helpers.js';

before(startServer);
after(stopServer);

// Fotos reales (las de la portada) para que el filtro trabaje como con fotos de celular.
const REAL = ['01-drop', '02-hoodies', '03-camisetas', '04-chaqueta', '05-fleece', '06-cargo']
  .map((f) => fs.readFileSync(new URL(`../public/img/brand/${f}.jpg`, import.meta.url)));
let next = 0;
const photo = async (opts = {}) => {
  let img = opts.color ? sharp({ create: { width: 800, height: 1000, channels: 3, background: opts.color } }) : sharp(REAL[next++ % REAL.length]);
  if (opts.blur) img = img.blur(opts.blur);
  return { data: await img.jpeg({ quality: 92 }).toBuffer(), type: 'image/jpeg', name: 'foto.jpg' };
};
const flagsOf = (productId) => db.prepare('SELECT check_flags FROM product_images WHERE product_id = ? ORDER BY position').all(productId).map((r) => r.check_flags);
const idFrom = (res) => Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);

let admin;
let storeA;
let storeB;
let storeBId;
let shared;
let held;

test('preparación', async () => {
  admin = await adminLogin();
  storeA = await signupSeller('a@test.cr', 'Closet A');
  storeB = await signupSeller('b@test.cr', 'Closet B');
  storeBId = db.prepare("SELECT id FROM users WHERE email = 'b@test.cr'").get().id;
  shared = await photo();
});

test('una foto casi negra se rechaza al subir, con un mensaje claro', async () => {
  const res = await publish(storeA, POLO, [await photo({ color: '#050505' })]);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /casi negra/);
});

test('borrosas y de un solo color se publican, pero quedan marcadas para el admin', async () => {
  const id = idFrom(await publish(storeA, POLO, [await photo({ blur: 10 }), await photo({ color: '#3366aa' }), await photo()]));
  assert.deepEqual(flagsOf(id), ['borrosa', 'plana', null]);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'disponible', 'se ve mientras se revisa');
});

test('la misma foto en otra tienda se marca; en la misma tienda no', async () => {
  const first = idFrom(await publish(storeA, { ...POLO, title: 'Jeans' }, [shared]));
  assert.deepEqual(flagsOf(first), [null]);
  const again = idFrom(await publish(storeA, { ...POLO, title: 'Jeans otra talla' }, [shared]));
  assert.deepEqual(flagsOf(again), [null], 'la tienda puede repetir sus propias fotos');
  // Otra tienda sube la misma foto, más pequeña y recomprimida.
  const copy = { ...shared, data: await sharp(shared.data).resize(500).jpeg({ quality: 60 }).toBuffer() };
  held = idFrom(await publish(storeB, { ...POLO, title: 'Jeans robados' }, [copy]));
  assert.deepEqual(flagsOf(held), ['repetida:Closet A']);
});

test('Admin → Fotos: solo el admin; muestra las marcas; aprueba de una vez los que no tienen', async () => {
  assert.equal((await get('/admin/fotos', storeA)).status, 403);
  let page = await (await get('/admin/fotos', admin)).text();
  assert.match(page, /⚠ Se ve borrosa/);
  assert.match(page, /⚠ Igual a una foto de otra tienda \(Closet A\)/);
  assert.match(await (await get('/admin', admin)).text(), /Fotos<\/span>\s*<span class="badge">4</);
  assert.match(flashOf(await post('/admin/fotos/sin-marcas', admin)), /2 artículos sin marcas aprobados/);
  page = await (await get('/admin/fotos', admin)).text();
  assert.doesNotMatch(page, />Jeans</);
  assert.match(page, /Jeans robados/);
});

test('pausar por fotos: se oculta, la tienda recibe el motivo y no lo puede reactivar sola', async () => {
  assert.match(flashOf(await post(`/admin/fotos/${held}/pausar`, admin, {})), /Elige por qué/);
  await post(`/admin/fotos/${held}/pausar`, admin, { reason: 'ajenas', note: 'Toma tus propias fotos.' });
  const p = db.prepare('SELECT status, admin_hidden, photo_hold FROM products WHERE id = ?').get(held);
  assert.deepEqual({ ...p }, { status: 'pausado', admin_hidden: 1, photo_hold: 1 });
  const chat = await (await get('/mensajes/cowface', storeB)).text();
  assert.match(chat, /Pausamos tu artículo «Jeans robados» porque sus fotos parecen ser de otra tienda o de internet/);
  assert.match(chat, /Toma tus propias fotos\./);
  assert.match(flashOf(await post(`/vendedor/productos/${held}/estado`, storeB, { status: 'disponible' })), /CowFace ocultó este artículo/);
  assert.match(await (await get('/admin/fotos', admin)).text(), /Esperando que la tienda cambie las fotos/);
});

test('la tienda sube fotos nuevas: vuelve a la revisión y al aprobar sale a la venta', async () => {
  const body = new FormData();
  for (const [k, v] of Object.entries({ ...POLO, title: 'Jeans robados' })) body.append(k, String(v));
  const fresh = await photo();
  body.append('photos', new Blob([fresh.data], { type: 'image/jpeg' }), 'nueva.jpg');
  const { ctx } = await import('./helpers.js');
  await fetch(`${ctx.base}/vendedor/productos/${held}/editar`, { method: 'POST', body, headers: { cookie: storeB }, redirect: 'manual' });
  assert.match(await (await get('/admin/fotos', admin)).text(), /La tienda subió fotos nuevas: revísalas/);
  assert.match(flashOf(await post(`/admin/fotos/${held}/ok`, admin)), /volvió a la venta/);
  const p = db.prepare('SELECT status, admin_hidden, photo_hold FROM products WHERE id = ?').get(held);
  assert.deepEqual({ ...p }, { status: 'disponible', admin_hidden: 0, photo_hold: 0 });
});

test('WhatsApp de soporte: lo pone el admin y solo lo ven las tiendas', async () => {
  assert.match(flashOf(await post('/admin/soporte-tiendas', admin, { phone: '123' })), /8 dígitos/);
  assert.match(flashOf(await post('/admin/soporte-tiendas', admin, { phone: '6000-2222' })), /guardado/);
  assert.match(await (await get('/admin', admin)).text(), /name="phone" inputmode="tel" value="6000-2222"/);
  assert.match(await (await get('/vendedor', storeB)).text(), /href="https:\/\/wa\.me\/50660002222"[^>]*>[\s\S]*?Soporte por WhatsApp · 6000-2222/);
  assert.match(await (await get('/mensajes/cowface', storeB)).text(), /WhatsApp al 6000-2222/);
  const buyer = await signup('compra@test.cr', 'Compradora');
  assert.doesNotMatch(await (await get('/mensajes/cowface', buyer)).text(), /6000-2222/, 'los compradores no lo ven');
  await post('/admin/soporte-tiendas', admin, { phone: '' });
  assert.doesNotMatch(await (await get('/vendedor', storeB)).text(), /Soporte por WhatsApp/);
  assert.ok(storeBId);
});

test('fotos de antes del filtro: se les calcula la huella igual que a las nuevas', async () => {
  const { backfillHashes } = await import('../src/photo-check.js');
  const before = db.prepare('SELECT id, phash FROM product_images WHERE phash IS NOT NULL ORDER BY id LIMIT 3').all();
  db.prepare(`UPDATE product_images SET phash = NULL WHERE id IN (${before.map((r) => r.id).join(',')})`).run();
  assert.equal(await backfillHashes(), 3);
  const { hamming } = await import('../src/photo-check.js');
  for (const r of before) {
    const now = db.prepare('SELECT phash FROM product_images WHERE id = ?').get(r.id).phash;
    assert.ok(hamming(now, r.phash) <= 4, 'la huella sale de la foto guardada y queda casi igual');
  }
});
