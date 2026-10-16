// Espacio del volumen en /admin: cuánto ocupan las fotos y demás, cuánto queda, y el correo al
// admin al pasar el 80 %, 90 % y 95 % (una vez por nivel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adminLogin, db, flashOf, get, post, setSetting, signup, startServer, stopServer } from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { checkDiskAlert, refreshDisk } = await import('../src/disk.js');

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

let admin;
const MB = 1024 ** 2;
const wait = () => new Promise((r) => setTimeout(r, 100));

test('el admin ve el espacio usado, por partes, y cuánto queda', async () => {
  admin = await adminLogin();
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['espacio'] });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'grande.jpg'), Buffer.alloc(3 * MB));
  let res = await post('/admin/espacio', admin, { volume_gb: '1' });
  assert.match(flashOf(res), /Tamaño del volumen: 1 GB/);
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /<section id="espacio">/);
  assert.match(page, /usados de <strong>1\.00 GB<\/strong>/);
  assert.match(page, /Fotos de artículos<\/td><td>3 MB/);
  assert.match(page, /name="volume_gb"[^>]*value="1"/);

  res = await post('/admin/espacio', admin, { volume_gb: 'mucho' });
  assert.match(flashOf(res), /Escribe el tamaño en GB/);
  const user = await signup('cliente@test.cr', 'Cliente');
  assert.equal((await post('/admin/espacio', user, { volume_gb: '1' })).status, 403);
});

test('al pasar el 80 % y el 90 % llega un correo, una sola vez por nivel', async () => {
  // Tamaño del volumen para quedar en ~85 % (y luego ~94 %) de lo que ya se usa.
  const used = (await refreshDisk()).used;
  const gbFor = (pct) => String(used / (pct / 100) / 1024 ** 3);
  setSetting('volume_gb', gbFor(85));
  const from = outbox.length;
  assert.equal(await checkDiskAlert(), 80);
  assert.equal(await checkDiskAlert(), null, 'no se repite');
  await wait();
  const mails = outbox.slice(from).filter((m) => m.to === 'yo@test.cr');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /El espacio va en 8\d %/);
  assert.match(mails[0].text, /Volume Size/);
  assert.match(await (await get('/admin', admin)).text(), /El volumen se está llenando/);

  setSetting('volume_gb', gbFor(94));
  assert.equal(await checkDiskAlert(), 90);

  // Al agrandarlo (bajar de 75 %) se reinicia y vuelve a avisar si se llena otra vez.
  setSetting('volume_gb', '1');
  assert.equal(await checkDiskAlert(), null);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'disk_alert_level'").get().value, '0');
  const s = await refreshDisk();
  assert.ok(s.free > 1000 * MB && s.percent < 5);
});
