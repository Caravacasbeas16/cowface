import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PNG, POLO, adminLogin, ctx, db, get, post, publish, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { parseFilters, searchProducts } = await import('../src/products.js');
const { findBlocked } = await import('../src/moderation.js');

// Correo con números y gmail, como el real: antes un error de escape lo rechazaba.
process.env.CONTACT_EMAIL = 'prueba123@gmail.com';

before(startServer);
after(stopServer);

let seller;
let buyer;
let productId;
let convId;

// ---------- Filtro de contacto ----------

test('el filtro bloquea redes, teléfonos, correos y enlaces aunque los disfracen', () => {
  const blocked = [
    'escribime al whatsapp', 'pasame tu WhatsApp', 'w h a t s a p p', 'wh4ts4pp', 'mandame un wasap',
    'te busco en facebook', 'f4ceb00k', 'face book', 'por messenger mejor', 'mi ig es tal', 'instagram',
    'llamame al 8888-8888', '8888 8888', '+506 88888888', '8 8 8 8 8 8 8 8',
    'ana@gmail.com', 'ana arroba gmail punto com', 'mirá wa.me/50688888888', 'www.tienda.com', 'tienda.cr',
  ];
  for (const text of blocked) assert.ok(findBlocked(text), `debió bloquear: "${text}"`);

  const allowed = [
    '¿Todavía la tenés?', 'Te ofrezco ₡22000', 'Entre 25000 y 30000 está bien', 'La mando por Correos de Costa Rica',
    'Al instante te respondo', 'Talla M, mide 72 cm de largo', 'Nos vemos en el mall de Heredia', '¿Aceptas SINPE?',
    'Es una camisa elegante', 'figura en la etiqueta',
  ];
  for (const text of allowed) assert.equal(findBlocked(text), null, `no debió bloquear: "${text}"`);
});

// ---------- Publicar ----------

test('para publicar primero se piden los datos para recibir pagos', async () => {
  const fresh = await signup('nuevo@test.cr', 'Nuevo');
  const res = await get('/vendedor/productos/nuevo', fresh);
  assert.equal(res.headers.get('location'), '/vendedor/pagos?next=publicar');
  const bad = await post('/vendedor/pagos', fresh, { payout_phone: '123', payout_name: 'X' });
  assert.equal(bad.status, 400);
});

test('un vendedor publica con foto; la descripción tampoco admite contacto', async () => {
  seller = await signupSeller('vendedor@test.cr', 'Vendedor Test', '8888-1234');
  const res = await publish(seller, POLO, [{ data: PNG, type: 'image/png', name: 'polo.png' }]);
  assert.equal(res.status, 302);
  productId = Number(res.headers.get('location').split('/').pop());
  assert.equal(db.prepare('SELECT price FROM products WHERE id = ?').get(productId).price, 25000);
  const img = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').get(productId);
  assert.ok(fs.existsSync(`${process.env.UPLOAD_DIR}/${img.filename}`), 'la foto quedó en disco');

  const bad = await publish(seller, { ...POLO, description: 'Info al WhatsApp 8888-1234' });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM flagged_messages WHERE context = 'publicación'").get().n, 1);

  const wrongSize = await publish(seller, { ...POLO, size: 'US 9' });
  assert.equal(wrongSize.status, 400);
});

test('la búsqueda filtra por talla, categoría, estado y precio', () => {
  const find = (q) => searchProducts(parseFilters(q)).items.map((p) => p.id);
  assert.ok(find({ categoria: 'ropa', talla: 'M' }).includes(productId));
  assert.ok(!find({ categoria: 'ropa', talla: 'L' }).includes(productId));
  assert.ok(find({ q: 'polo lacoste' }).includes(productId));
  assert.ok(!find({ estado: 'usado' }).includes(productId));
  assert.doesNotThrow(() => find({ categoria: "x' OR 1=1 --", talla: ['M', 'zzz'], pagina: '-5' }));
});

// ---------- Chat ----------

