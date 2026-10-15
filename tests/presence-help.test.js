// Horario de las tiendas, "en línea / activa hace…" y "Pedir ayuda a CowFace" (el admin se hace cargo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { parseHours, hoursStatus, timeLabel } = await import('../src/store-hours.js');
const { presenceLabel } = await import('../src/presence.js');
const { outbox } = await import('../src/mailer.js');

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

const cr = (date, time) => Date.parse(`${date}T${time}:00-06:00`);
let admin;
let seller;
let buyer;
let sellerId;
let productId;
let convId;

// ---------- Horario (sin servidor) ----------

test('el horario valida días y horas, y dice si está abierta o cuándo abre', () => {
  assert.match(parseHours({ open_lun: '1', from_lun: '18:00', to_lun: '09:00' }).error, /Lunes: la hora de cierre/);
  assert.match(parseHours({ open_mar: '1', from_mar: '', to_mar: '10:00' }).error, /Martes: escribe/);
  const { hours } = parseHours({ open_lun: '1', from_lun: '09:00', to_lun: '18:00', open_sab: '1', from_sab: '10:00', to_sab: '14:30', from_dom: '09:00', to_dom: '10:00' });
  assert.deepEqual(Object.keys(hours), ['lun', 'sab'], 'solo los días marcados');
  // 2026-10-19 es lunes.
  assert.equal(hoursStatus(hours, cr('2026-10-19', '10:00')).label, 'Abierta ahora · cierra 6 p. m.');
  assert.equal(hoursStatus(hours, cr('2026-10-19', '07:00')).label, 'Cerrada · abre hoy a las 9 a. m.');
  assert.equal(hoursStatus(hours, cr('2026-10-19', '19:00')).label, 'Cerrada · abre el sábado a las 10 a. m.');
  assert.equal(hoursStatus(hours, cr('2026-10-24', '20:00')).label, 'Cerrada · abre el lunes a las 9 a. m.');
  assert.equal(hoursStatus(hours, cr('2026-10-23', '20:00')).label, 'Cerrada · abre mañana a las 10 a. m.');
  assert.equal(timeLabel('14:30'), '2:30 p. m.');
  assert.equal(hoursStatus({}).has, false);
});

test('"en línea" y "activa hace…"', () => {
  const now = Date.now();
  assert.equal(presenceLabel(null, true), 'En línea');
  assert.equal(presenceLabel(new Date(now - 20 * 60e3).toISOString(), false, now), 'Activa hace 20 min');
  assert.equal(presenceLabel(new Date(now - 3 * 3600e3).toISOString(), false, now), 'Activa hace 3 h');
  assert.equal(presenceLabel(new Date(now - 30 * 3600e3).toISOString(), false, now), 'Activa ayer');
  assert.equal(presenceLabel(new Date(now - 5 * 86400e3).toISOString(), false, now), 'Activa hace 5 días');
  assert.equal(presenceLabel(null, false), 'Sin actividad reciente');
});

// ---------- En el sitio ----------

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['ayuda'] });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  productId = await publishPolo(seller);
});

test('la tienda guarda su horario en Mi cuenta y se ve en su perfil y sus artículos', async () => {
  assert.match(flashOf(await post('/vendedor/horario', seller, { open_lun: '1', from_lun: '20:00', to_lun: '08:00' })), /hora de cierre/);
  const all = {};
  for (const d of ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']) Object.assign(all, { [`open_${d}`]: '1', [`from_${d}`]: '00:00', [`to_${d}`]: '23:59' });
  assert.match(flashOf(await post('/vendedor/horario', seller, all)), /Horario guardado/);
  const profile = await (await get(`/u/${sellerId}`)).text();
  assert.match(profile, /Horario de atención/);
  assert.match(profile, /Lunes<\/td><td class="">12 a\. m\. – 11:59 p\. m\./);
  assert.match(profile, /Abierta ahora · cierra 11:59 p\. m\./);
  assert.match(await (await get(`/p/${productId}`)).text(), /Abierta ahora/);
  assert.match(await (await get('/tiendas')).text(), /Abierta ahora/);
  assert.match(await (await get('/vendedor/configuracion', seller)).text(), /name="open_lun" value="1" checked/);
});

test('se ve si la tienda está en línea o cuándo estuvo activa', async () => {
  // Acaba de usar el sitio: en línea.
  assert.match(await (await get(`/p/${productId}`)).text(), /presence-on[^>]*><span class="presence-dot"[^>]*><\/span>En línea/);
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 3600e3).toISOString(), sellerId);
  assert.match(await (await get(`/u/${sellerId}`)).text(), /Activa hace 2 h/);
});

