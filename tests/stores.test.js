// Chats cifrados, directorio de tiendas con historial (ventas y reseñas previas) y datos a la tienda tras el SINPE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PNG, adminLogin, ctx, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { encryptExisting, openText } = await import('../src/crypto-box.js');
const { ATTACH_DIR } = await import('../src/storage.js');
const { default: sharp } = await import('sharp');

process.env.CHAT_KEY = 'clave-de-prueba-para-el-chat';
process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let sellerId;
let convId;
let receipt = 400000000;
const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
});

// ---------- Cifrado ----------

test('los mensajes se guardan cifrados pero se leen normal en el chat, la bandeja y el admin', async () => {
  const id = await publishPolo(seller);
  const res = await post(`/p/${id}/mensaje`, buyer, { body: 'Hola, ¿me la apartas hasta el viernes?' });
  convId = Number(res.headers.get('location').split('/').pop());

  const stored = db.prepare('SELECT body FROM messages WHERE conversation_id = ? ORDER BY id DESC').get(convId).body;
  assert.match(stored, /^enc1:/);
  assert.doesNotMatch(stored, /apartas/, 'en la base no se lee el mensaje');

  assert.match(await (await get(`/mensajes/${convId}`, seller)).text(), /me la apartas hasta el viernes/);
  assert.match(await (await get('/mensajes', seller)).text(), /me la apartas/);
  assert.match(await (await get(`/admin/conversaciones/${convId}`, admin)).text(), /me la apartas/);
  assert.match(await (await get('/admin', admin)).text(), /Los mensajes, fotos y comprobantes del chat se guardan cifrados/);
});