test('sin sesión, ofertar manda a entrar y vuelve al artículo', async () => {
  const res = await fetch(`${ctx.base}/p/${productId}/ofertar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ amount: '20000' }), headers: { Referer: `${ctx.base}/p/${productId}` },
  });
  assert.equal(res.headers.get('location'), `/entrar?next=${encodeURIComponent(`/p/${productId}`)}`);
});

test('chat: mensaje normal pasa, contacto se bloquea y queda registrado', async () => {
  buyer = await signup('comprador@test.cr', 'Compradora Test', '8777-0000');
  const first = await post(`/p/${productId}/mensaje`, buyer, { body: '¿Es talla regular?' });
  assert.equal(first.status, 302);
  convId = Number(first.headers.get('location').split('/').pop());

  assert.equal((await post(`/mensajes/${convId}`, seller, { body: 'Sí, es regular.' }, true)).status, 200);

  const blocked = await post(`/mensajes/${convId}`, buyer, { body: 'pasame tu whats mejor' }, true);
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error, /whats/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId).n, 2, 'no se guardó');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM flagged_messages WHERE context = 'chat'").get().n, 1);
});

test('nadie más puede ver ni escribir en una conversación ajena', async () => {
  const intruder = await signup('intruso@test.cr', 'Intruso');
  assert.equal((await get(`/mensajes/${convId}`, intruder)).status, 404);
  assert.equal((await post(`/mensajes/${convId}`, intruder, { body: 'hola' })).status, 404);
});

test('ofertas: mínimo 50 %, no se acepta la propia, la contraoferta reemplaza', async () => {
  assert.equal((await post(`/mensajes/${convId}/oferta`, buyer, { amount: '5000' }, true)).status, 400);
  assert.equal((await post(`/mensajes/${convId}/oferta`, buyer, { amount: '18000' }, true)).status, 200);
  const first = db.prepare("SELECT id FROM offers WHERE conversation_id = ? AND status = 'pendiente'").get(convId).id;
  assert.equal((await post(`/ofertas/${first}/aceptar`, buyer, {}, true)).status, 409);
  assert.equal((await post(`/mensajes/${convId}/oferta`, seller, { amount: '21000' }, true)).status, 200);
  assert.equal(db.prepare('SELECT status FROM offers WHERE id = ?').get(first).status, 'reemplazada');
});

test('aviso en vivo: el comprador recibe el evento cuando el vendedor escribe', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${ctx.base}/mensajes/eventos`, { headers: { cookie: buyer }, signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  await reader.read(); // "retry: ..."
  await post(`/mensajes/${convId}`, seller, { body: 'Ya va en camino' }, true);
  let text = '';
  while (!text.includes('event: conversacion')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, new RegExp(`"id":${convId}`));
  ctrl.abort();
});

// ---------- Admin y seguridad ----------

test('admin: intentos bloqueados y lista de palabras editable', async () => {
  const cookie = await adminLogin();
  const page = await (await get('/admin', cookie)).text();
  assert.match(page, /pasame tu whats mejor/);
  assert.match(page, /Falta configurar el cobro/);

  await post('/admin/palabras', cookie, { words: 'whatsapp\nsinpe' });
  assert.ok(findBlocked('¿aceptás sinpe?'));
  assert.equal(findBlocked('mi facebook'), null, 'la lista nueva reemplaza la anterior');
  await post('/admin/palabras', cookie, { words: 'whatsapp\nfacebook\nmessenger\ninstagram' });

  assert.equal((await get('/admin', buyer)).status, 403);
});

test('un usuario no puede tocar artículos de otro', async () => {
  assert.equal((await get(`/vendedor/productos/${productId}/editar`, buyer)).status, 404);
  assert.equal((await post(`/vendedor/productos/${productId}/borrar`, buyer)).status, 404);
});

test('páginas de salud, términos y privacidad', async () => {
  assert.equal(await (await get('/salud')).text(), 'ok');
  const terms = await (await get('/terminos')).text();
  assert.match(terms, /WhatsApp, Facebook, Messenger/);
  assert.match(terms, /<strong>2 %<\/strong>/);
  assert.match(terms, /mailto:prueba123@gmail\.com/);
  assert.equal((await get('/privacidad')).status, 200);
  assert.equal(await (await get('/salud?detalle=1')).text(), 'ok', 'el diagnóstico no es público');
  const health = await (await get('/salud?detalle=1', await adminLogin())).json();
  assert.equal(health.correoContacto, 'ok');
});

test('login no redirige a sitios externos', async () => {
  const res = await post('/entrar', '', { email: 'vendedor@test.cr', password: 'clave-segura-1', next: '//evil.example' });
  assert.equal(res.headers.get('location'), '/');
});

// Va al final: deja bloqueada la IP de las pruebas para /entrar.
test('bloquea demasiados intentos de entrar', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/entrar', '', { email: 'x@test.cr', password: 'mala' });
  assert.equal(last.status, 429);
});
