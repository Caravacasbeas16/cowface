// Vista previa al compartir, respaldos y carga rápida de tiendas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  PNG, adminLogin, ctx, db, flashOf, get, post, publishPolo, setSetting, signup, signupSeller, startServer, stopServer,
} from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const backup = await import('../src/backup.js');
const { parseCsv, rowToBody } = await import('../src/bulk.js');
const { default: sharp } = await import('sharp');

process.env.MAIL_TEST_OUTBOX = '1';
// Correo "configurado" para que se ofrezcan los envíos; con MAIL_TEST_OUTBOX nada sale a internet.
process.env.MAIL_FROM = 'avisos@test.cr';
process.env.BREVO_API_KEY = 'prueba';
before(startServer);
after(stopServer);

let admin;
let seller;
const meta = (html, prop) => html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1];

test('preparación', async () => {
  admin = await adminLogin();
  seller = await signupSeller('tienda@test.cr', 'Tienda Uno');
});

// ---------- Vista previa ----------

test('al compartir un artículo se ve su foto, nombre, precio y talla', async () => {
  const id = await publishPolo(seller, { brand: 'Lacoste', size: 'M' });
  const html = await (await get(`/p/${id}`)).text();
  assert.match(meta(html, 'og:title'), /^Camisa polo azul · ₡25\s?000$/);
  assert.match(meta(html, 'og:description'), /Lacoste · Talla M · Nuevo con etiqueta · Heredia/);
  assert.match(meta(html, 'og:image'), new RegExp(`^${ctx.base}/fotos/[a-f0-9]+_t\\.jpg$`), 'imagen con dirección completa (miniatura liviana)');
  assert.equal(meta(html, 'og:type'), 'product');
  assert.equal(meta(html, 'og:url'), `${ctx.base}/p/${id}`);
  assert.equal(meta(html, 'product:price:amount'), '25000');
  // La imagen se puede descargar sin sesión (WhatsApp la busca sin cookies).
  assert.equal((await fetch(meta(html, 'og:image'))).status, 200);
});

test('perfiles y portada también tienen vista previa', async () => {
  const sellerId = db.prepare("SELECT id FROM users WHERE email = 'tienda@test.cr'").get().id;
  const profile = await (await get(`/u/${sellerId}`)).text();
  assert.equal(meta(profile, 'og:title'), 'Tienda Uno en CowFace');
  assert.match(meta(profile, 'og:description'), /1 artículo a la venta/);
  assert.match(meta(profile, 'og:image'), /\/fotos\//);
  const home = await (await get('/')).text();
  assert.equal(meta(home, 'og:image'), `${ctx.base}/img/brand/01-drop.jpg`);
});

// ---------- Respaldos ----------

test('respaldo diario: copia comprimida, sin sesiones, una por día', async () => {
  setSetting('notify_email', 'yo@test.cr');
  const r = await backup.runDailyBackup();
  assert.match(r.name, backup.BACKUP_NAME);
  assert.equal(r.emailed, 'sin-clave', 'sin BACKUP_PASSWORD no se manda por correo');
  assert.ok((await backup.runDailyBackup()).skipped, 'el mismo día no se repite');

  const file = path.join(backup.BACKUP_DIR, r.name);
  const tmp = path.join(os.tmpdir(), `cf-restore-${Date.now()}.db`);
  fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(file)));
  const copy = new DatabaseSync(tmp);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 2, 'tiene los usuarios');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'pero no las sesiones');
  copy.close();
  fs.rmSync(tmp);
});

test('con BACKUP_PASSWORD llega por correo cifrado y se puede restaurar con el script', async () => {
  setSetting('notify_email', 'yo@test.cr');
  process.env.BACKUP_PASSWORD = 'una-clave-larga-de-prueba';
  const from = outbox.length;
  const r = await backup.runDailyBackup({ force: true });
  assert.equal(r.emailed, 'enviado');
  const mail = outbox.slice(from).find((m) => m.to === 'yo@test.cr');
  assert.match(mail.subject, /Respaldo del/);
  assert.deepEqual(mail.attachments.map((a) => path.extname(a)), ['.cfbk']);

  const gz = fs.readFileSync(path.join(backup.BACKUP_DIR, r.name));
  const encrypted = backup.encrypt(gz);
  assert.ok(!encrypted.includes(Buffer.from('tienda@test.cr')), 'el correo no viaja en claro');
  assert.throws(() => backup.decrypt(encrypted, 'otra-clave-cualquiera'), /incorrecta/);
  assert.ok(backup.decrypt(encrypted, process.env.BACKUP_PASSWORD).equals(gz));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bk-'));
  fs.writeFileSync(path.join(dir, 'respaldo.cfbk'), encrypted);
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', path.join(dir, 'respaldo.cfbk')], { env: { ...process.env } }).toString();
  assert.match(out, /Listo/);
  const restored = new DatabaseSync(path.join(dir, 'cowface-restaurado.db'));
  assert.ok(restored.prepare("SELECT 1 FROM users WHERE email = 'tienda@test.cr'").get());
  restored.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.BACKUP_PASSWORD;
});

