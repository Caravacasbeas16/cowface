// Tiempo de respuesta de la tienda, gráfico de ventas, oferta a quienes guardaron un artículo
// (como Grailed) y etiqueta de envío para imprimir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLogin, db, flashOf, get, post, publishPolo, quoted, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

before(startServer);
after(stopServer);

let admin;
let seller;
let buyer;
let sellerId;
const ids = {};

test('preparación', async () => {
  admin = await adminLogin();
  await post('/admin/pagos-config', admin, { phone: '6000-1111', holder: 'CowFace', window_hours: '24', release_days: '3' });
  seller = await signupSeller('tienda@test.cr', 'Closet Vintage');
  buyer = await signup('compra@test.cr', 'Compradora');
  sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  for (const k of ['a', 'b', 'c']) ids[k] = await publishPolo(seller, { title: `Camisa ${k}`, price: '₡20.000' });
});

test('tiempo de respuesta: con 3 conversaciones respondidas rápido, "Suele responder en menos de 1 h"', async () => {
  assert.doesNotMatch(await (await get(`/u/${sellerId}`)).text(), /Suele responder/, 'sin datos suficientes');
  for (const k of ['a', 'b', 'c']) {
    const res = await post(`/p/${ids[k]}/mensaje`, buyer, { body: '¿Todavía la tienes?' });
    const conv = res.headers.get('location').split('/').pop();
    await post(`/mensajes/${conv}`, seller, { body: 'Sí, todavía la tengo.' });
  }
  // La tienda guarda el cálculo 10 min; otra petición de otro proceso no aplica, así que se limpia por tiempo.
  const { replyTime } = await import('../src/presence.js');
  assert.equal(replyTime(sellerId, Date.now() + 11 * 60_000), 'Suele responder en menos de 1 h');
});

test('oferta a quienes guardaron el artículo: llega a su chat, una vez al día, y se puede aceptar', async () => {
  await post(`/p/${ids.a}/favorito`, buyer, {}, true);
  assert.match(await (await get('/vendedor/inventario', seller)).text(), /♥ 1 · Ofrecer/);
  assert.match(flashOf(await post(`/vendedor/productos/${ids.a}/oferta-favoritos`, seller, { amount: '25000' })), /menor al precio actual/);
  let res = await post(`/vendedor/productos/${ids.a}/oferta-favoritos`, seller, { amount: '17000' });
  assert.match(flashOf(res), /Oferta de ₡17\s?000 enviada a 1 persona/);
  const offer = db.prepare(`
    SELECT o.* FROM offers o JOIN conversations c ON c.id = o.conversation_id
    WHERE o.product_id = ? AND o.made_by = ? AND o.status = 'pendiente'
  `).get(ids.a, sellerId);
  assert.equal(offer.amount, 17000);
  res = await post(`/vendedor/productos/${ids.a}/oferta-favoritos`, seller, { amount: '16000' });
  assert.match(flashOf(res), /Ya enviaste una oferta/);
  assert.match(flashOf(await post(`/vendedor/productos/${ids.b}/oferta-favoritos`, seller, { amount: '15000' })), /Nadie ha guardado/);

  await post(`/ofertas/${offer.id}/aceptar`, buyer);
  const order = db.prepare('SELECT * FROM orders WHERE product_id = ?').get(ids.a);
  assert.equal(order.price, 17000);
  assert.equal(order.source, 'oferta');
});

test('etiqueta de envío: solo con el pago confirmado y solo para la tienda del pedido', async () => {
  const order = db.prepare('SELECT * FROM orders WHERE product_id = ?').get(ids.a);
  assert.equal((await get(`/vendedor/pedidos/${order.id}/etiqueta`, seller)).status, 404, 'todavía no está pagado');
  quoted(order.id, 'correos', 2500);
  await post(`/pedidos/${order.id}/pago`, buyer, { reference: '77889900', address: 'Heredia, San Pablo, 200 m sur de la iglesia', phone: '8777-1234' });
  await post(`/admin/pedidos/${order.id}/confirmar-pago`, admin);
  const label = await (await get(`/vendedor/pedidos/${order.id}/etiqueta`, seller)).text();
  assert.match(label, new RegExp(order.code));
  assert.match(label, /Compradora/);
  assert.match(label, /200 m sur de la iglesia/);
  assert.match(label, /87771234|8777-1234/);
  assert.match(label, /Closet Vintage/);
  assert.match(await (await get(`/mensajes/${order.conversation_id}`, seller)).text(), /Imprimir etiqueta de envío/);
  assert.match(await (await get('/vendedor/pedidos?tab=atender', seller)).text(), /Etiqueta de envío/);
  const other = await signupSeller('otra@test.cr', 'Otra Tienda');
  assert.equal((await get(`/vendedor/pedidos/${order.id}/etiqueta`, other)).status, 404);
});

test('inicio de la tienda: gráfico de ventas de las últimas 2 semanas', async () => {
  const page = await (await get('/vendedor', seller)).text();
  assert.match(page, /Ventas · últimas 2 semanas/);
  assert.match(page, /₡17\s?000 en 1 venta/);
  assert.equal((page.match(/class="spark-col"/g) || []).length, 14);
});

test('barra de abajo (celular), avance del pedido y orden "Más populares"', async () => {
  const guest = await (await get('/')).text();
  assert.match(guest, /class="tabbar"/);
  assert.match(guest, /href="\/entrar" class="[^"]*"><svg/);
  assert.match(await (await get('/buscar', buyer)).text(), /class="tabbar"[\s\S]*href="\/favoritos" class=""[\s\S]*href="\/vendedor"/);
  const order = db.prepare('SELECT * FROM orders WHERE product_id = ?').get(ids.a);
  const chat = await (await get(`/mensajes/${order.conversation_id}`, buyer)).text();
  assert.doesNotMatch(chat, /class="tabbar"/, 'el chat tiene su propio cuadro de texto abajo');
  assert.match(chat, /class="order-track"/);
  assert.equal((chat.match(/class="is-done"/g) || []).length, 3, 'pedido, envío cotizado y pagado');
  assert.match(chat, /class="is-current"><span class="dot-step" aria-hidden="true">4<\/span><span>Enviado/);

  await post(`/p/${ids.c}/favorito`, buyer, {}, true);
  const list = await (await get('/buscar?orden=populares')).text();
  assert.ok(list.indexOf('Camisa c') < list.indexOf('Camisa b'), 'el guardado va primero');
  assert.match(list, /Más populares/);
});
