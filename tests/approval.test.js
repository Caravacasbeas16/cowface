// Aprobación de tiendas: para vender hay que pedirlo y el admin aprueba; comprar no lo necesita.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLO, adminLogin, db, flashOf, get, photoOf, post, publish, publishPolo, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');

process.env.MAIL_TEST_OUTBOX = '1';
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

let admin;
let nueva;
let nuevaId;
const status = (id) => db.prepare('SELECT seller_status FROM users WHERE id = ?').get(id).seller_status;
const products = (id) => db.prepare('SELECT title, status FROM products WHERE seller_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/notificaciones', admin, { email: 'yo@test.cr', events: ['tienda'] });
  nueva = await signup('nueva@test.cr', 'Ana Nueva');
  nuevaId = db.prepare("SELECT id FROM users WHERE email = 'nueva@test.cr'").get().id;
});

test('para publicar: primero el SINPE, después la solicitud de tienda', async () => {
  assert.equal((await get('/vendedor/productos/nuevo', nueva)).headers.get('location'), '/vendedor/pagos?next=publicar');
  await post('/vendedor/pagos', nueva, { payout_phone: '8811-2233', payout_name: 'Ana Nueva', next: 'publicar' });
  assert.equal((await get('/vendedor/productos/nuevo', nueva)).headers.get('location'), '/vendedor/solicitud');
  const page = await (await get('/vendedor/solicitud', nueva)).text();
  assert.match(page, /revisamos cada tienda antes de que pueda publicar/);
  // Tampoco se puede publicar mandando el formulario directo.
  const direct = await publish(nueva, POLO, [photoOf()]);
  assert.equal(direct.headers.get('location'), '/vendedor/solicitud');
  assert.equal(products(nuevaId).length, 0);
});

test('la solicitud valida los datos, avisa al admin y queda en revisión', async () => {
  const bad = await post('/vendedor/solicitud', nueva, { store_name: '', instagram: 'no válido!', about: 'ropa' });
  assert.equal(bad.status, 400);
  const html = await bad.text();
  assert.match(html, /nombre de tu tienda/i);
  assert.match(html, /Solo el usuario/);

  const from = outbox.length;
  const ok = await post('/vendedor/solicitud', nueva, { store_name: 'Closet de Ana', instagram: '@closetdeana', about: 'Ropa americana de segunda mano, jeans y chaquetas.' });
  assert.match(flashOf(ok), /Recibimos tu solicitud/);
  assert.equal(status(nuevaId), 'pendiente');
  await new Promise((r) => setTimeout(r, 100));
  const mail = outbox.slice(from).find((m) => m.to === 'yo@test.cr');
  assert.match(mail.subject, /Tienda por aprobar: Closet de Ana/);
  assert.match(mail.text, /Instagram: @closetdeana/);
  assert.match(await (await get('/vendedor/solicitud', nueva)).text(), /Tu tienda está en revisión/);
});

test('en revisión puede guardar borradores, pero no publicar', async () => {
  const form = await (await get('/vendedor/productos/nuevo', nueva)).text();
  assert.match(form, /Tu tienda está en revisión/);
  assert.doesNotMatch(form, /value="publicar"/, 'no hay botón de publicar');
  const res = await publish(nueva, { ...POLO, title: 'Jeans de prueba', action: 'publicar' }, [photoOf()]);
  assert.equal(res.status, 302);
  assert.match(flashOf(res), /cuando aprobemos tu tienda/);
  assert.deepEqual(products(nuevaId), [{ title: 'Jeans de prueba', status: 'borrador' }], 'aunque pida publicar, queda como borrador');
  assert.doesNotMatch(await (await get('/buscar?q=jeans')).text(), /Jeans de prueba/);
});

