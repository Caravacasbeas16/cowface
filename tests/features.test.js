// Experiencia del vendedor (borradores, medidas, envío, edición rápida), adjuntos en el chat,
// totales con envío y comprobantes, avisos de búsquedas guardadas y páginas de ayuda.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLO, adminLogin, ctx, db, flashOf, get, photoOf, post, productIdFrom, publish, setSetting, signup, signupSeller,
  startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { default: sharp } = await import('sharp');

process.env.MAIL_TEST_OUTBOX = '1';
before(startServer);
after(stopServer);

let seller;
let buyer;
let admin;
let outsider;
let sellerId;
let receipt = 700000000;

const lastOrder = () => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
const multipart = (url, cookie, fields, files = []) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  for (const f of files) body.append(f.field, new Blob([f.data], { type: f.type }), f.name);
  return fetch(`${ctx.base}${url}`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
};
const pngWithGps = await sharp({ create: { width: 500, height: 400, channels: 3, background: '#0a0' } })
  .png().withMetadata({ exif: { IFD0: { Artist: 'Comprador', Make: 'Phone' } } }).toBuffer();

test('preparación', async () => {
  seller = await signupSeller('vende@test.cr', 'Vendedora');
  buyer = await signup('compra@test.cr', 'Comprador', '8777-0000');
  outsider = await signup('fuera@test.cr', 'Fuera', '8666-0000');
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'vende@test.cr'").get().id;
});

// ---------- Vendedor ----------

test('borrador: se guarda sin fotos, nadie más lo ve, y se publica después con foto', async () => {
  const res = await publish(seller, { ...POLO, title: 'Borrador secreto Supreme', action: 'borrador' });
  assert.equal(res.status, 302);
  const id = Number(res.headers.get('location').match(/productos\/(\d+)\/editar/)[1]);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'borrador');
  assert.equal((await get(`/p/${id}`, buyer)).status, 404, 'un comprador no lo ve');
  assert.equal((await get(`/p/${id}`, seller)).status, 200, 'la dueña sí');
  assert.doesNotMatch(await (await get('/buscar?q=supreme')).text(), /Borrador secreto/);
  assert.equal((await post(`/p/${id}/mensaje`, buyer, { body: 'hola' })).status, 404, 'no se puede escribir sobre un borrador');

  const noPhoto = await multipart(`/vendedor/productos/${id}/editar`, seller, { ...POLO, title: 'Borrador secreto Supreme', action: 'publicar' });
  assert.equal(noPhoto.status, 400, 'para publicar necesita foto');
  const ok = await multipart(`/vendedor/productos/${id}/editar`, seller, { ...POLO, title: 'Borrador secreto Supreme', action: 'publicar' },
    [{ field: 'photos', ...photoOf() }]);
  assert.equal(ok.headers.get('location'), `/p/${id}?publicado=1`);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'disponible');
});

test('medidas y pick up se guardan; el artículo no muestra costo de envío ni total con envío', async () => {
  const res = await publish(seller, { ...POLO, title: 'Hoodie con medidas', category: 'ropa', m_pecho: '58,5', m_largo: '72', meetup: '' },
    [photoOf()]);
  const id = productIdFrom(res);
  const p = db.prepare('SELECT measurements, meetup FROM products WHERE id = ?').get(id);
  assert.deepEqual(JSON.parse(p.measurements), { pecho: 58.5, largo: 72 });
  assert.equal(p.meetup, 0);
  const page = await (await get(`/p/${id}`, buyer)).text();
  assert.match(page, /58\.5 cm/);
  assert.match(page, /Correos de Costa Rica o Uber Flash/);
  assert.match(page, /la tienda te cotiza el envío/);
  assert.doesNotMatch(page, /Pick up en/, 'sin pick up activado');
  assert.doesNotMatch(page, /Total<\/span>/, 'no hay total antes de elegir la entrega');
  assert.doesNotMatch(await (await get('/vendedor/productos/nuevo', seller)).text(), /name="shipping_cost"/, 'publicar ya no pide el envío');

  const bad = await publish(seller, { ...POLO, m_pecho: 'mucho' }, [photoOf()]);
  assert.match(await bad.text(), /centímetros/);
});

test('edición rápida de precio y cantidad; cantidad 0 lo marca vendido', async () => {
  const id = productIdFrom(await publish(seller, POLO, [photoOf()]));
  await post(`/vendedor/productos/${id}/rapido`, seller, { price: '19.000', quantity: '3' });
  assert.deepEqual({ ...db.prepare('SELECT price, quantity, status FROM products WHERE id = ?').get(id) }, { price: 19000, quantity: 3, status: 'disponible' });
  await post(`/vendedor/productos/${id}/rapido`, seller, { price: '19000', quantity: '0' });
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'vendido');
  assert.equal((await post(`/vendedor/productos/${id}/rapido`, buyer, { price: '1', quantity: '1' })).status, 404);
});

// ---------- Chat ----------

