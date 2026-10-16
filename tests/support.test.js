// Chat directo entre el admin (CowFace) y una tienda: la tienda lo ve fijo arriba en Mensajes como
// "CowFace · Equipo oficial", con aviso al celular y por correo; el admin ve sus respuestas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, get, post, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

process.env.PUSH_TEST_OUTBOX = '1';
process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
const { pushOutbox } = await import('../src/push.js');
const { outbox } = await import('../src/mailer.js');

before(startServer);
after(stopServer);

let admin;
let seller;
let other;
let sellerId;
const settle = () => new Promise((r) => setTimeout(r, 80));

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['soporte'] });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  other = await signup('otra@test.cr', 'Otra Persona');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.test/s', 'k', 'a')").run(sellerId);
});

test('solo el admin entra a sus mensajes', async () => {
  assert.equal((await get('/admin/mensajes', seller)).status, 403);
  assert.equal((await get(`/admin/mensajes/${sellerId}`, seller)).status, 403);
  assert.equal((await post(`/admin/mensajes/${sellerId}`, seller, { body: 'Hola' })).status, 403);
  assert.equal((await get('/mensajes/cowface')).status, 302, 'la tienda tiene que entrar');
});

test('el admin busca la tienda y le escribe: le llega como CowFace oficial, al celular y por correo', async () => {
  assert.match(await (await get('/admin/mensajes?q=closet', admin)).text(), new RegExp(`href="/admin/mensajes/${sellerId}"`));
  assert.match(await (await get('/admin/tiendas?tab=aprobadas', admin)).text(), /💬 Escribir/);
  const pushes = pushOutbox.length;
  const mails = outbox.length;
  const res = await post(`/admin/mensajes/${sellerId}`, admin, { body: '¡Hola! Te damos la bienvenida a CowFace. ¿Te ayudamos a subir tu inventario?' });
  assert.equal(res.headers.get('location'), `/admin/mensajes/${sellerId}#fin`);
  await settle();
  const push = pushOutbox.slice(pushes).find((p) => p.userId === sellerId);
  assert.match(push.title, /CowFace · Equipo oficial/);
  assert.equal(push.url, '/mensajes/cowface');
  assert.match(outbox.slice(mails).find((m) => m.to === 'tienda@test.cr').subject, /CowFace te escribió/);
  const stored = db.prepare('SELECT body FROM support_messages ORDER BY id DESC').get().body;
  assert.ok(stored.length > 0);

  // En sus mensajes: fijo arriba, marcado como oficial y sin leer.
  const inbox = await (await get('/mensajes', seller)).text();
  assert.match(inbox, /inbox-official unread/);
  assert.match(inbox, /✓ Equipo oficial/);
  assert.match(inbox, /Te damos la bienvenida/);
  assert.match(await (await get('/', seller)).text(), /data-unread >1</, 'cuenta en el número de Mensajes');
});

test('la tienda lo lee y responde; el admin ve la respuesta y el "leído"', async () => {
  const page = await (await get('/mensajes/cowface', seller)).text();
  assert.match(page, /CowFace · Equipo oficial ✓/);
  assert.match(page, /bubble-official/);
  assert.doesNotMatch(await (await get('/', seller)).text(), /data-unread >1</, 'ya no cuenta como sin leer');

  const mails = outbox.length;
  await post('/mensajes/cowface', seller, { body: 'Sí, por favor. Tengo 40 prendas.' });
  await settle();
  assert.match(outbox.slice(mails).find((m) => m.to === 'yo@test.cr').subject, /Mensaje de Closet Vintage/);
  let adminInbox = await (await get('/admin/mensajes', admin)).text();
  assert.match(adminInbox, /Tengo 40 prendas/);
  assert.match(await (await get('/admin', admin)).text(), /href="\/admin\/mensajes"[\s\S]*?<span class="badge">1<\/span>/);
  const thread = await (await get(`/admin/mensajes/${sellerId}`, admin)).text();
  assert.match(thread, /leído ✓/);
  assert.match(thread, /Tengo 40 prendas/);
  adminInbox = await (await get('/admin/mensajes', admin)).text();
  assert.doesNotMatch(adminInbox, /<span class="badge">1<\/span>/, 'leído por el admin');
});

test('otra persona no ve el chat de la tienda (cada quien el suyo)', async () => {
  const page = await (await get('/mensajes/cowface', other)).text();
  assert.doesNotMatch(page, /Tengo 40 prendas/);
  assert.match(await (await get('/mensajes', other)).text(), /inbox-official[\s\S]*Escríbenos aquí/, 'siempre aparece, para escribir primero');
  assert.equal((await post('/mensajes/cowface', seller, { body: '   ' })).status, 302);
});

test('una tienda o persona puede escribirle primero a CowFace; le llega al admin', async () => {
  const otherId = db.prepare("SELECT id FROM users WHERE email = 'otra@test.cr'").get().id;
  await post('/mensajes/cowface', other, { body: 'Hola, quiero abrir una tienda. ¿Cómo hago?' });
  const inbox = await (await get('/admin/mensajes', admin)).text();
  assert.match(inbox, new RegExp(`href="/admin/mensajes/${otherId}"`));
  assert.match(inbox, /quiero abrir una tienda/);
  await post(`/admin/mensajes/${otherId}`, admin, { body: 'Claro, entra a Vender en CowFace.' });
  assert.match(await (await get('/mensajes/cowface', other)).text(), /entra a Vender en CowFace/);
  assert.match(await (await get('/vendedor', seller)).text(), /href="\/mensajes\/cowface"/, 'en el panel de la tienda');
});