test('el admin la ve en "Por hacer", la aprueba y a la tienda le llega el correo', async () => {
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /Tiendas por aprobar/);
  assert.match(page, /Closet de Ana/);
  assert.match(page, /instagram\.com\/closetdeana/);
  assert.match(page, /1 borrador listos/);
  assert.match(await (await get('/', admin)).text(), /Admin<span class="badge" >1</, 'cuenta como tarea pendiente');

  const from = outbox.length;
  assert.match(flashOf(await post(`/admin/tiendas/${nuevaId}/aprobar`, admin)), /aprobada/);
  assert.equal(status(nuevaId), 'aprobado');
  const mail = outbox.slice(from).find((m) => m.to === 'nueva@test.cr');
  assert.match(mail.subject, /fue aprobada/);
  assert.match(mail.text, /\/vendedor\/productos\/nuevo/);

  // Ya puede publicar, también sus borradores.
  const draftId = db.prepare('SELECT id FROM products WHERE seller_id = ?').get(nuevaId).id;
  const pub = await (async () => {
    const body = new FormData();
    for (const [k, v] of Object.entries({ ...POLO, title: 'Jeans de prueba', action: 'publicar' })) body.append(k, String(v));
    body.append('photos', new Blob([photoOf().data], { type: 'image/png' }), 'f.png');
    const { ctx } = await import('./helpers.js');
    return fetch(`${ctx.base}/vendedor/productos/${draftId}/editar`, { method: 'POST', body, headers: { cookie: nueva }, redirect: 'manual' });
  })();
  assert.equal(pub.headers.get('location'), `/p/${draftId}?publicado=1`);
  assert.equal(products(nuevaId)[0].status, 'disponible');
});

test('rechazar manda el motivo; la tienda puede corregir y volver a pedir', async () => {
  const otra = await signup('otra@test.cr', 'Otra Persona');
  const otraId = db.prepare("SELECT id FROM users WHERE email = 'otra@test.cr'").get().id;
  await post('/vendedor/pagos', otra, { payout_phone: '8822-3344', payout_name: 'Otra Persona' });
  await post('/vendedor/solicitud', otra, { store_name: 'Réplicas Baratas', about: 'Vendo réplicas de marcas famosas.' });
  const from = outbox.length;
  await post(`/admin/tiendas/${otraId}/rechazar`, admin, { reason: 'No se permiten réplicas' });
  assert.equal(status(otraId), 'rechazado');
  assert.match(outbox.slice(from).find((m) => m.to === 'otra@test.cr').text, /Motivo: No se permiten réplicas/);
  const page = await (await get('/vendedor/solicitud', otra)).text();
  assert.match(page, /No pudimos aprobar tu solicitud anterior/);
  assert.match(page, /No se permiten réplicas/);
  await post('/vendedor/solicitud', otra, { store_name: 'Closet de Otra', about: 'Ropa original usada, en buen estado.' });
  assert.equal(status(otraId), 'pendiente');
  assert.equal((await post(`/admin/tiendas/${otraId}/aprobar`, otra)).status, 403, 'solo el admin aprueba');
});

test('quitar la aprobación pausa sus artículos y ya no puede volver a ponerlos a la venta', async () => {
  const seller = await signupSeller('tienda@test.cr', 'Tienda Vieja');
  const id = await publishPolo(seller, { title: 'Camisa a pausar' });
  const sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  await post(`/admin/tiendas/${sellerId}/quitar-aprobacion`, admin, {});
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'pausado');
  assert.match(flashOf(await post(`/vendedor/productos/${id}/estado`, seller, { status: 'disponible' })), /no está aprobada/);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'pausado');
  assert.match(await (await get('/vendedor', seller)).text(), /no está aprobada para vender/);
});

test('el admin puede apagar la aprobación; comprar nunca la necesitó; las tiendas que crea el admin ya vienen aprobadas', async () => {
  await post('/admin/aprobacion', admin, {});
  const libre = await signup('libre@test.cr', 'Libre');
  await post('/vendedor/pagos', libre, { payout_phone: '8833-4455', payout_name: 'Libre' });
  assert.equal((await get('/vendedor/productos/nuevo', libre)).status, 200);
  await post('/admin/aprobacion', admin, { on: '1' });

  const buyer = await signup('compra@test.cr', 'Compradora');
  const id = db.prepare("SELECT id FROM products WHERE status = 'disponible' ORDER BY id DESC").get().id;
  assert.equal((await post(`/p/${id}/mensaje`, buyer, { body: '¿Todavía la tienes?' })).status, 302, 'comprar y preguntar no piden aprobación');

  await post('/admin/tiendas/nueva', admin, { store_name: 'Creada por admin', name: 'Admin Store', email: 'creada@test.cr', phone: '8899-0011', province: 'Cartago' });
  assert.equal(db.prepare("SELECT seller_status FROM users WHERE email = 'creada@test.cr'").get().seller_status, 'aprobado');
});
