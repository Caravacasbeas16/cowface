// Favoritos con aviso de bajada de precio, seguir tiendas ("Siguiendo"), logo y portada de la
// tienda, y la página de la tienda por secciones (como DoorDash / Uber Eats).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PNG, adminLogin, ctx, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

process.env.PUSH_TEST_OUTBOX = '1';
process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
const { pushOutbox } = await import('../src/push.js');
const { outbox } = await import('../src/mailer.js');
const { notifyPriceDrops } = await import('../src/social.js');

before(startServer);
after(stopServer);

let seller;
let buyer;
let sellerId;
let buyerId;
const ids = {};
const settle = () => new Promise((r) => setTimeout(r, 120));
const json = (url, cookie) => post(url, cookie, {}, true).then((r) => r.json());

test('preparación', async () => {
  await adminLogin();
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  buyerId = db.prepare("SELECT id FROM users WHERE email = 'compra@test.cr'").get().id;
  // El comprador tiene las notificaciones del celular activadas.
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.test/1', 'k', 'a')").run(buyerId);
  ids.polo = await publishPolo(seller, { title: 'Camisa polo azul' });
  ids.jeans = await publishPolo(seller, { title: 'Jeans Levis 501', item_type: 'Jeans', size: 'Cintura 32' });
});

test('favoritos: guardar y quitar (sin recargar), la lista y el contador en el artículo', async () => {
  assert.deepEqual(await json(`/p/${ids.polo}/favorito`, buyer), { ok: true, saved: true });
  const page = await (await get(`/p/${ids.polo}`, buyer)).text();
  assert.match(page, /♥ 1 persona lo guardó/);
  assert.match(page, /data-fav-label>Guardado/);
  assert.match(await (await get('/buscar', buyer)).text(), /fav-btn is-on/, 'el corazón sale lleno en las tarjetas');
  assert.match(await (await get('/favoritos', buyer)).text(), /Camisa polo azul/);
  assert.equal((await post(`/p/${ids.polo}/favorito`, seller, {}, true)).status, 404, 'no a lo propio');
  assert.deepEqual(await json(`/p/${ids.polo}/favorito`, buyer), { ok: true, saved: false });
  // Sin JS: redirige con aviso.
  const res = await post(`/p/${ids.polo}/favorito`, buyer);
  assert.match(flashOf(res), /Guardado en tus favoritos/);
  assert.equal((await get('/favoritos')).status, 302, 'hay que entrar');
});

