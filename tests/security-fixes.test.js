// Arreglos de la revisión de seguridad: sesiones guardadas con hash, carpeta temporal de fotos,
// "enc1:" en el chat, entrega distinta a la pedida, dirección fija después de cotizar y aviso
// cuando una tienda cambia su número para cobrar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
const { outbox } = await import('../src/mailer.js');
const { sessionHash } = await import('../src/auth.js');

before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let sellerId;

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage', '8888-1234');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
});

test('la base guarda el hash de la sesión, nunca el token de la cookie', () => {
  const token = buyer.split('=')[1];
  const tokens = db.prepare('SELECT token FROM sessions').all().map((r) => r.token);
  assert.ok(!tokens.includes(token), 'el token tal cual no está en la base');
  assert.ok(tokens.includes(sessionHash(token)));
});

test('la carpeta temporal de subidas no se sirve, ni con la ruta codificada', async () => {
  const tmp = path.join(process.env.UPLOAD_DIR, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'abc123'), 'secreto');
  for (const url of ['/fotos/tmp/abc123', '/fotos/%74mp/abc123', '/fotos/%2574mp/abc123', '/fotos/TMP/abc123']) {
    assert.notEqual((await get(url)).status, 200, url);
  }
});

test('un mensaje que empieza con "enc1:" igual se cifra (con CHAT_KEY)', async () => {
  const { sealText, openText } = await import('../src/crypto-box.js');
  process.env.CHAT_KEY = 'clave-de-prueba-muy-larga-123';
  try {
    const typed = 'enc1:esto lo escribió una persona';
    const stored = sealText(typed);
    assert.notEqual(stored, typed);
    assert.equal(openText(stored), typed);
    assert.equal(sealText(stored), stored, 'lo ya cifrado no se vuelve a cifrar');
  } finally {
    delete process.env.CHAT_KEY;
  }
});

test('si la tienda cotiza otra entrega, el comprador tiene que aceptarla; la dirección cotizada no cambia al pagar', async () => {
  const id = await publishPolo(seller, { title: 'Camisa polo azul' });
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'San José, Barrio Escalante, casa 12' });
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'uber_flash', cost: '0' });
  const page = await (await get(`/mensajes/${o.conversation_id}`, buyer)).text();
  assert.match(page, /name="accept_method"/);
  assert.match(page, /yo había pedido Correos de Costa Rica/);
  let res = await post(`/pedidos/${o.id}/pago`, buyer, { reference: '12345678', phone: '8777-1234', address: 'Otra dirección en Limón centro' });
  assert.match(flashOf(res), /no lo que pediste/);
  assert.equal(db.prepare('SELECT payment_reported_at FROM orders WHERE id = ?').get(o.id).payment_reported_at, null);

  // La tienda cotiza lo que se pidió: ya no hace falta aceptar, y la dirección queda la cotizada.
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '2500' });
  res = await post(`/pedidos/${o.id}/pago`, buyer, { reference: '12345678', phone: '8777-1234', address: 'Otra dirección en Limón centro' });
  const paid = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  assert.ok(paid.payment_reported_at);
  assert.equal(paid.delivery_address, 'San José, Barrio Escalante, casa 12');
});

test('Uber Flash sin link del viaje: plazo normal (no se libera el mismo día)', async () => {
  const id = await publishPolo(seller, { title: 'Gorra' });
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'uber_flash', address: 'San Pedro, frente al Mall' });
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'uber_flash', cost: '2800' });
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '87654321', phone: '8777-1234' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  const { shipWithPhoto } = await import('./helpers.js');
  await shipWithPhoto(seller, o.id);
  const shipped = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  assert.equal(shipped.status, 'enviado');
  assert.ok(Date.parse(shipped.auto_release_at) - Date.now() > 2.5 * 86400e3, 'sin link, 3 días');
});

test('cambiar el SINPE para cobrar: correo a la tienda, aviso y marca para el admin', async () => {
  const from = outbox.length;
  await post('/vendedor/pagos', seller, { payout_phone: '8888-9999', payout_name: 'Otro Titular' });
  await new Promise((r) => setTimeout(r, 50));
  const mail = outbox.slice(from).find((m) => m.to === 'tienda@test.cr');
  assert.match(mail.subject, /Cambiaste el número donde recibes tus pagos/);
  assert.ok(db.prepare('SELECT payout_changed_at FROM users WHERE id = ?').get(sellerId).payout_changed_at);
  // El mismo número otra vez no avisa.
  const again = outbox.length;
  await post('/vendedor/pagos', seller, { payout_phone: '8888-9999', payout_name: 'Otro Titular' });
  assert.equal(outbox.slice(again).filter((m) => m.to === 'tienda@test.cr').length, 0);
});

test('reportar: "back" raro no redirige afuera', async () => {
  const res = await post('/reportar', '', { type: 'usuario', id: sellerId, reason: 'estafa', back: '/\\evil.com' });
  assert.equal(res.headers.get('location'), '/entrar?next=%2F');
});

test('recordatorio de pago: 3 h antes de vencer, una sola vez, por celular y correo', async () => {
  const { sendPaymentReminders } = await import('../src/payment-reminders.js');
  const { pushOutbox } = await import('../src/push.js');
  process.env.PUSH_TEST_OUTBOX = '1';
  const buyerId = db.prepare("SELECT id FROM users WHERE email = 'compra@test.cr'").get().id;
  db.prepare("INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.test/r', 'k', 'a')").run(buyerId);
  const id = await publishPolo(seller, { title: 'Bolso de cuero' });
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC').get();
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'Cartago centro, casa azul' });
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '2000' });
  assert.equal(await sendPaymentReminders('https://cowface.test'), 0, 'todavía falta mucho');
  db.prepare('UPDATE orders SET payment_due_at = ? WHERE id = ?').run(new Date(Date.now() + 2 * 3600e3).toISOString(), o.id);
  const mails = outbox.length;
  const pushes = pushOutbox.length;
  assert.equal(await sendPaymentReminders('https://cowface.test'), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(outbox.slice(mails).find((m) => m.to === 'compra@test.cr').subject, new RegExp(`${o.code} vence`));
  assert.match(pushOutbox.slice(pushes).find((p) => p.userId === buyerId).title, /vence pronto/);
  assert.equal(await sendPaymentReminders('https://cowface.test'), 0, 'una sola vez');
});