test('fotos y PDF en el chat: privados, sin metadatos, y el texto pasa por el filtro', async () => {
  const id = productIdFrom(await publish(seller, POLO, [photoOf()]));
  const first = await post(`/p/${id}/mensaje`, buyer, { body: '¿Me mandas foto de la etiqueta?' });
  const convId = Number(first.headers.get('location').split('/').pop());

  const photo = await multipart(`/mensajes/${convId}/adjunto`, seller, { body: 'Aquí está' }, [{ field: 'file', data: pngWithGps, type: 'image/png', name: 'etiqueta.png' }]);
  assert.equal(photo.status, 302);
  const msg = db.prepare('SELECT * FROM messages WHERE attachment IS NOT NULL ORDER BY id DESC').get();
  assert.equal(msg.attachment_type, 'imagen');
  assert.equal(msg.body, 'Aquí está');

  const asBuyer = await get(`/adjuntos/${msg.attachment}`, buyer);
  assert.equal(asBuyer.status, 200);
  assert.equal((await sharp(Buffer.from(await asBuyer.arrayBuffer())).metadata()).exif, undefined, 'sin metadatos');
  assert.equal((await get(`/adjuntos/${msg.attachment}`, outsider)).status, 404, 'otra persona no puede verla');
  assert.equal((await get(`/adjuntos/${msg.attachment}`)).status, 404, 'sin sesión tampoco');
  assert.equal((await get(`/fotos/../attachments/${msg.attachment}`)).status, 404);

  const pdf = await multipart(`/mensajes/${convId}/adjunto`, buyer, {}, [{ field: 'file', data: Buffer.from('%PDF-1.4\n%prueba'), type: 'application/pdf', name: 'comprobante.pdf' }]);
  assert.equal(pdf.status, 302);
  const pdfMsg = db.prepare('SELECT attachment FROM messages WHERE attachment_type = ? ORDER BY id DESC').get('pdf');
  assert.match((await get(`/adjuntos/${pdfMsg.attachment}`, seller)).headers.get('content-disposition'), /attachment/);

  const fake = await multipart(`/mensajes/${convId}/adjunto`, buyer, {}, [{ field: 'file', data: Buffer.from('MZ'), type: 'application/pdf', name: 'x.pdf' }]);
  assert.match(flashOf(fake), /no es una foto o PDF válido/);
  const blocked = await multipart(`/mensajes/${convId}/adjunto`, buyer, { body: 'mi whatsapp es este' }, [{ field: 'file', data: pngWithGps, type: 'image/png', name: 'a.png' }]);
  assert.match(flashOf(blocked), /whatsapp/i);
  assert.equal((await multipart(`/mensajes/${convId}/adjunto`, outsider, {}, [{ field: 'file', data: pngWithGps, type: 'image/png', name: 'a.png' }])).status, 404);
});

// ---------- Pedidos ----------

test('envío cotizado por la tienda, captura del SINPE, guía de envío y evidencia del reclamo', async () => {
  const id = productIdFrom(await publish(seller, { ...POLO, price: '20000' }, [photoOf()]));
  await post(`/p/${id}/comprar`, buyer);
  let o = lastOrder();
  assert.deepEqual([o.shipping_cost, o.total, o.payout_amount], [0, 20000, 20000 - 400]);

  // El comprador pide Correos; la tienda cotiza ₡3 000; recién ahí paga y sube la captura.
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'correos', address: 'Heredia centro, casa azul' });
  await post(`/pedidos/${o.id}/cotizar`, seller, { method: 'correos', cost: '3000' });
  o = lastOrder();
  assert.deepEqual([o.shipping_cost, o.total, o.payout_amount], [3000, 23000, 20000 - 400 + 3000]);
  const paid = await multipart(`/pedidos/${o.id}/pago`, buyer,
    { payer_name: 'Compradora', address: 'Heredia centro, casa azul', phone: '8777-0000' },
    [{ field: 'comprobante', data: pngWithGps, type: 'image/png', name: 'sinpe.png' }]);
  assert.equal(paid.status, 302);
  o = lastOrder();
  assert.ok(o.payment_proof, 'se guardó la captura');
  assert.equal(o.total, 23000);
  assert.equal((await get(`/adjuntos/${o.payment_proof}`, admin)).status, 200, 'el admin ve la captura');
  assert.equal((await get(`/adjuntos/${o.payment_proof}`, outsider)).status, 404);
  assert.match(await (await get('/admin', admin)).text(), /debe entrar <strong>₡23\s?000/);

  await post(`/admin/pedidos/${o.id}/confirmar-pago`, admin);
  assert.match(flashOf(await post(`/pedidos/${o.id}/enviado`, seller, {})), /foto del envío/);
  await multipart(`/pedidos/${o.id}/enviado`, seller, {}, [{ field: 'comprobante', data: pngWithGps, type: 'image/png', name: 'guia.png' }]);
  o = lastOrder();
  assert.equal(o.status, 'enviado');
  assert.ok(o.shipping_proof);

  await multipart(`/pedidos/${o.id}/reclamo`, buyer, { reason: 'Llegó con una mancha que no se mencionó.' },
    [{ field: 'comprobante', data: pngWithGps, type: 'image/png', name: 'mancha.png' }]);
  o = lastOrder();
  assert.equal(o.status, 'en_disputa');
  assert.ok(o.dispute_evidence);
  const convPage = await (await get(`/admin/conversaciones/${o.conversation_id}`, admin)).text();
  assert.match(convPage, /Evidencia del reclamo/);
  assert.equal((await get(`/admin/conversaciones/${o.conversation_id}`, buyer)).status, 403);
});