test('si baja de precio algo guardado: aviso al celular y por correo, una sola vez por bajada', async () => {
  await post(`/vendedor/productos/${ids.polo}/descuento`, seller, { pct: '20' });
  const pushFrom = pushOutbox.length;
  const mailFrom = outbox.length;
  assert.equal(await notifyPriceDrops('https://cowface.test'), 1);
  await settle();
  const push = pushOutbox.slice(pushFrom).find((p) => p.userId === buyerId);
  assert.match(push.title, /Bajó de precio/);
  assert.match(push.body, /Camisa polo azul: ahora ₡20/);
  const mail = outbox.slice(mailFrom).find((m) => m.to === 'compra@test.cr');
  assert.match(mail.subject, /Bajó de precio: Camisa polo azul/);
  assert.match(mail.html, /https:\/\/cowface\.test\/p\//);
  assert.equal(await notifyPriceDrops('https://cowface.test'), 0, 'no se repite');
  // Si sube y vuelve a bajar, avisa de nuevo.
  await post(`/vendedor/productos/${ids.polo}/descuento/quitar`, seller);
  await notifyPriceDrops();
  await post(`/vendedor/productos/${ids.polo}/descuento`, seller, { pct: '10' });
  assert.equal(await notifyPriceDrops(), 1);
});

test('seguir una tienda: contador, pestaña Siguiendo y aviso cuando publica', async () => {
  assert.match(await (await get(`/u/${sellerId}`, buyer)).text(), /\+ Seguir/);
  assert.deepEqual(await json(`/u/${sellerId}/seguir`, buyer), { ok: true, following: true });
  const store = await (await get(`/u/${sellerId}`, buyer)).text();
  assert.match(store, /✓ Siguiendo/);
  assert.match(store, /data-followers>1</);
  assert.equal((await json(`/u/${buyerId}/seguir`, buyer)).ok, false, 'no a sí mismo');

  const from = pushOutbox.length;
  await publishPolo(seller, { title: 'Chaqueta de mezclilla', item_type: 'Abrigos y chaquetas' });
  await settle();
  const push = pushOutbox.slice(from).find((p) => p.userId === buyerId);
  assert.match(push.title, /Nuevo en Closet Vintage/);
  assert.match(push.body, /Chaqueta de mezclilla/);
  const feed = await (await get('/siguiendo', buyer)).text();
  assert.match(feed, /Chaqueta de mezclilla/);
  assert.match(feed, /Closet Vintage/);

  await post(`/u/${sellerId}/dejar-de-seguir`, buyer, {}, true);
  assert.match(await (await get('/siguiendo', buyer)).text(), /Todavía no sigues ninguna tienda/);
});

// Sube logo y/o portada como lo hace el formulario.
const brand = (cookie, files) => {
  const body = new FormData();
  for (const [field, data, type] of files) body.append(field, new Blob([data], { type }), `${field}.png`);
  return fetch(`${ctx.base}/vendedor/marca`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
};
const brandRow = () => db.prepare('SELECT store_logo, store_banner FROM users WHERE id = ?').get(sellerId);
const exists = (f) => fs.existsSync(path.join(process.env.UPLOAD_DIR, f));

test('logo y portada de la tienda: subir, reemplazar (borra la anterior) y quitar', async () => {
  let res = await brand(seller, [['logo', PNG, 'image/png'], ['banner', PNG, 'image/png']]);
  assert.match(flashOf(res), /Logo y portada guardados/);
  const first = brandRow();
  assert.ok(first.store_logo && exists(first.store_logo));
  assert.ok(first.store_banner && exists(first.store_banner));
  const page = await (await get(`/u/${sellerId}`)).text();
  assert.ok(page.includes(`/fotos/${first.store_logo}`) && page.includes(`/fotos/${first.store_banner}`));
  assert.ok((await (await get('/tiendas')).text()).includes(first.store_logo));

  await brand(seller, [['logo', PNG, 'image/png']]);
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(brandRow().store_logo, first.store_logo);
  assert.ok(!exists(first.store_logo), 'el logo anterior se borra');

  res = await brand(seller, [['logo', Buffer.from('no soy una imagen'), 'image/png']]);
  assert.match(flashOf(res), /no es una imagen válida/);
  await post('/vendedor/marca/banner/quitar', seller);
  assert.equal(brandRow().store_banner, null);
  assert.equal((await brand(buyer, [['logo', PNG, 'image/png']])).headers.get('location'), '/vendedor', 'solo tiendas');
});

test('página de la tienda: secciones por tipo, buscador, vendidos y "verificada"', async () => {
  await post('/vendedor/perfil', seller, { store_about: 'Ropa vintage americana. Subimos todos los jueves.' });
  await post(`/vendedor/productos/${ids.jeans}/vendida`, seller);
  const page = await (await get(`/u/${sellerId}`)).text();
  assert.match(page, /Subimos todos los jueves/);
  assert.match(page, /data-store-search/);
  assert.match(page, /id="camisas-polo"/);
  assert.match(page, /href="#abrigos-y-chaquetas"/);
  assert.match(page, /Vendidos recientemente[\s\S]*Jeans Levis 501/);
  assert.match(page, /✓ Verificada/);
  assert.match(page, /🔥 Ofertas/, 'la polo tiene descuento');
});

test('"Lo más popular" en la tienda cuando tiene más de 6 artículos', async () => {
  const more = [];
  for (let i = 0; i < 5; i++) more.push(await publishPolo(seller, { title: `Polo extra ${i}` }));
  db.exec('UPDATE products SET views = 0; DELETE FROM favorites;'); // sin lo que dejaron las pruebas anteriores
  assert.doesNotMatch(await (await get(`/u/${sellerId}`)).text(), /Lo más popular/, 'sin visitas ni ♥ todavía');
  await post(`/p/${more[3]}/favorito`, buyer, {}, true);
  const page = await (await get(`/u/${sellerId}`)).text();
  assert.match(page, /⭐ Lo más popular[\s\S]*Polo extra 3[\s\S]*<\/section>/);
  assert.match(page, /href="#populares"/);
});
