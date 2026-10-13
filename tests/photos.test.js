// Fotos: calidad, privacidad (sin GPS/EXIF), orientación, miniaturas, límites y portada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { POLO, ctx, db, flashOf, get, post, publish, signupSeller, startServer, stopServer } from './helpers.js';

const { default: sharp } = await import('sharp');

before(startServer);
after(stopServer);

let seller;
const UPLOADS = () => process.env.UPLOAD_DIR;
const images = (productId) => db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id').all(productId);
const idFrom = (res) => Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);

// Foto "de celular": 4000×3000, girada (EXIF orientación 6) y con datos de cámara y de autor.
const phonePhoto = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#aa3322' } })
  .jpeg({ quality: 95 })
  .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'TestPhone', Model: 'X1', Artist: 'Vendedora Privada' } } })
  .toBuffer();

test('preparación', async () => {
  seller = await signupSeller('fotos@test.cr', 'Fotógrafa');
});

test('foto de celular: se endereza, queda en alta calidad, sin metadatos y con miniatura', async () => {
  const res = await publish(seller, POLO, [{ data: phonePhoto, type: 'image/jpeg', name: 'IMG_0001.jpg' }]);
  assert.equal(res.status, 302);
  const [img] = images(idFrom(res));
  assert.ok(img.thumb, 'tiene miniatura');

  // Original: resolución completa, enderezada, sin metadatos, calidad máxima.
  const original = await sharp(path.join(UPLOADS(), img.original)).metadata();
  assert.deepEqual([original.width, original.height], [3000, 4000], 'la original conserva toda la resolución');
  assert.equal(original.exif, undefined, 'sin EXIF (ni GPS, ni modelo de cámara, ni autor)');
  assert.ok([undefined, 1].includes(original.orientation), 'ya viene derecha, sin bandera de rotación');
  assert.equal(original.chromaSubsampling, '4:4:4');

  // Versión para la página: 2048 px de lado mayor, para que cargue rápido.
  const large = await sharp(path.join(UPLOADS(), img.filename)).metadata();
  assert.deepEqual([large.width, large.height], [1536, 2048]);
  assert.equal(large.format, 'jpeg');
  assert.equal(large.exif, undefined);
  assert.equal(large.chromaSubsampling, '4:4:4', 'color sin submuestreo (máxima calidad)');

  const thumb = await sharp(path.join(UPLOADS(), img.thumb)).metadata();
  assert.equal(Math.max(thumb.width, thumb.height), 800);
  assert.ok(fs.statSync(path.join(UPLOADS(), img.thumb)).size < fs.statSync(path.join(UPLOADS(), img.filename)).size);

  // Las tarjetas usan la miniatura; la página del artículo, la grande.
  const home = await (await get('/')).text();
  assert.match(home, new RegExp(`/fotos/${img.thumb}`));
  const page = await (await get(`/p/${idFrom(res)}`)).text();
  assert.match(page, new RegExp(`src="/fotos/${img.filename}"`));
  assert.equal(fs.readdirSync(path.join(UPLOADS(), 'tmp')).length, 0, 'no quedan archivos temporales');
});

