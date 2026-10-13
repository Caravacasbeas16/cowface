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

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

export const POLO = {
  title: 'Camisa polo azul', brand: 'Lacoste', category: 'ropa', department: 'hombre', item_type: 'Camisas polo',
  size: 'M', color: 'Azul', condition: 'nuevo', price: '₡25.000', quantity: 1, description: '',
};

export const get = (url, cookie = '') => fetch(`${ctx.base}${url}`, { headers: { cookie }, redirect: 'manual' });

export const post = (url, cookie = '', data = {}, json = false) => fetch(`${ctx.base}${url}`, {
  method: 'POST', redirect: 'manual', body: form(data),
  headers: { cookie, ...(json ? { Accept: 'application/json' } : {}) },
});

export async function signup(email, name, phone = '8888-1234') {
  const res = await post('/registro', '', { name, store_name: '', email, phone, province: 'Heredia', password: 'clave-segura-1' });
  assert.equal(res.status, 302, 'el registro redirige');
  return res.headers.get('set-cookie').split(';')[0];
}

// Registra un vendedor con sus datos para recibir pagos.
export async function signupSeller(email, name, phone = '8888-1234') {
  const cookie = await signup(email, name, phone);
  const res = await post('/vendedor/pagos', cookie, { payout_phone: phone, payout_name: name });
  assert.equal(res.status, 302);
  return cookie;
}

export async function publish(cookie, fields, files = []) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  for (const f of files) body.append('photos', new Blob([f.data], { type: f.type }), f.name);
  return fetch(`${ctx.base}/vendedor/productos/nuevo`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' });
}

export async function publishPolo(cookie, extra = {}) {
  const res = await publish(cookie, { ...POLO, ...extra });
  assert.equal(res.status, 302, 'publicó');
  return Number(res.headers.get('location').split('/').pop());
}

export async function adminLogin() {
  db.prepare("INSERT OR IGNORE INTO users (role, name, email, password_hash) VALUES ('admin', 'Admin', 'admin@test.cr', ?)")
    .run(hashPassword('clave-admin-123'));
  const res = await post('/entrar', '', { email: 'admin@test.cr', password: 'clave-admin-123' });
  assert.equal(res.headers.get('location'), '/admin');
  return res.headers.get('set-cookie').split(';')[0];
}

export const flashOf = (res) => decodeURIComponent((res.headers.get('set-cookie') || '').match(/flash=([^;]*)/)?.[1] || '');