test('el panel muestra los respaldos y deja descargarlos solo al admin', async () => {
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /id="respaldos"/);
  assert.match(page, /BACKUP_PASSWORD/);
  const [{ name }] = backup.listBackups();
  const res = await get(`/admin/respaldos/${name}`, admin);
  assert.equal(res.status, 200);
  assert.equal(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await get(`/admin/respaldos/${name}`, seller)).status, 403);
  assert.equal((await get('/admin/respaldos/..%2F..%2Fcowface.db', admin)).status, 404);
  assert.match(flashOf(await post('/admin/respaldos/ahora', admin)), /Respaldo hecho/);
});

test('"Descargar todo" trae la base, las fotos y los adjuntos', async () => {
  const res = await get('/admin/respaldos/completo', admin);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /cowface-completo-.*\.tar\.gz/);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  const names = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(tar.subarray(off + 124, off + 136).toString().replace(/\0.*$/s, ''), 8);
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(names[0], 'cowface.db');
  assert.ok(names.some((n) => /^uploads\/[a-f0-9]+_t\.jpg$/.test(n)), 'incluye las fotos');
  assert.ok(!names.some((n) => n.startsWith('uploads/tmp')), 'sin la carpeta temporal');
  assert.equal((await get('/admin/respaldos/completo', seller)).status, 403);
});

// ---------- Carga rápida ----------

test('el CSV acepta ";" o ",", comillas, tildes y valores como los escribe una persona', () => {
  const { headers, rows } = parseCsv('﻿Título;Categoría;Para;Talla;Estado;Precio\r\n"Hoodie ""vintage""; gris";zapatos;Niños;9;nuevo con etiqueta;₡25.000\r\n;;;;;\r\n');
  assert.deepEqual(headers, ['titulo', 'categoria', 'para', 'talla', 'estado', 'precio']);
  assert.equal(rows.length, 1, 'las filas vacías se ignoran');
  assert.equal(rows[0].values.titulo, 'Hoodie "vintage"; gris');
  const body = rowToBody(rows[0].values);
  assert.deepEqual([body.category, body.department, body.size, body.condition], ['zapatos', 'ninos', 'US 9', 'nuevo']);
  assert.equal(rowToBody({ categoria: 'Zapatos', talla: '40' }).size, 'EU 40');
  assert.equal(rowToBody({ categoria: 'Ropa', tipo: 'jeans', talla: '32' }).size, 'Cintura 32');
  assert.equal(rowToBody({ categoria: 'Bolsos', tipo: 'mochila' }).item_type, 'Mochilas');
  assert.equal(rowToBody({ estado: 'Usado - como nuevo' }).condition, 'como_nuevo');
  assert.equal(rowToBody({ pick_up: 'No' }).meetup, '');
  assert.equal(parseCsv('titulo;en persona\nGorra;no\n').headers[1], 'pick_up', 'la columna vieja "en persona" sigue sirviendo');
  assert.equal(parseCsv('titulo,precio\nCamisa,"25,000"\n').rows[0].values.precio, '25,000');
});

let storeId;

