// Cuándo se le paga a la tienda: mismo día si se completa un día hábil antes del corte (6 p. m. hora de
// Costa Rica); si es de noche o en fin de semana, el siguiente día hábil.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, flashOf, get, post, publishPolo, signup, signupSeller, startServer, stopServer } from './helpers.js';

const { payoutDay, payoutDayLabel, cutoffLabel } = await import('../src/payout-schedule.js');

// Hora de Costa Rica → ISO en UTC (CR = UTC−6).
const cr = (date, time) => new Date(`${date}T${time}:00-06:00`).toISOString();

test('de día y entre semana: se paga ese mismo día', () => {
  assert.equal(payoutDay(cr('2026-10-13', '15:00')), '2026-10-13'); // martes 3 p. m.
  assert.equal(payoutDay(cr('2026-10-13', '17:59')), '2026-10-13');
  assert.equal(payoutDay(cr('2026-10-13', '00:30')), '2026-10-13', 'madrugada: ya es el día hábil');
});

test('de noche: el siguiente día hábil', () => {
  assert.equal(payoutDay(cr('2026-10-13', '18:00')), '2026-10-14'); // martes 6 p. m. → miércoles
  assert.equal(payoutDay(cr('2026-10-13', '23:45')), '2026-10-14');
  assert.equal(payoutDay(cr('2026-10-16', '20:00')), '2026-10-19', 'viernes de noche → lunes');
});

test('fin de semana: el lunes', () => {
  assert.equal(payoutDay(cr('2026-10-17', '10:00')), '2026-10-19'); // sábado
  assert.equal(payoutDay(cr('2026-10-18', '16:00')), '2026-10-19'); // domingo
});

test('la hora de corte se puede cambiar', () => {
  assert.equal(payoutDay(cr('2026-10-13', '19:30'), 20), '2026-10-13');
  assert.equal(payoutDay(cr('2026-10-13', '20:00'), 20), '2026-10-14');
  assert.equal(cutoffLabel(18), '6 p. m.');
  assert.equal(cutoffLabel(12), '12 p. m.');
});

test('textos para la tienda: hoy, mañana o el día', () => {
  const now = Date.parse(cr('2026-10-13', '10:00'));
  assert.equal(payoutDayLabel('2026-10-13', now), 'hoy al final del día');
  assert.equal(payoutDayLabel('2026-10-14', now), 'mañana al final del día');
  assert.equal(payoutDayLabel('2026-10-19', now), 'el lunes 19 oct al final del día');
});

// ---------- En el sitio ----------

before(startServer);
after(stopServer);

test('el admin cambia la hora de corte y la regla aparece en términos; al completar, el chat dice cuándo se paga', async () => {
  const admin = await adminLogin();
  assert.match(flashOf(await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3', cutoff_hour: '9' })), /Hora de corte/);
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3', cutoff_hour: '19' });
  assert.match(await (await get('/terminos')).text(), /después de las 7 p\. m\. o en fin de semana, el siguiente día hábil/);
  assert.match(await (await get('/admin', admin)).text(), /<option value="19" selected>7 p\. m\.<\/option>/);

  const seller = await signupSeller('tienda@test.cr', 'Tienda');
  const buyer = await signup('compra@test.cr', 'Compradora');
  const id = await publishPolo(seller);
  await post(`/p/${id}/comprar`, buyer);
  const o = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: '12121212', method: 'pick_up', phone: '8777-0000' });
  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  await post(`/pedidos/${o.id}/recibido`, buyer);
  const note = db.prepare("SELECT body FROM messages WHERE conversation_id = ? AND kind = 'sistema' ORDER BY id DESC").get(o.conversation_id).body;
  assert.match(note, /Pago a la tienda \(ya con la comisión rebajada\): (hoy|mañana|el \w+ \d+ \w+) al final del día\./);
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /Pagar (hoy|mañana|el )/);
  assert.match(await (await get(`/mensajes/${o.conversation_id}`, seller)).text(), /CowFace te transfiere ₡24\s?500 por SINPE al 88881234 (hoy|mañana|el )/);
});