test('las fotos del chat se guardan cifradas en el disco y se ven normal', async () => {
  const shot = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#0a0' } }).png().toBuffer();
  const body = new FormData();
  body.append('file', new Blob([shot], { type: 'image/png' }), 'etiqueta.png');
  await fetch(`${ctx.base}/mensajes/${convId}/adjunto`, { method: 'POST', body, headers: { cookie: buyer }, redirect: 'manual' });
  const { attachment } = db.prepare('SELECT attachment FROM messages WHERE attachment IS NOT NULL ORDER BY id DESC').get();
  const onDisk = fs.readFileSync(path.join(ATTACH_DIR, attachment));
  assert.equal(onDisk.subarray(0, 4).toString(), 'CFE1', 'el archivo en el disco está cifrado');
  await assert.rejects(sharp(onDisk).metadata(), 'y no se puede abrir como imagen');
  const served = await get(`/adjuntos/${attachment}`, seller);
  assert.equal(served.status, 200);
  assert.equal((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width, 600);
});

test('lo que se guardó antes sin cifrar se cifra al arrancar; con otra clave no se lee', () => {
  db.prepare("INSERT INTO messages (conversation_id, sender_id, kind, body) VALUES (?, NULL, 'sistema', 'Mensaje viejo sin cifrar')").run(convId);
  const plain = path.join(ATTACH_DIR, `${'a'.repeat(24)}.png`);
  fs.writeFileSync(plain, PNG);
  const r = encryptExisting(db, ATTACH_DIR);
  assert.ok(r.messages >= 1 && r.files >= 1);
  const row = db.prepare("SELECT body FROM messages WHERE kind = 'sistema' ORDER BY id DESC").get();
  assert.match(row.body, /^enc1:/);
  assert.equal(openText(row.body), 'Mensaje viejo sin cifrar');
  assert.equal(fs.readFileSync(plain).subarray(0, 4).toString(), 'CFE1');

  process.env.CHAT_KEY = 'otra-clave-totalmente-distinta';
  assert.match(openText(row.body), /otra clave/);
  delete process.env.CHAT_KEY;
  assert.match(openText(row.body), /falta la clave/);
  process.env.CHAT_KEY = 'clave-de-prueba-para-el-chat';
});

// ---------- Historial y tiendas ----------

test('el admin pone ventas y reseñas previas; se suman y el perfil lo aclara', async () => {
  const bad = await post(`/admin/tiendas/${sellerId}/historial`, admin, { sales_base: '120', reviews_base_count: '85', reviews_base_avg: '' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Promedio de 1 a 5/);
  const ok = await post(`/admin/tiendas/${sellerId}/historial`, admin, { sales_base: '120', reviews_base_count: '85', reviews_base_avg: '4,9', history_source: 'Instagram' });
  assert.match(flashOf(ok), /guardado/);

  const profile = await (await get(`/u/${sellerId}`)).text();
  assert.match(profile, /<strong>120<\/strong> ventas/);
  assert.match(profile, /4\.9/);
  assert.match(profile, /\(85 reseñas\)/);
  assert.match(profile, /Incluye historial de antes de CowFace \(Instagram\):\s+120 ventas y 85 reseñas \(★ 4\.9\)/);
  assert.equal((await post(`/admin/tiendas/${sellerId}/historial`, seller, { sales_base: '9999' })).status, 403);
});

test('el directorio de tiendas muestra ventas y reseñas, y el artículo las ventas de la tienda', async () => {
  const page = await (await get('/tiendas')).text();
  assert.match(page, /Closet Vintage/);
  assert.match(page, /120 ventas/);
  assert.doesNotMatch(page, /Compradora/, 'quien no vende no aparece');
  const id = await publishPolo(seller, { title: 'Hoodie gris' });
  assert.match(await (await get(`/p/${id}`)).text(), /120 ventas · Ver perfil/);
  assert.match(await (await get('/')).text(), /href="\/tiendas"/);
});

// ---------- Datos a la tienda después del SINPE ----------

test('tras confirmar el SINPE, el admin le manda a la tienda los datos de entrega', async () => {
  const id = await publishPolo(seller, { title: 'Jeans 501' });
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: String(++receipt), method: 'correos', address: 'Heredia, San Pablo, casa 12', phone: '8777-0000' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);

  let page = await (await get('/admin', admin)).text();
  assert.match(page, /Datos por enviar a tiendas/);
  assert.match(page, /Dirección \/ punto de entrega: Heredia, San Pablo, casa 12/);
  assert.match(page, /Sin enviar/);

  const from = outbox.length;
  const sent = await post(`/admin/pedidos/${o.id}/enviar-datos`, admin);
  assert.match(flashOf(sent), /enviados a tienda@test\.cr/);
  const mail = outbox.slice(from).find((m) => m.to === 'tienda@test.cr');
  assert.match(mail.subject, new RegExp(`Pedido ${o.code}: envíalo a Compradora`));
  assert.match(mail.text, /Heredia, San Pablo, casa 12/);
  assert.match(mail.text, /87770000/);
  assert.match(mail.text, /sube la foto del envío/);
  assert.ok(db.prepare('SELECT data_sent_at FROM orders WHERE id = ?').get(o.id).data_sent_at);
  page = await (await get('/admin', admin)).text();
  assert.match(page, /Datos enviados/);
  assert.match(page, /Reenviar por correo/);
  assert.equal((await post(`/admin/pedidos/${o.id}/enviar-datos`, seller)).status, 403);
});

test('"Ya se los mandé" (por WhatsApp) lo marca; la venta completada suma al historial', async () => {
  const id = await publishPolo(seller, { title: 'Gorra' });
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: String(++receipt), method: 'en_persona', address: 'Mall Oxígeno', phone: '8777-0000' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await post(`/admin/pedidos/${o.id}/datos-enviados`, admin);
  assert.ok(db.prepare('SELECT data_sent_at FROM orders WHERE id = ?').get(o.id).data_sent_at);

  await post(`/pedidos/${o.id}/recibido`, buyer);
  assert.match(await (await get(`/u/${sellerId}`)).text(), /<strong>121<\/strong> ventas/, '120 previas + 1 en CowFace');
});
