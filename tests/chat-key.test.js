// Cifrado de los chats: también los intentos bloqueados, los pedidos de ayuda y el chat con CowFace;
// lo guardado antes de tener clave se cifra al arrancar; y si la clave falta o cambia, se avisa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { chatKeyStatus, checkChatKey, sealOldTexts } = await import('../src/chat-key.js');

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
delete process.env.CHAT_KEY;
before(startServer);
after(() => { delete process.env.CHAT_KEY; stopServer(); });

const KEY = 'una-clave-larga-de-prueba-123';
let admin;
let seller;
let buyer;
let convId;

test('sin clave: apagado, y lo que se guarda queda en texto (como antes)', async () => {
  admin = await adminLogin();
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['seguridad', 'ayuda'] });
  seller = await signupSeller('tienda@test.cr', 'Tienda');
  buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller);
  const first = await post(`/p/${id}/mensaje`, buyer, { body: '¿Todavía la tiene?' });
  convId = Number(first.headers.get('location').split('/').pop());
  await post(`/mensajes/${convId}`, buyer, { body: 'escribime al 8888-1234' }, true);
  assert.equal(chatKeyStatus(), 'apagado');
  assert.match(await (await get('/admin', admin)).text(), /Los chats todavía no se cifran/);
  assert.equal(db.prepare('SELECT body FROM flagged_messages ORDER BY id DESC').get().body, 'escribime al 8888-1234');
});

test('con clave: lo viejo se cifra al arrancar y lo nuevo se guarda cifrado; el admin lo lee igual', async () => {
  process.env.CHAT_KEY = KEY;
  assert.equal(chatKeyStatus(), 'ok');
  assert.ok(sealOldTexts() >= 1);
  assert.match(db.prepare('SELECT body FROM flagged_messages ORDER BY id DESC').get().body, /^enc1:/);

  await post(`/mensajes/${convId}`, buyer, { body: 'mi insta es tienda.cr' }, true);
  await post(`/mensajes/${convId}/ayuda`, buyer, { body: 'La tienda no me responde desde ayer.' });
  for (const table of ['flagged_messages', 'help_requests']) {
    const rows = db.prepare(`SELECT body FROM ${table}`).all();
    assert.ok(rows.every((r) => r.body.startsWith('enc1:')), `${table} cifrado en la base`);
  }
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /escribime al 8888-1234/);
  assert.match(page, /mi insta es tienda\.cr/);
  assert.match(page, /La tienda no me responde desde ayer/);
  assert.match(page, /✓ Los mensajes, fotos y comprobantes del chat se guardan cifrados/);
  const health = await (await get('/salud?detalle=1', admin)).json();
  assert.equal(health.cifradoChats, 'ok');
});

test('si la clave cambia: aviso en el panel y correo al admin', async () => {
  process.env.CHAT_KEY = 'otra-clave-distinta-456789';
  const from = outbox.length;
  assert.equal(checkChatKey(), 'otra');
  await new Promise((r) => setTimeout(r, 100));
  const mail = outbox.slice(from).find((m) => m.to === 'yo@test.cr');
  assert.match(mail.subject, /Problema con el cifrado de los chats/);
  assert.match(mail.text, /CHAT_KEY cambió/);
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /Problema con la clave del cifrado/);
  assert.doesNotMatch(page, /✓ Los mensajes, fotos y comprobantes/);
});

test('si la clave falta: también avisa; con la clave de antes vuelve a estar bien', async () => {
  delete process.env.CHAT_KEY;
  assert.equal(checkChatKey(), 'falta');
  assert.match(await (await get('/admin', admin)).text(), /Falta la clave CHAT_KEY/);
  process.env.CHAT_KEY = KEY;
  assert.equal(chatKeyStatus(), 'ok');
  assert.match(await (await get('/admin', admin)).text(), /escribime al 8888-1234/, 'lo cifrado se vuelve a leer');
});