test('"Pedir ayuda a CowFace": avisa al admin, queda en "Por hacer" y el admin responde en el chat', async () => {
  const res = await post(`/p/${productId}/mensaje`, buyer, { body: '¿Me la apartas?' });
  convId = Number(res.headers.get('location').split('/').pop());
  assert.match(await (await get(`/mensajes/${convId}`, buyer)).text(), /Pedir ayuda a CowFace/);
  assert.match(flashOf(await post(`/mensajes/${convId}/ayuda`, buyer, { body: 'corto' })), /qué pasó/);

  const from = outbox.length;
  const ok = await post(`/mensajes/${convId}/ayuda`, buyer, { body: 'La tienda no me responde desde hace dos días.' });
  assert.match(flashOf(ok), /CowFace ya está al tanto y se hace cargo/);
  await new Promise((r) => setTimeout(r, 100));
  const mail = outbox.slice(from).find((m) => m.to === 'yo@test.cr');
  assert.match(mail.subject, /Pidieron ayuda/);
  assert.match(mail.text, /no me responde desde hace dos días/);
  const chat = await (await get(`/mensajes/${convId}`, seller)).text();
  assert.match(chat, /Compradora pidió ayuda a CowFace/);
  assert.doesNotMatch(chat, /no me responde desde hace dos días/, 'lo que escribió solo lo lee CowFace');

  const panel = await (await get('/admin', admin)).text();
  assert.match(panel, /Ayuda solicitada/);
  assert.match(panel, /no me responde desde hace dos días/);
  assert.match(await (await get('/', admin)).text(), /Admin<span class="badge" >1</);

  await post(`/admin/conversaciones/${convId}/mensaje`, admin, { body: 'Hola, ya le escribimos a la tienda.' });
  assert.match(await (await get(`/mensajes/${convId}`, buyer)).text(), /💬 CowFace: Hola, ya le escribimos a la tienda\./);
  const h = db.prepare("SELECT id FROM help_requests WHERE status = 'abierta'").get();
  await post(`/admin/ayuda/${h.id}/resolver`, admin, { note: 'La tienda respondió y apartó la prenda.' });
  assert.match(await (await get(`/mensajes/${convId}`, buyer)).text(), /CowFace resolvió la solicitud de ayuda: La tienda respondió/);
  assert.doesNotMatch(await (await get('/admin', admin)).text(), /Ayuda solicitada/);

  // Solo las partes piden ayuda; solo el admin responde y resuelve.
  const otra = await signup('otra@test.cr', 'Otra');
  assert.equal((await post(`/mensajes/${convId}/ayuda`, otra, { body: 'Quiero meterme en esta conversación.' })).status, 404);
  assert.equal((await post(`/admin/conversaciones/${convId}/mensaje`, buyer, { body: 'Soy admin' })).status, 403);
});

test('la garantía aparece en el artículo, "Cómo funciona" y los términos', async () => {
  assert.match(await (await get(`/p/${productId}`, buyer)).text(), /Garantía CowFace:<\/strong> si hay un problema con tu compra, nos hacemos cargo/);
  assert.match(await (await get('/como-funciona')).text(), /CowFace se hace cargo/);
  assert.match(await (await get('/terminos')).text(), /Garantía CowFace:<\/strong> si hay un problema con una compra, CowFace se hace cargo/);
});
