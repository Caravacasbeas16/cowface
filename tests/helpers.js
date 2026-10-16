// Utilidades de prueba: base de datos temporal, servidor en un puerto libre y atajos HTTP.
// Cada archivo de prueba corre en su propio proceso, así que cada uno tiene su propia base.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cowface-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

export const { createApp } = await import('../src/app.js');
export const { db, setSetting } = await import('../src/db.js');
// Las pruebas calculan con 2 % (sus montos están escritos así); el sitio cobra 5 % (ver commission.test.js).
setSetting('commission_rate', '0.02');
export const { hashPassword } = await import('../src/auth.js');

export const ctx = { base: '' };
let server;

export async function startServer() {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  ctx.base = `http://localhost:${server.address().port}`;
}

export function stopServer() {
  server.closeAllConnections();
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

export const form = (obj) => new URLSearchParams(obj);

// Imágenes reales (los artículos necesitan fotos de al menos 300 px).
const { default: sharp } = await import('sharp');
export const PNG = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#336699' } }).png().toBuffer();
export const photoOf = (type = 'image/png') => ({ data: PNG, type, name: 'foto.png' });

export const POLO = {
  title: 'Camisa polo azul', brand: 'Lacoste', category: 'ropa', department: 'hombre', item_type: 'Camisas polo',
  size: 'M', color: 'Azul', condition: 'nuevo', price: '₡25.000', quantity: 1, description: '', meetup: '1',
};

export const get = (url, cookie = '') => fetch(`${ctx.base}${url}`, { headers: { cookie }, redirect: 'manual' });

// Deja la entrega de un pedido ya definida (como si la tienda la hubiera cotizado), para las pruebas
// que no son de la entrega. Las de la entrega usan /entrega y /cotizar (ver delivery.test.js).
const LEGACY = { en_persona: 'pick_up', mensajero: 'uber_flash' };
export function quoted(orderId, method = 'correos', cost = 0) {
  const m = LEGACY[method] || method;
  db.prepare(`UPDATE orders SET delivery_method = ?, delivery_requested = ?, delivery_quote_at = datetime('now'),
    shipping_cost = ?, total = price + ?, payout_amount = price - commission_amount + ? WHERE id = ? AND delivery_quote_at IS NULL`)
    .run(m, m, cost, cost, cost, orderId);
}

// Una captura del SINPE distinta cada vez (la misma captura no sirve para dos pedidos).
let shade = 0;
export const proofImage = () => {
  shade += 1;
  return sharp({ create: { width: 320, height: 320, channels: 3, background: { r: shade % 256, g: (shade >> 8) % 256, b: 120 } } }).png().toBuffer();
};

// Aviso de pago como lo manda el formulario: nombre de quien pagó y la captura (obligatoria).
// data.proof: una captura dada (Buffer) o false para no mandar ninguna.
async function payWith(url, cookie, data) {
  const body = new FormData();
  const { proof, ...fields } = data;
  if (!fields.payer_name) fields.payer_name = 'Persona de prueba';
  delete fields.reference;
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  if (proof !== false) body.append('comprobante', new Blob([proof || await proofImage()], { type: 'image/png' }), 'sinpe.png');
  return fetch(`${ctx.base}${url}`, { method: 'POST', redirect: 'manual', body, headers: { cookie } });
}

export const post = (url, cookie = '', data = {}, json = false) => {
  const pay = url.match(/^\/pedidos\/(\d+)\/pago$/);
  if (pay && data.method) quoted(Number(pay[1]), data.method);
  if (pay) return payWith(url, cookie, data);
  return fetch(`${ctx.base}${url}`, {
    method: 'POST', redirect: 'manual', body: form(data),
    headers: { cookie, ...(json ? { Accept: 'application/json' } : {}) },
  });
};

export async function signup(email, name, phone = '8888-1234') {
  const res = await post('/registro', '', { name, store_name: '', email, phone, province: 'Heredia', password: 'clave-segura-1' });
  assert.equal(res.status, 302, 'el registro redirige');
  return res.headers.get('set-cookie').split(';')[0];
}

// Registra un vendedor con sus datos para recibir pagos y su tienda aprobada.
export async function signupSeller(email, name, phone = '8888-1234') {
  const cookie = await signup(email, name, phone);
  const res = await post('/vendedor/pagos', cookie, { payout_phone: phone, payout_name: name });
  assert.equal(res.status, 302);
  // Tienda ya aprobada por el admin (la aprobación se prueba aparte, en approval.test.js).
  db.prepare("UPDATE users SET seller_status = 'aprobado' WHERE email = ?").run(email);
  return cookie;
}

export async function publish(cookie, fields, files = []) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  for (const f of files) body.append('photos', new Blob([f.data], { type: f.type }), f.name);
  return fetch(`${ctx.base}/vendedor/productos/nuevo`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
}

export async function publishPolo(cookie, extra = {}) {
  const res = await publish(cookie, { ...POLO, ...extra }, [photoOf()]);
  assert.equal(res.status, 302, 'publicó');
  return productIdFrom(res);
}

// Número de artículo en la redirección después de publicar ("/p/12?publicado=1").
export const productIdFrom = (res) => Number((res.headers.get('location') || '').match(/\/p\/(\d+)/)?.[1]);

export async function adminLogin() {
  db.prepare("INSERT OR IGNORE INTO users (role, name, email, password_hash) VALUES ('admin', 'Admin', 'admin@test.cr', ?)")
    .run(hashPassword('clave-admin-123'));
  const res = await post('/entrar', '', { email: 'admin@test.cr', password: 'clave-admin-123' });
  assert.equal(res.headers.get('location'), '/admin');
  return res.headers.get('set-cookie').split(';')[0];
}

export const flashOf = (res) => decodeURIComponent((res.headers.get('set-cookie') || '').match(/flash=([^;]*)/)?.[1] || '');

// El vendedor marca un envío como enviado con la foto (obligatoria para envíos).
export function shipWithPhoto(cookie, orderId, note = '') {
  const body = new FormData();
  if (note) body.append('note', note);
  body.append('comprobante', new Blob([PNG], { type: 'image/png' }), 'guia.png');
  return fetch(`${ctx.base}/pedidos/${orderId}/enviado`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
}