test('el admin crea la cuenta de una tienda y le manda la invitación', async () => {
  const bad = await post('/admin/tiendas/nueva', admin, { name: 'X', email: 'tienda@test.cr', phone: '12', province: '' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Ya existe una cuenta con ese correo/);

  const from = outbox.length;
  const res = await post('/admin/tiendas/nueva', admin, {
    store_name: 'Closet Vintage', name: 'María Pérez', email: 'closet@test.cr', phone: '8811-2233', province: 'San José', send_email: '1',
  });
  assert.equal(res.status, 200);
  const page = await res.text();
  const link = page.match(/data-copy="([^"]+)"/)[1];
  assert.match(link, /\/restablecer\//);
  const mail = outbox.slice(from).find((m) => m.to === 'closet@test.cr');
  assert.match(mail.subject, /Closet Vintage ya está en CowFace/);
  assert.ok(mail.text.includes(link));
  const store = db.prepare("SELECT * FROM users WHERE email = 'closet@test.cr'").get();
  assert.equal(store.payout_phone, '88112233', 'el SINPE es el mismo teléfono si no se indica otro');
  storeId = store.id;

  // La tienda crea su contraseña con el enlace y entra.
  const pathOnly = link.replace(/^https?:\/\/[^/]+/, '');
  assert.equal((await post(pathOnly, '', { password: 'clave-tienda-123', confirm: 'clave-tienda-123' })).status, 302);
  const login = await post('/entrar', '', { email: 'closet@test.cr', password: 'clave-tienda-123' });
  assert.equal(login.headers.get('location'), '/');
  assert.equal((await post('/admin/tiendas/nueva', seller, { name: 'X' })).status, 403);
});

test('carga rápida: crea los válidos, explica los errores y pone las fotos en orden', async () => {
  const red = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#c00' } }).jpeg().toBuffer();
  const blue = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#00c' } }).jpeg().toBuffer();
  const csv = [
    'titulo;marca;categoria;tipo;para;talla;color;estado;precio;cantidad;envio;en_persona;descripcion;fotos',
    'Jeans Levi\'s 501;Levi\'s;Ropa;Jeans;Hombre;32;Azul;Usado;18.000;1;2500;Sí;Poco uso;jean-frente.jpg; jean-atras',
    'Air Force 1;Nike;Zapatos;Tenis;Unisex;9;Blanco;Como nuevo;45000;;;No;;af1.JPG',
    'Bolso sin fotos;Guess;Bolsos;Carteras;Mujer;Pequeño;Negro;Nuevo sin etiqueta;30000;;;;;',
    'Sombrero raro;;Sombreros;;Mujer;M;;Usado;10000;;;;;',
    'Gorra;New Era;Accesorios;Gorras y sombreros;Unisex;Única;Negro;Usado;12000;;;;;gorra.jpg',
    'Con contacto;;Ropa;Camisas;Hombre;M;;Usado;9000;;;;Escribime al whatsapp;jean-frente.jpg',
  ].join('\n');
  const body = new FormData();
  body.append('archivo', new Blob([csv], { type: 'text/csv' }), 'inventario.csv');
  body.append('fotos', new Blob([red], { type: 'image/jpeg' }), 'jean-frente.jpg');
  body.append('fotos', new Blob([blue], { type: 'image/jpeg' }), 'jean-atras.jpg');
  body.append('fotos', new Blob([PNG], { type: 'image/png' }), 'AF1.jpg'.replace('.jpg', '.png'));
  body.append('publish', '1');
  const res = await fetch(`${ctx.base}/admin/tiendas/${storeId}/carga`, { method: 'POST', body, headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /2 publicados<\/strong>, 1 como borrador y 3 con errores/);
  assert.match(page, /Categoría &#34;Sombreros&#34; no existe|Categoría "Sombreros" no existe/);
  assert.match(page, /No subiste la foto: gorra\.jpg/);
  assert.match(page, /whatsapp/i);

  const items = db.prepare('SELECT * FROM products WHERE seller_id = ? ORDER BY id').all(storeId);
  assert.deepEqual(items.map((p) => [p.title, p.status, p.size]), [
    ["Jeans Levi's 501", 'disponible', 'Cintura 32'],
    ['Air Force 1', 'disponible', 'US 9'],
    ['Bolso sin fotos', 'borrador', 'Pequeño'],
  ]);
  assert.equal(items[0].price, 18000);
  assert.equal(items[1].meetup, 0);
  const jeanPhotos = db.prepare('SELECT filename FROM product_images WHERE product_id = ? ORDER BY position').all(items[0].id);
  assert.equal(jeanPhotos.length, 2);
  const cover = await sharp(path.join(process.env.UPLOAD_DIR, jeanPhotos[0].filename)).stats();
  assert.ok(cover.channels[0].mean > 150, 'la portada es la primera foto del CSV (la roja)');
  assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR, 'tmp')).length, 0, 'no quedan temporales');
  // Lo publicado aparece en la búsqueda.
  assert.match(await (await get('/buscar?q=levis')).text(), /Jeans Levi&#39;s 501|Jeans Levi's 501/);
});

test('carga rápida: rechaza Excel sin convertir, y solo es para el admin', async () => {
  const body = new FormData();
  body.append('archivo', new Blob([Buffer.from('PK\x03\x04xlsx')], { type: 'application/vnd.ms-excel' }), 'inventario.xlsx');
  const res = await fetch(`${ctx.base}/admin/tiendas/${storeId}/carga`, { method: 'POST', body, headers: { cookie: admin } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /CSV UTF-8/);
  assert.equal((await get(`/admin/tiendas/${storeId}/carga`, seller)).status, 403);
  const tpl = await get('/admin/carga/plantilla.csv', admin);
  assert.match(tpl.headers.get('content-disposition'), /plantilla/);
  const text = await tpl.text();
  assert.match(text, /^﻿?titulo;marca;categoria/);
  // La plantilla misma se puede importar (sin fotos, como borradores).
  assert.equal(parseCsv(text).rows.length, 2);
});

test('el panel tiene los accesos a crear tienda y cargar artículos', async () => {
  const page = await (await get('/admin', admin)).text();
  assert.match(page, /href="\/admin\/tiendas\/nueva"/);
  assert.match(page, new RegExp(`href="/admin/tiendas/${storeId}/carga"`));
  await signup('otra@test.cr', 'Otra');
});