test('una foto JPG derecha se guarda sin volver a comprimir: los píxeles quedan idénticos', async () => {
  const upright = await sharp({ create: { width: 4032, height: 3024, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
    .jpeg({ quality: 96 }).withMetadata({ exif: { IFD0: { Make: 'TestPhone', Artist: 'Vendedora' } } }).toBuffer();
  const res = await publish(seller, POLO, [{ data: upright, type: 'image/jpeg', name: 'IMG_0002.jpg' }]);
  const [img] = images(idFrom(res));
  const saved = fs.readFileSync(path.join(UPLOADS(), img.original));
  const imageData = (b) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
  assert.ok(imageData(saved).equals(imageData(upright)), 'los datos de la imagen son los mismos bytes que se subieron');
  assert.equal((await sharp(saved).metadata()).exif, undefined, 'pero sin EXIF');
  // La pantalla completa del artículo usa la original.
  const page = await (await get(`/p/${idFrom(res)}`)).text();
  assert.match(page, new RegExp(`data-full="/fotos/${img.original}"`));
});

test('fotos pequeñas no se agrandan (no se inventa calidad)', async () => {
  const small = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#222' } }).png().toBuffer();
  const res = await publish(seller, POLO, [{ data: small, type: 'image/png', name: 'chica.png' }]);
  const meta = await sharp(path.join(UPLOADS(), images(idFrom(res))[0].filename)).metadata();
  assert.deepEqual([meta.width, meta.height], [600, 800]);
});

test('acepta fotos grandes de hasta 20 MB y rechaza con mensaje claro lo que no sirve', async () => {
  const noisy = (sigma, quality) => sharp({ create: { width: 6000, height: 4500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } } })
    .jpeg({ quality }).toBuffer();
  const big = await noisy(25, 92); // ~15 MB, como una foto de 27 MP
  assert.ok(big.length > 5 * 1024 * 1024 && big.length < 20 * 1024 * 1024, `la foto de prueba pesa ${(big.length / 1048576).toFixed(1)} MB`);
  assert.equal((await publish(seller, POLO, [{ data: big, type: 'image/jpeg', name: 'grande.jpg' }])).status, 302);

  const huge = await noisy(60, 100); // ~35 MB
  assert.match(await (await publish(seller, POLO, [{ data: huge, type: 'image/jpeg', name: 'enorme.jpg' }])).text(), /menos de 20 MB/);

  const heic = await publish(seller, POLO, [{ data: Buffer.from('....ftypheic'), type: 'image/heic', name: 'IMG.HEIC' }]);
  assert.equal(heic.status, 400);
  assert.match(await heic.text(), /HEIC/);

  const gif = await publish(seller, POLO, [{ data: Buffer.from('GIF89a'), type: 'image/gif', name: 'a.gif' }]);
  assert.match(await gif.text(), /JPG, PNG, WebP o AVIF/);

  const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).png().toBuffer();
  assert.match(await (await publish(seller, POLO, [{ data: tiny, type: 'image/png', name: 't.png' }])).text(), /muy pequeña/);

  const none = await publish(seller, POLO, []);
  assert.equal(none.status, 400);
  assert.match(await none.text(), /al menos una foto/);
  assert.equal(fs.readdirSync(path.join(UPLOADS(), 'tmp')).length, 0, 'los rechazos tampoco dejan basura');
});

test('hasta 8 fotos; se puede elegir la portada; siempre queda al menos una', async () => {
  const photo = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  const eight = Array.from({ length: 8 }, (_, i) => ({ data: photo, type: 'image/jpeg', name: `${i}.jpg` }));
  const res = await publish(seller, POLO, eight);
  assert.equal(res.status, 302);
  const id = idFrom(res);
  const list = images(id);
  assert.equal(list.length, 8);

  const nine = await publish(seller, POLO, [...eight, eight[0]]);
  assert.match(await nine.text(), /Máximo 8 fotos/);

  await post(`/vendedor/productos/${id}/fotos/${list[5].id}/portada`, seller);
  assert.equal(images(id)[0].id, list[5].id, 'la foto elegida pasa a ser la portada');

  for (const img of list.slice(1)) await post(`/vendedor/productos/${id}/fotos/${img.id}/borrar`, seller);
  assert.equal(images(id).length, 1);
  const last = await post(`/vendedor/productos/${id}/fotos/${images(id)[0].id}/borrar`, seller);
  assert.match(flashOf(last), /al menos una foto/);
  assert.equal(images(id).length, 1);
  for (const img of list.slice(1)) {
    assert.ok(!fs.existsSync(path.join(UPLOADS(), img.filename)) && !fs.existsSync(path.join(UPLOADS(), img.thumb)), 'se borran grande y miniatura');
  }
});

test('la carpeta temporal no se sirve y las fotos se guardan en caché', async () => {
  assert.equal((await get('/fotos/tmp/cualquiera')).status, 404);
  const [img] = db.prepare('SELECT filename FROM product_images LIMIT 1').all();
  const res = await fetch(`${ctx.base}/fotos/${img.filename}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=31536000/);
});
