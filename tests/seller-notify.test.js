// Correo al vendedor cuando le escriben y no lo lee en unos minutos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { runMessageEmails } = await import('../src/seller-notify.js');

process.env.MAIL_TEST_OUTBOX = '1';
before(startServer);
after(stopServer);

let seller;
let buyer;
let convId;
const MIN = 60e3;
const toSeller = (from) => outbox.slice(from).filter((m) => m.to === 'vende@test.cr');
// Corre el revisor como si fuera "minutos" después del último mensaje.
const runAfter = (minutes) => runMessageEmails(Date.now() + minutes * MIN);

test('preparación', async () => {
  seller = await signupSeller('vende@test.cr', 'Vendedora');
  buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller);
  const res = await post(`/p/${id}/mensaje`, buyer, { body: '¿Todavía la tienes? ¿Es talla regular?' });
  convId = Number(res.headers.get('location').split('/').pop());
});

test('no avisa enseguida: espera unos minutos por si lo lee', async () => {
  const from = outbox.length;
  assert.equal((await runAfter(1)).sent, 0);
  assert.equal(toSeller(from).length, 0);
});

test('si no lo leyó, le llega un correo con el mensaje y el enlace para responder', async () => {
  const from = outbox.length;
  assert.equal((await runAfter(6)).sent, 1);
  const [mail] = toSeller(from);
  assert.match(mail.subject, /Compradora te escribió por «Camisa polo azul»/);
  assert.match(mail.text, /¿Todavía la tienes\?/);
  assert.match(mail.text, new RegExp(`/mensajes/${convId}`));
  // Solo uno: otra pasada no lo repite.
  assert.equal((await runAfter(7)).sent, 0);
});

test('máximo un correo por conversación cada hora; incluye ofertas', async () => {
  // El correo anterior salió hace un minuto; después llega una oferta.
  db.prepare('UPDATE conversations SET seller_notified_at = ? WHERE id = ?').run(new Date(Date.now() - MIN).toISOString(), convId);
  await post(`/mensajes/${convId}/oferta`, buyer, { amount: '20000' }, true);
  let from = outbox.length;
  assert.equal((await runAfter(20)).sent, 0, 'todavía no pasó la hora');
  from = outbox.length;
  assert.equal((await runAfter(70)).sent, 1);
  assert.match(toSeller(from)[0].text, /oferta de ₡20\s?000/);
});

test('si el vendedor abre el chat, no se le avisa', async () => {
  db.prepare('UPDATE conversations SET seller_notified_at = NULL WHERE id = ?').run(convId);
  await post(`/mensajes/${convId}`, buyer, { body: 'Hola de nuevo' }, true);
  await get(`/mensajes/${convId}`, seller);
  assert.equal((await runAfter(10)).sent, 0);
});

test('los mensajes del vendedor no le avisan a él mismo', async () => {
  db.prepare('UPDATE conversations SET seller_notified_at = NULL WHERE id = ?').run(convId);
  await post(`/mensajes/${convId}`, seller, { body: 'Sí, todavía la tengo' }, true);
  assert.equal((await runAfter(10)).sent, 0);
});

test('el vendedor lo puede apagar y volver a encender desde Mi cuenta', async () => {
  assert.match(await (await get('/vendedor', seller)).text(), /name="email_messages" value="1" checked/);
  assert.match(flashOf(await post('/vendedor/avisos-correo', seller, {})), /Ya no te mandaremos/);
  db.prepare('UPDATE conversations SET seller_notified_at = NULL WHERE id = ?').run(convId);
  await post(`/mensajes/${convId}`, buyer, { body: '¿Me la apartas?' }, true);
  assert.equal((await runAfter(10)).sent, 0);

  await post('/vendedor/avisos-correo', seller, { email_messages: '1' });
  assert.equal((await runAfter(10)).sent, 1);
});

test('no avisa de mensajes viejos (más de 2 días)', async () => {
  db.prepare('UPDATE conversations SET seller_notified_at = NULL WHERE id = ?').run(convId);
  await post(`/mensajes/${convId}`, buyer, { body: 'Mensaje viejo' }, true);
  assert.equal((await runAfter(3 * 24 * 60)).sent, 0);
});
