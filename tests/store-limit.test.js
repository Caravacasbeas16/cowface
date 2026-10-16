// Cupo de tiendas: de entrada 10 aprobadas. Al llenarse, las solicitudes quedan en lista de espera
// y el admin no puede aprobar ni crear más hasta subir el cupo (0 = sin límite).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, db, flashOf, get, post, signup, startServer, stopServer } from './helpers.js';

before(startServer);
after(stopServer);

let admin;
let applicant;
let applicantId;

const pending = async (email, store) => {
  const cookie = await signup(email, store);
  const id = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  db.prepare("UPDATE users SET seller_status = 'pendiente', store_name = ?, seller_request = '{}', payout_phone = '88881234', payout_name = ? WHERE id = ?").run(store, store, id);
  return { cookie, id };
};

test('preparación: 10 tiendas aprobadas llenan el cupo', async () => {
  admin = await adminLogin();
  // Directo en la base: el registro solo deja 5 por hora desde la misma conexión.
  const add = db.prepare("INSERT INTO users (role, name, store_name, email, password_hash, seller_status) VALUES ('usuario', ?, ?, ?, 'x', 'aprobado')");
  for (let i = 1; i <= 10; i++) add.run(`Tienda ${i}`, `Tienda ${i}`, `t${i}@test.cr`);
  ({ cookie: applicant, id: applicantId } = await pending('espera@test.cr', 'Tienda en espera'));
  const page = await (await get('/admin/tiendas', admin)).text();
  assert.match(page, /Tiendas aprobadas: 10 de 10/);
  assert.match(page, /Cupo lleno/);
});

test('con el cupo lleno no se aprueba ni se crea otra tienda', async () => {
  const res = await post(`/admin/tiendas/${applicantId}/aprobar`, admin, { back: '/admin/tiendas?tab=pendientes' });
  assert.match(flashOf(res), /el cupo es de 10/);
  assert.equal(db.prepare('SELECT seller_status FROM users WHERE id = ?').get(applicantId).seller_status, 'pendiente');

  const create = await post('/admin/tiendas/nueva', admin, { name: 'Ana Nueva', email: 'creada@test.cr', phone: '8888-1234', province: 'Heredia' });
  assert.equal(create.status, 400);
  assert.match(await create.text(), /el cupo es de 10/);
});

test('la tienda que espera ve que está en lista de espera', async () => {
  assert.match(await (await get('/vendedor/solicitud', applicant)).text(), /lista de espera/);
});

test('subir el cupo deja aprobar; 0 es sin límite; solo el admin lo cambia', async () => {
  assert.match(flashOf(await post('/admin/tiendas/limite', admin, { limit: '-3' })), /Escribe un número/);
  assert.equal((await post('/admin/tiendas/limite', applicant, { limit: '0' })).status, 403);

  assert.match(flashOf(await post('/admin/tiendas/limite', admin, { limit: '11' })), /Cupo de tiendas: 11/);
  await post(`/admin/tiendas/${applicantId}/aprobar`, admin);
  assert.equal(db.prepare('SELECT seller_status FROM users WHERE id = ?').get(applicantId).seller_status, 'aprobado');

  const next = await pending('otra@test.cr', 'Otra más');
  assert.match(flashOf(await post(`/admin/tiendas/${next.id}/aprobar`, admin)), /el cupo es de 11/);
  assert.match(flashOf(await post('/admin/tiendas/limite', admin, { limit: '0' })), /Sin límite/);
  await post(`/admin/tiendas/${next.id}/aprobar`, admin);
  assert.equal(db.prepare('SELECT seller_status FROM users WHERE id = ?').get(next.id).seller_status, 'aprobado');
  assert.match(await (await get('/admin/tiendas', admin)).text(), /Sin límite de tiendas/);
});