test('pick up no cobra envío y se paga sin esperar cotización; si la tienda no lo ofrece, se rechaza', async () => {
  const id = productIdFrom(await publish(seller, { ...POLO, price: '15000' }, [photoOf()]));
  await post(`/p/${id}/comprar`, buyer);
  const o = lastOrder();
  await post(`/pedidos/${o.id}/entrega`, buyer, { method: 'pick_up' });
  await post(`/pedidos/${o.id}/pago`, buyer, { reference: String(++receipt), phone: '8777-0000' });
  assert.deepEqual(Object.values(db.prepare('SELECT shipping_cost, total, payout_amount, delivery_method FROM orders WHERE id = ?').get(o.id)), [0, 15000, 15000 - 300, 'pick_up']);
  assert.ok(db.prepare('SELECT payment_reported_at FROM orders WHERE id = ?').get(o.id).payment_reported_at);

  const noMeet = productIdFrom(await publish(seller, { ...POLO, meetup: '' }, [photoOf()]));
  await post(`/p/${noMeet}/comprar`, buyer);
  const o2 = lastOrder();
  const res = await post(`/pedidos/${o2.id}/entrega`, buyer, { method: 'pick_up' });
  assert.match(flashOf(res), /no ofrece pick up/);
  await post(`/pedidos/${o2.id}/cancelar`, buyer);
  await post(`/pedidos/${o.id}/cancelar`, buyer).catch(() => {});
});

// ---------- Avisos ----------

test('avisos: guardar una búsqueda y recibir un correo cuando se publica algo que coincide', async () => {
  const saved = await post('/avisos', buyer, { query: 'categoria=zapatos&talla=US+9' });
  assert.match(flashOf(saved), /te avisamos por correo/i);
  assert.match(await (await get('/vendedor/compras', buyer)).text(), /Zapatos · talla US 9/);

  const before = outbox.length;
  await publish(seller, { ...POLO, title: 'Camisa que no coincide' }, [photoOf()]);
  await publish(seller, { ...POLO, title: 'Jordan 1 Chicago', category: 'zapatos', item_type: 'Tenis', size: 'US 9' }, [photoOf()]);
  await new Promise((r) => setTimeout(r, 300));
  const mails = outbox.slice(before);
  assert.equal(mails.length, 1, 'un solo correo, solo por lo que coincide');
  assert.equal(mails[0].to, 'compra@test.cr');
  assert.match(mails[0].subject, /Jordan 1 Chicago/);

  await publish(seller, { ...POLO, title: 'Jordan 4', category: 'zapatos', item_type: 'Tenis', size: 'US 9' }, [photoOf()]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outbox.length, before + 1, 'como máximo un aviso cada 6 horas por búsqueda');

  const s = db.prepare('SELECT id FROM saved_searches LIMIT 1').get();
  await post(`/vendedor/avisos/${s.id}/borrar`, buyer);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_searches').get().n, 0);
});

// ---------- Comprador y ayuda ----------

test('búsqueda: filtros activos removibles; sin resultados sugiere categorías y no muestra el orden', async () => {
  const page = await (await get('/buscar?categoria=ropa&talla=M&talla=L')).text();
  assert.match(page, /href="\/buscar\?categoria=ropa&amp;talla=L"[^>]*>Talla M/);
  assert.match(page, /Avísame cuando haya/);

  const empty = await (await get('/buscar?categoria=bolsos')).text();
  assert.match(empty, /Todavía no hay/);
  assert.doesNotMatch(empty, /<select name="orden"/);
  assert.match(empty, /href="\/buscar\?categoria=ropa"/, 'sugiere una categoría con artículos');
});

test('términos y "cómo funciona" describen el mismo flujo, con plazos', async () => {
  setSetting('auto_release_days', '5');
  const terms = await (await get('/terminos')).text();
  assert.match(terms, /gestionar el pago de cada venta/);
  assert.match(terms, /<strong>5 días después<\/strong>/);
  assert.match(terms, /costo del envío de devolución lo asume el vendedor/);
  assert.doesNotMatch(terms, /no participa en el pago/);
  const how = await (await get('/como-funciona')).text();
  assert.match(how, /2 días hábiles/);
  assert.match(how, /Qué pasa si el paquete se atrasa/);
  setSetting('auto_release_days', '3');
});

test('pdf.js se sirve desde el propio sitio para importar fotos desde PDF', async () => {
  const res = await get('/vendor/pdfjs/build/pdf.min.mjs');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal((await get('/vendor/pdfjs/../package.json')).status, 404);
  assert.match(await (await get('/vendedor/productos/nuevo', seller)).text(), /Importar desde PDF/);
});
